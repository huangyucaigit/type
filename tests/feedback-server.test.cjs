'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { mkdtemp, rm, mkdir } = require('node:fs/promises');

const serverModule = import('../translation-server.mjs');
const storeModule = import('../feedback-store.mjs');
const fingerprint = 'a'.repeat(64);
const privateError = 'feedback-internal-path-and-secret-must-not-leak';

async function withTemporaryStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mars-feedback-http-'));
  const filePath = path.join(directory, 'feedback.json');
  const { createFeedbackStore } = await storeModule;
  let clock = Date.parse('2026-10-11T04:00:00.000Z');
  const makeStore = () => createFeedbackStore({ filePath, now: () => clock });
  try { await run({ filePath, makeStore, advanceDay: () => { clock += 86400000; } }); }
  finally {
    // Delete only the directory returned by mkdtemp, never a workspace data directory.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^mars-feedback-http-/);
    await rm(directory, { recursive: true, force: true });
  }
}

async function withServer(feedbackStore, run, overrides = {}) {
  const { createServer } = await serverModule;
  const server = createServer({
    configured: false,
    translate: async () => { throw new Error('No model requests are allowed in feedback tests.'); },
    analyze: async () => { throw new Error('No model requests are allowed in feedback tests.'); },
    feedbackStore,
    ...overrides,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  function request(url = '/api/feedback', { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: { Host: host, ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(body); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body, data });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  async function session(extraHeaders = {}) {
    const response = await request('/api/feedback', { headers: { 'X-Browser-Fingerprint': fingerprint, ...extraHeaders } });
    assert.equal(response.status, 200, response.body);
    const cookieHeader = response.headers['set-cookie']?.find(value => value.startsWith('mars_feedback='));
    assert.ok(cookieHeader, 'A server-issued browser identity cookie is required.');
    return { response, cookie: cookieHeader.split(';')[0], cookieHeader, csrfToken: response.data.csrfToken };
  }
  function post(state, input = {}, { headers = {}, body, ...options } = {}) {
    return request('/api/feedback', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: state?.cookie || '', 'X-Browser-Fingerprint': fingerprint, ...headers },
      body: body === undefined ? JSON.stringify({ csrfToken: state?.csrfToken, fingerprint, nickname: '练习者', message: '希望加入更多雅思作文练习范文。', website: '', ...input }) : body,
      ...options,
    });
  }
  try { await run({ request, post, session, origin, host }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function assertPublicMessage(message) {
  assert.ok(message && typeof message === 'object' && !Array.isArray(message));
  assert.deepEqual(Object.keys(message).sort(), ['createdAt', 'id', 'message', 'nickname']);
  assert.equal(typeof message.id, 'string');
  assert.equal(typeof message.createdAt, 'string');
  assert.equal(typeof message.nickname, 'string');
  assert.equal(typeof message.message, 'string');
}

test('public feedback reads have an IP limit before loading the board', async () => {
  let reads = 0;
  await withServer({ read: async () => { reads++; return { cookie: 'test-cookie', messages: [] }; } }, async ({ request }) => {
    for (let i = 0; i < 60; i++) assert.equal((await request()).status, 200);
    assert.equal((await request()).status, 429);
    assert.equal(reads, 60);
    assert.equal((await request('/api/status')).status, 200);
  });
});

test('feedback GET issues a protected identity cookie and returns an empty public board', async () => {
  await withTemporaryStore(async ({ makeStore }) => {
    await withServer(makeStore(), async ({ session }) => {
      const { response, cookieHeader, cookie } = await session();
      assert.equal(response.data.canSubmit, true);
      assert.deepEqual(response.data.messages, []);
      assert.ok(response.data.csrfToken);
      assert.match(response.data.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(response.data.resetAt);
      assert.equal(response.data.nextCursor, null);
      assert.match(cookieHeader, /;\s*Path=\/api\/feedback(?:;|$)/i);
      assert.match(cookieHeader, /;\s*HttpOnly(?:;|$)/i);
      assert.match(cookieHeader, /;\s*SameSite=Strict(?:;|$)/i);
      assert.match(cookieHeader, /;\s*Max-Age=\d+(?:;|$)/i);
      assert.doesNotMatch(cookieHeader, /;\s*Secure(?:;|$)/i);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.ok(!Object.hasOwn(response.data, 'cookie'));
      assert.ok(!response.body.includes(cookie.slice('mars_feedback='.length)));
      assert.ok(!response.body.includes(fingerprint));
    });
  });
});

test('feedback HTTPS deployment marks its identity cookie Secure', async () => {
  await withTemporaryStore(async ({ makeStore }) => {
    await withServer(makeStore(), async ({ request }) => {
      const response = await request('/api/feedback', { headers: { Host: 'feedback.example.test', Origin: 'https://feedback.example.test' } });
      assert.equal(response.status, 200);
      assert.match(response.headers['set-cookie'].join(';'), /;\s*Secure(?:;|$)/i);
    }, { publicOrigins: ['https://feedback.example.test'] });
  });
});

test('feedback successful submission is immediately public without exposing browser identities', async () => {
  await withTemporaryStore(async ({ makeStore }) => {
    await withServer(makeStore(), async ({ session, post, request }) => {
      const state = await session();
      const submitted = await post(state);
      assert.equal(submitted.status, 201, submitted.body);
      assertPublicMessage(submitted.data.message);
      assert.equal(submitted.data.message.nickname, '练习者');
      assert.equal(submitted.data.message.message, '希望加入更多雅思作文练习范文。');
      const board = await request('/api/feedback');
      assert.equal(board.status, 200);
      assert.deepEqual(board.data.messages, [submitted.data.message]);
      assertPublicMessage(board.data.messages[0]);
      assert.ok(!board.body.includes(fingerprint));
      assert.ok(!board.body.includes(state.cookie.slice('mars_feedback='.length)));
      const own = await request('/api/feedback', { headers: { Cookie: state.cookie, 'X-Browser-Fingerprint': fingerprint } });
      assert.equal(own.data.canSubmit, false);
    });
  });
});

test('feedback concurrent HTTP submissions permit exactly one message per browser and day', async () => {
  await withTemporaryStore(async ({ makeStore }) => {
    await withServer(makeStore(), async ({ session, post, request }) => {
      const state = await session();
      const results = await Promise.all([post(state), post(state, { message: '也希望可以保存我自己的学习设置。' })]);
      assert.deepEqual(results.map(response => response.status).sort(), [201, 429]);
      const blocked = results.find(response => response.status === 429);
      assert.equal(blocked.data.code, 'DAILY_LIMIT');
      assert.ok(Number(blocked.data.retryAfter) > 0);
      assert.ok(Number(blocked.headers['retry-after']) > 0);
      assert.equal((await request('/api/feedback')).data.messages.length, 1);
    });
  });
});

test('feedback daily limits survive server and store restart, and reset on the next Shanghai day', async () => {
  await withTemporaryStore(async ({ makeStore, advanceDay }) => {
    let state;
    await withServer(makeStore(), async ({ session, post }) => {
      state = await session();
      assert.equal((await post(state)).status, 201);
    });
    await withServer(makeStore(), async ({ request, post }) => {
      const restored = await request('/api/feedback', { headers: { Cookie: state.cookie, 'X-Browser-Fingerprint': fingerprint } });
      assert.equal(restored.status, 200);
      assert.equal(restored.data.canSubmit, false);
      assert.equal(restored.data.messages.length, 1);
      state.csrfToken = restored.data.csrfToken;
      const duplicate = await post(state);
      assert.equal(duplicate.status, 429);
      assert.equal(duplicate.data.code, 'DAILY_LIMIT');
      advanceDay();
      const next = await request('/api/feedback', { headers: { Cookie: state.cookie, 'X-Browser-Fingerprint': fingerprint } });
      assert.equal(next.data.canSubmit, true);
      state.csrfToken = next.data.csrfToken;
      assert.equal((await post(state, { message: '今天继续练习后发现分句功能很方便。' })).status, 201);
    });
  });
});

test('feedback requires a permitted Origin and authentic cookie plus CSRF token before writing', async () => {
  await withTemporaryStore(async ({ makeStore }) => {
    await withServer(makeStore(), async ({ session, post, request, origin }) => {
      const state = await session();
      for (const headers of [{ Origin: undefined }, { Origin: 'null' }, { Origin: 'https://attacker.test' }]) {
        // Omit absent Origin at transport level; Node rejects undefined header values.
        if (headers.Origin === undefined) {
          const absent = await request('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: state.cookie }, body: JSON.stringify({ csrfToken: state.csrfToken, nickname: '练习者', message: '这条不应被提交到留言板。' }) });
          assert.equal(absent.status, 403);
        } else assert.equal((await post(state, {}, { headers })).status, 403);
      }
      assert.equal((await post(state, { csrfToken: 'forged-token' })).status, 403);
      assert.equal((await post(state, {}, { headers: { Cookie: '' } })).status, 403);
      const forgedCookie = state.cookie.slice(0, -1) + (state.cookie.endsWith('a') ? 'b' : 'a');
      assert.equal((await post(state, {}, { headers: { Cookie: forgedCookie } })).status, 403);
      assert.equal((await request('/api/feedback')).data.messages.length, 0);
      assert.equal((await post(state, {}, { headers: { Origin: origin } })).status, 201);
    });
  });
});

test('feedback validates methods, JSON media type and an 8192-byte body before storage', async () => {
  await withTemporaryStore(async ({ makeStore }) => {
    await withServer(makeStore(), async ({ session, post, request, origin }) => {
      const state = await session();
      for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await request('/api/feedback', { method, headers: { Origin: origin } })).status, 405);
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx']) {
        assert.equal((await post(state, {}, { headers: { 'Content-Type': contentType } })).status, 415);
      }
      assert.equal((await post(state, {}, { body: JSON.stringify({ message: 'a'.repeat(8193) }) })).status, 413);
      assert.equal((await request('/api/feedback')).data.messages.length, 0);
    });
  });
});

test('feedback rejects malformed JSON, empty content and bot honeypot submissions', async () => {
  await withTemporaryStore(async ({ makeStore }) => {
    await withServer(makeStore(), async ({ session, post, request }) => {
      const state = await session();
      for (const body of ['', '{broken', 'null', '[]', '"text"']) assert.equal((await post(state, {}, { body })).status, 400, body);
      assert.equal((await post(state, { message: ' \n ' })).status, 400);
      assert.equal((await post(state, { website: 'https://spam.invalid' })).status, 400);
      assert.equal((await request('/api/feedback')).data.messages.length, 0);
      assert.equal((await post(state, {}, { headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 201);
    });
  });
});

test('feedback socket IP write throttling cannot be bypassed with forged proxy headers', async () => {
  await withTemporaryStore(async ({ makeStore }) => {
    await withServer(makeStore(), async ({ post }) => {
      for (let index = 0; index < 10; index++) {
        const response = await post(null, {}, { headers: { 'X-Real-IP': `192.0.2.${index + 1}` } });
        assert.equal(response.status, 403, response.body);
      }
      const limited = await post(null, {}, { headers: { 'X-Real-IP': '192.0.2.99' } });
      assert.equal(limited.status, 429);
      assert.equal(limited.data.code, 'RATE_LIMIT');
      assert.ok(Number(limited.headers['retry-after']) > 0);
      assert.notEqual(limited.data.code, 'DAILY_LIMIT');
    });
  });
});

test('feedback trusts individual proxy addresses only when explicitly configured', async () => {
  await withTemporaryStore(async ({ makeStore }) => {
    await withServer(makeStore(), async ({ post }) => {
      for (let index = 0; index < 11; index++) {
        const response = await post(null, {}, { headers: { 'X-Real-IP': `192.0.2.${index + 1}` } });
        assert.equal(response.status, 403, response.body);
      }
    }, { trustProxy: true });
  });
});

test('feedback failed durable writes return a safe service error and never become public', async () => {
  await withTemporaryStore(async ({ makeStore, filePath }) => {
    await withServer(makeStore(), async ({ session, post, request }) => {
      const state = await session();
      await rm(filePath, { force: true });
      await mkdir(filePath);
      const failed = await post(state);
      assert.equal(failed.status, 503, failed.body);
      assert.equal(typeof failed.data.error, 'string');
      assert.ok(!failed.body.includes(filePath));
      assert.ok(!failed.body.includes(privateError));
      const after = await request('/api/feedback', { headers: { Cookie: state.cookie, 'X-Browser-Fingerprint': fingerprint } });
      if (after.status === 200) {
        assert.deepEqual(after.data.messages, []);
        assert.equal(after.data.canSubmit, true);
      } else assert.equal(after.status, 503);
    });
  });
});

test('feedback static pages are accessible while private data and backend source stay inaccessible', async () => {
  await withTemporaryStore(async ({ makeStore }) => {
    await withServer(makeStore(), async ({ request }) => {
      for (const asset of ['/feedback.html', '/feedback.js', '/feedback.css']) {
        const response = await request(asset);
        assert.equal(response.status, 200, asset);
        assert.ok(response.body.length > 0);
        assert.equal(response.headers['cache-control'], 'no-store');
        const head = await request(asset, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(head.body, '');
      }
      for (const secretPath of ['/.env', '/feedback-store.mjs', '/translation-server.mjs', '/.data/feedback.json', '/.data/feedback-secret', '/tests/feedback-server.test.cjs', '/%2e%2e/.env', '/.data%2ffeedback.json']) {
        const response = await request(secretPath);
        assert.ok([400, 404].includes(response.status), secretPath);
        assert.ok(!response.body.includes(privateError));
      }
    });
  });
});
