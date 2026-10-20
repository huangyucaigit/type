'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');

const DAY = 86400000;
const BASE = Date.UTC(2026, 9, 16);
const PASSWORD = 'Invite-password-27';
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

async function setup(t, options = {}) {
  const { createAuthService } = await import('../auth-service.mjs');
  let clock = BASE, draws = 0, sequence = 0, service;
  const configuration = { filename: ':memory:', now: () => clock, drawStarterDays: () => 3,
    drawReferralDays: () => { draws++; return 5; }, ...options };
  const open = () => { service = createAuthService(configuration); };
  open();
  t.after(() => service.close());
  function client({ jar = new Map(), initialCsrf, browser = `Browser ${++sequence}`, fingerprint = String(sequence).padStart(64, '0') } = {}) {
    let csrf = initialCsrf;
    return {
      jar, browser, fingerprint,
      get csrf() { return csrf; },
      cookie() { return [...jar].map(([key, value]) => `${key}=${value}`).join('; '); },
      async call(pathname, body, overrides = {}) {
        const headers = { cookie: this.cookie(), 'x-csrf-token': csrf, 'user-agent': browser, ...overrides.headers };
        const captured = new Map(), response = { getHeader: key => captured.get(key), setHeader: (key, value) => captured.set(key, value) };
        const result = await service.handle({ request: { method: body === undefined ? 'GET' : 'POST', headers }, response,
          pathname, body, origin: 'https://type.example.test', clientIp: '192.0.2.1', secure: true, ...overrides });
        for (const item of captured.get('Set-Cookie') || []) {
          const pair = item.split(';')[0], separator = pair.indexOf('=');
          jar.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
        csrf = result.csrfToken || csrf;
        return result;
      },
      init() { return this.call('/api/auth/session'); },
      register(email = `${browser.replace(/\W/g, '').toLowerCase()}@example.test`, extra = {}) { return this.call('/api/auth/register', { nickname: '练习同学', email, password: PASSWORD, fingerprint, ...extra }); },
      login(email) { return this.call('/api/auth/login', { email, password: PASSWORD, fingerprint }); },
      logout() { return this.call('/api/auth/logout', {}); },
      prepare() { return this.call('/api/referrals/prepare', { fingerprint }); },
      visit(code, extra = {}) { return this.call('/api/referrals/visit', { code, fingerprint, ...extra }); },
      claim() { return this.call('/api/coupons/starter/claim', { fingerprint }); },
      clearCookies() { return client({ browser, fingerprint }); },
    };
  }
  return { get service() { return service; }, client, get draws() { return draws; }, now: () => clock,
    advance(ms) { clock += ms; }, reopen() { service.close(); open(); } };
}

async function diskSetup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-referrals-'));
  const filename = path.join(directory, 'auth.sqlite');
  const h = await setup(t, { filename, ...options });
  t.after(async () => { h.service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  return { h, filename };
}

async function inviter(h, email = 'owner@example.test') {
  const owner = h.client();
  await owner.init();
  const registered = await owner.register(email);
  await owner.prepare();
  return { owner, code: registered.referral.code, user: registered.user };
}

async function invite(h, code, email) {
  const visitor = h.client();
  await visitor.init();
  await visitor.visit(code);
  const registered = await visitor.register(email);
  return { visitor, registered };
}

test('opaque referral code is stable per account and anonymous visits reveal no inviter identity or grant time', async t => {
  const h = await setup(t), anonymous = h.client();
  assert.deepEqual((await anonymous.init()).referral, { code: null, rewardedCount: 0, rewardLimit: 3, totalDays: 0, remaining: 3 });
  const { owner, code, user } = await inviter(h);
  assert.match(code, /^[A-Za-z0-9_-]{24}$/);
  assert.equal((await owner.init()).referral.code, code);
  assert.ok(!code.includes(user.id));
  const visited = await anonymous.visit(code, { inviterId: 'forged', days: 999 });
  assert.deepEqual(visited.referralVisit, { status: 'recorded' });
  assert.equal(visited.referral.code, null);
  assert.equal(visited.guest.status, 'available');
  assert.equal(visited.entitlement.hasAccess, false);
  assert.ok(!JSON.stringify(visited).includes(user.id));
  assert.ok(!JSON.stringify(visited).includes(user.email));
  assert.equal(h.draws, 0);
});

test('new registration rewards inviter once, preserves invitee starter coupon and stacks with active account time', async t => {
  const h = await setup(t), { owner, code } = await inviter(h);
  const started = await owner.claim();
  assert.equal(started.entitlement.accountEndsAt, BASE + 4 * DAY);
  h.advance(DAY);
  const { visitor, registered } = await invite(h, code, 'friend@example.test');
  assert.equal(registered.entitlement.accountEndsAt, null);
  assert.equal(registered.starter.status, 'available');
  const rewarded = await owner.init();
  assert.deepEqual(rewarded.referral, { code, rewardedCount: 1, rewardLimit: 3, totalDays: 5, remaining: 2 });
  assert.equal(rewarded.entitlement.accountEndsAt, BASE + 9 * DAY);
  assert.equal((await visitor.claim()).lastGrant.days, 3);
  await visitor.logout(); await visitor.login('friend@example.test');
  assert.equal((await owner.init()).entitlement.accountEndsAt, rewarded.entitlement.accountEndsAt);
  assert.equal(h.draws, 1);
});

test('invitation reward starts at now when old entitlement has expired', async t => {
  const h = await setup(t), { owner, code } = await inviter(h);
  await owner.claim(); h.advance(10 * DAY);
  await invite(h, code, 'after-expiry@example.test');
  assert.equal((await owner.init()).entitlement.accountEndsAt, h.now() + 5 * DAY);
});

test('maximum three successful friends earn rewards; later friends can still register and claim starter coupons', async t => {
  const h = await setup(t), { owner, code } = await inviter(h);
  for (let index = 0; index < 4; index++) {
    const { visitor, registered } = await invite(h, code, `cap-${index}@example.test`);
    assert.ok(registered.user);
    assert.equal((await visitor.claim()).lastGrant.days, 3);
  }
  const rewarded = await owner.init();
  assert.equal(rewarded.referral.rewardedCount, 3);
  assert.equal(rewarded.referral.totalDays, 15);
  assert.equal(rewarded.referral.remaining, 0);
  assert.equal(rewarded.entitlement.accountEndsAt, BASE + 15 * DAY);
  assert.equal(h.draws, 3);
});

test('first valid inviter sticks for 30 days without extending the attribution deadline', async t => {
  const h = await setup(t), first = await inviter(h, 'first@example.test'), second = await inviter(h, 'second@example.test');
  const visitor = h.client(); await visitor.init(); await visitor.visit(first.code);
  h.advance(29 * DAY);
  assert.equal((await visitor.visit(second.code)).referralVisit.status, 'existing');
  h.advance(DAY);
  await visitor.register('expired-touch@example.test');
  assert.equal((await first.owner.init()).referral.rewardedCount, 0);
  assert.equal((await second.owner.init()).referral.rewardedCount, 0);
  const fresh = h.client(); await fresh.init(); await fresh.visit(first.code); h.advance(30 * DAY);
  assert.equal((await fresh.visit(second.code)).referralVisit.status, 'recorded');
  await fresh.register('new-touch@example.test');
  assert.equal((await first.owner.init()).referral.rewardedCount, 0);
  assert.equal((await second.owner.init()).referral.rewardedCount, 1);
});

test('self browser, signed accounts and existing account login never earn invitation rewards', async t => {
  const h = await setup(t), { owner, code } = await inviter(h), existing = h.client();
  assert.equal((await owner.visit(code)).referralVisit.status, 'ignored');
  await owner.logout();
  assert.equal((await owner.visit(code)).referralVisit.status, 'ignored');
  await owner.register('same-owner-browser@example.test');
  await existing.init(); await existing.register('already@example.test');
  const signed = await existing.visit(code);
  assert.equal(signed.referralVisit.status, 'ignored');
  const loginBrowser = h.client(); await loginBrowser.init(); await loginBrowser.visit(code);
  await loginBrowser.login('already@example.test'); await loginBrowser.logout();
  assert.equal((await loginBrowser.visit(code)).referralVisit.status, 'ignored');
  await loginBrowser.register('extra@example.test');
  const account = h.client(); await account.init(); await account.login('owner@example.test');
  assert.equal((await account.init()).referral.rewardedCount, 0);
  assert.equal(h.draws, 0);
});

test('same signed device ignores changed fingerprint and cannot contribute two registrations', async t => {
  const h = await setup(t), { owner, code } = await inviter(h);
  const { visitor } = await invite(h, code, 'once@example.test');
  await visitor.logout();
  assert.equal((await visitor.visit(code, { fingerprint: 'f'.repeat(64) })).referralVisit.status, 'ignored');
  await visitor.register('twice@example.test', { fingerprint: 'e'.repeat(64) });
  assert.equal((await owner.init()).referral.rewardedCount, 1);
  assert.equal(h.draws, 1);
});

test('cleared cookies recover attribution for registration and preserve browser deduplication after reward', async t => {
  const h = await setup(t), { owner, code } = await inviter(h), visitor = h.client();
  await visitor.init(); await visitor.visit(code);
  const recovered = visitor.clearCookies(); await recovered.init();
  await recovered.register('recovered@example.test');
  assert.equal((await owner.init()).referral.rewardedCount, 1);
  const repeat = visitor.clearCookies(); await repeat.init();
  assert.equal((await repeat.visit(code)).referralVisit.status, 'ignored');
  await repeat.register('repeated@example.test');
  assert.equal((await owner.init()).referral.rewardedCount, 1);
  const selfRecovered = owner.clearCookies(); await selfRecovered.init();
  assert.equal((await selfRecovered.visit(code)).referralVisit.status, 'ignored');
  await selfRecovered.register('self-cleared@example.test');
  assert.equal((await owner.init()).referral.rewardedCount, 1);
});

test('cookie based attribution remains compatible with registration callers that omit fingerprint', async t => {
  const h = await setup(t), { owner, code } = await inviter(h), visitor = h.client();
  await visitor.init(); await visitor.visit(code);
  await visitor.call('/api/auth/register', { nickname: '练习同学', email: 'old-client@example.test', password: PASSWORD });
  assert.equal((await owner.init()).referral.rewardedCount, 1);
});

test('invalid and duplicate registrations do not consume attribution or award extra time', async t => {
  const h = await setup(t), { owner, code } = await inviter(h), visitor = h.client();
  await visitor.init(); await visitor.visit(code);
  await rejects(visitor.register('invalid'), 'INVALID_EMAIL');
  await rejects(visitor.register('owner@example.test'), 'EMAIL_IN_USE');
  await rejects(visitor.register('invalid-fp@example.test', { fingerprint: 'bad' }), 'INVALID_FINGERPRINT');
  assert.equal((await owner.init()).referral.rewardedCount, 0);
  await visitor.register('valid@example.test');
  await rejects(visitor.register('valid@example.test'), 'EMAIL_IN_USE');
  assert.equal((await owner.init()).referral.rewardedCount, 1);
});

test('invalid reward generator atomically rolls back registration, attribution consumption and inviter duration', async t => {
  let generated = 8;
  const h = await setup(t, { drawReferralDays: () => generated }), { owner, code } = await inviter(h), visitor = h.client();
  await visitor.init(); await visitor.visit(code);
  await rejects(visitor.register('retry@example.test'), 'REFERRAL_UNAVAILABLE');
  assert.equal((await visitor.init()).user, null);
  assert.equal((await owner.init()).referral.rewardedCount, 0);
  generated = 7;
  await visitor.register('retry@example.test');
  assert.equal((await owner.init()).referral.totalDays, 7);
});

test('all five random day outcomes are supported independently of starter draw', async t => {
  for (const days of [3, 4, 5, 6, 7]) {
    const h = await setup(t, { drawReferralDays: () => days }), { owner, code } = await inviter(h);
    const { visitor } = await invite(h, code, `days-${days}@example.test`);
    assert.equal((await owner.init()).referral.totalDays, days);
    assert.equal((await visitor.claim()).lastGrant.days, 3);
  }
});

test('referral visit validates signed cookie, CSRF, method, opaque code and fingerprint', async t => {
  const h = await setup(t), { code } = await inviter(h), visitor = h.client();
  await rejects(visitor.visit(code), 'CSRF_INVALID');
  await visitor.init();
  await rejects(visitor.call('/api/referrals/visit'), 'METHOD_NOT_ALLOWED');
  await rejects(visitor.call('/api/referrals/visit', { code, fingerprint: visitor.fingerprint }, { headers: { 'x-csrf-token': 'forged' } }), 'CSRF_INVALID');
  for (const bad of ['', 'a'.repeat(23), 'a'.repeat(25), {}, null, 123, '含有汉字'.repeat(6)]) await rejects(visitor.visit(bad), 'INVALID_REFERRAL');
  await rejects(visitor.visit('x'.repeat(24)), 'REFERRAL_NOT_FOUND');
  for (const fingerprint of ['', 'x'.repeat(64), {}, null, 123]) await rejects(visitor.visit(code, { fingerprint }), 'INVALID_FINGERPRINT');
  await rejects(visitor.prepare(), 'LOGIN_REQUIRED');
  assert.equal((await visitor.visit(code)).referralVisit.status, 'recorded');
  assert.equal(h.draws, 0);
});

test('SMS creates one referral reward for a new account and never for existing SMS login', async t => {
  let sent;
  const h = await setup(t, { providers: { status: { sms: true }, sendSms: async input => { sent = input; } } });
  const { owner, code } = await inviter(h), visitor = h.client();
  await visitor.init(); await visitor.visit(code);
  await visitor.call('/api/auth/sms/send', { phone: '13300000091' });
  await visitor.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13300000091', code: sent.code, fingerprint: visitor.fingerprint });
  assert.equal((await owner.init()).referral.rewardedCount, 1);
  const existing = h.client(); await existing.init(); await existing.visit(code); h.advance(60000);
  await existing.call('/api/auth/sms/send', { phone: '13300000091' });
  await existing.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13300000091', code: sent.code, fingerprint: existing.fingerprint });
  assert.equal((await owner.init()).referral.rewardedCount, 1);
});

test('pending attributions, referral code, rewards and browser deduplication survive database restart', async t => {
  const { h, filename } = await diskSetup(t), { owner, code } = await inviter(h), visitor = h.client();
  await visitor.init(); await visitor.visit(code); h.reopen();
  assert.equal((await owner.init()).referral.code, code);
  await visitor.register('durable@example.test'); h.reopen();
  assert.equal((await owner.init()).referral.rewardedCount, 1);
  const cleared = visitor.clearCookies(); await cleared.init();
  assert.equal((await cleared.visit(code)).referralVisit.status, 'ignored');
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(filename);
  const browserRows = db.prepare('SELECT * FROM access_referral_accounts').all();
  assert.ok(browserRows.length >= 2);
  assert.ok(!JSON.stringify(browserRows).includes('192.0.2.1'));
  assert.ok(!JSON.stringify(browserRows).includes('Browser '));
  assert.equal(db.prepare('SELECT count(*) AS count FROM access_referral_rewards').get().count, 1);
  db.close();
});

test('concurrent registrations against separate SQLite connections cannot exceed the three reward cap', async t => {
  const { h, filename } = await diskSetup(t), { owner, code } = await inviter(h);
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../auth-service.mjs')).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createAuthService } = await import(workerData.moduleUrl);
      const service = createAuthService({ filename: workerData.filename, now: () => workerData.now, drawReferralDays: () => 3 });
      const jar = new Map(); let csrf;
      async function call(pathname, body) {
        const captured = new Map();
        const state = await service.handle({ request: { method: body === undefined ? 'GET' : 'POST', headers: {
          cookie: [...jar].map(([k,v]) => k+'='+v).join('; '), 'x-csrf-token': csrf, 'user-agent': 'Concurrent '+workerData.index } },
          response: { getHeader: key => captured.get(key), setHeader: (key,value) => captured.set(key,value) },
          pathname, body, clientIp: '192.0.2.40', origin: 'https://type.example.test' });
        for (const cookie of captured.get('Set-Cookie') || []) { const pair=cookie.split(';')[0], at=pair.indexOf('='); jar.set(pair.slice(0,at),pair.slice(at+1)); }
        csrf=state.csrfToken || csrf; return state;
      }
      try {
        const fingerprint = String(workerData.index).padStart(64,'0');
        await call('/api/auth/session');
        await call('/api/referrals/visit', { code: workerData.code, fingerprint });
        const registered = await call('/api/auth/register', { nickname: '练习同学', email: 'concurrent-'+workerData.index+'@example.test', password: 'Invite-password-27', fingerprint });
        parentPort.postMessage({ id: registered.user.id });
      } finally { service.close(); }
    })().catch(error => { parentPort.postMessage({ error: error.stack }); process.exitCode=1; });
  `;
  const registered = await Promise.all(Array.from({ length: 5 }, (_, index) => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { moduleUrl, filename, code, now: BASE, index: index + 1 } });
    worker.once('message', result => result.error ? reject(new Error(result.error)) : resolve(result));
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`Worker exit ${code}`)); });
  })));
  assert.equal(new Set(registered.map(result => result.id)).size, 5);
  const rewarded = await owner.init();
  assert.equal(rewarded.referral.rewardedCount, 3);
  assert.equal(rewarded.referral.totalDays, 9);
  assert.equal(rewarded.entitlement.accountEndsAt, BASE + 9 * DAY);
});
