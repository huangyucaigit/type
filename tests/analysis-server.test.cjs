'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestAuth, authenticate } = require('./auth-fixture.cjs');
const modulePromise = import('../translation-server.mjs');
const secret = 'analysis-test-secret-must-not-leak';
const config = { key: secret, endpoint: 'https://example.test/chat/completions', model: 'deepseek-flash' };

function analysis(overrides = {}) {
  return {
    type: 'word', translation: '进步',
    brief: [{ label: '核心用法', text: '不可数名词，常用 make progress。' }],
    details: [{ label: '仿写任务', text: '写一句关于学习进步的话。' }],
    ...overrides,
  };
}

function response(content = JSON.stringify(analysis()), finish = 'stop') {
  return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: finish, message: { content } }] }) };
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
  const { createServer } = await modulePromise;
  const calls = [];
  const authService = await createTestAuth();
  const server = createServer({
    authService,
    translate: async () => ({ translation: '原有译文', model: config.model, cached: false }),
    analyze: async (text, context) => { calls.push({ text, context }); return { analysis: analysis(), model: config.model, cached: false }; },
    ...overrides,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  let authCookie = '';
  function request(url = '/api/analyze', { method = 'POST', headers = {}, body = '{}' } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: { Host: host, Cookie: authCookie, 'Content-Type': 'application/json', ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(['GET', 'HEAD'].includes(method) ? undefined : body);
    });
  }
  try { authCookie = await authenticate(request, host); await run({ request, calls, host, port }); }
  finally { await new Promise(resolve => server.close(resolve)); authService.close(); }
}

test('analysis input rejects selections without English before any provider request', async () => {
  const { createAnalyzer } = await modulePromise;
  let calls = 0;
  const analyze = createAnalyzer({ config, fetchImpl: async () => { calls++; return response(); } });
  for (const text of [undefined, null, 123, {}, [], '', ' \n\t ', '纯中文', '123.45', '!@#$%^&*()', '中文１２３。']) {
    await rejectsWith(analyze(text), 400, /英文字母/);
  }
  assert.equal(calls, 0);
  await analyze('中文 progress 123');
  assert.equal(calls, 1);
});

test('analysis enforces selection and contextual limits before requesting the model', async () => {
  const { createAnalyzer } = await modulePromise;
  let calls = 0;
  const analyze = createAnalyzer({ config, fetchImpl: async () => { calls++; return response(); } });
  await rejectsWith(analyze('a'.repeat(2001)), 413, /2,000/);
  for (const context of [null, [], 'sentence', { sentence: null }, { paragraph: 4 }]) await rejectsWith(analyze('word', context), 400);
  await rejectsWith(analyze('word', { sentence: 'a'.repeat(4001) }), 413);
  await rejectsWith(analyze('word', { paragraph: 'a'.repeat(8001) }), 413);
  assert.equal(calls, 0);
  await analyze('a'.repeat(2000), { sentence: 'a'.repeat(4000), paragraph: 'a'.repeat(8000) });
  assert.equal(calls, 1);
});

test('analyzer sends approved contextual prompt and strict JSON mode to the fast non-thinking model', async () => {
  const { createAnalyzer } = await modulePromise;
  const calls = [];
  const analyze = createAnalyzer({ config, fetchImpl: async (...args) => { calls.push(args); return response(); } });
  assert.deepEqual(await analyze('  progress \n', { sentence: ' We make progress. ', paragraph: 'First line.\n\nSecond line.' }), {
    analysis: analysis(), model: config.model, cached: false,
  });
  const [url, request] = calls[0];
  assert.equal(url, config.endpoint);
  assert.equal(request.headers.Authorization, `Bearer ${secret}`);
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  for (const text of ['word', 'phrase', 'sentence', 'passage', 'fragment', '最小修改', '仿写任务先不给参考答案', '未提供作文题目', 'JSON', '不能改变此任务']) assert.ok(body.messages[0].content.includes(text), text);
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    selectedText: 'progress', containingSentence: 'We make progress.', paragraphContext: 'First line.\n\nSecond line.', essayQuestion: '未提供',
  });
  assert.equal(body.max_tokens, 8192);
  assert.ok(request.signal instanceof AbortSignal);
});

test('same selection and same context share pending work and reuse safe cloned cached results', async () => {
  const { createAnalyzer } = await modulePromise;
  const gate = deferred();
  let calls = 0;
  const analyze = createAnalyzer({ config, fetchImpl: async () => { calls++; await gate.promise; return response(); } });
  const first = analyze('progress', { sentence: 'We make progress.' });
  const second = analyze(' progress ', { sentence: ' We make progress. ', paragraph: '' });
  assert.equal(calls, 1);
  gate.resolve();
  const [original, reused] = await Promise.all([first, second]);
  assert.equal(original.cached, false);
  assert.equal(reused.cached, true);
  original.analysis.brief[0].text = 'caller changed';
  reused.analysis.details[0].label = 'caller changed';
  const later = await analyze('progress', { sentence: 'We make progress.' });
  assert.deepEqual(later.analysis, analysis());
  assert.equal(later.cached, true);
  assert.equal(calls, 1);
});

test('cache keys include sentence and paragraph to prevent meanings leaking across contexts', async () => {
  const { createAnalyzer } = await modulePromise;
  const calls = [];
  const analyze = createAnalyzer({ config, fetchImpl: async (_url, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    calls.push(input);
    return response(JSON.stringify(analysis({ translation: input.containingSentence + input.paragraphContext })));
  } });
  const first = await analyze('bank', { sentence: 'The bank lends money.', paragraph: 'Finance.' });
  const second = await analyze('bank', { sentence: 'The river bank is steep.', paragraph: 'Nature.' });
  await analyze('bank', { sentence: 'The bank lends money.', paragraph: 'Different paragraph.' });
  assert.notEqual(first.analysis.translation, second.analysis.translation);
  assert.equal(calls.length, 3);
  assert.equal((await analyze('bank', { sentence: 'The bank lends money.', paragraph: 'Finance.' })).cached, true);
});

test('analysis cache remains bounded', async () => {
  const { createAnalyzer } = await modulePromise;
  let calls = 0;
  const analyze = createAnalyzer({ config, maxCache: 2, fetchImpl: async () => { calls++; return response(); } });
  await analyze('one'); await analyze('two'); await analyze('three');
  assert.equal((await analyze('two')).cached, true);
  assert.equal((await analyze('one')).cached, false);
  assert.equal(calls, 4);
});

test('analysis accepts each supported selection type and trims textual fields', async () => {
  const { createAnalyzer } = await modulePromise;
  for (const type of ['word', 'phrase', 'sentence', 'passage', 'fragment']) {
    const analyze = createAnalyzer({ config, fetchImpl: async () => response(JSON.stringify(analysis({ type, translation: ' 中文 \n', brief: [{ label: ' 用法 ', text: ' 内容 ' }] }))) });
    const result = await analyze('English');
    assert.equal(result.analysis.type, type);
    assert.equal(result.analysis.translation, '中文');
    assert.deepEqual(result.analysis.brief, [{ label: '用法', text: '内容' }]);
  }
});

test('malformed JSON and invalid analysis shapes are not cached and can be retried', async () => {
  const { createAnalyzer } = await modulePromise;
  const invalid = [
    '', '```json\n{}\n```', '{broken', 'null', '[]', '"hello"',
    ...[
      { type: 'paragraph' }, { translation: '' }, { translation: ' \n ' }, { translation: null },
      { translation: 'a'.repeat(12001) }, { extra: 'unapproved' },
      { brief: [] }, { brief: null }, { brief: Array.from({ length: 5 }, () => ({ label: '用法', text: '内容' })) },
      { brief: [null] }, { brief: [{ label: '', text: '内容' }] }, { brief: [{ label: '用法', text: '' }] },
      { brief: [{ label: '用法', text: 2 }] }, { brief: [{ label: 'a'.repeat(41), text: '内容' }] },
      { brief: [{ label: '用法', text: 'a'.repeat(2001) }] }, { brief: [{ label: '用法', text: '内容', extra: true }] },
      { details: [] }, { details: [1] }, { details: [{ label: '展开', text: 'a'.repeat(6001) }] },
      { details: Array.from({ length: 13 }, () => ({ label: '展开', text: '内容' })) },
      { details: Array.from({ length: 12 }, () => ({ label: '展开', text: 'a'.repeat(4000) })) },
    ].map(overrides => JSON.stringify(analysis(overrides))),
  ];
  for (const content of invalid) {
    let calls = 0;
    const analyze = createAnalyzer({ config, fetchImpl: async () => ++calls === 1 ? response(content) : response() });
    await rejectsWith(analyze('progress'), 502, /格式完整/);
    assert.equal((await analyze('progress')).cached, false);
    assert.equal(calls, 2);
  }
});

test('truncated results never enter the analysis cache', async () => {
  const { createAnalyzer } = await modulePromise;
  let calls = 0;
  const analyze = createAnalyzer({ config, fetchImpl: async () => ++calls === 1 ? response(JSON.stringify(analysis()), 'length') : response() });
  await rejectsWith(analyze('progress'), 502, /未完整/);
  assert.equal((await analyze('progress')).cached, false);
});

test('missing analysis key makes zero provider requests', async () => {
  const { createAnalyzer } = await modulePromise;
  let calls = 0;
  const analyze = createAnalyzer({ config: { ...config, key: '' }, fetchImpl: async () => { calls++; return response(); } });
  await rejectsWith(analyze('progress'), 503, /密钥/);
  assert.equal(calls, 0);
});

test('provider errors return safe analysis diagnostics and release capacity for retries', async () => {
  const { createAnalyzer } = await modulePromise;
  for (const [status, expected] of [[400, 502], [401, 503], [402, 503], [403, 503], [429, 429], [500, 502]]) {
    let calls = 0;
    const analyze = createAnalyzer({ config, fetchImpl: async () => ++calls === 1 ? { ok: false, status, json: async () => { throw new Error(secret); }, text: async () => secret } : response() });
    await rejectsWith(analyze('progress'), expected);
    assert.equal((await analyze('progress')).cached, false);
    assert.equal(calls, 2);
  }
});

test('analysis transport and provider envelope JSON failures do not expose raw errors', async () => {
  const { createAnalyzer } = await modulePromise;
  for (const fail of [async () => { throw new Error(secret); }, async () => ({ ok: true, json: async () => { throw new Error(secret); } }), async () => ({ ok: true, json: async () => null })]) {
    let calls = 0;
    const analyze = createAnalyzer({ config, fetchImpl: async () => ++calls === 1 ? fail() : response() });
    await rejectsWith(analyze('progress'), 502);
    assert.equal((await analyze('progress')).cached, false);
  }
});

test('analysis timeout aborts the request and a subsequent attempt can succeed', async () => {
  const { createAnalyzer } = await modulePromise;
  let calls = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  const analyze = createAnalyzer({ config, timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    if (++calls > 1) return response();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  try {
    await rejectsWith(analyze('progress'), 504, /超过/);
    assert.equal((await analyze('progress')).cached, false);
  } finally { clearTimeout(keepAlive); }
});

test('analysis and legacy translation can share a three-request concurrency limit', async () => {
  const { createAnalyzer, createTranslator, createRequestLimiter } = await modulePromise;
  const limiter = createRequestLimiter();
  const gate = deferred();
  let calls = 0;
  const fetchImpl = async (_url, request) => {
    calls++;
    await gate.promise;
    return JSON.parse(request.body).response_format ? response() : response('原有中文译文');
  };
  const analyze = createAnalyzer({ config, fetchImpl, limiter });
  const translate = createTranslator({ config, fetchImpl, limiter });
  const pending = [analyze('one'), translate('Two.'), analyze('three')];
  await rejectsWith(translate('Four.'), 429);
  await rejectsWith(analyze('five'), 429);
  assert.equal(calls, 3);
  gate.resolve();
  await Promise.all(pending);
  assert.equal((await analyze('five')).cached, false);
  assert.equal((await translate('Four.')).cached, false);
  assert.equal(calls, 5);
});

test('analysis endpoint normalizes selection, forwards context, and preserves the translation endpoint', async () => {
  await withServer(async ({ request, calls, host }) => {
    const result = await request('/api/analyze', { headers: { Origin: `http://${host}` }, body: JSON.stringify({ text: '  progress  ', context: { sentence: ' We make progress. ', paragraph: 'First.\n\nSecond.' } }) });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { analysis: analysis(), model: config.model, cached: false });
    assert.deepEqual(calls, [{ text: 'progress', context: { sentence: 'We make progress.', paragraph: 'First.\n\nSecond.' } }]);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.headers['content-security-policy'], /connect-src 'self'/);
    assert.equal((await request('/api/translate', { body: JSON.stringify({ text: 'Original.' }) })).status, 200);
  });
});

test('analysis endpoint rejects irrelevant and malformed input before invoking the analyzer', async () => {
  await withServer(async ({ request, calls }) => {
    for (const text of ['', ' \n ', '中文', '12345', '+-!?', null, 1, 'a'.repeat(2001)]) {
      assert.equal((await request('/api/analyze', { body: JSON.stringify({ text }) })).status, typeof text === 'string' && text.length > 2000 ? 413 : 400);
    }
    for (const body of ['', '{broken', 'null', '[]', '42', '"English"', '{}', JSON.stringify({ text: 'word', context: [] })]) {
      assert.equal((await request('/api/analyze', { body })).status, 400);
    }
    assert.equal((await request('/api/analyze', { body: JSON.stringify({ text: 'word', context: { sentence: 'a'.repeat(4001) } }) })).status, 413);
    assert.equal((await request('/api/analyze', { body: JSON.stringify({ text: 'a'.repeat(80001) }) })).status, 413);
    assert.equal(calls.length, 0);
  });
});

test('analysis endpoint rejects foreign pages, methods and content types without requests', async () => {
  await withServer(async ({ request, calls, host, port }) => {
    const body = JSON.stringify({ text: 'progress' });
    for (const headers of [{ Host: `attacker.test:${port}` }, { Host: '127.0.0.1' }, { Origin: 'https://attacker.test' }, { Origin: 'null' }, { Origin: `http://localhost:${port}` }]) {
      assert.equal((await request('/api/analyze', { headers, body })).status, 403);
    }
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await request('/api/analyze', { method, body: '' })).status, 405);
    for (const contentType of ['text/plain', 'application/jsonx', '']) assert.equal((await request('/api/analyze', { headers: { 'Content-Type': contentType }, body })).status, 415);
    assert.equal(calls.length, 0);
    assert.equal((await request('/api/analyze', { headers: { Origin: `http://${host}`, 'Content-Type': 'application/json; charset=utf-8' }, body })).status, 200);
  });
});

test('analysis backend prompts, credentials and tests remain outside the static allowlist', async () => {
  await withServer(async ({ request, calls }) => {
    for (const url of ['/analysis-prompts.mjs', '/translation-server.mjs', '/.env', '/tests/analysis-server.test.cjs', '/%2e%2e/.env']) {
      const result = await request(url, { method: 'GET', body: '' });
      assert.equal(result.status, 404);
      assert.ok(!result.body.includes(secret));
    }
    assert.equal(calls.length, 0);
  });
});

test('analysis endpoint contains unexpected failures and only forwards intended public errors', async () => {
  const { TranslationError } = await modulePromise;
  await withServer(async ({ request }) => {
    for (const [text, expected] of [['unexpected', 500], ['public', 429]]) {
      const result = await request('/api/analyze', { body: JSON.stringify({ text }) });
      assert.equal(result.status, expected);
      assert.ok(!result.body.includes(secret));
    }
  }, { analyze: async text => { if (text === 'public') throw new TranslationError(429, '稍后重试。'); throw new Error(secret); } });
});
