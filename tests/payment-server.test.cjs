'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readFileSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { createTestAuth } = require('./auth-fixture.cjs');

const apiSecretBase64 = Buffer.alloc(32, 0x12).toString('base64');
const notifySecretBase64 = Buffer.alloc(32, 0x89).toString('base64');
const paymentConfig = {
  baseUrl: 'https://pay.where.work', projectCode: 'type-test', apiKeyId: 'api-test', apiSecretBase64,
  notifyKeyId: 'notify-test', notifySecretBase64, notifyUrl: 'https://billing.example.test/payments/notify',
};

async function fixture(t, options = {}) {
  const { createServer } = await import('../translation-server.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(path.join(tmpdir(), 'type-payment-http-'));
  const filename = path.join(directory, 'auth.sqlite');
  let timestamp = Date.UTC(2026, 9, 16, 8, 0, 0);
  const authService = await createTestAuth({ filename, now: () => timestamp,
    paymentOptions: { mode: 'mock', config: paymentConfig, ...options.paymentOptions },
  });
  const server = createServer({ authService, configured: true,
    translate: async () => ({ translation: '测试译文' }), analyze: async () => ({ analysis: {} }),
    review: async () => ({ review: {} }), titleArticle: async () => ({ title: '测试标题' }),
    ...options.serverOptions,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    authService.close();
    for (const item of readdirSync(directory)) {
      const resolved = path.resolve(directory, item);
      assert.ok(resolved.startsWith(path.resolve(directory) + path.sep));
      assert.match(item, /^auth\.sqlite(?:-wal|-shm)?$/);
      unlinkSync(resolved);
    }
    rmdirSync(directory);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let clientNumber = 0;
  function client() {
    const cookies = new Map();
    let csrfToken;
    const userAgent = `Payment HTTP fixture browser ${++clientNumber}`;
    function request(path, { method = 'GET', body, rawBody, headers = {}, jar = true } = {}) {
      return new Promise((resolve, reject) => {
        const outgoing = {
          'User-Agent': userAgent,
          ...(jar ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
          ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) } : {}),
          ...headers,
        };
        for (const [key, value] of Object.entries(outgoing)) if (value === undefined || value === null) delete outgoing[key];
        const req = http.request(`${origin}${path}`, { method, headers: outgoing }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            for (const item of response.headers['set-cookie'] || []) {
              if (!jar) continue;
              const pair = item.split(';')[0], equals = pair.indexOf('=');
              cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
            }
            const text = Buffer.concat(chunks).toString('utf8');
            let data; try { data = JSON.parse(text); } catch { /* SVG/static/error bodies may not be JSON. */ }
            if (jar && data?.csrfToken) csrfToken = data.csrfToken;
            resolve({ status: response.statusCode, headers: response.headers, data, text });
          });
        });
        req.on('error', reject);
        req.end(rawBody !== undefined ? rawBody : body === undefined ? '' : JSON.stringify(body));
      });
    }
    const post = (path, body = {}, settings = {}) => request(path, { method: 'POST', body, ...settings });
    async function register(email = `billing-${clientNumber}@example.test`, headers = {}) {
      assert.equal((await request('/api/auth/session', { headers })).status, 200);
      const result = await post('/api/auth/register', { nickname: '练习同学', email, password: 'Payment-test-password-1234' }, { headers });
      assert.equal(result.status, 200, result.text);
      return result.data;
    }
    return { request, post, register, cookies, get csrfToken() { return csrfToken; } };
  }
  const primary = client();
  function readDb(sql, ...parameters) {
    const db = new DatabaseSync(filename, { readOnly: true });
    try { return db.prepare(sql).get(...parameters); } finally { db.close(); }
  }
  function mockConfig() {
    return { baseUrl: 'https://payment-mock.invalid', projectCode: 'type_mock', apiKeyId: 'mock_api_v1',
      apiSecretBase64: readDb('SELECT value FROM auth_settings WHERE key=?', 'billing_mock_api_secret').value,
      notifyKeyId: 'mock_notify_v1', notifySecretBase64: readDb('SELECT value FROM auth_settings WHERE key=?', 'billing_mock_notify_secret').value,
      notifyUrl: 'https://type.where.work/payments/notify' };
  }
  function mockEvent(orderNo) {
    const row = readDb('SELECT * FROM billing_mock_payments WHERE business_order_no=?', orderNo);
    const succeeded = readDb("SELECT * FROM billing_mock_attempts WHERE payment_id=? AND attempt_status='SUCCEEDED'", row.payment_id);
    return { eventId: row.event_id, eventType: 'PAYMENT.SUCCEEDED', projectCode: 'type_mock', paymentId: row.payment_id,
      attemptId: succeeded.attempt_id, businessOrderNo: row.business_order_no, amountFen: row.amount_fen,
      currency: 'CNY', wechatTransactionId: row.transaction_id, paidAt: new Date(row.paid_at).toISOString() };
  }
  async function signedNotification(event, changed = {}) {
    const { signPaymentRequest } = await import('../payment-client.mjs');
    const config = mockConfig();
    const rawBody = Buffer.from(JSON.stringify(event));
    const rawTarget = changed.rawTarget || '/payments/notify';
    const signed = signPaymentRequest({ method: 'POST', rawTarget, projectCode: config.projectCode, keyId: config.notifyKeyId,
      timestamp: Math.floor(timestamp / 1000), nonce: randomBytes(24).toString('hex'), rawBody, secretBase64: config.notifySecretBase64 });
    return primary.request(rawTarget, { method: 'POST', rawBody, jar: false,
      headers: { Origin: undefined, 'X-CSRF-Token': undefined, ...signed.headers, ...changed.headers } });
  }
  return { ...primary, client, authService, readDb, mockConfig, mockEvent, signedNotification,
    now: () => timestamp, advance: ms => { timestamp += ms; } };
}

function assertPrivate(data, config = {}) {
  const text = JSON.stringify(data);
  for (const secret of [apiSecretBase64, notifySecretBase64, config.apiSecretBase64, config.notifySecretBase64,
    'apiSecretBase64', 'notifySecretBase64', 'apiKeyId', 'notifyKeyId'].filter(Boolean)) assert.equal(text.includes(secret), false);
}

test('billing catalogue is public JSON and private modules and signing secrets stay off HTTP', async t => {
  const f = await fixture(t);
  const catalogue = await f.request('/api/billing/plans');
  assert.equal(catalogue.status, 200, catalogue.text);
  assert.equal(catalogue.headers['cache-control'], 'no-store');
  assert.equal(catalogue.data.billing.mode, 'mock');
  assert.equal(catalogue.data.billing.available, true);
  assert.deepEqual(catalogue.data.plans.map(plan => [plan.id, plan.amountFen, plan.days, plan.currency]), [
    ['monthly', 990, 30, 'CNY'], ['quarterly', 1990, 90, 'CNY'], ['yearly', 5990, 365, 'CNY'],
  ]);
  assertPrivate(catalogue.data, f.mockConfig());
  for (const path of ['/payment-client.mjs', '/payment-mock.mjs', '/payment-admin.mjs', '/.env', '/.data/auth.sqlite', '/.deploy/payment-config.json']) {
    assert.equal((await f.request(path)).status, 404, path);
  }
});

test('server fixes prices and durations, rejects tampered fields and durably reuses a pending order', async t => {
  const f = await fixture(t);
  await f.register();
  for (const body of [
    { planId: 'monthly', requestId: randomUUID(), amountFen: 1 },
    { planId: 'monthly', requestId: randomUUID(), days: 9999 },
    { planId: 'monthly', requestId: randomUUID(), userId: 'someone-else' },
    { planId: 'unknown', requestId: randomUUID() }, { planId: 'monthly', requestId: 'not-a-uuid' },
  ]) assert.equal((await f.post('/api/billing/orders', body)).status, 400);
  const requestId = randomUUID();
  const first = await f.post('/api/billing/orders', { planId: 'monthly', requestId });
  assert.equal(first.status, 200, first.text);
  const order = first.data.order;
  assert.equal(order.amountFen, 990);
  assert.equal(order.days, 30);
  assert.equal(order.currency, 'CNY');
  assert.equal(order.mode, 'mock');
  assert.equal(order.status, 'UNPAID');
  assert.equal(order.paymentStatus, 'UNPAID');
  assert.equal(order.attemptStatus, 'PENDING');
  assert.match(order.codeUrl, /^mock-payment:\/\//);
  assert.equal(first.data.entitlement.accountEndsAt, null);
  assertPrivate(first.data, f.mockConfig());
  for (const repeated of [requestId, randomUUID()]) {
    const response = await f.post('/api/billing/orders', { planId: 'monthly', requestId: repeated });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.data.order.orderNo, order.orderNo);
    assert.equal(response.data.order.attemptId, order.attemptId);
  }
  assert.equal((await f.post('/api/billing/orders', { planId: 'quarterly', requestId })).status, 409);
  assert.equal((await f.post('/api/billing/orders', { planId: 'yearly', requestId: randomUUID() })).status, 409);
  const listed = await f.request('/api/billing/orders');
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.data.orders.length, 1);
  const detail = await f.request(`/api/billing/orders/${order.orderNo}`);
  assert.equal(detail.data.order.paymentId, order.paymentId);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_mock_payments').count, 1);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_attempts').count, 1);
});

test('order ownership covers details, history and every write action, with no cross-account disclosure', async t => {
  const f = await fixture(t);
  await f.register('owner@example.test');
  const created = await f.post('/api/billing/orders', { planId: 'quarterly', requestId: randomUUID() });
  assert.equal(created.status, 200, created.text);
  const orderNo = created.data.order.orderNo;
  const other = f.client();
  await other.register('other@example.test');
  const history = await other.request('/api/billing/orders');
  assert.equal(history.status, 200, history.text);
  assert.deepEqual(history.data.orders, []);
  assert.equal((await other.request(`/api/billing/orders/${orderNo}`)).status, 404);
  for (const action of ['sync', 'close', 'retry', 'mock-complete', 'mock-notify-retry']) {
    const response = await other.post(`/api/billing/orders/${orderNo}/${action}`);
    assert.equal(response.status, 404, `${action}: ${response.text}`);
    assert.equal(response.data.order, undefined);
  }
  const unchanged = await f.request(`/api/billing/orders/${orderNo}`);
  assert.equal(unchanged.data.order.status, 'UNPAID');
  assert.equal(unchanged.data.order.attemptStatus, 'PENDING');
});

test('simultaneous checkout requests for one account share one order and one provider attempt', async t => {
  const f = await fixture(t);
  await f.register();
  const responses = await Promise.all(Array.from({ length: 3 }, () => f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() })));
  for (const response of responses) assert.equal(response.status, 200, response.text);
  assert.equal(new Set(responses.map(response => response.data.order.orderNo)).size, 1);
  assert.equal(new Set(responses.map(response => response.data.order.attemptId)).size, 1);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_orders').count, 1);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_mock_payments').count, 1);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_attempts').count, 1);
});

test('all order actions reject bad CSRF before changing payment or granting time', async t => {
  const f = await fixture(t);
  await f.register();
  const created = await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() });
  assert.equal(created.status, 200, created.text);
  for (const action of ['sync', 'close', 'retry', 'mock-complete', 'mock-notify-retry']) {
    const response = await f.post(`/api/billing/orders/${created.data.order.orderNo}/${action}`, {}, { headers: { 'X-CSRF-Token': 'invalid' } });
    assert.equal(response.status, 403, `${action}: ${response.text}`);
  }
  const current = await f.request(`/api/billing/orders/${created.data.order.orderNo}`);
  assert.equal(current.data.order.attemptStatus, 'PENDING');
  assert.equal(current.data.entitlement.accountEndsAt, null);
});

test('mock completion commits the paid order and 30-day entitlement, signed duplicate callbacks only ACK', async t => {
  const f = await fixture(t);
  await f.register();
  const created = await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() });
  assert.equal(created.status, 200, created.text);
  const orderNo = created.data.order.orderNo;
  const completed = await f.post(`/api/billing/orders/${orderNo}/mock-complete`);
  assert.equal(completed.status, 200, completed.text);
  assert.equal(completed.data.order.status, 'PAID');
  assert.equal(completed.data.order.paymentStatus, 'PAID');
  assert.equal(completed.data.order.attemptStatus, 'SUCCEEDED');
  assert.equal(completed.data.order.codeUrl, null);
  assert.equal(completed.data.order.notificationStatus, 'ACK');
  assert.equal(completed.data.entitlement.accountEndsAt, f.now() + 30 * 86400000);
  assert.equal(completed.data.order.entitlementEndsAt, completed.data.entitlement.accountEndsAt);
  const event = f.mockEvent(orderNo);
  for (let count = 0; count < 2; count++) {
    const notified = await f.signedNotification(event);
    assert.equal(notified.status, 200, notified.text);
    assert.deepEqual(notified.data, { eventId: event.eventId, status: 'ACK' });
    assert.equal(notified.headers['content-type'].startsWith('application/json'), true);
  }
  const concurrent = await Promise.all(Array.from({ length: 3 }, () => f.signedNotification(event)));
  for (const response of concurrent) {
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.data, { eventId: event.eventId, status: 'ACK' });
  }
  const duplicate = await f.post(`/api/billing/orders/${orderNo}/mock-complete`);
  assert.equal(duplicate.data.entitlement.accountEndsAt, completed.data.entitlement.accountEndsAt);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_events').count, 1);
  const session = await f.request('/api/auth/session');
  assert.equal(session.data.entitlement.accountEndsAt, completed.data.entitlement.accountEndsAt);
});

test('paid time stacks onto an existing starter coupon and repeated delivery never extends it again', async t => {
  const f = await fixture(t);
  await f.register();
  const claimed = await f.post('/api/coupons/starter/claim', { fingerprint: 'c'.repeat(64) });
  assert.equal(claimed.status, 200, claimed.text);
  const before = claimed.data.entitlement.accountEndsAt;
  const created = await f.post('/api/billing/orders', { planId: 'yearly', requestId: randomUUID() });
  assert.equal(created.status, 200, created.text);
  const completed = await f.post(`/api/billing/orders/${created.data.order.orderNo}/mock-complete`);
  assert.equal(completed.status, 200, completed.text);
  assert.equal(completed.data.entitlement.accountEndsAt, before + 365 * 86400000);
  const retry = await f.post(`/api/billing/orders/${created.data.order.orderNo}/mock-notify-retry`);
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.data.entitlement.accountEndsAt, completed.data.entitlement.accountEndsAt);
});

test('notification audit records only committed matching HTTP ACKs and tolerates logger failures', async t => {
  const records = [];
  let failLogger = false;
  const f = await fixture(t, { serverOptions: { paymentNotificationLogger: record => {
    records.push(record);
    if (failLogger) throw new Error('simulated logger failure');
  } } });
  await f.register();
  const created = await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() });
  const orderNo = created.data.order.orderNo;
  const completed = await f.post(`/api/billing/orders/${orderNo}/mock-complete`);
  assert.equal(completed.status, 200);
  const event = f.mockEvent(orderNo);
  const bad = await f.signedNotification({ ...event, amountFen: event.amountFen + 1 });
  assert.equal(bad.status, 409);
  assert.deepEqual(records, []);
  const valid = await f.signedNotification(event);
  assert.equal(valid.status, 200);
  assert.deepEqual(records, [{ event: 'payment_notification_ack', eventId: event.eventId, status: 'ACK', httpStatus: 200 }]);
  failLogger = true;
  const repeated = await f.signedNotification(event);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.data, { eventId: event.eventId, status: 'ACK' });
  assert.equal(records.length, 2);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_events').count, 1);
  assert.equal((await f.request('/api/auth/session')).data.entitlement.accountEndsAt, completed.data.entitlement.accountEndsAt);
});

test('closing an unpaid attempt grants nothing and retry creates only a new attempt on the same order', async t => {
  const f = await fixture(t);
  await f.register();
  const created = await f.post('/api/billing/orders', { planId: 'quarterly', requestId: randomUUID() });
  assert.equal(created.status, 200, created.text);
  const first = created.data.order;
  const closed = await f.post(`/api/billing/orders/${first.orderNo}/close`);
  assert.equal(closed.status, 200, closed.text);
  assert.equal(closed.data.order.attemptStatus, 'CLOSED');
  assert.equal(closed.data.order.codeUrl, null);
  assert.equal(closed.data.entitlement.accountEndsAt, null);
  assert.equal((await f.post(`/api/billing/orders/${first.orderNo}/mock-complete`)).status, 409);
  const retried = await f.post(`/api/billing/orders/${first.orderNo}/retry`);
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.data.order.orderNo, first.orderNo);
  assert.equal(retried.data.order.paymentId, first.paymentId);
  assert.notEqual(retried.data.order.attemptId, first.attemptId);
  assert.equal(retried.data.order.attemptStatus, 'PENDING');
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_mock_payments').count, 1);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_attempts').count, 2);
  const completed = await f.post(`/api/billing/orders/${first.orderNo}/mock-complete`);
  assert.equal(completed.status, 200, completed.text);
  assert.equal(completed.data.entitlement.accountEndsAt, f.now() + 90 * 86400000);
});

test('expired QR cannot complete payment or create a parallel attempt before explicit closure', async t => {
  const f = await fixture(t);
  await f.register();
  const created = await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() });
  assert.equal(created.status, 200, created.text);
  const first = created.data.order;
  f.advance(900000);
  const expired = await f.request(`/api/billing/orders/${first.orderNo}`);
  assert.equal(expired.data.order.attemptStatus, 'EXPIRED');
  assert.equal(expired.data.order.codeUrl, null);
  assert.equal((await f.post(`/api/billing/orders/${first.orderNo}/mock-complete`)).status, 409);
  const beforeClose = await f.post(`/api/billing/orders/${first.orderNo}/retry`);
  assert.equal(beforeClose.status, 200, beforeClose.text);
  assert.equal(beforeClose.data.order.attemptId, first.attemptId);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_attempts').count, 1);
  assert.equal((await f.post(`/api/billing/orders/${first.orderNo}/close`)).data.order.attemptStatus, 'CLOSED');
  const retry = await f.post(`/api/billing/orders/${first.orderNo}/retry`);
  assert.equal(retry.data.order.attemptStatus, 'PENDING');
  assert.notEqual(retry.data.order.attemptId, first.attemptId);
});

test('lost create response recovers the existing provider payment and persisted idempotency key', async t => {
  let lost = false;
  const f = await fixture(t, { paymentOptions: { mockOptions: { afterRequest: ({ rawTarget }) => {
    if (!lost && rawTarget === '/api/v1/payments/native') { lost = true; throw new Error('simulated transport loss'); }
  } } } });
  await f.register();
  const requestId = randomUUID();
  const created = await f.post('/api/billing/orders', { planId: 'monthly', requestId });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.data.order.attemptStatus, 'UNKNOWN');
  const key = f.readDb('SELECT idempotency_key FROM billing_attempts').idempotency_key;
  const recovered = await f.request(`/api/billing/orders/${created.data.order.orderNo}`);
  assert.equal(recovered.status, 200, recovered.text);
  assert.equal(recovered.data.order.attemptStatus, 'PENDING');
  assert.equal(recovered.data.order.orderNo, created.data.order.orderNo);
  assert.equal(f.readDb('SELECT idempotency_key FROM billing_attempts').idempotency_key, key);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_mock_payments').count, 1);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_attempts').count, 1);
});

test('a paid provider snapshot does not grant time until its signed notification commits', async t => {
  let suppress = true;
  const f = await fixture(t, { paymentOptions: { mockOptions: { beforeNotification: () => { if (suppress) throw new Error('delivery outage'); } } } });
  await f.register();
  const created = await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() });
  assert.equal(created.status, 200, created.text);
  const orderNo = created.data.order.orderNo;
  const incomplete = await f.post(`/api/billing/orders/${orderNo}/mock-complete`);
  assert.equal(incomplete.status, 200, incomplete.text);
  assert.equal(incomplete.data.order.paymentStatus, 'PAID');
  assert.equal(incomplete.data.order.status, 'UNPAID');
  assert.equal(incomplete.data.order.needsAttention, true);
  assert.equal(incomplete.data.entitlement.accountEndsAt, null);
  suppress = false;
  const delivered = await f.post(`/api/billing/orders/${orderNo}/mock-notify-retry`);
  assert.equal(delivered.status, 200, delivered.text);
  assert.equal(delivered.data.order.status, 'PAID');
  assert.equal(delivered.data.entitlement.accountEndsAt, f.now() + 30 * 86400000);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_events').count, 1);
});

test('billing writes require an account, same origin, JSON and a valid anti-CSRF token', async t => {
  const f = await fixture(t);
  await f.request('/api/auth/session');
  assert.equal((await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() })).status, 401);
  await f.register();
  for (const headers of [{ Origin: undefined }, { Origin: 'https://attacker.example.test' }, { 'X-CSRF-Token': 'forged' }, { 'X-CSRF-Token': undefined }]) {
    assert.equal((await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() }, { headers })).status, 403);
  }
  assert.equal((await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/billing/orders', { method: 'POST', rawBody: '{broken' })).status, 400);
  assert.equal((await f.request('/api/billing/orders', { method: 'POST', rawBody: '[]' })).status, 400);
  assert.equal((await f.request('/api/billing/plans', { method: 'PUT' })).status, 405);
});

test('notification route caps bytes before parsing or authentication and never returns a success ACK for bad signatures', async t => {
  const f = await fixture(t);
  const common = { method: 'POST', jar: false, headers: { Origin: undefined, 'X-CSRF-Token': undefined } };
  const unsigned = await f.request('/payments/notify', { ...common, rawBody: '{}' });
  assert.equal(unsigned.status, 401, unsigned.text);
  assert.equal(unsigned.data?.status, undefined);
  assert.equal(unsigned.headers.location, undefined);
  const malformed = await f.request('/payments/notify', { ...common, rawBody: '{broken' });
  assert.equal(malformed.status, 401, malformed.text);
  const tooLarge = await f.request('/payments/notify', { ...common, rawBody: Buffer.alloc(65537, 0x20) });
  assert.equal(tooLarge.status, 413, tooLarge.text);
  assert.equal(tooLarge.data?.status, undefined);
  assert.equal((await f.request('/payments/notify')).status, 405);
});

test('signed callback conflicts reject rather than acknowledge or extend paid access', async t => {
  const f = await fixture(t);
  await f.register();
  const created = await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() });
  assert.equal(created.status, 200, created.text);
  const paid = await f.post(`/api/billing/orders/${created.data.order.orderNo}/mock-complete`);
  assert.equal(paid.status, 200, paid.text);
  const event = f.mockEvent(created.data.order.orderNo);
  for (const changed of [{ amountFen: 1 }, { paymentId: 'another-payment' }, { wechatTransactionId: 'another-transaction' }, { attemptId: 'unknown-attempt' }]) {
    const response = await f.signedNotification({ ...event, ...changed });
    assert.equal(response.status, 409, response.text);
    assert.notEqual(response.data?.status, 'ACK');
  }
  const unknownOrder = await f.signedNotification({ ...event, eventId: randomUUID(), businessOrderNo: 'unknown-order' });
  assert.equal(unknownOrder.status, 404, unknownOrder.text);
  const notSuccess = await f.signedNotification({ ...event, eventType: 'PAYMENT.PENDING' });
  assert.equal(notSuccess.status, 400, notSuccess.text);
  const badSignature = await f.signedNotification(event, { headers: { 'X-Pay-Signature': Buffer.alloc(32).toString('base64') } });
  assert.equal(badSignature.status, 401, badSignature.text);
  const duplicateHeader = await f.signedNotification(event, { headers: { 'X-Pay-Project': ['type_mock', 'type_mock'] } });
  assert.equal(duplicateHeader.status, 401, duplicateHeader.text);
  const queryTarget = await f.signedNotification(event, { rawTarget: '/payments/notify?changed=1' });
  assert.equal(queryTarget.status, 401, queryTarget.text);
  assert.equal((await f.request('/api/auth/session')).data.entitlement.accountEndsAt, paid.data.entitlement.accountEndsAt);
  assert.equal(f.readDb('SELECT count(*) AS count FROM billing_events').count, 1);
});

test('public HTTPS host hides mock checkout and rejects mock payment and notification mutation', async t => {
  const f = await fixture(t, { serverOptions: { publicOrigins: ['https://billing.example.test'], trustProxy: true } });
  await f.register();
  // A trusted reverse-proxy deployment blocks mock mode even when a client
  // forges a localhost Host header. The guard precedes any order lookup.
  const localhostCatalogue = await f.request('/api/billing/plans');
  assert.equal(localhostCatalogue.data.billing.available, false);
  const forgedLocal = await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() });
  assert.equal(forgedLocal.status, 403, forgedLocal.text);
  assert.equal(forgedLocal.data.code, 'MOCK_PAYMENT_LOCAL_ONLY');
  const headers = { Host: 'billing.example.test', Origin: 'https://billing.example.test', 'X-Forwarded-Proto': 'https' };
  const catalogue = await f.request('/api/billing/plans', { headers });
  assert.equal(catalogue.status, 200, catalogue.text);
  assert.equal(catalogue.data.billing.available, false);
  assert.equal(catalogue.data.billing.enabled, false);
  for (const [url, body] of [
    ['/api/billing/orders', { planId: 'monthly', requestId: randomUUID() }],
    ['/api/billing/orders/unknown_order/mock-complete', {}],
    ['/api/billing/orders/unknown_order/mock-notify-retry', {}],
  ]) {
    const response = await f.post(url, body, { headers });
    assert.equal(response.status, 403, response.text);
    assert.equal(response.data.code, 'MOCK_PAYMENT_LOCAL_ONLY');
  }
  const callback = await f.request('/payments/notify', { method: 'POST', rawBody: '{}', jar: false,
    headers: { ...headers, Origin: undefined, 'X-CSRF-Token': undefined } });
  assert.equal(callback.status, 403, callback.text);
  assert.notEqual(callback.data?.status, 'ACK');
  assert.equal((await f.request('/api/auth/session')).data.entitlement.accountEndsAt, null);
  assert.equal((await f.request('/api/billing/plans', { headers: { ...headers, 'X-Forwarded-Proto': undefined } })).status, 426);
});

test('live adapter with a fake transport never exposes mock confirmation actions', async t => {
  let current;
  let upstreamCalls = 0;
  const f = await fixture(t, { paymentOptions: { mode: 'live', config: paymentConfig, fetchImpl: async (url, options) => {
    upstreamCalls += 1;
    assert.equal(new URL(url).origin, 'https://pay.where.work');
    if (options.method === 'POST' && url.endsWith('/api/v1/payments/native')) {
      const input = JSON.parse(options.body);
      current = { paymentId: 'fake-live-payment', businessOrderNo: input.businessOrderNo, amountFen: input.amountFen,
        currency: 'CNY', paymentStatus: 'UNPAID', attemptId: 'fake-live-attempt', attemptStatus: 'PENDING',
        codeUrl: 'weixin://wxpay/bizpayurl?pr=FAKE_NO_REAL_PAYMENT', expiresAt: '2026-10-16T08:15:00Z' };
    }
    return new Response(JSON.stringify(current), { status: options.method === 'POST' ? 201 : 200, headers: { 'Content-Type': 'application/json' } });
  } } });
  await f.register();
  const catalogue = await f.request('/api/billing/plans');
  assert.equal(catalogue.data.billing.simulation, false);
  const created = await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.data.order.mode, 'live');
  assert.match(created.data.order.codeUrl, /^weixin:\/\//);
  for (const action of ['mock-complete', 'mock-notify-retry']) {
    const response = await f.post(`/api/billing/orders/${created.data.order.orderNo}/${action}`);
    assert.equal(response.status, 403, response.text);
    assert.equal(response.data.code, 'MOCK_PAYMENT_DISABLED');
  }
  assert.equal(upstreamCalls, 1, 'fake transport must not be called by blocked mock actions');
  assert.equal((await f.request('/api/auth/session')).data.entitlement.accountEndsAt, null);
});

test('disabled billing still publishes fixed plans but cannot create or confirm payment', async t => {
  const f = await fixture(t, { paymentOptions: { mode: 'disabled' } });
  await f.register();
  const catalogue = await f.request('/api/billing/plans');
  assert.equal(catalogue.status, 200, catalogue.text);
  assert.equal(catalogue.data.billing.available, false);
  assert.equal(catalogue.data.billing.mode, 'disabled');
  const create = await f.post('/api/billing/orders', { planId: 'monthly', requestId: randomUUID() });
  assert.equal(create.status, 503, create.text);
  assert.equal(create.data.code, 'PAYMENT_DISABLED');
  const notify = await f.request('/payments/notify', { method: 'POST', rawBody: '{}', jar: false,
    headers: { Origin: undefined, 'X-CSRF-Token': undefined } });
  assert.equal(notify.status, 503, notify.text);
  assert.notEqual(notify.data?.status, 'ACK');
});

test('reverse proxy preserves the exact application notification route before the legacy demo redirect', () => {
  const nginx = readFileSync(require.resolve('../deploy/nginx.conf'), 'utf8');
  assert.match(nginx, /location\s*=\s*\/payments\/notify\s*\{[^}]*proxy_pass\s+\$app_backend\s*;/s);
});
