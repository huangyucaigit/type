'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestAuth } = require('./auth-fixture.cjs');

async function fixture(t, options = {}) {
  const { createServer, createFeedbackRateLimiter } = await import('../translation-server.mjs');
  let timestamp = Date.UTC(2026, 9, 16, 0, 0, 0);
  const messages = [], sms = [], aiCalls = [];
  const authService = await createTestAuth({ now: () => timestamp, providers: {
    status: { sms: true, email: true },
    sendSms: async data => { sms.push(data); },
    sendResetEmail: async data => { messages.push(data); },
    sendBindEmail: async data => { messages.push(data); },
  } });
  const server = createServer({ authService,
    aiRateLimiter: createFeedbackRateLimiter({ now: () => timestamp }),
    translate: async text => { aiCalls.push('translate'); return { translation: text }; },
    analyze: async () => { aiCalls.push('analyze'); return { analysis: {} }; },
    review: async () => { aiCalls.push('review'); return { review: {} }; },
    titleArticle: async () => { aiCalls.push('title'); return { title: '标题' }; },
    ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); authService.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  let csrfToken;
  function request(url, { method = 'GET', body, headers = {}, jar = true } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${origin}${url}`, { method, headers: {
        ...(jar ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) } : {}),
        ...headers,
      } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          for (const item of response.headers['set-cookie'] || []) {
            if (!jar) continue;
            const pair = item.split(';')[0], equals = pair.indexOf('=');
            cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
          }
          const text = Buffer.concat(chunks).toString();
          let data; try { data = JSON.parse(text); } catch {}
          if (jar && data?.csrfToken) csrfToken = data.csrfToken;
          resolve({ status: response.statusCode, headers: response.headers, data, text });
        });
      });
      req.on('error', reject);
      req.end(body === undefined ? '' : JSON.stringify(body));
    });
  }
  const post = (url, body = {}, options = {}) => request(url, { method: 'POST', body, ...options });
  const register = (email = 'learner@example.test') => post('/api/auth/register', { nickname: '练习同学', email, password: 'Test-password-8024' });
  return { request, post, register, messages, sms, aiCalls, cookies, authService, now: () => timestamp, advance: ms => { timestamp += ms; } };
}

test('a visitor can use every AI feature for 24h without registration, then extend once with a starter coupon', async t => {
  const f = await fixture(t);
  const inputs = [
    ['/api/translate', { text: 'Education matters.' }],
    ['/api/analyze', { text: 'Education' }],
    ['/api/review', { reference: 'Education matters.', answer: 'Education is important.' }],
    ['/api/article-title', { text: 'Education matters.' }],
  ];
  for (const [url, body] of inputs) {
    const result = await f.post(url, body);
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'GUEST_REQUIRED');
  }
  const session = await f.request('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.data.user, null);
  assert.equal(session.data.guest.status, 'available');
  assert.equal(session.data.guest.startedAt, null);
  assert.equal(session.data.entitlement.hasAccess, false);
  assert.equal(session.headers['cache-control'], 'no-store');
  assert.ok(session.headers['set-cookie'].some(cookie => /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie)));
  assert.equal((await f.post('/api/auth/register', { nickname: '练习同学', email: 'learner@example.test', password: 'Test-password-8024' }, { headers: { 'X-CSRF-Token': 'forged' } })).status, 403);
  assert.equal((await f.post('/api/auth/register', { nickname: '练习同学',}, { headers: { Origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await f.post('/api/guest/start', { fingerprint: '1'.repeat(64) }, { headers: { 'X-CSRF-Token': 'forged' } })).status, 403);
  const guest = await f.post('/api/guest/start', { fingerprint: '1'.repeat(64) });
  assert.equal(guest.status, 200);
  assert.equal(guest.data.user, null);
  assert.equal(guest.data.guest.endsAt - guest.data.guest.startedAt, 24 * 3600000);
  assert.equal(guest.data.entitlement.hasAccess, true);
  for (const [url, body] of inputs) assert.equal((await f.post(url, body)).status, 200);
  f.advance(3600000);
  const restarted = await f.post('/api/guest/start', { fingerprint: 'f'.repeat(64) });
  assert.equal(restarted.data.guest.endsAt, guest.data.guest.endsAt);
  const registered = await f.register();
  assert.equal(registered.status, 200);
  assert.equal(registered.data.user.emailVerified, false);
  assert.equal(registered.data.entitlement.hasAccess, true);
  assert.equal(registered.data.starter.status, 'available');
  assert.equal(registered.data.starter.days, null);
  assert.equal(registered.data.entitlement.accountEndsAt, null);
  assert.ok(registered.headers['set-cookie'].some(cookie => /Max-Age=31536000/.test(cookie)));
  const claimed = await f.post('/api/coupons/starter/claim', { fingerprint: '1'.repeat(64) });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.starter.days, 3);
  assert.equal(claimed.data.entitlement.expiresAt, guest.data.guest.endsAt + 3 * 86400000);
  assert.equal(claimed.data.guest.status, 'transferred');
  const repeated = await f.post('/api/coupons/starter/claim', { fingerprint: '2'.repeat(64), days: 999 });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.entitlement.expiresAt, claimed.data.entitlement.expiresAt);
  for (const [url, body] of inputs) assert.equal((await f.post(url, body)).status, 200);
  f.advance(claimed.data.entitlement.expiresAt - f.now());
  for (const [url, body] of inputs) {
    const result = await f.post(url, body);
    assert.equal(result.status, 403);
    assert.ok(result.data.error);
  }
  assert.equal(f.aiCalls.length, 8);
  assert.equal((await f.post('/api/trial/claim')).status, 404);
  for (const url of ['/.env', '/auth-service.mjs', '/auth-providers.mjs', '/coupon-admin.mjs', '/.data/auth.sqlite', '/AliyunSMSAccessKey.csv']) assert.equal((await f.request(url)).status, 404);
});

test('password reset uses a single-use mailed link and revokes existing sessions', async t => {
  const f = await fixture(t);
  await f.request('/api/auth/session');
  assert.equal((await f.register()).status, 200);
  const oldSessionCookies = [...f.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  const present = await f.post('/api/auth/password/forgot', { email: 'learner@example.test' });
  const absent = await f.post('/api/auth/password/forgot', { email: 'absent@example.test' });
  assert.equal(present.status, 200);
  assert.deepEqual(present.data, absent.data);
  assert.equal(f.messages.length, 1);
  const token = new URL(f.messages[0].url).searchParams.get('reset');
  assert.ok(token);
  assert.ok(!f.messages[0].url.includes('Test-password'));
  assert.equal((await f.post('/api/auth/password/reset', { token, password: 'New-password-9012' })).status, 200);
  const old = await f.request('/api/auth/session', { jar: false, headers: { Cookie: oldSessionCookies } });
  assert.equal(old.data.user, null);
  assert.equal((await f.post('/api/auth/password/reset', { token, password: 'Another-password-7234' })).status, 400);
  assert.equal((await f.post('/api/auth/login', { email: 'learner@example.test', password: 'Test-password-8024' })).status, 401);
  assert.equal((await f.post('/api/auth/login', { email: 'learner@example.test', password: 'New-password-9012' })).status, 200);
});

test('SMS first login creates an account without claiming a coupon, and logout preserves the browser reward limit', async t => {
  const f = await fixture(t);
  await f.request('/api/auth/session');
  assert.equal((await f.post('/api/auth/sms/send', { phone: '123456', purpose: 'login' })).status, 400);
  assert.equal((await f.post('/api/auth/sms/send', { phone: '13341313711', purpose: 'login' })).status, 200);
  assert.equal(f.sms.length, 1);
  const loggedIn = await f.post('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: f.sms[0].code });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.data.user.phone, '13341313711');
  assert.equal(loggedIn.data.starter.status, 'available');
  assert.equal(loggedIn.data.starter.days, null);
  assert.equal((await f.post('/api/coupons/starter/claim', { fingerprint: '2'.repeat(64) })).status, 200);
  assert.equal((await f.post('/api/auth/logout')).status, 200);
  assert.equal((await f.register('second@example.test')).status, 200);
  assert.equal((await f.post('/api/coupons/starter/claim', { fingerprint: '3'.repeat(64) })).status, 403);
});

test('fixed 365 day session expires even if it was accessed recently', async t => {
  const f = await fixture(t);
  await f.request('/api/auth/session');
  await f.register();
  f.advance(365 * 86400000 - 1);
  assert.ok((await f.request('/api/auth/session')).data.user);
  f.advance(1);
  assert.equal((await f.request('/api/auth/session')).data.user, null);
});

test('public accounts require HTTPS and only a trusted proxy can select Secure cookies', async t => {
  const settings = { publicOrigins: ['http://account.example.test', 'https://account.example.test'] };
  const f = await fixture(t, { ...settings, trustProxy: true });
  const plain = { Host: 'account.example.test', Origin: 'http://account.example.test' };
  for (const route of ['/api/auth/session', '/api/translate']) assert.equal((await f.request(route, { headers: plain })).status, 426);
  const encrypted = { Host: 'account.example.test', Origin: 'https://account.example.test', 'X-Forwarded-Proto': 'https' };
  const session = await f.request('/api/auth/session', { headers: encrypted });
  assert.equal(session.status, 200);
  assert.ok(session.headers['set-cookie'].every(cookie => /; Secure/.test(cookie)));
  const registered = await f.post('/api/auth/register', { nickname: '练习同学', email: 'secure@example.test', password: 'Test-password-7239' }, { headers: encrypted });
  assert.equal(registered.status, 200);
  assert.ok(registered.headers['set-cookie'].some(cookie => /zijian_session=/.test(cookie) && /; Secure/.test(cookie)));
  const untrusted = await fixture(t, settings);
  assert.equal((await untrusted.request('/api/auth/session', { headers: encrypted })).status, 426);
});

test('expired anonymous experience cannot be restarted, extended by client flags, or used for AI', async t => {
  const f = await fixture(t);
  await f.request('/api/auth/session');
  const guest = await f.post('/api/guest/start', { fingerprint: 'b'.repeat(64), days: 365, paidUntil: Date.UTC(2099, 0, 1) });
  assert.equal(guest.status, 200);
  assert.equal(guest.data.guest.endsAt - f.now(), 86400000);
  assert.equal((await f.post('/api/coupons/starter/claim', { fingerprint: 'b'.repeat(64) })).status, 401);
  f.advance(86400000);
  assert.equal((await f.post('/api/translate', { text: 'Education matters.' })).status, 403);
  await f.post('/api/guest/start', { fingerprint: 'c'.repeat(64) });
  const state = await f.request('/api/auth/session');
  assert.equal(state.data.guest.endsAt, guest.data.guest.endsAt);
  assert.equal(state.data.entitlement.hasAccess, false);
  assert.equal(f.aiCalls.length, 0);
});

test('channel codes require login and CSRF, deduplicate by activity, and stack different activities and starter time', async t => {
  const f = await fixture(t);
  f.authService.createCampaign({ id: 'autumn', title: '秋季体验', days: 7, endsAt: f.now() + 10 * 86400000,
    maxRedemptions: 10, codes: [{ code: 'XHS-AUTUMN', channel: '小红书' }, { code: 'DY-AUTUMN', channel: '抖音' }] });
  f.authService.createCampaign({ id: 'welcome', title: '欢迎活动', days: 2, endsAt: f.now() + 10 * 86400000,
    maxRedemptions: 10, codes: [{ code: 'WELCOME-2', channel: '公众号' }] });
  await f.request('/api/auth/session');
  assert.equal((await f.post('/api/coupons/redeem', { code: 'XHS-AUTUMN' })).status, 401);
  await f.register();
  assert.equal((await f.post('/api/coupons/redeem', { code: 'XHS-AUTUMN' }, { headers: { 'X-CSRF-Token': 'forged' } })).status, 403);
  assert.equal((await f.post('/api/coupons/redeem', { code: 'XHS-AUTUMN' }, { headers: { Origin: 'https://attacker.test' } })).status, 403);
  const first = await f.post('/api/coupons/redeem', { code: 'xhs-autumn' });
  assert.equal(first.status, 200);
  assert.equal(first.data.entitlement.expiresAt, f.now() + 7 * 86400000);
  assert.equal(first.data.starter.status, 'available');
  const otherChannel = await f.post('/api/coupons/redeem', { code: 'DY-AUTUMN' });
  assert.ok(otherChannel.status >= 400);
  assert.equal((await f.request('/api/auth/session')).data.entitlement.expiresAt, first.data.entitlement.expiresAt);
  const second = await f.post('/api/coupons/redeem', { code: 'WELCOME-2' });
  assert.equal(second.status, 200);
  assert.equal(second.data.entitlement.expiresAt, f.now() + 9 * 86400000);
  const starter = await f.post('/api/coupons/starter/claim', { fingerprint: 'd'.repeat(64) });
  assert.equal(starter.status, 200);
  assert.equal(starter.data.entitlement.expiresAt, f.now() + 13 * 86400000);
  f.advance(10 * 86400000);
  // The redemption window has ended; already activated time remains usable.
  assert.equal((await f.post('/api/translate', { text: 'Education matters.' })).status, 200);
  assert.equal((await f.request('/api/auth/session')).data.entitlement.expiresAt, starter.data.entitlement.expiresAt);
  assert.equal((await f.post('/api/coupons/redeem', { code: 'WELCOME-2' })).status >= 400, true);
});
