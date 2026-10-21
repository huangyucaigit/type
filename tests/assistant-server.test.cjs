'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestAuth, authenticate } = require('./auth-fixture.cjs');
const modules = Promise.all([import('../translation-server.mjs'), import('../assistant-service.mjs')]);
const config = { key: 'private-assistant-key', endpoint: 'https://example.test/chat/completions', model: 'deepseek-flash' };
function body(owner) { return { owner, article: { title: 'Practice', text: 'We make progress.' }, messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '解释 progress' }], metadata: { references: [{ text: 'progress', sentence: 'We make progress.' }] } }] }; }
const provider = () => ({ ok: true, body: new ReadableStream({ start(controller) {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"持续练习会取得进步。"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  controller.enqueue(bytes); controller.close();
} }) });
async function withServer(run, { authenticateUser = true, ...overrides } = {}) {
  const [{ createServer }, { createAssistant }] = await modules;
  const authService = await createTestAuth();
  let calls = 0;
  const server = createServer({ authService, assistant: createAssistant({ config, fetchImpl: async () => { calls++; return provider(); } }), ...overrides });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, host = `127.0.0.1:${port}`;
  let cookie = '';
  async function request(path, { method = 'POST', headers = {}, body: data = '{}' } = {}) {
    return fetch(`http://${host}${path}`, { method, headers: { Origin: `http://${host}`, Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : data });
  }
  try {
    if (authenticateUser) cookie = await authenticate(request, host);
    const session = await (await request('/api/auth/session', { method: 'GET' })).json();
    const owner = session.user ? `account:${session.user.id}` : 'guest';
    await run({ request, host, port, owner, cookie, calls: () => calls });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); authService.close(); }
}

test('authorized assistant route streams SDK events with CSP and private cache headers', async () => {
  await withServer(async ({ request, owner, calls }) => {
    const response = await request('/api/assistant', { body: JSON.stringify(body(owner)) });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
    assert.equal(response.headers.get('x-accel-buffering'), 'no'); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    const value = await response.text(); assert.match(value, /text-delta/); assert.match(value, /持续练习/); assert.match(value, /"type":"finish"/);
    assert.ok(!value.includes(config.key)); assert.equal(calls(), 1);
  });
});
test('account mismatch is rejected before the provider sees another account conversation', async () => {
  await withServer(async ({ request, calls }) => {
    const result = await request('/api/assistant', { body: JSON.stringify(body('guest')) });
    assert.equal(result.status, 409); assert.equal((await result.json()).code, 'ASSISTANT_OWNER_CHANGED'); assert.equal(calls(), 0);
  });
});
test('unused visitor time cannot be bypassed by directly posting to the assistant', async () => {
  await withServer(async ({ request, calls }) => {
    const result = await request('/api/assistant', { body: JSON.stringify(body('guest')) });
    assert.equal(result.status, 403); assert.equal((await result.json()).code, 'GUEST_REQUIRED'); assert.equal(calls(), 0);
  }, { authenticateUser: false });
});
test('assistant rejects foreign/missing origins, unsupported methods/content and bad JSON', async () => {
  await withServer(async ({ request, host, port, owner, cookie, calls }) => {
    assert.equal((await request('/api/assistant', { method: 'GET' })).status, 405);
    assert.equal((await request('/api/assistant', { headers: { Origin: 'https://foreign.test' } })).status, 403);
    assert.equal((await request('/api/assistant', { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await request('/api/assistant', { body: 'bad' })).status, 400);
    const noOrigin = await new Promise(resolve => {
      const request = http.request({ hostname: '127.0.0.1', port, path: '/api/assistant', method: 'POST', headers: { Host: host, Cookie: cookie, 'Content-Type': 'application/json' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      }); request.end(JSON.stringify(body(owner)));
    });
    assert.equal(noOrigin, 403); assert.equal(calls(), 0);
  });
});
test('public HTTP cannot send assistant content before upgrading to HTTPS', async () => {
  await withServer(async ({ port, owner, calls }) => {
    const status = await new Promise(resolve => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/assistant', method: 'POST',
        headers: { Host: 'example.test', Origin: 'https://example.test', 'Content-Type': 'application/json' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }); req.end(JSON.stringify(body(owner)));
    });
    assert.equal(status, 426); assert.equal(calls(), 0);
  }, { publicOrigins: ['https://example.test'] });
});
test('pre-stream provider failures remain safe JSON, while post-stream failures become error events', async () => {
  const [, { createAssistant }] = await modules;
  await withServer(async ({ request, owner }) => {
    const result = await request('/api/assistant', { body: JSON.stringify(body(owner)) });
    assert.equal(result.status, 503); assert.match((await result.json()).error, /暂时不可用/);
  }, { assistant: createAssistant({ config, fetchImpl: async () => ({ ok: false, status: 401 }) }) });
  await withServer(async ({ request, owner }) => {
    const result = await request('/api/assistant', { body: JSON.stringify(body(owner)) });
    assert.equal(result.status, 200); const events = await result.text(); assert.match(events, /"type":"error"/); assert.doesNotMatch(events, /"type":"finish"/);
  }, { assistant: createAssistant({ config, fetchImpl: async () => ({ ok: true, body: new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分内容"}}]}\n\n')); c.close();
  } }) }) }) });
});
test('assistant assets are public but sources, dependencies and configuration remain private', async () => {
  await withServer(async ({ request }) => {
    for (const path of ['/assistant-bridge.js', '/assistant-history.js', '/learning-assistant.js', '/learning-assistant.css', '/learning-assistant.js.LEGAL.txt']) {
      const result = await request(path, { method: 'GET' }); assert.equal(result.status, 200, path);
    }
    for (const path of ['/assistant-service.mjs', '/assistant/package.json', '/assistant/src/main.tsx', '/assistant/node_modules/ai/package.json', '/.env']) {
      assert.equal((await request(path, { method: 'GET' })).status, 404, path);
    }
  });
});
test('aborting the downstream HTTP request cancels the provider signal', async () => {
  const [, { createAssistant }] = await modules;
  let upstreamSignal;
  await withServer(async ({ request, host, owner, cookie }) => {
    const controller = new AbortController();
    const response = await fetch(`http://${host}/api/assistant`, { method: 'POST', headers: { Origin: `http://${host}`, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body(owner)), signal: controller.signal });
    const reader = response.body.getReader(); await reader.read(); controller.abort();
    for (let i = 0; i < 30 && !upstreamSignal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(upstreamSignal.aborted, true);
  }, { assistant: createAssistant({ config, fetchImpl: async (_url, options) => {
    upstreamSignal = options.signal;
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n')); } }) };
  } }) });
});
