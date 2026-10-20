'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestAuth } = require('./auth-fixture.cjs');

const DAY = 86400000;
const PASSWORD = 'Referral-password-8024';

async function fixture(t, options = {}) {
  const { createServer } = await import('../translation-server.mjs');
  let timestamp = Date.UTC(2026, 9, 16), clientCount = 0, draws = 0;
  const messages = [], sms = [];
  const authService = await createTestAuth({ now: () => timestamp,
    drawReferralDays: () => { draws++; return 5; }, providers: {
      status: { sms: true, email: true },
      sendSms: async value => { sms.push(value); },
      sendResetEmail: async value => { messages.push(value); },
      sendBindEmail: async value => { messages.push(value); },
    },
  });
  const server = createServer({ authService,
    translate: async text => ({ translation: text }), analyze: async () => ({ analysis: {} }),
    review: async () => ({ review: {} }), titleArticle: async () => ({ title: '练习范文' }),
    ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); authService.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  function client(identity) {
    const index = ++clientCount;
    const fingerprint = identity?.fingerprint || index.toString(16).padStart(64, '0');
    const userAgent = identity?.userAgent || `Referral HTTP browser ${index}`;
    const cookies = new Map();
    let csrfToken;
    function request(url, { method = 'GET', body, headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const outgoing = {
          Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          'User-Agent': userAgent,
          ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) } : {}),
          ...headers,
        };
        for (const key of Object.keys(outgoing)) if (outgoing[key] === null) delete outgoing[key];
        const req = http.request(`${origin}${url}`, { method, headers: outgoing }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            for (const item of response.headers['set-cookie'] || []) {
              const pair = item.split(';')[0], equals = pair.indexOf('=');
              cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
            }
            const text = Buffer.concat(chunks).toString();
            let data; try { data = JSON.parse(text); } catch {}
            if (data?.csrfToken) csrfToken = data.csrfToken;
            resolve({ status: response.statusCode, headers: response.headers, data, text });
          });
        });
        req.on('error', reject);
        req.end(body === undefined ? '' : JSON.stringify(body));
      });
    }
    const post = (url, body = {}, extra = {}) => request(url, { method: 'POST', body, ...extra });
    return { fingerprint, userAgent, request, post,
      session: () => request('/api/auth/session'),
      register: (email, extra = {}) => post('/api/auth/register', { nickname: '练习同学', email, password: PASSWORD, fingerprint, ...extra }),
      login: email => post('/api/auth/login', { email, password: PASSWORD, fingerprint }),
      visit: (code, extra = {}) => post('/api/referrals/visit', { code, fingerprint, ...extra }),
      prepare: () => post('/api/referrals/prepare', { fingerprint }),
    };
  }
  async function inviter(email = 'inviter@example.test') {
    const c = client();
    await c.session();
    const registered = await c.register(email);
    assert.equal(registered.status, 200);
    const prepared = await c.prepare();
    assert.equal(prepared.status, 200);
    assert.match(prepared.data.referral.code, /^[A-Za-z0-9_-]{24}$/);
    return { c, code: prepared.data.referral.code, id: registered.data.user.id, email };
  }
  return { client, inviter, authService, sms, messages, now: () => timestamp,
    advance: ms => { timestamp += ms; }, get draws() { return draws; } };
}

test('referral HTTP routes require the correct method, same origin and CSRF, while visits allow anonymous users', async t => {
  const f = await fixture(t), owner = await f.inviter(), visitor = f.client();
  const anonymous = await visitor.session();
  assert.deepEqual(anonymous.data.referral, { code: null, rewardedCount: 0, rewardLimit: 3, totalDays: 0, remaining: 3 });
  assert.equal((await visitor.prepare()).status, 401);
  const body = { code: owner.code, fingerprint: visitor.fingerprint };
  const post = headers => visitor.post('/api/referrals/visit', body, { headers });
  assert.equal((await post({ 'X-CSRF-Token': 'forged' })).status, 403);
  assert.equal((await post({ Origin: 'https://attacker.example.test' })).status, 403);
  assert.equal((await post({ Origin: null })).status, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415);
  const noSession = f.client();
  assert.equal((await noSession.visit(owner.code)).status, 403);
  for (const route of ['/api/referrals/visit', '/api/referrals/prepare']) assert.equal((await visitor.request(route)).status, 405);
  assert.equal((await visitor.visit('bad')).data.code, 'INVALID_REFERRAL');
  const unknown = `${owner.code.slice(0, -1)}${owner.code.endsWith('a') ? 'b' : 'a'}`;
  assert.equal((await visitor.visit(unknown)).data.code, 'REFERRAL_NOT_FOUND');
  assert.equal((await visitor.post('/api/referrals/visit', { code: owner.code })).data.code, 'INVALID_FINGERPRINT');
  const visit = await visitor.visit(owner.code);
  assert.equal(visit.status, 200);
  assert.equal(visit.data.referralVisit.status, 'recorded');
  assert.equal(visit.headers['cache-control'], 'no-store');
  assert.equal(visit.data.user, null);
  assert.equal(visit.data.referral.code, null);
  assert.equal(visit.data.guest.startedAt, null);
  assert.equal(visit.data.entitlement.hasAccess, false);
  for (const privateValue of [owner.email, owner.id, owner.code, PASSWORD]) assert.ok(!visit.text.includes(privateValue));
  for (const route of ['/.env', '/auth-service.mjs', '/.data/auth.sqlite', '/AliyunSMSAccessKey.csv']) assert.equal((await visitor.request(route)).status, 404);
  assert.equal(f.sms.length, 0);
  assert.equal(f.messages.length, 0);
});

test('referral routes retain the public HTTPS requirement and do not trust forwarded TLS without configuration', async t => {
  const publicOrigins = ['http://account.example.test', 'https://account.example.test'];
  const f = await fixture(t, { publicOrigins, trustProxy: true }), c = f.client();
  const plain = { Host: 'account.example.test', Origin: 'http://account.example.test' };
  for (const route of ['/api/referrals/visit', '/api/referrals/prepare']) {
    assert.equal((await c.post(route, {}, { headers: plain })).status, 426);
  }
  const encrypted = { Host: 'account.example.test', Origin: 'https://account.example.test', 'X-Forwarded-Proto': 'https' };
  const session = await c.request('/api/auth/session', { headers: encrypted });
  assert.equal(session.status, 200);
  assert.ok(session.headers['set-cookie'].every(value => /; Secure/.test(value)));
  const untrusted = await fixture(t, { publicOrigins }), outsider = untrusted.client();
  assert.equal((await outsider.post('/api/referrals/visit', {}, { headers: encrypted })).status, 426);
});

test('a newly invited registration rewards only its inviter and leaves the invitee starter coupon independent', async t => {
  const f = await fixture(t), owner = await f.inviter(), friend = f.client();
  await friend.session();
  await friend.visit(owner.code, { days: 999, rewardLimit: 999 });
  assert.equal((await owner.c.session()).data.referral.rewardedCount, 0);
  // The signed browser Cookie preserves attribution even for older clients
  // which do not repeat the fingerprint in their registration request.
  const registered = await friend.post('/api/auth/register', { nickname: '练习同学', email: 'friend@example.test', password: PASSWORD });
  assert.equal(registered.status, 200);
  assert.equal(registered.data.user.emailVerified, false);
  assert.equal(registered.data.starter.status, 'available');
  assert.equal(registered.data.entitlement.accountEndsAt, null);
  assert.equal(registered.data.referral.rewardedCount, 0);
  assert.notEqual(registered.data.referral.code, owner.code);
  assert.ok(!registered.text.includes(owner.email));
  const rewarded = await owner.c.session();
  assert.deepEqual(rewarded.data.referral, { code: owner.code, rewardedCount: 1, rewardLimit: 3, totalDays: 5, remaining: 2 });
  assert.equal(rewarded.data.entitlement.accountEndsAt, f.now() + 5 * DAY);
  assert.equal(rewarded.data.starter.status, 'available');
  const starter = await friend.post('/api/coupons/starter/claim', { fingerprint: friend.fingerprint });
  assert.equal(starter.status, 200);
  assert.equal(starter.data.lastGrant.days, 3);
  assert.equal(starter.data.entitlement.accountEndsAt, f.now() + 4 * DAY);
  assert.equal((await owner.c.session()).data.entitlement.accountEndsAt, rewarded.data.entitlement.accountEndsAt);
  assert.equal(f.draws, 1);
  assert.equal(f.sms.length, 0);
  assert.equal(f.messages.length, 0);
});

test('three lifetime invitation rewards stack after existing access and a fourth valid signup receives no further reward', async t => {
  const f = await fixture(t), owner = await f.inviter();
  const starter = await owner.c.post('/api/coupons/starter/claim', { fingerprint: owner.c.fingerprint });
  assert.equal(starter.status, 200);
  const initialExpiry = starter.data.entitlement.accountEndsAt;
  for (let index = 0; index < 4; index++) {
    const friend = f.client();
    await friend.session();
    assert.equal((await friend.visit(owner.code)).status, 200);
    const registered = await friend.register(`invited-${index}@example.test`);
    assert.equal(registered.status, 200);
    assert.equal(registered.data.starter.status, 'available');
    const current = (await owner.c.session()).data;
    const count = Math.min(index + 1, 3);
    assert.equal(current.referral.rewardedCount, count);
    assert.equal(current.referral.remaining, 3 - count);
    assert.equal(current.referral.totalDays, count * 5);
    assert.equal(current.entitlement.accountEndsAt, initialExpiry + count * 5 * DAY);
  }
  assert.equal(f.draws, 3);
  f.advance(90 * DAY);
  assert.equal((await owner.c.session()).data.referral.rewardedCount, 3);
  assert.equal((await owner.c.session()).data.referral.remaining, 0);
});

test('one browser contributes once, including after logout, a different email and cleared cookies', async t => {
  const f = await fixture(t), owner = await f.inviter(), friend = f.client();
  await friend.session(); await friend.visit(owner.code);
  assert.equal((await friend.register('one@example.test')).status, 200);
  await friend.post('/api/auth/logout');
  assert.equal((await friend.visit(owner.code)).data.referralVisit.status, 'ignored');
  assert.equal((await friend.register('two@example.test')).status, 200);
  const cleared = f.client(friend);
  await cleared.session();
  assert.equal((await cleared.visit(owner.code)).data.referralVisit.status, 'ignored');
  assert.equal((await cleared.register('three@example.test')).status, 200);
  const ownerState = (await owner.c.session()).data;
  assert.equal(ownerState.referral.rewardedCount, 1);
  assert.equal(ownerState.entitlement.accountEndsAt, f.now() + 5 * DAY);
  assert.equal(f.draws, 1);
});

test('sharing from a registered browser cannot reward itself after switching emails or clearing cookies', async t => {
  const f = await fixture(t), owner = await f.inviter();
  assert.equal((await owner.c.visit(owner.code)).data.referralVisit.status, 'ignored');
  await owner.c.post('/api/auth/logout');
  assert.equal((await owner.c.visit(owner.code)).data.referralVisit.status, 'ignored');
  assert.equal((await owner.c.register('self-other@example.test')).status, 200);
  const cleared = f.client(owner.c);
  await cleared.session();
  assert.equal((await cleared.visit(owner.code)).data.referralVisit.status, 'ignored');
  assert.equal((await cleared.register('self-cleared@example.test')).status, 200);
  const original = f.client(); await original.session();
  assert.equal((await original.login(owner.email)).status, 200);
  assert.equal((await original.session()).data.referral.rewardedCount, 0);
  assert.equal(f.draws, 0);
});

test('an existing account login consumes pending attribution without paying or reusing it for a later signup', async t => {
  const f = await fixture(t), owner = await f.inviter(), existing = f.client();
  await existing.session(); await existing.register('existing@example.test');
  const freshBrowser = f.client(); await freshBrowser.session();
  assert.equal((await freshBrowser.visit(owner.code)).data.referralVisit.status, 'recorded');
  assert.equal((await freshBrowser.login('existing@example.test')).status, 200);
  await freshBrowser.post('/api/auth/logout');
  assert.equal((await freshBrowser.register('replacement@example.test')).status, 200);
  assert.equal((await owner.c.session()).data.referral.rewardedCount, 0);
  assert.equal(f.draws, 0);
});

test('first valid attribution survives another card and invalid registrations, but expires after 30 days', async t => {
  const f = await fixture(t), first = await f.inviter('first@example.test'), second = await f.inviter('second@example.test');
  const friend = f.client(); await friend.session();
  assert.equal((await friend.visit(first.code)).data.referralVisit.status, 'recorded');
  assert.equal((await friend.visit(second.code)).data.referralVisit.status, 'existing');
  assert.equal((await friend.register('friend@example.test', { password: 'short' })).status, 400);
  const registered = await friend.register('friend@example.test');
  assert.equal(registered.status, 200);
  assert.equal((await first.c.session()).data.referral.rewardedCount, 1);
  assert.equal((await second.c.session()).data.referral.rewardedCount, 0);
  const late = f.client(); await late.session(); await late.visit(first.code);
  f.advance(30 * DAY);
  assert.equal((await late.register('late@example.test')).status, 200);
  assert.equal((await first.c.session()).data.referral.rewardedCount, 1);
  assert.equal(f.draws, 1);
});

test('concurrent duplicate registration cannot duplicate invitation rewards', async t => {
  const f = await fixture(t), owner = await f.inviter(), friend = f.client();
  await friend.session(); await friend.visit(owner.code);
  const results = await Promise.all([friend.register('race@example.test'), friend.register('race@example.test')]);
  assert.deepEqual(results.map(value => value.status).sort(), [200, 409]);
  assert.equal((await owner.c.session()).data.referral.rewardedCount, 1);
  assert.equal(f.draws, 1);
});
