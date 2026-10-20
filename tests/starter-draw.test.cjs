'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');

const DAY = 86400000;
const BASE = Date.UTC(2026, 9, 16);
const FP = 'a'.repeat(64);
const PASSWORD = 'Draw-password-81';
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

async function setup(t, options = {}) {
  const { createAuthService } = await import('../auth-service.mjs');
  let clock = BASE, draws = 0, service;
  const configuration = { filename: ':memory:', now: () => clock, drawStarterDays: () => { draws++; return 5; }, ...options };
  const open = () => { service = createAuthService(configuration); return service; };
  open();
  t.after(() => service.close());
  function client(jar = new Map(), initialCsrf) {
    let csrf = initialCsrf;
    return {
      jar,
      get csrf() { return csrf; },
      cookie() { return [...jar].map(([key, value]) => `${key}=${value}`).join('; '); },
      async call(pathname, body, overrides = {}) {
        const headers = { cookie: this.cookie(), 'x-csrf-token': csrf, 'user-agent': 'Draw test browser', ...overrides.headers };
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
      register(email = 'draw@example.test') { return this.call('/api/auth/register', { nickname: '练习同学', email, password: PASSWORD }); },
      login(email = 'draw@example.test') { return this.call('/api/auth/login', { email, password: PASSWORD }); },
      draw(fingerprint = FP, overrides) { return this.call('/api/coupons/starter/draw', { fingerprint }, overrides); },
      claim(fingerprint = FP) { return this.call('/api/coupons/starter/claim', { fingerprint }); },
      start(fingerprint = FP) { return this.call('/api/guest/start', { fingerprint }); },
      clone() { return client(new Map(jar), csrf); },
    };
  }
  return { get service() { return service; }, client, get draws() { return draws; }, now: () => clock,
    advance(ms) { clock += ms; }, reopen() { service.close(); open(); } };
}

async function diskSetup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-starter-draw-'));
  const filename = path.join(directory, 'auth.sqlite');
  const h = await setup(t, { filename, ...options });
  t.after(async () => { h.service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  return { h, filename };
}

test('anonymous draw is fixed server state and never starts guest access or grants account time', async t => {
  const h = await setup(t), c = h.client();
  assert.deepEqual((await c.init()).starterDraw, { status: 'available', days: null, drawnAt: null });
  const drawn = await c.call('/api/coupons/starter/draw', { fingerprint: FP, days: 99, expiresAt: BASE + 999 * DAY });
  assert.deepEqual(drawn.starterDraw, { status: 'pending', days: 5, drawnAt: BASE });
  assert.equal(drawn.user, null);
  assert.equal(drawn.guest.status, 'available');
  assert.equal(drawn.guest.startedAt, null);
  assert.equal(drawn.guest.endsAt, null);
  assert.equal(drawn.entitlement.hasAccess, false);
  assert.equal(drawn.entitlement.accountEndsAt, null);
  assert.equal(drawn.lastGrant, undefined);
  await rejects(h.service.requireAccess({ headers: { cookie: c.cookie() } }), 'GUEST_REQUIRED');
  h.advance(4 * DAY);
  assert.deepEqual((await c.init()).starterDraw, drawn.starterDraw);
  assert.deepEqual((await c.draw('b'.repeat(64))).starterDraw, drawn.starterDraw);
  assert.equal(h.draws, 1);
});

test('first practice after drawing still starts a fresh 24 hour guest clock', async t => {
  const h = await setup(t), c = h.client();
  await c.init(); await c.draw(); h.advance(2 * DAY);
  const started = await c.start();
  assert.equal(started.guest.startedAt, h.now());
  assert.equal(started.guest.endsAt, h.now() + DAY);
  assert.equal(started.starterDraw.days, 5);
  h.advance(6 * 3600000);
  await c.register();
  const claimed = await c.claim();
  assert.equal(claimed.lastGrant.days, 5);
  assert.equal(claimed.lastGrant.inheritedMs, 18 * 3600000);
  assert.equal(claimed.entitlement.expiresAt, h.now() + 5 * DAY + 18 * 3600000);
  assert.equal(h.draws, 1);
});

test('registration preserves the visible prize and claiming grants it once with the untouched guest day', async t => {
  const h = await setup(t), c = h.client();
  await c.init(); const drawn = await c.draw(); h.advance(30 * DAY);
  const registered = await c.register();
  assert.deepEqual(registered.starterDraw, drawn.starterDraw);
  assert.equal(registered.starter.claimDeadline, h.now() + 7 * DAY);
  assert.equal(registered.entitlement.hasAccess, false);
  const claimed = await c.claim();
  assert.deepEqual(claimed.starterDraw, { status: 'claimed', days: 5, drawnAt: BASE });
  assert.equal(claimed.lastGrant.days, drawn.starterDraw.days);
  assert.equal(claimed.entitlement.expiresAt, h.now() + 6 * DAY);
  const repeated = await c.claim('b'.repeat(64));
  assert.equal(repeated.lastGrant, undefined);
  assert.equal(repeated.entitlement.expiresAt, claimed.entitlement.expiresAt);
  assert.equal(h.draws, 1);
});

test('SMS auto-registration preserves an anonymous pending draw without activating it', async t => {
  let sent;
  const h = await setup(t, { providers: { status: { sms: true }, sendSms: async input => { sent = input; } } }), c = h.client();
  await c.init(); await c.draw();
  await c.call('/api/auth/sms/send', { phone: '13300000001' });
  const logged = await c.call('/api/auth/sms/login', { nickname: '练习同学', phone: '13300000001', code: sent.code });
  assert.equal(logged.user.phone, '13300000001');
  assert.equal(logged.starterDraw.status, 'pending');
  assert.equal(logged.entitlement.hasAccess, false);
  assert.equal((await c.claim()).lastGrant.days, 5);
  assert.equal(h.draws, 1);
});

test('cleared cookies recover the same prize by auxiliary identity; a signed browser ignores a changed digest', async t => {
  const h = await setup(t), first = h.client(), cleared = h.client(), unrelated = h.client();
  await first.init(); const original = await first.draw();
  await cleared.init();
  assert.equal((await cleared.init()).starterDraw.status, 'available');
  assert.deepEqual((await cleared.draw()).starterDraw, original.starterDraw);
  h.advance(3600000);
  assert.deepEqual((await first.draw('c'.repeat(64))).starterDraw, original.starterDraw);
  await unrelated.init();
  const independent = await unrelated.draw(FP, { clientIp: '192.0.2.2' });
  assert.equal(independent.starterDraw.drawnAt, h.now());
  assert.equal(h.draws, 2);
});

test('pending prize persists across SQLite restarts without persisting raw browser signals', async t => {
  const { h, filename } = await diskSetup(t), c = h.client();
  await c.init(); const original = await c.draw();
  h.reopen(); h.advance(DAY);
  assert.deepEqual((await c.init()).starterDraw, original.starterDraw);
  assert.deepEqual((await c.draw()).starterDraw, original.starterDraw);
  assert.equal(h.draws, 1);
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(filename);
  const guest = db.prepare('SELECT * FROM access_guests').get();
  assert.equal(guest.started_at, null);
  assert.notEqual(guest.fingerprint_hash, FP);
  assert.ok(!JSON.stringify(guest).includes('192.0.2.1'));
  assert.equal(db.prepare('SELECT count(*) AS total FROM access_starter_draws').get().total, 1);
  db.close();
});

test('legacy direct claim creates a fixed result compatible with the new draw state', async t => {
  const h = await setup(t), c = h.client();
  await c.init(); await c.register();
  const claimed = await c.claim();
  assert.deepEqual(claimed.starterDraw, { status: 'claimed', days: 5, drawnAt: h.now() });
  await rejects(c.draw(), 'STARTER_ALREADY_CLAIMED');
  assert.equal(h.draws, 1);
});

test('each valid prize is supported and an invalid generator fails atomically without consuming a draw', async t => {
  for (const days of [3, 4, 5, 6, 7]) {
    const h = await setup(t, { drawStarterDays: () => days }), c = h.client();
    await c.init();
    assert.equal((await c.draw()).starterDraw.days, days);
    await c.register();
    assert.equal((await c.claim()).lastGrant.days, days);
  }
  let generated = 8;
  const h = await setup(t, { drawStarterDays: () => generated }), c = h.client();
  await c.init(); await rejects(c.draw(), 'COUPON_UNAVAILABLE');
  assert.deepEqual((await c.init()).starterDraw, { status: 'available', days: null, drawnAt: null });
  generated = 3;
  assert.equal((await c.draw()).starterDraw.days, 3);
});

test('draws enforce signed cookie, CSRF, POST and valid digest before generating a prize', async t => {
  const h = await setup(t), c = h.client();
  await rejects(c.draw(), 'CSRF_INVALID');
  await c.init();
  await rejects(c.draw(FP, { headers: { 'x-csrf-token': 'forged' } }), 'CSRF_INVALID');
  await rejects(c.call('/api/coupons/starter/draw'), 'METHOD_NOT_ALLOWED');
  for (const fingerprint of ['', 'x'.repeat(64), null, {}, 123]) await rejects(c.draw(fingerprint), 'INVALID_FINGERPRINT');
  assert.equal(h.draws, 0);
});

test('claimed accounts and consumed browsers cannot draw or claim another starter prize', async t => {
  const h = await setup(t), first = h.client(), otherBrowser = h.client();
  await first.init(); await first.draw(); await first.register(); const claimed = await first.claim();
  await rejects(first.draw(), 'STARTER_ALREADY_CLAIMED');
  await otherBrowser.init(); await otherBrowser.login();
  assert.equal((await otherBrowser.init()).starterDraw.status, 'claimed');
  await rejects(otherBrowser.draw('b'.repeat(64)), 'STARTER_ALREADY_CLAIMED');
  await first.call('/api/auth/logout', {});
  assert.equal((await first.init()).starterDraw.status, 'claimed');
  await rejects(first.draw(), 'STARTER_BROWSER_USED');
  await first.register('second@example.test');
  assert.equal((await first.init()).starterDraw.status, 'ineligible');
  await rejects(first.draw(), 'STARTER_BROWSER_USED');
  await rejects(first.claim(), 'STARTER_BROWSER_USED');
  assert.equal(h.draws, 1);
  assert.equal((await otherBrowser.init()).entitlement.expiresAt, claimed.entitlement.expiresAt);
});

test('denied draw after cookie clearing retains only recovered identity so refresh hides the consumed prize', async t => {
  const { h, filename } = await diskSetup(t), first = h.client(), cleared = h.client();
  await first.init(); await first.draw(); await first.register(); const claimed = await first.claim();
  assert.equal((await cleared.init()).starterDraw.status, 'available');
  await rejects(cleared.draw(), 'STARTER_BROWSER_USED');
  const recovered = await cleared.init();
  assert.equal(recovered.starterDraw.status, 'claimed');
  assert.equal(recovered.guest.status, 'transferred');
  assert.equal(recovered.guest.startedAt, null);
  assert.equal(recovered.entitlement.hasAccess, false);
  assert.equal(recovered.user, null);
  assert.equal(h.draws, 1);
  assert.equal((await first.init()).entitlement.expiresAt, claimed.entitlement.expiresAt);
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(filename);
  assert.equal(db.prepare('SELECT count(*) AS total FROM access_guests').get().total, 1);
  assert.equal(db.prepare('SELECT count(*) AS total FROM access_starter_draws').get().total, 1);
  assert.equal(db.prepare('SELECT count(*) AS total FROM access_starters').get().total, 1);
  assert.equal(db.prepare('SELECT count(*) AS total FROM access_devices').get().total, 2);
  db.close();
});

test('pending draws do not extend the seven day account claim deadline or revive legacy rewards', async t => {
  const { h, filename } = await diskSetup(t), c = h.client();
  await c.init(); await c.draw(); await c.register();
  h.advance(7 * DAY);
  assert.deepEqual((await c.init()).starterDraw, { status: 'ineligible', days: null, drawnAt: null });
  await rejects(c.draw(), 'STARTER_CLAIM_EXPIRED');
  await rejects(c.claim(), 'STARTER_CLAIM_EXPIRED');
  assert.equal(h.draws, 1);
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(filename);
  const userId = (await c.init()).user.id;
  db.prepare('INSERT INTO access_starters (user_id,days,claimed_at,legacy) VALUES (?,NULL,?,1)').run(userId, h.now());
  db.close();
  assert.equal((await c.init()).starterDraw.status, 'ineligible');
  await rejects(c.draw(), 'STARTER_ALREADY_CLAIMED');
  assert.equal((await c.claim()).lastGrant, undefined);
});

test('two accounts on one browser can share the visible draw but only one can receive it', async t => {
  const h = await setup(t), first = h.client();
  await first.init(); const drawn = await first.draw(); await first.register('first@example.test');
  const second = first.clone(); await second.register('second@example.test');
  assert.deepEqual((await second.draw('b'.repeat(64))).starterDraw, drawn.starterDraw);
  const results = await Promise.allSettled([first.claim(), second.claim('b'.repeat(64))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'fulfilled').value.lastGrant.days, drawn.starterDraw.days);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STARTER_BROWSER_USED');
  assert.equal(h.draws, 1);
});

test('independent SQLite connections racing to draw persist exactly one prize', async t => {
  const { h, filename } = await diskSetup(t), c = h.client();
  await c.init();
  const shared = new SharedArrayBuffer(8), barrier = new Int32Array(shared);
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../auth-service.mjs')).href;
  function race(days) {
    return new Promise((resolve, reject) => {
      let result;
      const worker = new Worker(`
        const { workerData: data, parentPort } = require('node:worker_threads');
        (async () => {
          const { createAuthService } = await import(data.moduleUrl);
          const barrier = new Int32Array(data.shared);
          const service = createAuthService({ filename: data.filename, now: () => data.now,
            drawStarterDays: () => { Atomics.add(barrier, 1, 1); return data.days; } });
          Atomics.add(barrier, 0, 1); Atomics.notify(barrier, 0);
          while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 5000);
          try {
            const state = await service.handle({ request: { method: 'POST', headers: { cookie: data.cookie,
              'x-csrf-token': data.csrfToken, 'user-agent': 'Draw test browser' } }, response: {},
              pathname: '/api/coupons/starter/draw', body: { fingerprint: data.fingerprint }, clientIp: '192.0.2.1' });
            parentPort.postMessage(state.starterDraw);
          } finally { service.close(); }
        })().catch(error => { throw error; });
      `, { eval: true, workerData: { moduleUrl, filename, now: h.now(), shared, days, cookie: c.cookie(), csrfToken: c.csrf, fingerprint: FP } });
      worker.on('message', value => { result = value; });
      worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve(result) : reject(new Error(`Worker failed: ${code}`)));
    });
  }
  const results = await Promise.all([race(3), race(7)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].status, 'pending');
  assert.ok([3, 7].includes(results[0].days));
  assert.equal(Atomics.load(barrier, 1), 1);
  assert.deepEqual((await c.init()).starterDraw, results[0]);
  await c.register();
  assert.equal((await c.claim()).lastGrant.days, results[0].days);
  assert.equal(h.draws, 0);
});

test('HTTP draw is anonymous, rejects cross-origin/CSRF requests and disables response caching', async t => {
  const h = await setup(t), { createServer } = await import('../translation-server.mjs');
  const server = createServer({ authService: h.service, configured: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function request(pathname, method = 'GET', headers = {}, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${origin}${pathname}`, { method, headers }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const initial = await request('/api/auth/session');
  const headers = { Origin: origin, Cookie: initial.headers['set-cookie'].map(item => item.split(';')[0]).join('; '), 'Content-Type': 'application/json', 'X-CSRF-Token': initial.data.csrfToken };
  assert.equal((await request('/api/coupons/starter/draw', 'POST', { ...headers, Origin: 'https://attacker.example' }, { fingerprint: FP })).status, 403);
  assert.equal((await request('/api/coupons/starter/draw', 'POST', { ...headers, 'X-CSRF-Token': 'forged' }, { fingerprint: FP })).status, 403);
  const drawn = await request('/api/coupons/starter/draw', 'POST', headers, { fingerprint: FP });
  assert.equal(drawn.status, 200);
  assert.equal(drawn.headers['cache-control'], 'no-store');
  assert.equal(drawn.data.starterDraw.status, 'pending');
  assert.equal(drawn.data.user, null);
  assert.equal(drawn.data.guest.startedAt, null);
  assert.equal(h.draws, 1);
});
