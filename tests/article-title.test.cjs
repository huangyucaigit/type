const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../article-title.mjs');
const serverPromise = import('../translation-server.mjs');
const config = { key: 'private-test-key', endpoint: 'https://example.test/chat/completions', model: 'deepseek-flash' };
const success = (content = '{"title":"日常练习的价值"}', finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ finish_reason, message: { content } }] }) });

async function titler(fetchImpl, overrides = {}) {
  const { createArticleTitler } = await modulePromise;
  const { createRequestLimiter } = await serverPromise;
  return createArticleTitler({ config, fetchImpl, limiter: createRequestLimiter(), ...overrides });
}

test('AI titles use the existing fast model, short JSON output, and cached concurrent requests', async () => {
  let calls = 0, request;
  const generate = await titler(async (url, options) => { calls++; request = JSON.parse(options.body); return success(); });
  const [first, second] = await Promise.all([generate('  Everyday practice helps. '), generate('Everyday practice helps.')]);
  assert.equal(first.title, '日常练习的价值');
  assert.equal(second.cached, true);
  assert.equal((await generate('Everyday practice helps.')).cached, true);
  assert.equal(calls, 1);
  assert.equal(request.model, 'deepseek-flash');
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.equal(request.messages[1].content, 'Everyday practice helps.');
  assert.equal(request.max_tokens, 256);
});

test('invalid or oversized title input never reaches the provider', async () => {
  const generate = await titler(() => { throw new Error('must not call'); });
  for (const text of [null, '', '   ', 42]) await assert.rejects(generate(text), { status: 400 });
  await assert.rejects(generate('x'.repeat(12001)), { status: 413 });
});

test('missing credentials, upstream failure, malformed titles and timeouts have safe retryable errors', async () => {
  const withoutKey = await titler(() => { throw new Error('must not call'); }, { config: { ...config, key: '' } });
  await assert.rejects(withoutKey('Article.'), { status: 503 });
  const cases = [
    [() => ({ ok: false, status: 429 }), 429],
    [() => ({ ok: false, status: 401, text: () => config.key }), 502],
    [() => success('{broken'), 502],
    [() => success('{"title":""}'), 502],
    [() => success(JSON.stringify({ title: '字'.repeat(81) })), 502],
    [() => success('{"title":"第一行\\n第二行"}'), 502],
    [() => success('{"title":"完整标题"}', 'length'), 502],
    [() => { throw Object.assign(new Error(config.key), { name: 'TimeoutError' }); }, 504],
  ];
  for (const [fetchImpl, status] of cases) {
    const generate = await titler(fetchImpl);
    await assert.rejects(generate('Article.'), error => error.status === status && !error.message.includes(config.key));
  }
});

test('title failures release shared concurrency slots and can be retried', async () => {
  const { createRequestLimiter } = await serverPromise;
  const limiter = createRequestLimiter(1);
  let calls = 0;
  const generate = await titler(async () => { if (++calls === 1) throw new Error('network'); return success(); }, { limiter });
  await assert.rejects(generate('Article.'), { status: 502 });
  assert.equal((await generate('Article.')).title, '日常练习的价值');
  limiter.acquire('busy');
  await assert.rejects(generate('Another article.'), { status: 429 });
  limiter.release();
  assert.equal((await generate('Another article.')).cached, false);
});

test('title API validates method, body, origin and content type and serves the history asset', async t => {
  const { createServer } = await serverPromise;
  const { createTestAuth, authenticate } = require('./auth-fixture.cjs');
  const authService = await createTestAuth();
  const calls = [];
  const server = createServer({ authService, titleArticle: async text => { calls.push(text); return { title: '文章主题' }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); authService.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await authenticate((url, options) => fetch(`${base}${url}`, options), new URL(base).host);
  const post = (body, headers = {}) => fetch(`${base}/api/article-title`, { method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const result = await post({ text: ' Article. ' });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { title: '文章主题' });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/api/article-title`)).status, 405);
  assert.equal((await post({ text: '' })).status, 400);
  assert.equal((await post(null)).status, 400);
  assert.equal((await post({ text: 'x'.repeat(12001) })).status, 413);
  assert.equal((await post({ text: 'Article.' }, { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await post({ text: 'Article.' }, { 'Content-Type': 'text/plain' })).status, 415);
  const broken = await fetch(`${base}/api/article-title`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(broken.status, 400);
  assert.deepEqual(calls, ['Article.']);
  const script = await fetch(`${base}/article-history.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
});
