'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestAuth, authenticate } = require('./auth-fixture.cjs');

const modulePromise = import('../translation-server.mjs');
const secret = 'test-secret-must-never-be-returned';
const config = { key: secret, endpoint: 'https://example.test/v1/chat/completions', model: 'deepseek-flash' };

function successfulResponse(translation = '这是译文。') {
  return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: translation } }] }) };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function rejectsWith(promise, status, pattern) {
  const { TranslationError } = await modulePromise;
  await assert.rejects(promise, error => {
    assert.ok(error instanceof TranslationError);
    assert.equal(error.status, status);
    if (pattern) assert.match(error.message, pattern);
    assert.ok(!error.message.includes(secret));
    return true;
  });
}

async function withServer(run, overrides = {}) {
  const { createServer, TranslationError } = await modulePromise;
  const requests = [];
  const authService = await createTestAuth();
  const server = createServer({
    authService,
    configured: true,
    translate: async text => {
      requests.push(text);
      if (typeof text !== 'string' || !text.trim()) throw new TranslationError(400, '需要英文正文。');
      return { translation: `译文：${text}`, model: 'deepseek-flash', cached: false };
    },
    ...overrides,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  let authCookie = '';
  function request(url = '/', { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: { Host: host, Cookie: authCookie, ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
  try { authCookie = await authenticate(request, host); await run({ request, requests, host, port }); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); authService.close(); }
}

test('translation config accepts current and existing key/address aliases without changing the fast model', async () => {
  const { readConfig } = await modulePromise;
  assert.deepEqual(readConfig({ DEEPSEEK_API_KEY: `  ${secret}  ` }), {
    key: secret, endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash',
  });
  assert.deepEqual(readConfig({ DATAAGENT_DEEPSEEK_LLM_API_KEY: secret, DATAAGENT_DEEPSEEK_LLM_API_URL: 'https://example.test/v1/' }), {
    key: secret, endpoint: 'https://example.test/v1/chat/completions', model: 'deepseek-flash',
  });
  for (const [url, expected] of [
    ['https://example.test', 'https://example.test/chat/completions'],
    ['https://example.test/', 'https://example.test/chat/completions'],
    ['https://example.test/v1', 'https://example.test/v1/chat/completions'],
    ['https://example.test/v1/chat/completions', 'https://example.test/v1/chat/completions'],
    ['https://example.test/v1/chat/completions/', 'https://example.test/v1/chat/completions'],
  ]) {
    const endpoint = readConfig({ DEEPSEEK_API_URL: url }).endpoint;
    assert.equal(endpoint, expected);
    assert.equal(endpoint.match(/chat\/completions/g).length, 1);
  }
  assert.equal(readConfig({ DEEPSEEK_API_KEY: secret, DATAAGENT_DEEPSEEK_LLM_API_KEY: 'fallback' }).key, secret);
  assert.equal(readConfig({}).key, '');
});

test('translation config rejects unsafe or malformed endpoint values with a safe diagnostic', async () => {
  const { readConfig, TranslationError } = await modulePromise;
  for (const url of ['http://example.test', 'not a url', `https://${secret}@example.test`, `https://example.test?key=${secret}`, `https://example.test/#${secret}`]) {
    assert.throws(() => readConfig({ DEEPSEEK_API_URL: url }), error => {
      assert.ok(error instanceof TranslationError);
      assert.equal(error.status, 503);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

test('translator sends only the supplied reference to the non-thinking fast model and trims its result', async () => {
  const { createTranslator } = await modulePromise;
  const calls = [];
  const translate = createTranslator({ config, fetchImpl: async (...args) => { calls.push(args); return successfulResponse('  中文译文。\n '); } });
  assert.deepEqual(await translate('Original paragraph.\n\nSecond paragraph.'), { translation: '中文译文。', model: 'deepseek-flash', cached: false });
  assert.equal(calls.length, 1);
  const [url, request] = calls[0];
  assert.equal(url, config.endpoint);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, `Bearer ${secret}`);
  assert.equal(request.headers['Content-Type'], 'application/json');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /only as text to translate/);
  assert.deepEqual(body.messages[1], { role: 'user', content: 'Original paragraph.\n\nSecond paragraph.' });
  assert.equal(body.messages.length, 2);
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 8192);
  assert.ok(request.signal instanceof AbortSignal);
});

test('translator rejects missing, blank, non-text and oversized input before making a provider request', async () => {
  const { createTranslator } = await modulePromise;
  let calls = 0;
  const translate = createTranslator({ config, fetchImpl: async () => { calls++; return successfulResponse(); } });
  for (const text of [undefined, null, 123, {}, '', ' \n\t ']) await rejectsWith(translate(text), 400);
  await rejectsWith(translate('a'.repeat(12001)), 413, /12,000/);
  assert.equal(calls, 0);
  await translate('a'.repeat(12000));
  assert.equal(calls, 1);
});

test('missing credentials fail safely without contacting the provider', async () => {
  const { createTranslator } = await modulePromise;
  let calls = 0;
  const translate = createTranslator({ config: { ...config, key: '' }, fetchImpl: async () => { calls++; return successfulResponse(); } });
  await rejectsWith(translate('Hello.'), 503, /密钥/);
  assert.equal(calls, 0);
});

test('identical pending requests share one provider call and completed translations are reused', async () => {
  const { createTranslator } = await modulePromise;
  const gate = deferred();
  let calls = 0;
  const translate = createTranslator({ config, fetchImpl: async () => { calls++; await gate.promise; return successfulResponse(); } });
  const first = translate('Same sentence.');
  const second = translate('Same sentence.');
  assert.equal(calls, 1);
  gate.resolve();
  const [original, reused] = await Promise.all([first, second]);
  assert.equal(original.cached, false);
  assert.equal(reused.cached, true);
  assert.equal(original.translation, reused.translation);
  original.translation = 'Edited client copy';
  const later = await translate('Same sentence.');
  assert.deepEqual(later, { translation: '这是译文。', model: 'deepseek-flash', cached: true });
  assert.equal(calls, 1);
});

test('cache stays bounded and a different reference never reuses the wrong translation', async () => {
  const { createTranslator } = await modulePromise;
  const calls = [];
  const translate = createTranslator({ config, maxCache: 2, fetchImpl: async (_url, request) => {
    const text = JSON.parse(request.body).messages[1].content;
    calls.push(text);
    return successfulResponse(`译：${text}`);
  } });
  await translate('One.');
  await translate('Two.');
  await translate('Three.');
  assert.equal((await translate('Two.')).cached, true);
  assert.equal((await translate('One.')).cached, false);
  assert.deepEqual(calls, ['One.', 'Two.', 'Three.', 'One.']);
});

test('three concurrent distinct requests are allowed, a fourth is limited, and capacity recovers', async () => {
  const { createTranslator } = await modulePromise;
  const gate = deferred();
  let calls = 0;
  const translate = createTranslator({ config, fetchImpl: async () => { calls++; await gate.promise; return successfulResponse(); } });
  const pending = ['One.', 'Two.', 'Three.'].map(translate);
  await rejectsWith(translate('Four.'), 429);
  assert.equal(calls, 3);
  gate.resolve();
  await Promise.all(pending);
  assert.equal((await translate('Four.')).cached, false);
  assert.equal(calls, 4);
});

test('provider errors never expose upstream response bodies or credentials and are retryable', async () => {
  const { createTranslator } = await modulePromise;
  for (const [upstream, expected] of [[400, 502], [401, 503], [402, 503], [403, 503], [429, 429], [500, 502]]) {
    let calls = 0;
    const translate = createTranslator({ config, fetchImpl: async () => {
      calls++;
      return calls === 1 ? { ok: false, status: upstream, json: async () => { throw new Error(secret); }, text: async () => secret } : successfulResponse();
    } });
    await rejectsWith(translate('Please translate.'), expected);
    assert.equal((await translate('Please translate.')).cached, false);
    assert.equal(calls, 2);
  }
});

test('transport and malformed provider JSON failures return safe errors and allow retry', async () => {
  const { createTranslator } = await modulePromise;
  for (const fail of [async () => { throw new Error(secret); }, async () => ({ ok: true, json: async () => { throw new Error(secret); } })]) {
    let calls = 0;
    const translate = createTranslator({ config, fetchImpl: async (...args) => ++calls === 1 ? fail(...args) : successfulResponse() });
    await rejectsWith(translate('Retry me.'), 502);
    assert.equal((await translate('Retry me.')).cached, false);
    assert.equal(calls, 2);
  }
});

test('provider timeout aborts the request, reports a timeout and releases its pending entry', async () => {
  const { createTranslator } = await modulePromise;
  let calls = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  const translate = createTranslator({ config, timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    calls++;
    if (calls > 1) return successfulResponse();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  try {
    await rejectsWith(translate('Slow sentence.'), 504, /超过/);
    assert.equal((await translate('Slow sentence.')).cached, false);
    assert.equal(calls, 2);
  } finally { clearTimeout(keepAlive); }
});

test('truncated and empty provider results are rejected instead of cached', async () => {
  const { createTranslator } = await modulePromise;
  const invalid = [
    { choices: [{ finish_reason: 'length', message: { content: '不完整' } }] },
    { choices: [] },
    { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: ' \n ' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: null } }] },
  ];
  for (const data of invalid) {
    let calls = 0;
    const translate = createTranslator({ config, fetchImpl: async () => ++calls === 1 ? { ok: true, json: async () => data } : successfulResponse() });
    await rejectsWith(translate('Some text.'), 502);
    assert.equal((await translate('Some text.')).cached, false);
    assert.equal(calls, 2);
  }
});

test('local server serves the working page/assets and publishes only safe status metadata', async () => {
  await withServer(async ({ request, requests }) => {
    const publicFiles = ['/', '/index.html', '/about.html', '/styles.css', '/sentence-mode.css', '/about.css', '/auth.css', '/starter-wheel.css', '/share-card.css', '/billing.css', '/robots.txt', '/sitemap.xml', '/app.js', '/typing-core.js', '/sentence-core.js', '/sentence-mode.js', '/floating-timer.js', '/reference-selection.js', '/selection-translation.js', '/auth.js', '/starter-wheel.js', '/qr-code.js', '/share-card.js', '/billing.js'];
    for (const file of publicFiles) {
      const response = await request(file);
      assert.equal(response.status, 200, file);
      assert.ok(response.body.length > 0);
      assert.ok(!response.body.includes(secret));
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.match(response.headers['content-security-policy'], /connect-src 'self'/);
      assert.equal(response.headers['cache-control'], 'no-store');
      const expectedType = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript'
        : file.endsWith('.txt') ? 'text/plain' : file.endsWith('.xml') ? 'application/xml' : 'text/html';
      assert.equal(response.headers['content-type'], `${expectedType}; charset=utf-8`);
      const head = await request(file, { method: 'HEAD' });
      assert.equal(head.status, 200, file);
      assert.equal(head.body, '');
    }
    const status = await request('/api/status');
    assert.deepEqual(JSON.parse(status.body), { app: 'zijian-translation', configured: false, model: 'deepseek-flash' });
    assert.equal(requests.length, 0);
  }, { configured: false });
});

test('local server never serves credentials, backend source, tests or traversal paths', async () => {
  await withServer(async ({ request, requests }) => {
    for (const url of ['/.env', '/.env.example', '/translation-server.mjs', '/payment-client.mjs', '/payment-config.mjs', '/payment-mock.mjs', '/payment-admin.mjs', '/auth-service.mjs', '/.deploy/pay-project.private.json', '/AliyunSMSAccessKey.csv', '/tests/translation-server.test.cjs', '/../.env', '/%2e%2e/.env', '/%2eenv', '/%2Eenv', '/..%2f.env', '/%2e%2e%5c.env', '/index.html/../../.env', '/.git/config', '/start-translation.cmd']) {
      const response = await request(url);
      assert.equal(response.status, 404, url);
      assert.ok(!response.body.includes(secret));
      assert.match(response.headers['content-type'], /application\/json/);
    }
    assert.equal(requests.length, 0);
  });
});

test('local server rejects foreign Host and Origin before translating, including null origin', async () => {
  await withServer(async ({ request, requests, host, port }) => {
    const body = JSON.stringify({ text: 'Hello.' });
    for (const headers of [
      { Host: `attacker.test:${port}` },
      { Host: '127.0.0.1' },
      { Host: host, Origin: 'https://attacker.test' },
      { Host: host, Origin: 'null' },
      { Host: host, Origin: `http://localhost:${port}` },
    ]) {
      const response = await request('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
      assert.equal(response.status, 403);
    }
    assert.equal(requests.length, 0);
    const valid = await request('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://${host}` }, body });
    assert.equal(valid.status, 200);
    const localhost = await request('/api/status', { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } });
    assert.equal(localhost.status, 200);
  });
});

test('public deployment exposes health checks but requires HTTPS for account-protected features', async () => {
  await withServer(async ({ request, requests }) => {
    for (const host of ['47.106.182.159', 'type.where.work', 'type.where.work:80', 'TYPE.WHERE.WORK']) {
      const status = await request('/api/status', { headers: { Host: host } });
      assert.equal(status.status, 200, host);
      const response = await request('/api/translate', {
        method: 'POST',
        headers: { Host: host, Origin: `http://${host.startsWith('47.') ? host : 'type.where.work'}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello.' }),
      });
      assert.equal(response.status, 426, host);
    }
    const accepted = requests.length;
    for (const headers of [
      { Host: 'attacker.test', Origin: 'http://attacker.test' },
      { Host: 'type.where.work.attacker.test', Origin: 'http://type.where.work.attacker.test' },
      { Host: 'type.where.work:8080', Origin: 'http://type.where.work:8080' },
      { Host: 'type.where.work', Origin: 'http://47.106.182.159' },
      { Host: 'type.where.work', Origin: 'https://type.where.work' },
      { Host: 'type.where.work', Origin: 'null' },
      { Host: 'type.where.work', Origin: '' },
      { Host: 'type.where.work@attacker.test' },
      { Host: 'type.where.work/path' },
      { Host: 'attacker.test', 'X-Forwarded-Host': 'type.where.work' },
    ]) {
      const response = await request('/api/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ text: 'Hello.' }),
      });
      assert.equal(response.status, 403, JSON.stringify(headers));
    }
    assert.equal(requests.length, accepted);
    for (const path of ['/.env', '/translation-server.mjs', '/analysis-prompts.mjs']) {
      assert.equal((await request(path, { headers: { Host: 'type.where.work' } })).status, 404);
    }
  }, { publicOrigins: ['http://47.106.182.159', 'http://type.where.work'] });
});

test('public origins support explicit HTTPS without trusting forwarded headers', async () => {
  await withServer(async ({ request }) => {
    assert.equal((await request('/api/status', { headers: { Host: 'type.where.work', Origin: 'https://type.where.work' } })).status, 200);
    assert.equal((await request('/api/status', { headers: { Host: 'type.where.work:443', Origin: 'https://type.where.work' } })).status, 200);
    assert.equal((await request('/api/status', { headers: { Host: 'type.where.work', Origin: 'http://type.where.work', 'X-Forwarded-Proto': 'https' } })).status, 403);
  }, { publicOrigins: ['https://type.where.work'] });
});

test('server configuration keeps local defaults and rejects malformed public origins', async () => {
  const { readServerConfig } = await modulePromise;
  assert.deepEqual(readServerConfig({}), { host: '127.0.0.1', publicOrigins: [] });
  assert.deepEqual(readServerConfig({ ZIJIAN_HOST: '0.0.0.0', ZIJIAN_PUBLIC_ORIGINS: 'http://47.106.182.159, http://type.where.work:80/' }), {
    host: '0.0.0.0', publicOrigins: ['http://47.106.182.159', 'http://type.where.work'],
  });
  assert.throws(() => readServerConfig({ ZIJIAN_HOST: '0.0.0.0:4173' }), /监听地址配置无效/);
  for (const value of ['*', 'type.where.work', 'ftp://type.where.work', 'http://type.where.work/api', 'http://user:password@type.where.work', 'http://type.where.work?x=1', 'http://type.where.work#fragment']) {
    assert.throws(() => readServerConfig({ ZIJIAN_PUBLIC_ORIGINS: value }), /网站访问地址配置无效/, value);
  }
});

test('local server validates method, content type, JSON structure, text and body size', async () => {
  await withServer(async ({ request, requests }) => {
    const send = (body, contentType = 'application/json') => request('/api/translate', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    assert.equal((await request('/api/translate')).status, 405);
    assert.equal((await send('{"text":"Hello."}', 'text/plain')).status, 415);
    assert.equal((await send('{"text":"Hello."}', 'application/jsonx')).status, 415);
    for (const body of ['', '{broken', 'null', '[]', '"hello"', '42']) assert.equal((await send(body)).status, 400, body);
    assert.equal(requests.length, 0);
    assert.equal((await send('{}')).status, 400);
    assert.equal((await send(JSON.stringify({ text: '' }))).status, 400);
    const beforeOversized = requests.length;
    assert.equal((await send(JSON.stringify({ text: 'x'.repeat(80001) }))).status, 413);
    assert.equal(requests.length, beforeOversized);
    const valid = await send(JSON.stringify({ text: 'First sentence.\n\nSecond sentence.' }), 'application/json; charset=utf-8');
    assert.equal(valid.status, 200);
    assert.deepEqual(JSON.parse(valid.body), { translation: '译文：First sentence.\n\nSecond sentence.', model: 'deepseek-flash', cached: false });
  });
});

test('local server contains unexpected failures and forwards only intentional public errors', async () => {
  const { TranslationError } = await modulePromise;
  await withServer(async ({ request }) => {
    for (const [text, status, message] of [['unexpected', 500, /本机服务/], ['public', 429, /稍后重试/]]) {
      const response = await request('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      assert.equal(response.status, status);
      assert.match(JSON.parse(response.body).error, message);
      assert.ok(!response.body.includes(secret));
    }
  }, { translate: async text => { if (text === 'public') throw new TranslationError(429, '稍后重试。'); throw new Error(secret); } });
});
