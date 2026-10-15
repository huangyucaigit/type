'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const serverModule = import('../translation-server.mjs');
const reviewerModule = import('../sentence-review.mjs');
const config = { key: 'private-review-test-key', endpoint: 'https://example.test/chat/completions', model: 'deepseek-flash' };
const sample = { reference: 'Education benefits society.', answer: 'Society benefits from education.' };
const result = {
  review: {
    languageStatus: 'correct', meaningStatus: 'consistent', summary: '表达正确，保留原意。',
    correctedAnswer: sample.answer, errors: [],
    differences: [{ aspect: '句子主语', answer: 'Society', reference: 'Education', explanation: '改用社会作主语。' }], meaningNotes: [],
  }, model: 'deepseek-flash', cached: false,
};

async function withServer(run, overrides = {}) {
  const { createServer } = await serverModule;
  const calls = [];
  const server = createServer({
    config,
    translate: async () => ({ translation: '教育使社会受益。' }),
    analyze: async () => ({ analysis: {} }),
    review: async (reference, answer) => { calls.push({ reference, answer }); return result; },
    ...overrides,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  const request = (url = '/api/review', { method = 'POST', headers = {}, body = JSON.stringify(sample) } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: { Host: host, 'Content-Type': 'application/json', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  try { await run({ request, calls, host }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('review route passes the exact group and draft after trimming, with private no-store responses', async () => {
  await withServer(async ({ request, calls, host }) => {
    const response = await request('/api/review', { headers: { Origin: `http://${host}` }, body: JSON.stringify({ reference: ` ${sample.reference}\n`, answer: `\n${sample.answer} ` }) });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), result);
    assert.deepEqual(calls, [sample]);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.ok(!response.body.includes(config.key));
  });
});

test('review route rejects blank, non-English and oversize groups or drafts before invoking the reviewer', async () => {
  await withServer(async ({ request, calls }) => {
    for (const field of ['reference', 'answer']) {
      for (const value of [undefined, null, 7, {}, [], '', ' \n\t ', '只有中文', '123.45', '!@#$']) {
        assert.equal((await request('/api/review', { body: JSON.stringify({ ...sample, [field]: value }) })).status, 400);
      }
      assert.equal((await request('/api/review', { body: JSON.stringify({ ...sample, [field]: 'a'.repeat(12001) }) })).status, 413);
    }
    for (const body of ['null', '[]', '4', '"text"', '{']) assert.equal((await request('/api/review', { body })).status, 400);
    assert.equal((await request('/api/review', { body: JSON.stringify({ ...sample, unused: 'a'.repeat(150001) }) })).status, 413);
    assert.equal(calls.length, 0);
  });
});

test('review route enforces methods, JSON content type and approved origins before model use', async () => {
  await withServer(async ({ request, calls, host }) => {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await request('/api/review', { method, body: '' })).status, 405);
    for (const value of ['', 'text/plain', 'application/jsonx']) assert.equal((await request('/api/review', { headers: { 'Content-Type': value } })).status, 415);
    for (const headers of [{ Origin: 'https://other.example' }, { Host: 'other.example' }, { Origin: 'null' }]) assert.equal((await request('/api/review', { headers })).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await request('/api/review', { headers: { Origin: `http://${host}`, 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
    assert.equal(calls.length, 1);
  });
});

test('review service errors retain safe status and generic unexpected failures hide details', async () => {
  const { SentenceReviewError } = await reviewerModule;
  for (const status of [429, 502, 503, 504]) {
    await withServer(async ({ request }) => {
      const response = await request();
      assert.equal(response.status, status);
      assert.deepEqual(JSON.parse(response.body), { error: '评析暂时不可用，请重试。' });
    }, { review: async () => { throw new SentenceReviewError(status, '评析暂时不可用，请重试。'); } });
  }
  await withServer(async ({ request }) => {
    const response = await request();
    assert.equal(response.status, 500);
    assert.ok(!response.body.includes(config.key));
  }, { review: async () => { throw new Error(config.key); } });
});

test('review module stays private and deployment applies the existing API rate limit', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  await withServer(async ({ request }) => {
    for (const url of ['/sentence-review.mjs', '/.env', '/.data/feedback.json']) assert.equal((await request(url, { method: 'GET', body: '' })).status, 404);
  });
  const nginx = fs.readFileSync(path.join(__dirname, '../deploy/nginx.conf'), 'utf8');
  assert.match(nginx, /location ~ \^\/api\/\(translate\|analyze\|review\|article-title\)\$\s*\{\s*limit_req zone=api_per_ip/);
});

test('server defaults share three provider slots across review, translation and selection learning', async () => {
  const originalFetch = global.fetch;
  let release, ready;
  const gate = new Promise(resolve => { release = resolve; });
  const allStarted = new Promise(resolve => { ready = resolve; });
  let providerCalls = 0;
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (++providerCalls === 3) ready();
    await gate;
    let content;
    if (!payload.response_format) content = '教育使社会受益。';
    else {
      const input = JSON.parse(payload.messages[1].content);
      content = JSON.stringify(input.reference ? { ...result.review, correctedAnswer: input.answer, differences: [] } : {
        type: 'word', translation: '教育', brief: [{ label: '词义', text: 'education 表示教育。' }], details: [{ label: '搭配', text: 'higher education 表示高等教育。' }],
      });
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
  };
  try {
    await withServer(async ({ request }) => {
      const active = [
        request('/api/translate', { body: JSON.stringify({ text: sample.reference }) }),
        request('/api/analyze', { body: JSON.stringify({ text: 'education' }) }),
        request(),
      ];
      try {
        await allStarted;
        assert.equal((await request('/api/review', { body: JSON.stringify({ ...sample, answer: 'Education helps society.' }) })).status, 429);
        assert.equal(providerCalls, 3);
      } finally { release(); }
      assert.deepEqual((await Promise.all(active)).map(item => item.status), [200, 200, 200]);
      assert.equal((await request('/api/review', { body: JSON.stringify({ ...sample, answer: 'Education helps society.' }) })).status, 200);
      assert.equal(providerCalls, 4);
    }, { translate: undefined, analyze: undefined, review: undefined });
  } finally { release(); global.fetch = originalFetch; }
});
