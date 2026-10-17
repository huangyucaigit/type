'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const DAY = 86400000, BASE = Date.UTC(2026, 9, 16);
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);

async function setup(t, options = {}) {
  const { createAuthService } = await import('../auth-service.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const { signPaymentRequest } = await import('../payment-client.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-payment-'));
  const filename = path.join(directory, 'auth.sqlite');
  let clock = BASE, service;
  const settings = { filename, now: () => clock, drawStarterDays: () => 3, drawReferralDays: () => 5,
    paymentOptions: { mode: 'mock', ...options.paymentOptions }, ...options };
  service = createAuthService(settings);
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  function query(sql, ...args) {
    const db = new DatabaseSync(filename);
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
  }
  function exec(sql) { const db = new DatabaseSync(filename); try { db.exec(sql); } finally { db.close(); } }
  function client(jar = new Map(), initialCsrf) {
    let csrf = initialCsrf;
    return {
      jar, get csrf() { return csrf; },
      cookie() { return [...jar].map(([key, value]) => `${key}=${value}`).join('; '); },
      async call(pathname, body, overrides = {}) {
        const captured = new Map(), response = { getHeader: key => captured.get(key), setHeader: (key, value) => captured.set(key, value) };
        const request = { method: body === undefined ? 'GET' : 'POST', headers: {
          cookie: this.cookie(), 'x-csrf-token': csrf, 'user-agent': 'Payment service test', ...overrides.headers,
        } };
        const result = await service.handle({ request, response, pathname, body, origin: 'http://127.0.0.1:4174',
          clientIp: '127.0.0.1', allowMock: true, ...overrides });
        for (const item of captured.get('Set-Cookie') || []) { const pair = item.split(';')[0], sep = pair.indexOf('='); jar.set(pair.slice(0, sep), pair.slice(sep + 1)); }
        csrf = result.csrfToken || csrf;
        return result;
      },
      init() { return this.call('/api/auth/session'); },
      register(email = `payment-${randomUUID()}@example.test`) { return this.call('/api/auth/register', { email, password: 'Payment-password-81' }); },
      create(planId = 'monthly', requestId = randomUUID(), extra = {}) { return this.call('/api/billing/orders', { planId, requestId, ...extra }); },
      detail(no) { return this.call(`/api/billing/orders/${no}`); },
      action(no, action) { return this.call(`/api/billing/orders/${no}/${action}`, {}); },
      clone() { return client(new Map(jar), csrf); },
    };
  }
  function config() {
    const settings = Object.fromEntries(query("SELECT key,value FROM auth_settings WHERE key LIKE 'billing_mock_%'").map(row => [row.key, row.value]));
    return { baseUrl: 'https://payment-mock.invalid', projectCode: 'type_mock', apiKeyId: 'mock_api_v1',
      apiSecretBase64: settings.billing_mock_api_secret, notifyKeyId: 'mock_notify_v1',
      notifySecretBase64: settings.billing_mock_notify_secret, notifyUrl: 'https://type.where.work/payments/notify' };
  }
  function event(order, overrides = {}) {
    return { eventId: `test_evt_${randomUUID()}`, eventType: 'PAYMENT.SUCCEEDED', projectCode: 'type_mock',
      paymentId: order.paymentId, attemptId: order.attemptId, businessOrderNo: order.orderNo,
      amountFen: order.amountFen, currency: 'CNY', wechatTransactionId: `test_tx_${randomUUID()}`,
      paidAt: new Date(clock).toISOString(), ...overrides };
  }
  function notificationRequest(event, overrides = {}) {
    const cfg = config(), rawBody = Buffer.from(JSON.stringify(event)), rawTarget = '/payments/notify';
    const signed = signPaymentRequest({ method: 'POST', rawTarget, projectCode: cfg.projectCode,
      keyId: cfg.notifyKeyId, timestamp: Math.floor(clock / 1000), nonce: randomBytes(24).toString('hex'), rawBody,
      secretBase64: cfg.notifySecretBase64 });
    return { request: { method: 'POST', headers: signed.headers },
      rawTarget, rawBody, rawHeaders: Object.entries(signed.headers).flat(), allowMock: true, ...overrides };
  }
  function notification(event, overrides = {}) {
    return service.receivePaymentNotification(notificationRequest(event, overrides));
  }
  return { client, query, exec, config, event, notification, notificationRequest, filename, get service() { return service; },
    now: () => clock, advance(ms) { clock += ms; }, reopen() { service.close(); service = createAuthService(settings); } };
}

async function registered(h) { const c = h.client(); await c.init(); await c.register(); return c; }

test('concurrent order reads coalesce, reads are limited and mutation queues stay bounded', async t => {
  let gated = false, upstream = 0, release;
  let gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const h = await setup(t, { paymentOptions: { mode: 'mock', mockOptions: { beforeRequest: async ({ rawTarget }) => {
    if (gated && rawTarget.startsWith('/api/v1/payments/')) { upstream++; await gate; }
  } } } });
  const c = await registered(h), order = (await c.create()).order;
  gated = true;
  const results = Array.from({ length: 150 }, () => c.detail(order.orderNo).then(() => 'ok', error => error.code));
  for (let i = 0; i < 100 && !upstream; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstream, 1);
  release();
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(value => value === 'ok').length, 60);
  assert.equal(outcomes.filter(value => value === 'RATE_LIMITED').length, 90);
  assert.equal(upstream, 1);
  h.advance(60001);
  assert.equal((await c.detail(order.orderNo)).order.orderNo, order.orderNo);

  upstream = 0; gate = new Promise(resolve => { release = resolve; });
  const actions = Array.from({ length: 100 }, () => c.action(order.orderNo, 'sync').then(() => 'ok', error => error.code));
  for (let i = 0; i < 100 && !upstream; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstream, 1);
  release();
  const actionOutcomes = await Promise.all(actions);
  assert.equal(actionOutcomes.filter(value => value === 'ok').length, 8);
  assert.equal(actionOutcomes.filter(value => value === 'RATE_LIMITED').length, 92);
});

function raceWorkers(h, workItems) {
  const shared = new SharedArrayBuffer(4), moduleUrl = pathToFileURL(path.resolve(__dirname, '../auth-service.mjs')).href;
  return Promise.all(workItems.map(work => new Promise((resolve, reject) => {
    let result;
    const worker = new Worker(`
      const { workerData: data, parentPort } = require('node:worker_threads');
      (async () => {
        const { createAuthService } = await import(data.moduleUrl);
        const service = createAuthService({ filename: data.filename, now: () => data.now, paymentOptions: { mode: 'mock' } });
        const barrier = new Int32Array(data.shared);
        Atomics.add(barrier, 0, 1); Atomics.notify(barrier, 0);
        while (Atomics.load(barrier, 0) < data.total) Atomics.wait(barrier, 0, 1, 5000);
        try {
          const output = data.work.notification
            ? await service.receivePaymentNotification(data.work.notification)
            : await service.handle({ ...data.work, response: {} });
          parentPort.postMessage(output);
        } finally { service.close(); }
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { moduleUrl, filename: h.filename, now: h.now(), shared, total: workItems.length, work } });
    worker.on('message', value => { result = value; }); worker.on('error', reject);
    worker.on('exit', code => code === 0 ? resolve(result) : reject(new Error(`Payment race worker failed: ${code}`)));
  })));
}

test('plans are server priced; disabled or nonlocal mock has no payment capability', async t => {
  const h = await setup(t), anon = h.client();
  const publicPlans = await anon.call('/api/billing/plans');
  assert.deepEqual(publicPlans.plans.map(p => [p.id, p.amountFen, p.days]), [['monthly', 990, 30], ['quarterly', 1990, 90], ['yearly', 5990, 365]]);
  assert.equal(publicPlans.user, null); assert.equal(publicPlans.billing.enabled, true);
  assert.equal((await anon.call('/api/billing/plans', undefined, { allowMock: false })).billing.enabled, false);
  await rejected(anon.create(), 'LOGIN_REQUIRED');
  await rejected(anon.create('monthly', randomUUID(), {}), 'LOGIN_REQUIRED');
  const c = await registered(h);
  await rejected(c.create('monthly', randomUUID(), { amountFen: 1 }), 'INVALID_ORDER');
  await rejected(c.create('monthly', randomUUID(), { days: 999 }), 'INVALID_ORDER');
  await rejected(c.create('invalid'), 'INVALID_ORDER');
  await rejected(c.create('monthly', 'no-uuid'), 'INVALID_ORDER');
  await rejected(c.call('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() }, { headers: { 'x-csrf-token': 'tampered' } }), 'CSRF_INVALID');
  await rejected(c.call('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() }, { allowMock: false }), 'MOCK_PAYMENT_LOCAL_ONLY');
  assert.equal(h.query('SELECT * FROM billing_orders').length, 0);
  const disabled = await setup(t, { paymentOptions: { mode: 'disabled' } }), d = await registered(disabled);
  assert.equal((await d.call('/api/billing/plans')).billing.enabled, false);
  await rejected(d.create(), 'PAYMENT_DISABLED');
});

test('creating, scanning and refreshing pending orders grant no time or guest activation', async t => {
  const h = await setup(t), c = await registered(h);
  const result = await c.create(), order = result.order;
  assert.equal(order.status, 'UNPAID'); assert.equal(order.paymentStatus, 'UNPAID');
  assert.equal(order.attemptStatus, 'PENDING'); assert.match(order.codeUrl, /^mock-payment:\/\//);
  assert.equal(order.expiresAt, BASE + 900000); assert.equal(order.grantedAt, null);
  assert.equal(result.entitlement.hasAccess, false); assert.equal(result.guest.startedAt, null);
  assert.equal((await c.detail(order.orderNo)).order.orderNo, order.orderNo);
  assert.equal((await c.call('/api/billing/orders')).orders.length, 1);
  assert.equal(h.query('SELECT * FROM billing_events').length, 0);
});

test('same request and simultaneous new intents reuse one active business order and provider attempt', async t => {
  const h = await setup(t), c = await registered(h), requestId = randomUUID();
  const results = await Promise.all([c.create('monthly', requestId), c.clone().create('monthly', requestId), c.clone().create()]);
  assert.equal(new Set(results.map(result => result.order.orderNo)).size, 1);
  assert.equal(h.query('SELECT * FROM billing_orders').length, 1);
  assert.equal(h.query('SELECT * FROM billing_attempts').length, 1);
  assert.equal(h.query('SELECT * FROM billing_mock_attempts').length, 1);
  await rejected(c.create('quarterly', requestId), 'ORDER_REQUEST_CONFLICT');
  await rejected(c.create('quarterly'), 'ACTIVE_ORDER_EXISTS');
});

test('orders and all state changing actions enforce owner login and CSRF', async t => {
  const h = await setup(t), first = await registered(h), second = await registered(h);
  const no = (await first.create()).order.orderNo;
  await rejected(second.detail(no), 'ORDER_NOT_FOUND');
  for (const action of ['sync', 'close', 'retry', 'mock-complete', 'mock-notify-retry']) {
    await rejected(second.action(no, action), 'ORDER_NOT_FOUND');
    await rejected(first.call(`/api/billing/orders/${no}/${action}`, {}, { headers: { 'x-csrf-token': 'wrong' } }), 'CSRF_INVALID');
  }
  assert.equal((await second.call('/api/billing/orders')).orders.length, 0);
  assert.equal(h.query('SELECT * FROM billing_events').length, 0);
});

test('mock success travels through signed callback and grants exactly purchased duration', async t => {
  const h = await setup(t), c = await registered(h), created = (await c.create()).order;
  const result = await c.action(created.orderNo, 'mock-complete');
  assert.equal(result.order.status, 'PAID'); assert.equal(result.order.paymentStatus, 'PAID');
  assert.equal(result.order.notificationStatus, 'ACK'); assert.equal(result.order.grantedAt, BASE);
  assert.equal(result.order.entitlementEndsAt, BASE + 30 * DAY);
  assert.equal(result.entitlement.paidUntil, result.entitlement.accountEndsAt);
  assert.equal(result.entitlement.accountEndsAt, BASE + 30 * DAY);
  assert.equal(h.query('SELECT * FROM billing_events').length, 1);
  const provider = h.query('SELECT * FROM billing_mock_payments')[0];
  assert.equal(provider.payment_status, 'PAID'); assert.equal(provider.notification_status, 'ACK');
  assert.equal((await c.action(created.orderNo, 'mock-notify-retry')).entitlement.accountEndsAt, result.entitlement.accountEndsAt);
  assert.equal((await c.action(created.orderNo, 'mock-complete')).entitlement.accountEndsAt, result.entitlement.accountEndsAt);
  assert.equal(h.query('SELECT * FROM billing_events').length, 1);
});

test('all plans stack with starter and channel coupons, and expired access starts at server now', async t => {
  const h = await setup(t), c = await registered(h);
  await c.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) });
  h.service.createCampaign({ id: 'pay-campaign', title: '叠加测试', days: 2, startsAt: BASE, endsAt: BASE + 20 * DAY,
    maxRedemptions: 3, codes: [{ code: 'PAY-PLUS-2', channel: 'test' }] });
  await c.call('/api/coupons/redeem', { code: 'PAY-PLUS-2' });
  let expected = BASE + 6 * DAY;
  for (const [plan, days] of [['monthly', 30], ['quarterly', 90], ['yearly', 365]]) {
    const no = (await c.create(plan)).order.orderNo;
    const result = await c.action(no, 'mock-complete'); expected += days * DAY;
    assert.equal(result.entitlement.accountEndsAt, expected); assert.equal(result.entitlement.paidUntil, expected);
  }
  h.advance(600 * DAY);
  // Session lasts 365 days, so log in to get a fresh session after advancing.
  const email = h.query('SELECT email FROM auth_users')[0].email;
  await c.call('/api/auth/login', { email, password: 'Payment-password-81' });
  const no = (await c.create()).order.orderNo;
  assert.equal((await c.action(no, 'mock-complete')).entitlement.accountEndsAt, h.now() + 30 * DAY);
});

test('valid duplicate delivery, refreshed signature and distinct event IDs grant only once', async t => {
  const h = await setup(t), c = await registered(h), order = (await c.create()).order;
  const event = h.event(order);
  assert.deepEqual(await h.notification(event), { eventId: event.eventId, status: 'ACK' });
  const expires = (await c.init()).entitlement.accountEndsAt;
  h.advance(20000);
  await Promise.all(Array.from({ length: 6 }, () => h.notification(event)));
  await h.notification({ ...event, eventId: `new_${randomUUID()}` });
  assert.equal((await c.init()).entitlement.accountEndsAt, expires);
  assert.equal(h.query('SELECT * FROM billing_events').length, 2);
  await rejected(h.notification({ ...event, paidAt: new Date(h.now()).toISOString() }), 'PAYMENT_EVENT_CONFLICT');
});

test('unknown orders, mismatched project/amount/currency/payment/attempt and invalid signature never grant', async t => {
  const h = await setup(t), c = await registered(h), order = (await c.create()).order;
  const event = h.event(order);
  for (const [changed, code] of [
    [{ businessOrderNo: 'type_unknown' }, 'PAYMENT_ORDER_NOT_FOUND'],
    [{ amountFen: 1 }, 'PAYMENT_ORDER_MISMATCH'], [{ currency: 'USD' }, 'PAYMENT_NOTIFICATION_INVALID'],
    [{ projectCode: 'another_project' }, 'PAYMENT_NOTIFICATION_INVALID'],
    [{ paymentId: 'another_payment' }, 'PAYMENT_ORDER_MISMATCH'],
    [{ attemptId: 'another_attempt' }, 'PAYMENT_ATTEMPT_MISMATCH'],
    [{ paidAt: new Date(BASE - DAY).toISOString() }, 'PAYMENT_ORDER_MISMATCH'],
  ]) await rejected(h.notification({ ...event, ...changed }), code);
  await rejected(h.notification(event, { rawBody: Buffer.from(JSON.stringify({ ...event, amountFen: 2 })) }), 'PAYMENT_NOTIFICATION_UNAUTHORIZED');
  await rejected(h.notification(event, { rawTarget: '/payments/notify?ignore=1' }), 'PAYMENT_NOTIFICATION_UNAUTHORIZED');
  await rejected(h.notification(event, { allowMock: false }), 'MOCK_PAYMENT_LOCAL_ONLY');
  assert.equal((await c.init()).entitlement.accountEndsAt, null);
  assert.equal(h.query('SELECT * FROM billing_events').length, 0);
});

test('payment and transaction identities cannot fulfil a second order', async t => {
  const h = await setup(t), c = await registered(h), original = (await c.create()).order;
  const event = h.event(original); await h.notification(event);
  const next = (await c.create('quarterly')).order;
  await rejected(h.notification(h.event(next, { wechatTransactionId: event.wechatTransactionId })), 'PAYMENT_ORDER_MISMATCH');
  await rejected(h.notification(h.event(next, { paymentId: event.paymentId })), 'PAYMENT_ORDER_MISMATCH');
  await rejected(h.notification({ ...event, wechatTransactionId: 'another_tx' }), 'PAYMENT_ORDER_MISMATCH');
  assert.equal((await c.init()).entitlement.accountEndsAt, BASE + 30 * DAY);
});

test('expired QR remains uncertain until close; retry then uses a new key under the original business order', async t => {
  const h = await setup(t), c = await registered(h), original = (await c.create()).order;
  const firstKey = h.query('SELECT idempotency_key FROM billing_attempts')[0].idempotency_key;
  h.advance(900000);
  const expired = (await c.detail(original.orderNo)).order;
  assert.equal(expired.attemptStatus, 'EXPIRED'); assert.equal(expired.codeUrl, null);
  await rejected(c.action(original.orderNo, 'mock-complete'), 'PAYMENT_ATTEMPT_UNAVAILABLE');
  const unchanged = (await c.action(original.orderNo, 'retry')).order;
  assert.equal(unchanged.attemptId, original.attemptId); assert.equal(h.query('SELECT * FROM billing_attempts').length, 1);
  assert.equal((await c.action(original.orderNo, 'close')).order.attemptStatus, 'CLOSED');
  const retried = (await c.action(original.orderNo, 'retry')).order;
  assert.equal(retried.orderNo, original.orderNo); assert.equal(retried.paymentId, original.paymentId);
  assert.notEqual(retried.attemptId, original.attemptId); assert.equal(retried.attemptStatus, 'PENDING');
  const keys = h.query('SELECT idempotency_key FROM billing_attempts ORDER BY generation');
  assert.equal(keys[0].idempotency_key, firstKey); assert.notEqual(keys[1].idempotency_key, firstKey);
  assert.equal((await c.action(original.orderNo, 'mock-complete')).entitlement.accountEndsAt, h.now() + 30 * DAY);
});

test('late signed payment success overrides confirmed closure and grants once', async t => {
  const h = await setup(t), c = await registered(h), original = (await c.create()).order;
  assert.equal((await c.action(original.orderNo, 'close')).order.attemptStatus, 'CLOSED');
  const event = h.event(original); await h.notification(event);
  const paid = (await c.detail(original.orderNo)).order;
  assert.equal(paid.status, 'PAID'); assert.equal(paid.attemptStatus, 'SUCCEEDED');
  assert.equal((await c.action(original.orderNo, 'retry')).order.status, 'PAID');
  assert.equal(h.query('SELECT * FROM billing_attempts').length, 1);
});

test('payment winning a close race remains PAID with the purchased duration', async t => {
  const h = await setup(t, { paymentOptions: { mode: 'mock', mockOptions: {
    beforeClose: async ({ businessOrderNo, complete }) => { await complete(businessOrderNo); },
  } } }), c = await registered(h), original = (await c.create()).order;
  const result = await c.action(original.orderNo, 'close');
  assert.equal(result.order.status, 'PAID'); assert.equal(result.entitlement.accountEndsAt, BASE + 30 * DAY);
  assert.equal(h.query('SELECT * FROM billing_events').length, 1);
});

test('provider response lost after create recovers by business number without a second payment', async t => {
  let once = true;
  const h = await setup(t, { paymentOptions: { mode: 'mock', mockOptions: {
    afterRequest: async ({ rawTarget }) => { if (once && rawTarget.endsWith('/native')) { once = false; throw new Error('lost response'); } },
  } } }), c = await registered(h);
  const uncertain = (await c.create()).order;
  assert.equal(uncertain.attemptStatus, 'UNKNOWN'); assert.equal(uncertain.codeUrl, null);
  assert.equal(uncertain.lastError, 'PAYMENT_RESULT_UNKNOWN');
  const recovered = (await c.detail(uncertain.orderNo)).order;
  assert.equal(recovered.attemptStatus, 'PENDING'); assert.ok(recovered.codeUrl);
  assert.equal(h.query('SELECT * FROM billing_mock_attempts').length, 1);
  assert.equal(h.query('SELECT * FROM billing_attempts').length, 1);
});

test('create request lost before provider acceptance replays original persisted idempotency key', async t => {
  let once = true;
  const h = await setup(t, { paymentOptions: { mode: 'mock', mockOptions: {
    beforeRequest: async ({ rawTarget }) => { if (once && rawTarget.endsWith('/native')) { once = false; throw new Error('request never arrived'); } },
  } } }), c = await registered(h);
  const uncertain = (await c.create()).order, key = h.query('SELECT idempotency_key FROM billing_attempts')[0].idempotency_key;
  assert.equal(uncertain.attemptStatus, 'UNKNOWN'); assert.equal(h.query('SELECT * FROM billing_mock_attempts').length, 0);
  const recovered = (await c.action(uncertain.orderNo, 'retry')).order;
  assert.equal(recovered.attemptStatus, 'PENDING');
  assert.equal(h.query('SELECT * FROM billing_mock_attempts')[0].idempotency_key, key);
});

test('signed notification can arrive before create response without regressing paid state', async t => {
  const h = await setup(t, { paymentOptions: { mode: 'mock', mockOptions: { completeBeforeCreateResponse: true } } }), c = await registered(h);
  const result = await c.create();
  assert.equal(result.order.status, 'PAID'); assert.equal(result.order.attemptStatus, 'SUCCEEDED');
  assert.equal(result.entitlement.accountEndsAt, BASE + 30 * DAY);
  assert.equal(h.query('SELECT * FROM billing_events').length, 1);
});

test('failed callback leaves provider paid but business unfulfilled until same event is retried', async t => {
  let blocked = true;
  const h = await setup(t, { paymentOptions: { mode: 'mock', mockOptions: {
    beforeNotification: async () => { if (blocked) throw new Error('receiver temporarily unavailable'); },
  } } }), c = await registered(h), order = (await c.create()).order;
  const pending = await c.action(order.orderNo, 'mock-complete');
  assert.equal(pending.order.status, 'UNPAID'); assert.equal(pending.order.paymentStatus, 'PAID');
  assert.equal(pending.order.needsAttention, true); assert.equal(pending.entitlement.accountEndsAt, null);
  const eventId = h.query('SELECT * FROM billing_mock_payments')[0].event_id;
  blocked = false;
  const result = await c.action(order.orderNo, 'mock-notify-retry');
  assert.equal(result.order.status, 'PAID'); assert.equal(result.entitlement.accountEndsAt, BASE + 30 * DAY);
  assert.equal(h.query('SELECT * FROM billing_events')[0].event_id, eventId);
  await c.action(order.orderNo, 'mock-notify-retry');
  assert.equal(h.query('SELECT * FROM billing_events').length, 1);
});

test('order, event dedupe and duration roll back together when the entitlement write fails', async t => {
  const h = await setup(t), c = await registered(h), order = (await c.create()).order;
  h.exec("CREATE TRIGGER billing_test_failure BEFORE UPDATE OF account_ends_at ON auth_users BEGIN SELECT RAISE(ABORT,'test write failed'); END");
  const pending = await c.action(order.orderNo, 'mock-complete');
  assert.equal(pending.order.status, 'UNPAID'); assert.equal(pending.entitlement.accountEndsAt, null);
  assert.equal(h.query('SELECT * FROM billing_events').length, 0);
  assert.equal(h.query('SELECT * FROM billing_orders')[0].granted_at, null);
  h.exec('DROP TRIGGER billing_test_failure');
  const paid = await c.action(order.orderNo, 'mock-notify-retry');
  assert.equal(paid.order.status, 'PAID'); assert.equal(paid.entitlement.accountEndsAt, BASE + 30 * DAY);
  assert.equal(h.query('SELECT * FROM billing_events').length, 1);
});

test('orders, mock keys, provider payment facts and grant dedupe survive service restart', async t => {
  const h = await setup(t), c = await registered(h), order = (await c.create()).order;
  const originalConfig = h.config(), key = h.query('SELECT idempotency_key FROM billing_attempts')[0].idempotency_key;
  h.reopen();
  assert.deepEqual(h.config(), originalConfig);
  assert.equal((await c.detail(order.orderNo)).order.attemptId, order.attemptId);
  assert.equal(h.query('SELECT idempotency_key FROM billing_attempts')[0].idempotency_key, key);
  const paid = await c.action(order.orderNo, 'mock-complete');
  h.reopen();
  assert.equal((await c.action(order.orderNo, 'mock-notify-retry')).entitlement.accountEndsAt, paid.entitlement.accountEndsAt);
  assert.equal(h.query('SELECT * FROM billing_events').length, 1);
  const exposed = JSON.stringify(await c.call('/api/billing/orders'));
  assert.equal(exposed.includes(originalConfig.apiSecretBase64), false);
  assert.equal(exposed.includes(originalConfig.notifySecretBase64), false);
});

test('mock mode ignores live credentials and never calls the supplied external fetch', async t => {
  let calls = 0;
  const h = await setup(t, { paymentOptions: { mode: 'mock', config: { baseUrl: 'https://real-provider.invalid' },
    fetchImpl: async () => { calls++; throw new Error('external fetch must not run'); } } }), c = await registered(h);
  const no = (await c.create()).order.orderNo;
  assert.equal((await c.action(no, 'mock-complete')).order.status, 'PAID');
  assert.equal(calls, 0);
});

test('independent SQLite workers reuse one active order, one idempotency key and one provider payment', async t => {
  const h = await setup(t), c = await registered(h);
  const work = () => ({ request: { method: 'POST', headers: { cookie: c.cookie(), 'x-csrf-token': c.csrf } },
    pathname: '/api/billing/orders', body: { planId: 'monthly', requestId: randomUUID() }, clientIp: '127.0.0.1', allowMock: true });
  const results = await raceWorkers(h, [work(), work()]);
  assert.equal(new Set(results.map(result => result.order.orderNo)).size, 1);
  const no = results[0].order.orderNo;
  assert.equal((await c.detail(no)).order.attemptStatus, 'PENDING');
  assert.equal(h.query('SELECT * FROM billing_orders').length, 1);
  assert.equal(h.query('SELECT * FROM billing_attempts').length, 1);
  assert.equal(h.query('SELECT * FROM billing_mock_payments').length, 1);
  assert.equal(h.query('SELECT * FROM billing_mock_attempts').length, 1);
});

test('independent SQLite notifications deduplicate one event and atomically stack different orders', async t => {
  const h = await setup(t), c = await registered(h), first = (await c.create()).order;
  const firstEvent = h.event(first);
  const duplicate = h.notificationRequest(firstEvent);
  await raceWorkers(h, [{ notification: duplicate }, { notification: duplicate }]);
  assert.equal((await c.init()).entitlement.accountEndsAt, BASE + 30 * DAY);
  assert.equal(h.query('SELECT * FROM billing_events').length, 1);
  const second = (await c.create('quarterly')).order; await c.action(second.orderNo, 'close');
  const third = (await c.create('yearly')).order;
  await raceWorkers(h, [{ notification: h.notificationRequest(h.event(second)) }, { notification: h.notificationRequest(h.event(third)) }]);
  assert.equal((await c.init()).entitlement.accountEndsAt, BASE + (30 + 90 + 365) * DAY);
  assert.equal(h.query("SELECT * FROM billing_orders WHERE status='PAID'").length, 3);
  assert.equal(h.query('SELECT * FROM billing_events').length, 3);
});

test('a stale closed-attempt query cannot deactivate a newer attempt reserved by another process', async t => {
  let interfere = false, h;
  h = await setup(t, { paymentOptions: { mode: 'mock', mockOptions: {
    afterRequest: async ({ rawTarget }) => {
      if (interfere && /^\/api\/v1\/payments\/mock_pay_[^/]+$/.test(rawTarget)) {
        interfere = false;
        h.exec(`INSERT INTO billing_attempts(id,order_no,generation,idempotency_key,status,created_at)
          SELECT 'next-reserved',order_no,2,'next-reserved-idempotency','CREATING',${BASE + 1} FROM billing_orders;
          UPDATE billing_orders SET active=1;`);
      }
    },
  } } });
  const c = await registered(h), order = (await c.create()).order;
  await c.action(order.orderNo, 'close'); interfere = true;
  const result = await c.detail(order.orderNo);
  assert.equal(result.order.attemptStatus, 'CREATING'); assert.equal(result.order.active, true);
  assert.equal(h.query('SELECT * FROM billing_attempts WHERE generation=2')[0].provider_attempt_id, null);
});

test('persisted project binding rejects a payment from a replaced project, and order description is durable', async t => {
  const h = await setup(t), c = await registered(h), order = (await c.create()).order;
  const row = h.query('SELECT * FROM billing_orders')[0], provider = h.query('SELECT * FROM billing_mock_payments')[0];
  assert.equal(row.description, provider.description); assert.equal(row.project_code, 'type_mock');
  h.exec("UPDATE billing_orders SET project_code='replaced_project'");
  await rejected(h.notification(h.event(order)), 'PAYMENT_ORDER_MISMATCH');
  await rejected(c.detail(order.orderNo), 'PAYMENT_ORDER_MISMATCH');
  assert.equal(h.query('SELECT * FROM billing_events').length, 0);
});

test('live adapter with an isolated fake transport refuses mock controls and fulfils only a signed callback', async t => {
  const { signPaymentRequest } = await import('../payment-client.mjs');
  const config = { baseUrl: 'https://fake-live-provider.invalid', projectCode: 'fake_live_type', apiKeyId: 'fake_api',
    apiSecretBase64: randomBytes(32).toString('base64'), notifyKeyId: 'fake_notify',
    notifySecretBase64: randomBytes(32).toString('base64'), notifyUrl: 'https://type.where.work/payments/notify' };
  let provider, calls = 0;
  const h = await setup(t, { paymentOptions: { mode: 'live', config, fetchImpl: async (_url, request) => {
    calls++;
    if (request.body) {
      const input = JSON.parse(request.body);
      provider = { paymentId: 'fake_live_payment', businessOrderNo: input.businessOrderNo, amountFen: input.amountFen,
        currency: 'CNY', paymentStatus: 'UNPAID', attemptId: 'fake_live_attempt', attemptStatus: 'PENDING',
        codeUrl: 'weixin://wxpay/bizpayurl?pr=FAKE_NOT_PAYABLE', expiresAt: new Date(BASE + 900000).toISOString() };
    }
    return new Response(JSON.stringify(provider), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } } }), c = await registered(h), order = (await c.create()).order;
  assert.equal((await c.init()).entitlement.accountEndsAt, null);
  await rejected(c.action(order.orderNo, 'mock-complete'), 'MOCK_PAYMENT_DISABLED');
  await rejected(c.action(order.orderNo, 'mock-notify-retry'), 'MOCK_PAYMENT_DISABLED');
  const event = h.event(order, { projectCode: config.projectCode }), rawBody = Buffer.from(JSON.stringify(event));
  const rawTarget = '/payments/notify';
  const signed = signPaymentRequest({ method: 'POST', rawTarget, projectCode: config.projectCode,
    keyId: config.notifyKeyId, timestamp: Math.floor(BASE / 1000), nonce: randomBytes(24).toString('hex'), rawBody,
    secretBase64: config.notifySecretBase64 });
  assert.deepEqual(await h.service.receivePaymentNotification({ request: { method: 'POST', headers: signed.headers }, rawTarget,
    rawBody, rawHeaders: Object.entries(signed.headers).flat() }), { eventId: event.eventId, status: 'ACK' });
  assert.equal((await c.init()).entitlement.accountEndsAt, BASE + 30 * DAY);
  assert.equal(calls, 1);
});

test('trusted operator can inspect a sanitized order and retry the same paid notification without granting twice', async t => {
  let blocked = true;
  const h = await setup(t, { paymentOptions: { mode: 'mock', mockOptions: {
    beforeNotification: async () => { if (blocked) throw new Error('temporary receiver outage'); },
  } } }), c = await registered(h), created = (await c.create()).order;
  assert.throws(() => h.service.getBillingOrder('missing-order'), error => error.code === 'ORDER_NOT_FOUND');
  await rejected(h.service.retryBillingNotification(created.orderNo), 'NOT_PAID');
  await c.action(created.orderNo, 'mock-complete');
  const waiting = h.service.getBillingOrder(created.orderNo);
  assert.equal(waiting.status, 'UNPAID'); assert.equal(waiting.paymentStatus, 'PAID'); assert.equal(waiting.needsAttention, true);
  blocked = false;
  const fixed = await h.service.retryBillingNotification(created.orderNo);
  assert.equal(fixed.status, 'PAID'); assert.equal(fixed.entitlementEndsAt, BASE + 30 * DAY);
  assert.equal((await h.service.retryBillingNotification(created.orderNo)).entitlementEndsAt, fixed.entitlementEndsAt);
  const encoded = JSON.stringify(fixed), config = h.config();
  assert.equal(encoded.includes(config.apiSecretBase64), false); assert.equal(encoded.includes(config.notifySecretBase64), false);
  assert.equal(h.query('SELECT * FROM billing_events').length, 1);
});

test('operator acceptance creates only the fixed one-fen SKU without exposing a discounted public plan', async t => {
  const h = await setup(t), c = await registered(h), userId = (await c.init()).user.id, requestId = randomUUID();
  const order = await h.service.createPaymentAcceptanceOrder({ userId, requestId });
  assert.equal(order.planId, 'acceptance_1fen'); assert.equal(order.planName, '支付接入验收');
  assert.equal(order.amountFen, 1); assert.equal(order.days, 1); assert.equal(order.currency, 'CNY');
  assert.equal(order.status, 'UNPAID'); assert.equal(order.attemptStatus, 'PENDING');
  assert.equal((await c.init()).entitlement.accountEndsAt, null);
  assert.deepEqual((await c.call('/api/billing/plans')).plans.map(plan => plan.id), ['monthly', 'quarterly', 'yearly']);
  for (const body of [
    { planId: 'acceptance_1fen', requestId: randomUUID() },
    { planId: 'monthly', requestId: randomUUID(), amountFen: 1 },
    { planId: 'monthly', requestId: randomUUID(), acceptance: true },
  ]) await rejected(c.call('/api/billing/orders', body), 'INVALID_ORDER');
  await rejected(c.call('/api/billing/acceptance', { userId, requestId: randomUUID() }), 'NOT_FOUND');
  const row = h.query('SELECT * FROM billing_orders')[0], provider = h.query('SELECT * FROM billing_mock_payments')[0];
  assert.equal(row.plan_name, '支付接入验收'); assert.equal(provider.amount_fen, 1);
  assert.equal(provider.description, '火星叔叔雅思作文练习 - 支付接入验收');
  assert.equal((await c.detail(order.orderNo)).order.planName, '支付接入验收');
  const other = await registered(h); await rejected(other.detail(order.orderNo), 'ORDER_NOT_FOUND');
});

test('acceptance requires an existing account, explicit valid request ID and fixed server fields', async t => {
  const h = await setup(t), c = await registered(h), userId = (await c.init()).user.id;
  for (const input of [null, {}, [], { userId }, { userId, requestId: 'invalid' },
    { userId, requestId: randomUUID(), amountFen: 99 }, { userId, requestId: randomUUID(), days: 365 },
    { userId, requestId: randomUUID(), planId: 'monthly' }, { userId, requestId: randomUUID(), description: 'override' }]) {
    await rejected(h.service.createPaymentAcceptanceOrder(input), 'INVALID_ACCEPTANCE_ORDER');
  }
  await rejected(h.service.createPaymentAcceptanceOrder({ userId: randomUUID(), requestId: randomUUID() }), 'USER_NOT_FOUND');
  assert.equal(h.query('SELECT * FROM billing_orders').length, 0);
  const disabled = await setup(t, { paymentOptions: { mode: 'disabled' } }), d = await registered(disabled);
  await rejected(disabled.service.createPaymentAcceptanceOrder({ userId: (await d.init()).user.id, requestId: randomUUID() }), 'PAYMENT_DISABLED');
});

test('acceptance requests reuse one order and payment, preserve paid results and cannot replace a normal active order', async t => {
  const h = await setup(t), c = await registered(h), userId = (await c.init()).user.id, requestId = randomUUID();
  const orders = await Promise.all([
    h.service.createPaymentAcceptanceOrder({ userId, requestId }),
    h.service.createPaymentAcceptanceOrder({ userId, requestId }),
    h.service.createPaymentAcceptanceOrder({ userId, requestId: randomUUID() }),
  ]);
  assert.equal(new Set(orders.map(order => order.orderNo)).size, 1);
  assert.equal(h.query('SELECT * FROM billing_orders').length, 1); assert.equal(h.query('SELECT * FROM billing_mock_attempts').length, 1);
  await rejected(c.create('monthly', requestId), 'ORDER_REQUEST_CONFLICT');
  await rejected(c.create(), 'ACTIVE_ORDER_EXISTS');
  const paid = await c.action(orders[0].orderNo, 'mock-complete');
  assert.equal(paid.entitlement.accountEndsAt, BASE + DAY); assert.equal(paid.entitlement.paidUntil, BASE + DAY);
  assert.equal((await h.service.createPaymentAcceptanceOrder({ userId, requestId })).status, 'PAID');
  await h.service.retryBillingNotification(orders[0].orderNo);
  assert.equal((await c.init()).entitlement.accountEndsAt, BASE + DAY); assert.equal(h.query('SELECT * FROM billing_events').length, 1);
  const normal = (await c.create('monthly')).order;
  assert.equal(normal.amountFen, 990); assert.equal(normal.days, 30);
  await rejected(h.service.createPaymentAcceptanceOrder({ userId, requestId: randomUUID() }), 'ACTIVE_ORDER_EXISTS');
  const second = await registered(h), normalRequestId = randomUUID(), normalUserId = (await second.init()).user.id;
  await second.create('yearly', normalRequestId);
  await rejected(h.service.createPaymentAcceptanceOrder({ userId: normalUserId, requestId: normalRequestId }), 'ORDER_REQUEST_CONFLICT');
});

test('acceptance name migration and uncertain create recovery preserve original one-fen payment request', async t => {
  let once = true;
  const h = await setup(t, { paymentOptions: { mode: 'mock', mockOptions: {
    afterRequest: async ({ rawTarget }) => { if (once && rawTarget.endsWith('/native')) { once = false; throw new Error('lost acceptance response'); } },
  } } }), c = await registered(h), userId = (await c.init()).user.id, requestId = randomUUID();
  const uncertain = await h.service.createPaymentAcceptanceOrder({ userId, requestId });
  assert.equal(uncertain.attemptStatus, 'UNKNOWN');
  const originalKey = h.query('SELECT * FROM billing_attempts')[0].idempotency_key;
  h.exec('ALTER TABLE billing_orders DROP COLUMN plan_name'); h.reopen();
  const recovered = await h.service.createPaymentAcceptanceOrder({ userId, requestId });
  assert.equal(recovered.orderNo, uncertain.orderNo); assert.equal(recovered.attemptStatus, 'PENDING');
  assert.equal(recovered.planName, '支付接入验收'); assert.equal(recovered.amountFen, 1); assert.equal(recovered.days, 1);
  assert.equal(h.query('SELECT * FROM billing_attempts')[0].idempotency_key, originalKey);
  assert.equal(h.query('SELECT * FROM billing_mock_payments').length, 1); assert.equal(h.query('SELECT * FROM billing_mock_attempts').length, 1);
  assert.equal(h.query('SELECT * FROM billing_orders')[0].plan_name, '支付接入验收');
});

test('one-fen fake-live acceptance uses the normal signed notification transaction and stacks exactly one day once', async t => {
  const { signPaymentRequest } = await import('../payment-client.mjs');
  const config = { baseUrl: 'https://fake-acceptance-provider.invalid', projectCode: 'fake_acceptance_type', apiKeyId: 'acceptance_api',
    apiSecretBase64: randomBytes(32).toString('base64'), notifyKeyId: 'acceptance_notify',
    notifySecretBase64: randomBytes(32).toString('base64'), notifyUrl: 'https://type.where.work/payments/notify' };
  const calls = [];
  const h = await setup(t, { paymentOptions: { mode: 'live', config, fetchImpl: async (url, request) => {
    assert.equal(new URL(url).origin, config.baseUrl);
    const body = request.body ? JSON.parse(request.body) : null; calls.push({ url, body, headers: request.headers });
    return new Response(JSON.stringify({ paymentId: 'fake_acceptance_pay', businessOrderNo: body.businessOrderNo, amountFen: body.amountFen,
      currency: 'CNY', paymentStatus: 'UNPAID', attemptId: 'fake_acceptance_attempt', attemptStatus: 'PENDING',
      codeUrl: 'weixin://wxpay/bizpayurl?pr=ACCEPTANCE_FAKE', expiresAt: new Date(BASE + 900000).toISOString() }),
    { status: 201, headers: { 'Content-Type': 'application/json' } });
  } } }), c = await registered(h);
  const before = await c.call('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) });
  const order = await h.service.createPaymentAcceptanceOrder({ userId: before.user.id, requestId: randomUUID() });
  assert.equal(order.amountFen, 1); assert.equal(order.mode, 'live');
  assert.equal(calls.length, 1); assert.equal(calls[0].body.amountFen, 1);
  assert.equal(calls[0].body.description, '火星叔叔雅思作文练习 - 支付接入验收');
  assert.equal(calls[0].body.expiresInSeconds, 900); assert.equal((await c.init()).entitlement.accountEndsAt, before.entitlement.accountEndsAt);
  await rejected(c.action(order.orderNo, 'mock-complete'), 'MOCK_PAYMENT_DISABLED');
  const event = h.event(order, { projectCode: config.projectCode });
  async function deliver(changes = {}) {
    const rawBody = Buffer.from(JSON.stringify({ ...event, ...changes })), rawTarget = '/payments/notify';
    const signed = signPaymentRequest({ method: 'POST', rawTarget, projectCode: config.projectCode, keyId: config.notifyKeyId,
      timestamp: Math.floor(BASE / 1000), nonce: randomBytes(24).toString('hex'), rawBody, secretBase64: config.notifySecretBase64 });
    return h.service.receivePaymentNotification({ request: { method: 'POST', headers: signed.headers }, rawTarget,
      rawBody, rawHeaders: Object.entries(signed.headers).flat() });
  }
  await rejected(deliver({ amountFen: 990 }), 'PAYMENT_ORDER_MISMATCH');
  assert.equal((await c.init()).entitlement.accountEndsAt, before.entitlement.accountEndsAt);
  assert.deepEqual(await deliver(), { eventId: event.eventId, status: 'ACK' });
  await deliver();
  const paid = h.service.getBillingOrder(order.orderNo), after = await c.init();
  assert.equal(paid.status, 'PAID'); assert.equal(paid.planName, '支付接入验收'); assert.equal(paid.amountFen, 1);
  assert.equal(paid.entitlementEndsAt, before.entitlement.accountEndsAt + DAY);
  assert.equal(after.entitlement.accountEndsAt, before.entitlement.accountEndsAt + DAY); assert.equal(after.entitlement.paidUntil, after.entitlement.accountEndsAt);
  assert.equal(h.query('SELECT * FROM billing_events').length, 1); assert.equal(calls.length, 1);
});
