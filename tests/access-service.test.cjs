'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, createHmac } = require('node:crypto');
const DAY = 86400000;
const FP = 'a'.repeat(64);
const PASSWORD = 'Test-password-81';
const BASE = Date.UTC(2026, 9, 16);
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

async function setup(t, options = {}) {
  const { createAuthService } = await import('../auth-service.mjs');
  let clock = BASE, draws = 0;
  const service = createAuthService({ filename: ':memory:', now: () => clock, drawStarterDays: () => { draws++; return 5; }, ...options });
  t.after(() => service.close());
  function client(jar = new Map(), initialCsrf) {
    let csrf = initialCsrf;
    return {
      jar,
      cookie() { return [...jar].map(([key, value]) => `${key}=${value}`).join('; '); },
      async call(pathname, body, overrides = {}) {
        const headers = { cookie: this.cookie(), 'x-csrf-token': csrf, 'user-agent': 'Test browser', ...overrides.headers };
        const captured = new Map(), response = { getHeader: key => captured.get(key), setHeader: (key, value) => captured.set(key, value) };
        const request = { method: body === undefined ? 'GET' : 'POST', headers };
        const result = await service.handle({ request, response, pathname, body, origin: 'https://type.example.test', clientIp: '192.0.2.1', secure: true, ...overrides, request });
        for (const cookie of captured.get('Set-Cookie') || []) {
          const pair = cookie.split(';')[0], separator = pair.indexOf('=');
          jar.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
        csrf = result.csrfToken || csrf;
        return result;
      },
      async init() { return this.call('/api/auth/session'); },
      async register(email = 'student@example.test') { await this.init(); return this.call('/api/auth/register', { nickname: '练习同学', email, password: PASSWORD }); },
      async login(email = 'student@example.test') { await this.init(); return this.call('/api/auth/login', { email, password: PASSWORD }); },
      start(fingerprint = FP, overrides) { return this.call('/api/guest/start', { fingerprint }, overrides); },
      claim(fingerprint = FP, overrides) { return this.call('/api/coupons/starter/claim', { fingerprint }, overrides); },
      redeem(code) { return this.call('/api/coupons/redeem', { code }); },
      access() { return service.requireAccess({ headers: { cookie: this.cookie() } }); },
      clone() { return client(new Map(jar), csrf); },
    };
  }
  function campaign(id = 'launch', patch = {}) {
    return service.createCampaign({ id, title: 'Launch campaign', days: 7, startsAt: clock, endsAt: clock + 30 * DAY, maxRedemptions: 100, codes: [{ code: `${id}-RED`, channel: '小红书' }, { code: `${id}-VIDEO`, channel: '抖音' }], ...patch });
  }
  return { service, client, campaign, now: () => clock, advance(ms) { clock += ms; }, get draws() { return draws; } };
}

test('visiting and registering do not start guest clock; first practice grants exactly 24 hours', async t => {
  const h = await setup(t), c = h.client();
  const visited = await c.init();
  assert.equal(visited.guest.status, 'available');
  assert.equal(visited.guest.startedAt, null);
  assert.equal(visited.entitlement.hasAccess, false);
  await rejects(c.access(), 'GUEST_REQUIRED');
  h.advance(6 * 3600000);
  const registered = await c.register();
  assert.equal(registered.guest.startedAt, null);
  const started = await c.start();
  assert.equal(started.user.email, 'student@example.test');
  assert.equal(started.guest.startedAt, h.now());
  assert.equal(started.entitlement.expiresAt, h.now() + DAY);
  assert.equal(started.entitlement.source, 'guest');
  assert.equal(started.starter.status, 'available');
  await c.access();
  h.advance(DAY - 1);
  await c.access();
  h.advance(1);
  assert.equal((await c.init()).guest.status, 'expired');
  await rejects(c.access(), 'ACCESS_EXPIRED');
});

test('anonymous access works without account and refresh, retries, logout or client time cannot renew it', async t => {
  const h = await setup(t), c = h.client();
  await c.init();
  const first = await c.call('/api/guest/start', { fingerprint: FP, now: 9999999999999, days: 999 });
  assert.equal(first.user, null);
  assert.equal((await c.access()).user, null);
  h.advance(3600000);
  const repeated = await c.start('b'.repeat(64));
  assert.equal(repeated.entitlement.expiresAt, first.entitlement.expiresAt);
  await c.call('/api/auth/logout', {});
  assert.equal((await c.access()).entitlement.expiresAt, first.entitlement.expiresAt);
  h.advance(DAY);
  assert.equal((await c.start()).guest.status, 'expired');
});

test('guest start requires signed browser, CSRF and valid fingerprint; retired trial endpoint is absent', async t => {
  const h = await setup(t), c = h.client();
  await rejects(c.start(), 'CSRF_INVALID');
  await c.init();
  for (const fingerprint of ['', 'x'.repeat(64), 1, null]) await rejects(c.start(fingerprint), 'INVALID_FINGERPRINT');
  await rejects(c.start(FP, { headers: { 'x-csrf-token': '0'.repeat(64) } }), 'CSRF_INVALID');
  await rejects(c.call('/api/trial/claim', { fingerprint: FP }), 'NOT_FOUND');
  await rejects(c.claim(), 'LOGIN_REQUIRED');
});

test('cleared cookies recover the same guest deadline through auxiliary digest without a new day', async t => {
  const h = await setup(t), first = h.client(), cleared = h.client();
  await first.init();
  const original = await first.start();
  h.advance(12 * 3600000);
  await cleared.init();
  const recovered = await cleared.start();
  assert.equal(recovered.entitlement.expiresAt, original.entitlement.expiresAt);
  h.advance(12 * 3600000);
  assert.equal((await cleared.start()).guest.status, 'expired');
});

test('fingerprint alone never denies visitors on another IP or another user agent', async t => {
  const h = await setup(t), first = h.client(), other = h.client(), third = h.client();
  await first.init(); await other.init(); await third.init();
  await first.start(); h.advance(DAY);
  assert.equal((await other.start(FP, { clientIp: '192.0.2.2' })).guest.status, 'active');
  assert.equal((await third.start(FP, { headers: { 'user-agent': 'Other browser' } })).guest.status, 'active');
});

test('starter claim inherits remaining guest time once; logout and a cleared cookie cannot reuse transferred time', async t => {
  const h = await setup(t), c = h.client();
  await c.init(); await c.start();
  h.advance(6 * 3600000);
  await c.register();
  const claimed = await c.claim();
  assert.equal(claimed.lastGrant.inheritedMs, 18 * 3600000);
  assert.equal(claimed.entitlement.expiresAt, h.now() + 5 * DAY + 18 * 3600000);
  assert.equal(h.draws, 1);
  assert.equal((await c.claim('b'.repeat(64))).entitlement.expiresAt, claimed.entitlement.expiresAt);
  assert.equal(h.draws, 1);
  await c.call('/api/auth/logout', {});
  assert.equal((await c.start()).guest.status, 'transferred');
  await rejects(c.access(), 'ACCESS_EXPIRED');
  const cleared = h.client(); await cleared.init();
  assert.equal((await cleared.start()).guest.status, 'transferred');
  await rejects(cleared.access(), 'ACCESS_EXPIRED');
});

test('registering before any practice keeps full guest day; already expired guest contributes zero', async t => {
  const h = await setup(t), early = h.client(), late = h.client();
  await early.register('early@example.test');
  const earlyClaim = await early.claim();
  assert.equal(earlyClaim.lastGrant.inheritedMs, DAY);
  await late.init(); await late.start('b'.repeat(64));
  h.advance(2 * DAY);
  await late.register('late@example.test');
  const lateClaim = await late.claim('b'.repeat(64));
  assert.equal(lateClaim.lastGrant.inheritedMs, 0);
  assert.equal(lateClaim.entitlement.expiresAt, h.now() + 5 * DAY);
});

test('new device cannot transfer another guest day to an account that already claimed', async t => {
  const h = await setup(t), first = h.client(), second = h.client();
  await first.register(); const original = await first.claim();
  await second.init(); await second.start('b'.repeat(64));
  await second.login();
  const repeated = await second.claim('b'.repeat(64));
  assert.equal(repeated.entitlement.expiresAt, original.entitlement.expiresAt);
  assert.equal(repeated.lastGrant, undefined);
  assert.equal(repeated.guest.status, 'active');
  assert.equal(h.draws, 1);
});

test('starter draw supports each 3 through 7 value and rejects invalid draws atomically', async t => {
  for (let days = 3; days <= 7; days++) {
    const h = await setup(t, { drawStarterDays: () => days }), c = h.client();
    await c.register();
    const result = await c.claim();
    assert.equal(result.starter.days, days);
    assert.equal(result.entitlement.expiresAt, h.now() + (days + 1) * DAY);
  }
  let draw = 8;
  const h = await setup(t, { drawStarterDays: () => draw }), c = h.client();
  await c.register();
  await rejects(c.claim(), 'COUPON_UNAVAILABLE');
  assert.equal((await c.init()).starter.status, 'available');
  draw = 3;
  assert.equal((await c.claim()).starter.days, 3);
});

test('starter deadline is exactly seven days after original registration, not last login', async t => {
  const h = await setup(t), first = h.client(), second = h.client();
  await first.register('first@example.test');
  await second.register('second@example.test');
  h.advance(7 * DAY - 1);
  assert.equal((await first.claim()).starter.status, 'claimed');
  h.advance(1);
  await second.login('second@example.test');
  assert.equal((await second.init()).starter.status, 'expired');
  await rejects(second.claim('b'.repeat(64)), 'STARTER_CLAIM_EXPIRED');
  assert.equal(h.draws, 1);
});

test('same browser concurrent accounts share one new-user reward and never reroll the winner', async t => {
  const h = await setup(t), first = h.client();
  await first.register('first@example.test');
  const second = first.clone(); await second.register('second@example.test');
  const results = await Promise.allSettled([first.claim(), second.claim('b'.repeat(64))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STARTER_BROWSER_USED');
  assert.equal(h.draws, 1);
});

test('campaign normalizes codes, attributes channels, restricts same campaign across codes and stacks distinct campaigns', async t => {
  const h = await setup(t), c = h.client();
  h.campaign(); h.campaign('autumn', { days: 3 });
  await c.register();
  const first = await c.redeem('  launch-red  ');
  assert.equal(first.entitlement.expiresAt, h.now() + 7 * DAY);
  await rejects(c.redeem('launch-video'), 'COUPON_ALREADY_REDEEMED');
  const second = await c.redeem('autumn-video');
  assert.equal(second.entitlement.expiresAt, h.now() + 10 * DAY);
  const starter = await c.claim();
  assert.equal(starter.entitlement.expiresAt, h.now() + 16 * DAY);
  const rows = h.service.getCampaigns();
  const launch = rows.find(row => row.id === 'launch');
  assert.equal(launch.redemptions, 1);
  assert.deepEqual(launch.codes.find(row => row.code === 'LAUNCH-RED'), { code: 'LAUNCH-RED', channel: '小红书', redemptions: 1 });
  assert.equal(launch.codes.find(row => row.code === 'LAUNCH-VIDEO').redemptions, 0);
});

test('campaign can be redeemed by old accounts, expired access starts from now and cutoff does not erase granted time', async t => {
  const h = await setup(t), c = h.client();
  await c.register(); await c.claim();
  h.advance(20 * DAY);
  h.campaign('old-users', { days: 3, endsAt: h.now() + 3600000 });
  const redeemed = await c.redeem('old-users-red');
  assert.equal(redeemed.entitlement.expiresAt, h.now() + 3 * DAY);
  h.advance(3600000);
  assert.equal((await c.access()).entitlement.hasAccess, true);
  const other = h.client(); await other.register('other@example.test');
  await rejects(other.redeem('old-users-video'), 'COUPON_EXPIRED');
});

test('campaign time window, disable, total cap and login requirements are enforced without granting time', async t => {
  const h = await setup(t), first = h.client(), second = h.client(), anon = h.client();
  h.campaign('limited', { startsAt: h.now() + DAY, endsAt: h.now() + 2 * DAY, maxRedemptions: 1 });
  await anon.init(); await rejects(anon.redeem('limited-red'), 'LOGIN_REQUIRED');
  await first.register('first@example.test'); await second.register('second@example.test');
  await rejects(first.redeem('limited-red'), 'COUPON_NOT_STARTED');
  h.advance(DAY);
  h.service.setCampaignEnabled('limited', false);
  await rejects(first.redeem('limited-red'), 'COUPON_DISABLED');
  h.service.setCampaignEnabled('limited', true);
  const results = await Promise.allSettled([first.redeem('limited-red'), second.redeem('limited-video')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'COUPON_EXHAUSTED');
  assert.equal(h.service.getCampaigns()[0].redemptions, 1);
});

test('bad codes and campaign configuration fail without exposing SQL or partially creating an activity', async t => {
  const h = await setup(t), c = h.client();
  await c.register();
  for (const code of ['', 'A', null, {}, 'DROP TABLE;', 'X'.repeat(65)]) await rejects(c.redeem(code), 'INVALID_COUPON');
  await rejects(c.redeem('NOT-ISSUED'), 'COUPON_NOT_FOUND');
  for (const patch of [{ days: 0 }, { days: 366 }, { maxRedemptions: 0 }, { codes: [] }, { endsAt: h.now() }, { codes: [{ code: 'ONE', channel: '' }] }]) {
    assert.throws(() => h.campaign('invalid', patch), error => error.code === 'INVALID_CAMPAIGN');
  }
  h.campaign('first');
  assert.throws(() => h.campaign('second', { codes: [{ code: 'FIRST-RED', channel: 'same' }] }), error => error.code === 'CAMPAIGN_CONFLICT');
  assert.throws(() => h.campaign('dupes', { codes: [{ code: 'SAME', channel: 'a' }, { code: 'same', channel: 'b' }] }), error => error.code === 'CAMPAIGN_CONFLICT');
  assert.equal(h.service.getCampaigns().length, 1);
  assert.throws(() => h.service.setCampaignEnabled('missing', false), error => error.code === 'CAMPAIGN_NOT_FOUND');
});

test('legacy SQLite migration preserves users, sessions, paid/trial expiry and consumed browser reward across restarts', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-access-migrate-'));
  let service;
  t.after(async () => { service?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const filename = path.join(directory, 'auth.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(filename), secret = 'legacy-private-secret';
  const token = 't'.repeat(43), device = 'd'.repeat(43), userId = 'legacy-user';
  const mac = value => createHmac('sha256', secret).update(value).digest('hex');
  db.exec(`CREATE TABLE auth_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE auth_users(id TEXT PRIMARY KEY,email TEXT UNIQUE,phone TEXT UNIQUE,password_hash TEXT,email_verified INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,trial_started_at INTEGER,trial_ends_at INTEGER,paid_until INTEGER);
    CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE auth_trial_claims(device_hash TEXT PRIMARY KEY,fingerprint_hash TEXT UNIQUE,user_id TEXT NOT NULL REFERENCES auth_users(id),claimed_at INTEGER NOT NULL);`);
  db.prepare('INSERT INTO auth_settings VALUES (?,?)').run('secret', secret);
  db.prepare('INSERT INTO auth_users(id,email,created_at,trial_started_at,trial_ends_at,paid_until) VALUES (?,?,?,?,?,?)').run(userId, 'legacy@example.test', BASE - DAY, BASE - DAY, BASE + 2 * DAY, BASE + 12 * DAY);
  db.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), userId, BASE - DAY, BASE + 364 * DAY);
  db.prepare('INSERT INTO auth_trial_claims VALUES (?,?,?,?)').run(mac(`device-claim:${device}`), mac(`fingerprint:${JSON.stringify(['192.0.2.1', 'Test browser', FP])}`), userId, BASE - DAY);
  db.close();
  const { createAuthService } = await import('../auth-service.mjs');
  const cookie = `zijian_session=${token}; zijian_device=${device}.${mac(`device:${device}`)}`;
  for (let reopen = 0; reopen < 2; reopen++) {
    service = createAuthService({ filename, now: () => BASE });
    const access = await service.requireAccess({ headers: { cookie } });
    assert.equal(access.entitlement.expiresAt, BASE + 12 * DAY);
    assert.equal(access.entitlement.trialEndsAt, BASE + 2 * DAY);
    const state = await service.handle({ request: { method: 'GET', headers: { cookie } }, response: {}, pathname: '/api/auth/session' });
    assert.equal(state.starter.status, 'legacy_claimed');
    assert.equal(state.guest.status, 'transferred');
    const claimed = await service.handle({ request: { method: 'POST', headers: { cookie, 'x-csrf-token': state.csrfToken } }, response: {}, pathname: '/api/coupons/starter/claim', body: { fingerprint: FP }, clientIp: '192.0.2.1' });
    assert.equal(claimed.entitlement.expiresAt, BASE + 12 * DAY);
    service.close();
  }
});

test('new guest, coupons and channel attribution survive database restart without raw fingerprints or addresses', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-access-persist-'));
  let reopened;
  t.after(async () => { reopened?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const filename = path.join(directory, 'auth.sqlite');
  const h = await setup(t, { filename }), c = h.client();
  await c.init(); const guest = await c.start(); await c.register();
  h.campaign(); const granted = await c.redeem('launch-video');
  h.service.close();
  const { createAuthService } = await import('../auth-service.mjs');
  reopened = createAuthService({ filename, now: h.now });
  assert.equal((await reopened.requireAccess({ headers: { cookie: c.cookie() } })).entitlement.expiresAt, granted.entitlement.expiresAt);
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(filename);
  const record = db.prepare('SELECT * FROM access_guests').get();
  assert.equal(record.ends_at, guest.guest.endsAt);
  assert.match(record.fingerprint_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(record.fingerprint_hash, FP);
  assert.ok(!JSON.stringify(record).includes('192.0.2.1'));
  db.close();
  assert.equal(reopened.getCampaigns()[0].codes.find(code => code.code === 'LAUNCH-VIDEO').redemptions, 1);
});

test('independent SQLite connections racing the last campaign redemption cannot oversubscribe it', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-access-race-'));
  const filename = path.join(directory, 'auth.sqlite');
  const h = await setup(t, { filename }), first = h.client(), second = h.client();
  t.after(async () => { h.service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  h.campaign('last-one', { maxRedemptions: 1 });
  await first.register('first@example.test'); await second.register('second@example.test');
  const states = await Promise.all([first.init(), second.init()]);
  const { Worker } = require('node:worker_threads');
  const { pathToFileURL } = require('node:url');
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../auth-service.mjs')).href;
  const shared = new SharedArrayBuffer(4), barrier = new Int32Array(shared);
  function race(c, csrfToken, code) {
    return new Promise((resolve, reject) => {
      let result;
      const worker = new Worker(`
        const { workerData: data, parentPort } = require('node:worker_threads');
        (async () => {
          const { createAuthService } = await import(data.moduleUrl);
          const service = createAuthService({ filename: data.filename, now: () => data.now });
          const barrier = new Int32Array(data.shared);
          Atomics.add(barrier, 0, 1); Atomics.notify(barrier, 0);
          while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 5000);
          try {
            const state = await service.handle({ request: { method: 'POST', headers: { cookie: data.cookie, 'x-csrf-token': data.csrfToken } }, response: {}, pathname: '/api/coupons/redeem', body: { code: data.code }, clientIp: '192.0.2.1' });
            parentPort.postMessage({ ok: true, expiresAt: state.entitlement.expiresAt });
          } catch (error) { parentPort.postMessage({ ok: false, code: error.code }); }
          finally { service.close(); }
        })().catch(error => { throw error; });
      `, { eval: true, workerData: { moduleUrl, filename, now: h.now(), shared, cookie: c.cookie(), csrfToken, code } });
      worker.on('message', value => { result = value; });
      worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve(result) : reject(new Error(`Worker failed: ${code}`)));
    });
  }
  const results = await Promise.all([race(first, states[0].csrfToken, 'last-one-red'), race(second, states[1].csrfToken, 'last-one-video')]);
  assert.equal(Atomics.load(barrier, 0), 2);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).code, 'COUPON_EXHAUSTED');
  assert.equal(h.service.getCampaigns()[0].redemptions, 1);
});
