'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PASSWORD = 'Sensible-password-79';
const DAY = 86400000;
let modules;
async function setup(t, options = {}) {
  modules ||= import('../auth-service.mjs');
  const { createAuthService } = await modules;
  let clock = Date.UTC(2026, 9, 16);
  const sms = [], resets = [], binds = [];
  const providers = {
    status: { sms: true, email: true },
    sendSms: async input => { sms.push(input); },
    sendResetEmail: async input => { resets.push(input); },
    sendBindEmail: async input => { binds.push(input); },
    ...options.providers,
  };
  const service = createAuthService({ filename: ':memory:', now: () => clock, drawStarterDays: () => 5, ...options, providers });
  t.after(() => service.close());
  function client(initial = {}) {
    const jar = new Map(initial.cookies || []);
    let csrfToken = initial.csrfToken;
    return {
      jar, get csrfToken() { return csrfToken; },
      cookie() { return [...jar].map(([key, value]) => `${key}=${value}`).join('; '); },
      async call(pathname, body, overrides = {}) {
        const headers = { cookie: this.cookie(), 'x-csrf-token': csrfToken, ...overrides.headers };
        const captured = new Map();
        const response = { getHeader: key => captured.get(key), setHeader: (key, value) => captured.set(key, value) };
        const request = { method: body === undefined ? 'GET' : 'POST', headers };
        const value = await service.handle({ request, response, pathname, body, origin: 'https://type.example.test', clientIp: '127.0.0.1', secure: true, ...overrides, request });
        for (const cookie of captured.get('Set-Cookie') || []) {
          const pair = cookie.split(';')[0], separator = pair.indexOf('=');
          jar.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
        if (value.csrfToken) csrfToken = value.csrfToken;
        this.lastSetCookies = captured.get('Set-Cookie') || [];
        return value;
      },
      access() { return service.requireAccess({ headers: { cookie: this.cookie() } }); },
      async register(email = 'student@example.test') {
        await this.call('/api/auth/session');
        return this.call('/api/auth/register', { nickname: '练习同学', email, password: PASSWORD });
      },
      async login(email = 'student@example.test', password = PASSWORD) {
        await this.call('/api/auth/session');
        return this.call('/api/auth/login', { email, password });
      },
      clone() { return client({ cookies: [...jar], csrfToken }); },
    };
  }
  return { service, client, sms, resets, binds, now: () => clock, advance(ms) { clock += ms; } };
}
const rejects = (promise, code, status) => assert.rejects(promise, error => error.code === code && (!status || error.status === status));
const tokenOf = entry => new URL(entry.url).searchParams.values().next().value;

test('a possibly delivered SMS stays usable after timeout and resend cooldown prevents an immediate duplicate', async t => {
  const { createAuthProviders } = await import('../auth-providers.mjs');
  let capturedCode, sends = 0;
  const provider = createAuthProviders({ env: { ALIYUN_ACCESS_KEY_ID:'test-id', ALIYUN_ACCESS_KEY_SECRET:'test-secret', ALIYUN_SMS_SIGN_NAME:'长沙松鼠信息火星叔叔', ALIYUN_SMS_LOGIN_TEMPLATE_CODE:'SMS_512626353' },
    onDiagnostic: () => {}, fetchImpl: async (_url, options) => {
      sends++; capturedCode = JSON.parse(new URLSearchParams(options.body).get('TemplateParam')).code;
      throw new DOMException('Response lost after acceptance', 'TimeoutError');
    } });
  const h = await setup(t, { providers: { sendSms: provider.sendSms } }), c = h.client(), phone = '13341313711';
  await c.call('/api/auth/session');
  await assert.rejects(c.call('/api/auth/sms/send', {phone}), error => error.code === 'SMS_SEND_UNCERTAIN' && error.retryAfter === 60);
  await rejects(c.call('/api/auth/sms/send', {phone}), 'SMS_COOLDOWN');
  assert.equal(sends, 1);
  await rejects(c.call('/api/auth/sms/login', {phone,code:capturedCode}), 'NICKNAME_REQUIRED');
  const logged = await c.call('/api/auth/sms/login', {phone,code:capturedCode,nickname:'短信同学'});
  assert.equal(logged.user.phone,phone);
  await rejects(c.call('/api/auth/sms/login', {phone,code:capturedCode}), 'INVALID_CODE');
});

test('email registration requires a trimmed nickname of at most ten Unicode characters; duplicates are allowed', async t => {
  const h = await setup(t), c = h.client();
  await c.call('/api/auth/session');
  for (const nickname of [undefined, null, '', '   ', '一二三四五六七八九十多', '😀'.repeat(11), '同\n学', '同\u200b学']) {
    await rejects(c.call('/api/auth/register', { email: 'nickname@example.test', password: PASSWORD, nickname }), 'INVALID_NICKNAME');
  }
  const first = await c.call('/api/auth/register', { email: 'nickname@example.test', password: PASSWORD, nickname: '  一二三四五六七八九十  ' });
  assert.equal(first.user.nickname, '一二三四五六七八九十');
  const second = await h.client().register('other-nickname@example.test');
  assert.equal(second.user.nickname, '练习同学');
  const same = await c.call('/api/auth/profile', { nickname: second.user.nickname });
  assert.equal(same.user.nickname, second.user.nickname);
  const emoji = await c.call('/api/auth/profile', { nickname: '😀'.repeat(10) });
  assert.equal([...emoji.user.nickname].length, 10);
});

test('SMS registration verifies OTP before requesting nickname and keeps that code usable through validation', async t => {
  const h = await setup(t), c = h.client(), phone = '13341313711';
  await c.call('/api/auth/session');
  await c.call('/api/auth/sms/send', { phone });
  const code = h.sms[0].code, wrong = code === '000000' ? '000001' : '000000';
  await rejects(c.call('/api/auth/sms/login', { phone, code: wrong }), 'INVALID_CODE');
  await rejects(c.call('/api/auth/sms/login', { phone, code }), 'NICKNAME_REQUIRED');
  assert.equal((await c.call('/api/auth/session')).user, null);
  await rejects(c.call('/api/auth/sms/login', { phone, code, nickname: '超'.repeat(11) }), 'INVALID_NICKNAME');
  const registered = await c.call('/api/auth/sms/login', { phone, code, nickname: '  短信新同学  ' });
  assert.equal(registered.user.nickname, '短信新同学');
  assert.equal(registered.user.phone, phone);
  await rejects(c.call('/api/auth/sms/login', { phone, code }), 'INVALID_CODE');
  h.advance(60000);
  await c.call('/api/auth/sms/send', { phone });
  const second = c.clone();
  const existing = await second.call('/api/auth/sms/login', { phone, code: h.sms[1].code, nickname: '不得覆盖' });
  assert.equal(existing.user.id, registered.user.id);
  assert.equal(existing.user.nickname, '短信新同学');
});

test('SMS OTP remains valid at 29 minutes and expires at 30, including while entering a nickname', async t => {
  const h = await setup(t), c = h.client(), phone = '13341313711';
  await c.call('/api/auth/session');
  const sent = await c.call('/api/auth/sms/send', { phone });
  assert.match(sent.message, /30 分钟/);
  h.advance(29 * 60000);
  await rejects(c.call('/api/auth/sms/login', { phone, code: h.sms[0].code }), 'NICKNAME_REQUIRED');
  h.advance(60000);
  await rejects(c.call('/api/auth/sms/login', { phone, code: h.sms[0].code, nickname: '新同学' }), 'INVALID_CODE');
});

test('nickname updates require login, session CSRF and valid input, and cannot update another account', async t => {
  const h = await setup(t), anonymous = h.client();
  await anonymous.call('/api/auth/session');
  await rejects(anonymous.call('/api/auth/profile', { nickname: '新昵称' }), 'LOGIN_REQUIRED');
  const c = h.client(), registered = await c.register();
  await rejects(c.call('/api/auth/profile', { nickname: '新昵称' }, { headers: { 'x-csrf-token': 'bad' } }), 'CSRF_INVALID');
  await rejects(c.call('/api/auth/profile', { nickname: '超'.repeat(11) }), 'INVALID_NICKNAME');
  const other = h.client(), another = await other.register('profile-other@example.test');
  await c.call('/api/auth/profile', { nickname: '自己的昵称', userId: another.user.id });
  assert.equal((await c.call('/api/auth/session')).user.nickname, '自己的昵称');
  assert.equal((await other.call('/api/auth/session')).user.nickname, '练习同学');
  await c.call('/api/guest/start', { fingerprint: 'a'.repeat(64) });
  assert.equal((await c.access()).user.nickname, '自己的昵称');
});

test('an existing database migrates without losing user, session or entitlement, and nickname survives restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-nickname-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const filename = path.join(directory, 'auth.sqlite'), h = await setup(t, { filename }), c = h.client();
  const initial = await c.register();
  const claimed = await c.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) });
  h.service.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(filename);
  db.exec('ALTER TABLE auth_users DROP COLUMN nickname'); db.close();
  const { createAuthService } = await modules;
  let restarted = createAuthService({ filename, now: h.now });
  try {
    const request = { method: 'GET', headers: { cookie: c.cookie(), 'x-csrf-token': c.csrfToken } };
    const restored = await restarted.handle({ request, response: {}, pathname: '/api/auth/session' });
    assert.equal(restored.user.id, initial.user.id);
    assert.equal(restored.user.nickname, null);
    assert.equal(restored.entitlement.accountEndsAt, claimed.entitlement.accountEndsAt);
    await restarted.handle({ request: { ...request, method: 'POST' }, response: {}, pathname: '/api/auth/profile', body: { nickname: '旧账号新昵称' } });
    restarted.close(); restarted = createAuthService({ filename, now: h.now });
    assert.equal((await restarted.handle({ request, response: {}, pathname: '/api/auth/session' })).user.nickname, '旧账号新昵称');
  } finally { restarted.close(); }
});

test('email verification rejects the wrong current password and preserves the existing hash', async t => {
  const h = await setup(t), c = h.client();
  await c.register();
  await rejects(c.call('/api/auth/email/bind', { email: 'student@example.test', password: 'Wrong-password-123' }), 'INVALID_CREDENTIALS');
  assert.equal(h.binds.length, 0);
  await c.call('/api/auth/email/bind', { email: 'student@example.test', password: PASSWORD });
  const result = await c.call('/api/auth/email/confirm', { token: tokenOf(h.binds[0]) });
  assert.equal(result.user.emailVerified, true);
  assert.ok((await h.client().login()).user);
  await rejects(h.client().login('student@example.test', 'Wrong-password-123'), 'INVALID_CREDENTIALS');
});

test('session reads without device cookies never grow browser associations and have a read limit', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-session-read-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const filename = path.join(directory, 'auth.sqlite'), h = await setup(t, { filename }), c = h.client();
  await c.register();
  const session = `zijian_session=${c.jar.get('zijian_session')}`;
  for (let i = 0; i < 1000; i++) await c.call('/api/auth/session', undefined, { headers: { cookie: session }, clientIp: `test-ip-${Math.floor(i / 100)}` });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(filename);
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM access_referral_accounts').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM access_guests').get().count, 0);
  } finally { db.close(); }
  for (let i = 0; i < 120; i++) await c.call('/api/auth/session', undefined, { clientIp: 'limited-session-ip' });
  await rejects(c.call('/api/auth/session', undefined, { clientIp: 'limited-session-ip' }), 'RATE_LIMITED', 429);
  h.advance(60001);
  assert.ok((await c.call('/api/auth/session', undefined, { clientIp: 'limited-session-ip' })).user);
  h.service.close();
});

test('registration normalizes email and leaves trial explicitly unclaimed', async t => {
  const h = await setup(t), c = h.client();
  const state = await c.register(' Student@Example.Test ');
  assert.equal(state.user.email, 'student@example.test');
  assert.equal(state.user.emailVerified, false);
  assert.equal(state.entitlement.status, 'guest_available');
  assert.equal(state.starter.status, 'available');
  assert.equal(state.entitlement.hasAccess, false);
  assert.equal(state.entitlement.trialStartedAt, null);
  await rejects(c.access(), 'GUEST_REQUIRED', 403);
});

test('anonymous session issues signed HttpOnly device cookie and CSRF token', async t => {
  const h = await setup(t), c = h.client();
  const state = await c.call('/api/auth/session');
  assert.equal(state.entitlement.status, 'guest_available');
  assert.equal(state.guest.startedAt, null);
  assert.match(state.csrfToken, /^[a-f0-9]{64}$/);
  assert.match(c.lastSetCookies[0], /HttpOnly; SameSite=Lax;.*Secure/);
  const initial = c.jar.get('zijian_device');
  await c.call('/api/auth/session');
  assert.equal(c.jar.get('zijian_device'), initial);
  assert.deepEqual(c.lastSetCookies, []);
});

test('all mutations require original signed device and correct CSRF, including Unicode input', async t => {
  const h = await setup(t), c = h.client();
  await rejects(c.call('/api/auth/register', { nickname: '练习同学', email: 'a@example.test', password: PASSWORD }), 'CSRF_INVALID');
  await c.call('/api/auth/session');
  await rejects(c.call('/api/auth/register', { nickname: '练习同学', email: 'a@example.test', password: PASSWORD }, { headers: { 'x-csrf-token': '字'.repeat(64) } }), 'CSRF_INVALID');
  c.jar.set('zijian_device', `${'x'.repeat(43)}.${'0'.repeat(64)}`);
  await rejects(c.call('/api/auth/register', { nickname: '练习同学', email: 'a@example.test', password: PASSWORD }), 'CSRF_INVALID');
});

test('validation rejects invalid emails and short passwords; duplicate registration is atomic', async t => {
  const h = await setup(t), c = h.client();
  await c.call('/api/auth/session');
  for (const email of ['no-at', 'a@b', 'a b@example.test', 'x@example.test\nheader: x']) {
    await rejects(c.call('/api/auth/register', { nickname: '练习同学', email, password: PASSWORD }), 'INVALID_EMAIL');
  }
  await rejects(c.call('/api/auth/register', { nickname: '练习同学', email: 'a@example.test', password: 'short' }), 'INVALID_PASSWORD');
  const results = await Promise.allSettled([
    c.call('/api/auth/register', { nickname: '练习同学', email: 'same@example.test', password: PASSWORD }),
    c.clone().call('/api/auth/register', { nickname: '练习同学', email: 'SAME@example.test', password: PASSWORD }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'EMAIL_IN_USE');
});

test('password login works, wrong or absent accounts return same error', async t => {
  const h = await setup(t), first = h.client(), second = h.client();
  const registered = await first.register();
  const logged = await second.login();
  assert.equal(logged.user.id, registered.user.id);
  await rejects(second.login('student@example.test', 'wrong-password'), 'INVALID_CREDENTIALS', 401);
  await rejects(second.login('absent@example.test', 'wrong-password'), 'INVALID_CREDENTIALS', 401);
});

test('session lifetime is fixed 365 days and does not slide on reads', async t => {
  const h = await setup(t), c = h.client();
  await c.register();
  assert.match(c.lastSetCookies[0], /Max-Age=31536000/);
  h.advance(364 * DAY);
  assert.ok((await c.call('/api/auth/session')).user);
  assert.deepEqual(c.lastSetCookies, []);
  h.advance(DAY);
  assert.equal((await c.call('/api/auth/session')).user, null);
  await rejects(c.access(), 'GUEST_REQUIRED', 403);
});

test('logout revokes only that session and keeps the device trial marker', async t => {
  const h = await setup(t), first = h.client(), other = h.client();
  await first.register();
  const stolen = first.clone(), device = first.jar.get('zijian_device');
  await other.login();
  await first.call('/api/auth/logout', {});
  assert.equal(first.jar.get('zijian_device'), device);
  assert.equal((await stolen.call('/api/auth/session')).user, null);
  assert.ok((await other.call('/api/auth/session')).user);
});

test('starter coupon result is fixed, includes unused guest day and expiry blocks server access', async t => {
  const h = await setup(t), c = h.client();
  await c.register();
  const started = h.now(), first = await c.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) });
  assert.equal(first.starter.days, 5);
  assert.equal(first.entitlement.expiresAt, started + 6 * DAY);
  assert.equal(first.guest.status, 'transferred');
  await c.access();
  h.advance(DAY);
  const again = await c.call('/api/coupons/starter/claim', { fingerprint: 'b'.repeat(64) });
  assert.equal(again.entitlement.expiresAt, first.entitlement.expiresAt);
  h.advance(5 * DAY - 1);
  await c.access();
  h.advance(1);
  assert.equal((await c.call('/api/auth/session')).entitlement.status, 'expired');
  await rejects(c.access(), 'ACCESS_EXPIRED', 403);
  const expiredClaim = await c.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) });
  assert.equal(expiredClaim.entitlement.status, 'expired');
});

test('trial account deadline follows another device; same browser switching accounts is blocked', async t => {
  const h = await setup(t), first = h.client(), secondDevice = h.client();
  await first.register('one@example.test');
  const trial = await first.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) });
  const elsewhere = await secondDevice.login('one@example.test');
  assert.equal(elsewhere.entitlement.expiresAt, trial.entitlement.expiresAt);
  await secondDevice.access();
  await first.call('/api/auth/logout', {});
  const newAccount = await first.register('two@example.test');
  assert.equal(newAccount.starter.status, 'browser_used');
  await rejects(first.call('/api/coupons/starter/claim', { fingerprint: 'b'.repeat(64) }), 'STARTER_BROWSER_USED', 403);
  await rejects(first.access(), 'ACCESS_EXPIRED', 403);
});

test('auxiliary fingerprint prevents re-claim after browser cookies were cleared', async t => {
  const h = await setup(t), first = h.client(), cleared = h.client();
  await first.register('one@example.test');
  await first.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) });
  await cleared.register('two@example.test');
  await rejects(cleared.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) }), 'STARTER_BROWSER_USED');
  assert.equal((await cleared.call('/api/auth/session')).entitlement.hasAccess, false);
});

test('a matching fingerprint alone does not deny another IP or user agent', async t => {
  const h = await setup(t), first = h.client(), second = h.client(), third = h.client();
  await first.register('one@example.test');
  await first.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) }, { clientIp: '192.0.2.1', headers: { 'user-agent': 'Browser one' } });
  await second.register('two@example.test');
  assert.equal((await second.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) }, { clientIp: '192.0.2.2', headers: { 'user-agent': 'Browser one' } })).entitlement.hasAccess, true);
  await third.register('three@example.test');
  assert.equal((await third.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) }, { clientIp: '192.0.2.1', headers: { 'user-agent': 'Browser two' } })).entitlement.hasAccess, true);
});

test('concurrent accounts on one device cannot both claim a trial', async t => {
  const h = await setup(t), first = h.client();
  await first.register('one@example.test');
  const second = first.clone();
  await second.register('two@example.test');
  const results = await Promise.allSettled([
    first.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) }),
    second.call('/api/coupons/starter/claim', { fingerprint: 'b'.repeat(64) }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STARTER_BROWSER_USED');
});

test('trial rejects missing, non-digest or malformed fingerprints', async t => {
  const h = await setup(t), c = h.client();
  await c.register();
  for (const fingerprint of [undefined, 'browser-id', 'a'.repeat(63), {}, 12]) {
    await rejects(c.call('/api/coupons/starter/claim', { fingerprint }), 'INVALID_FINGERPRINT');
  }
});

test('SMS login creates one account and supports only Chinese mainland phones', async t => {
  const h = await setup(t), c = h.client();
  await c.call('/api/auth/session');
  for (const phone of ['12345678901', '+12025550112', '85212345678']) {
    await rejects(c.call('/api/auth/sms/send', { phone }), 'INVALID_PHONE');
  }
  await c.call('/api/auth/sms/send', { phone: '+8613341313711', purpose: 'login' });
  assert.match(h.sms[0].code, /^\d{6}$/);
  const first = await c.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: h.sms[0].code });
  assert.equal(first.user.phone, '13341313711');
  assert.equal(first.user.email, null);
  await rejects(c.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: h.sms[0].code }), 'INVALID_CODE');
  h.advance(60000);
  await c.call('/api/auth/sms/send', { phone: '13341313711', purpose: 'login' });
  assert.equal((await c.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: h.sms[1].code })).user.id, first.user.id);
});

test('SMS code expires in thirty minutes, locks after five wrong attempts, and enforces resend wait', async t => {
  const h = await setup(t), c = h.client();
  await c.call('/api/auth/session');
  await c.call('/api/auth/sms/send', { phone: '13341313711' });
  await rejects(c.call('/api/auth/sms/send', { phone: '13341313711' }), 'SMS_COOLDOWN', 429);
  const incorrect = h.sms[0].code === '000000' ? '000001' : '000000';
  for (let attempt = 0; attempt < 5; attempt++) {
    await rejects(c.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: incorrect }), 'INVALID_CODE');
  }
  await rejects(c.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: h.sms[0].code }), 'INVALID_CODE');
  h.advance(60000);
  await c.call('/api/auth/sms/send', { phone: '13341313711' });
  h.advance(30 * 60000);
  await rejects(c.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: h.sms[1].code }), 'INVALID_CODE');
});

test('SMS rate limits by phone and IP, without leaking provider error details or usable failed codes', async t => {
  const h = await setup(t, { providers: { sendSms: async input => { h.sms.push(input); throw new Error('super-secret-access-key'); } } });
  const c = h.client();
  await c.call('/api/auth/session');
  await assert.rejects(c.call('/api/auth/sms/send', { phone: '13341313711' }), error => error.status === 503 && !error.message.includes('super-secret'));
  await rejects(c.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: h.sms[0].code }), 'INVALID_CODE');
  for (let request = 1; request < 5; request++) {
    h.advance(60000);
    await rejects(c.call('/api/auth/sms/send', { phone: '13341313711' }), 'DELIVERY_UNAVAILABLE');
  }
  await rejects(c.call('/api/auth/sms/send', { phone: '13341313711' }), 'RATE_LIMITED', 429);
});

test('forgot password responses do not enumerate accounts even when mail provider fails', async t => {
  const h = await setup(t, { providers: { sendResetEmail: async () => { throw new Error('secret-mail-key'); } } }), c = h.client();
  await c.register();
  const existing = await c.call('/api/auth/password/forgot', { email: 'student@example.test' });
  const absent = await c.call('/api/auth/password/forgot', { email: 'unknown@example.test' });
  assert.deepEqual(existing, absent);
  assert.match(existing.message, /如果该邮箱已注册/);
});

test('password reset verifies email, is single-use and revokes all account sessions', async t => {
  const h = await setup(t), first = h.client(), second = h.client();
  await first.register();
  await second.login();
  await first.call('/api/auth/password/forgot', { email: 'student@example.test' });
  assert.equal(h.resets.length, 1);
  assert.match(h.resets[0].url, /^https:\/\/type\.example\.test\/\?reset=/);
  const token = tokenOf(h.resets[0]);
  const reset = await first.call('/api/auth/password/reset', { token, password: 'A-new-strong-password' });
  assert.equal(reset.user, null);
  assert.equal((await second.call('/api/auth/session')).user, null);
  await rejects(first.call('/api/auth/password/reset', { token, password: PASSWORD }), 'INVALID_TOKEN');
  await rejects(first.login(), 'INVALID_CREDENTIALS');
  const state = await first.login('student@example.test', 'A-new-strong-password');
  assert.equal(state.user.emailVerified, true);
});

test('reset token expires exactly after thirty minutes and is consumed only once concurrently', async t => {
  const h = await setup(t), c = h.client();
  await c.register();
  await c.call('/api/auth/password/forgot', { email: 'student@example.test' });
  h.advance(30 * 60000);
  await rejects(c.call('/api/auth/password/reset', { token: tokenOf(h.resets[0]), password: PASSWORD }), 'INVALID_TOKEN');
  await c.call('/api/auth/password/forgot', { email: 'student@example.test' });
  const token = tokenOf(h.resets[1]);
  const results = await Promise.allSettled([
    c.call('/api/auth/password/reset', { token, password: 'Concurrent-password-one' }),
    c.clone().call('/api/auth/password/reset', { token, password: 'Concurrent-password-two' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'INVALID_TOKEN');
});

test('password change requires current password and revokes all sessions', async t => {
  const h = await setup(t), first = h.client(), second = h.client();
  await first.register();
  await second.login();
  await rejects(first.call('/api/auth/password/change', { currentPassword: 'wrong-password', password: PASSWORD }), 'INVALID_CREDENTIALS');
  await first.call('/api/auth/password/change', { currentPassword: PASSWORD, password: 'Changed-password-173' });
  assert.equal((await second.call('/api/auth/session')).user, null);
  assert.ok((await first.login('student@example.test', 'Changed-password-173')).user);
});

test('SMS account can bind email only after proving both existing account and email ownership', async t => {
  const h = await setup(t), c = h.client();
  await c.call('/api/auth/session');
  await c.call('/api/auth/sms/send', { phone: '13341313711' });
  const original = await c.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: h.sms[0].code });
  await c.call('/api/auth/email/bind', { email: 'student@example.test', password: PASSWORD });
  assert.equal((await c.call('/api/auth/session')).user.email, null);
  const token = tokenOf(h.binds[0]), other = h.client();
  await other.call('/api/auth/session');
  await rejects(other.call('/api/auth/email/confirm', { token }), 'LOGIN_REQUIRED');
  await other.register('other@example.test');
  await rejects(other.call('/api/auth/email/confirm', { token }), 'BIND_ACCOUNT_MISMATCH');
  const confirmed = await c.call('/api/auth/email/confirm', { token });
  assert.equal(confirmed.user.id, original.user.id);
  assert.equal(confirmed.user.emailVerified, true);
  const byEmail = await h.client().login();
  assert.equal(byEmail.user.id, original.user.id);
  await rejects(c.call('/api/auth/email/confirm', { token }), 'INVALID_TOKEN');
});

test('email-first account confirms original email before phone binding; SMS purposes cannot be mixed', async t => {
  const h = await setup(t), c = h.client();
  const original = await c.register();
  await rejects(c.call('/api/auth/sms/send', { phone: '13341313711', purpose: 'bind' }), 'EMAIL_UNVERIFIED');
  await c.call('/api/auth/email/bind', { email: 'student@example.test', password: PASSWORD });
  await c.call('/api/auth/email/confirm', { token: tokenOf(h.binds[0]) });
  await c.call('/api/auth/sms/send', { phone: '13341313711', purpose: 'login' });
  await rejects(c.call('/api/auth/phone/bind', { phone: '13341313711', code: h.sms[0].code }), 'INVALID_CODE');
  await c.call('/api/auth/sms/send', { phone: '13341313711', purpose: 'bind' });
  const bound = await c.call('/api/auth/phone/bind', { phone: '13341313711', code: h.sms[1].code });
  assert.equal(bound.user.id, original.user.id);
  assert.equal(bound.user.phone, '13341313711');
  h.advance(60000);
  await c.call('/api/auth/sms/send', { phone: '13341313711', purpose: 'login' });
  assert.equal((await c.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: h.sms[2].code })).user.id, original.user.id);
});

test('binding cannot merge a different account that already owns the email or phone', async t => {
  const h = await setup(t), emailAccount = h.client(), smsAccount = h.client();
  await emailAccount.register();
  await smsAccount.call('/api/auth/session');
  await smsAccount.call('/api/auth/sms/send', { phone: '13341313711' });
  await smsAccount.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13341313711', code: h.sms[0].code });
  await rejects(smsAccount.call('/api/auth/email/bind', { email: 'student@example.test', password: PASSWORD }), 'EMAIL_IN_USE');
  await emailAccount.call('/api/auth/email/bind', { email: 'student@example.test', password: PASSWORD });
  await emailAccount.call('/api/auth/email/confirm', { token: tokenOf(h.binds[0]) });
  await emailAccount.call('/api/auth/sms/send', { phone: '13341313711', purpose: 'bind' });
  await rejects(emailAccount.call('/api/auth/phone/bind', { phone: '13341313711', code: h.sms[1].code }), 'PHONE_IN_USE');
});

test('logout during asynchronous binding KDF prevents issuing a new binding token', async t => {
  const h = await setup(t), c = h.client();
  await c.register();
  const second = c.clone();
  const pending = c.call('/api/auth/email/bind', { email: 'student@example.test', password: PASSWORD });
  await second.call('/api/auth/logout', {});
  await rejects(pending, 'LOGIN_REQUIRED');
  assert.equal(h.binds.length, 0);
});

test('SQLite survives restart with session, signed device and trial, storing only credential hashes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-auth-'));
  let reopened;
  t.after(async () => { reopened?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const filename = path.join(directory, 'auth.sqlite');
  const h = await setup(t, { filename }), c = h.client();
  await c.register();
  const claimed = await c.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) });
  h.service.close();
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(filename);
  const user = db.prepare('SELECT * FROM auth_users').get();
  assert.match(user.password_hash, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!user.password_hash.includes(PASSWORD));
  const session = db.prepare('SELECT * FROM auth_sessions').get();
  assert.match(session.token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(session.token_hash, c.jar.get('zijian_session'));
  db.close();
  const { createAuthService } = await modules;
  reopened = createAuthService({ filename, now: h.now });
  const access = await reopened.requireAccess({ headers: { cookie: c.cookie() } });
  assert.equal(access.entitlement.expiresAt, claimed.entitlement.expiresAt);
  assert.equal(access.user.id, claimed.user.id);
});

test('unconfigured providers and unknown endpoints fail safely', async t => {
  const h = await setup(t, { providers: { status: { sms: false, email: false } } }), c = h.client();
  await c.call('/api/auth/session');
  await rejects(c.call('/api/auth/sms/send', { phone: '13341313711' }), 'PROVIDER_UNAVAILABLE', 503);
  await rejects(c.call('/api/auth/password/forgot', { email: 'student@example.test' }), 'PROVIDER_UNAVAILABLE', 503);
  await rejects(c.call('/api/auth/no-such-endpoint', {}), 'NOT_FOUND', 404);
  await rejects(c.call('/api/auth/login'), 'METHOD_NOT_ALLOWED', 405);
});
