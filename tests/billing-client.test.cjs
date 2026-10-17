'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { amount, orderView, createController } = require('../billing.js');
const NOW = 1800000000000;
const user = id => ({ user: id ? { id, email: `billing${id}@example.com` } : null });
const plan = { id: 'monthly', name: '月度', amountFen: 990, days: 30, currency: 'CNY' };
const config = (mode = 'mock', extra = {}) => ({ billing: { enabled: true, available: true, mode, ...extra }, plans: [plan], serverTime: NOW });
const order = (extra = {}) => ({ orderNo: 'TYPE-ORDER-123', planId: 'monthly', planName: '月度', amountFen: 990,
  days: 30, currency: 'CNY', status: 'UNPAID', paymentStatus: 'UNPAID', attemptStatus: 'PENDING',
  codeUrl: 'weixin://wxpay/bizpayurl?pr=mock-safe', createdAt: NOW, expiresAt: NOW + 600000, mode: 'mock', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides = {}) {
  let state = user(1), uuidCalls = 0;
  const calls = [], changes = [], values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const options = { getState: () => state, ready: async () => {}, storage, now: () => NOW,
    uuid: () => `client-uuid-0000000${++uuidCalls}`, onChange: view => changes.push(view),
    request: async (path, body) => { calls.push({ path, body });
      if (path === '/api/billing/plans') return config();
      if (path === '/api/billing/orders' && body === undefined) return { ...config(), orders: [order()] };
      return { ...config(), order: order() };
    }, ...overrides };
  const controller = createController(options);
  return { controller, calls, changes, values, storage, setState: next => { state = next; }, uuidCalls: () => uuidCalls };
}

test('money rendering uses the server amount in cents and rejects malformed numbers', () => {
  assert.equal(amount(990), '9.90'); assert.equal(amount(1990), '19.90'); assert.equal(amount(5990), '59.90');
  for (const value of [-1, '990', 1.5, NaN]) assert.equal(amount(value), '—');
});

test('payment confirmation alone never claims that practice time has arrived', () => {
  const pending = orderView(order({ paymentStatus: 'PAID', attemptStatus: 'SUCCEEDED', needsAttention: true }), NOW);
  assert.equal(pending.phase, 'processing'); assert.equal(pending.canPay, false); assert.match(pending.title, /处理中/);
  assert.equal(orderView(order({ status: 'PAID', grantedAt: null }), NOW).phase, 'processing');
  const granted = orderView(order({ status: 'PAID', paymentStatus: 'PAID', grantedAt: NOW, entitlementEndsAt: NOW + 30 * 86400000 }), NOW);
  assert.equal(granted.phase, 'paid'); assert.match(granted.description, /30 天/);
});

test('expired and uncertain attempts never offer an active QR or mock payment', () => {
  for (const value of [order({ expiresAt: NOW }), order({ attemptStatus: 'EXPIRED' }), order({ attemptStatus: 'UNKNOWN', codeUrl: null }),
    order({ attemptStatus: 'CREATING' }), order({ attemptStatus: 'CLOSING' }), order({ attemptStatus: 'CLOSED' }), order({ attemptStatus: 'REJECTED' })]) {
    assert.equal(orderView(value, NOW).canPay, false);
  }
  assert.equal(orderView(order({ attemptStatus: 'CLOSED', paymentStatus: 'PAID' }), NOW).phase, 'processing');
});

test('reading public plans never creates an order or starts a user entitlement', async () => {
  const page = harness(); await page.controller.metadata();
  assert.deepEqual(page.calls.map(call => call.path), ['/api/billing/plans']);
  assert.equal(page.controller.snapshot().active, false);
  assert.equal(page.controller.snapshot().plans[0].amountFen, 990);
});

test('guest purchase returns to the auth layer without making any billing request', async () => {
  const page = harness(); page.setState(user(null));
  assert.equal(await page.controller.open('monthly'), false);
  assert.equal(await page.controller.openHistory(), false); assert.equal(page.calls.length, 0);
});

test('disabled or unavailable payment never creates an order', async () => {
  for (const extra of [{ enabled: false }, { available: false }]) {
    const page = harness({ request: async path => { assert.equal(path, '/api/billing/plans'); return config('mock', extra); } });
    await page.controller.open('monthly'); assert.equal(page.controller.snapshot().order, null); assert.equal(page.uuidCalls(), 0);
  }
});

test('a purchase uses only plan ID plus a stable client request ID, never client amount or duration', async () => {
  const page = harness(); await page.controller.open('monthly');
  const request = page.calls.find(call => call.body);
  assert.deepEqual(request.body, { planId: 'monthly', requestId: 'client-uuid-00000001' });
  assert.equal(page.controller.snapshot().order.amountFen, 990);
  const stored = JSON.parse(page.values.get('zijian-billing-pending:1'));
  assert.deepEqual(stored, { planId: 'monthly', requestId: 'client-uuid-00000001', orderNo: 'TYPE-ORDER-123' });
});

test('a lost create response retries exactly the same purchase intent', async () => {
  const calls = []; let creates = 0;
  const page = harness({ request: async (path, body) => {
    calls.push({ path, body }); if (path === '/api/billing/plans') return config();
    if (++creates === 1) throw new Error('连接已中断');
    return { ...config(), order: order() };
  } });
  await page.controller.open('quarterly'); assert.match(page.controller.snapshot().error, /连接已中断/);
  await page.controller.retry();
  const creations = calls.filter(call => call.body);
  assert.equal(creations.length, 2); assert.deepEqual(creations[0].body, creations[1].body); assert.equal(page.uuidCalls(), 1);
});

test('retrying failed plan preparation can create the first purchase instead of getting stuck', async () => {
  let planReads = 0, creates = 0;
  const page = harness({ request: async path => {
    if (path === '/api/billing/plans') {
      if (++planReads === 1) throw new Error('套餐暂时无法读取');
      return config();
    }
    creates++; return { ...config(), order: order() };
  } });
  await page.controller.open('monthly'); assert.equal(page.uuidCalls(), 0);
  await page.controller.retry(); assert.equal(planReads, 2); assert.equal(creates, 1);
  assert.equal(page.controller.snapshot().order.orderNo, 'TYPE-ORDER-123');
});

test('pending order recovery after closing the window does not create a second order', async () => {
  const page = harness(); await page.controller.open('monthly'); page.controller.close();
  await page.controller.open('yearly');
  assert.equal(page.calls.filter(call => call.path === '/api/billing/orders' && call.body).length, 1);
  assert.ok(page.calls.some(call => call.path === '/api/billing/orders/TYPE-ORDER-123' && call.body === undefined));
  assert.equal(page.uuidCalls(), 1);
});

test('expired orders are explicitly closed before retrying the same business order', async () => {
  const calls = [];
  const page = harness({ request: async (path, body) => { calls.push({ path, body });
    if (path === '/api/billing/plans') return config();
    if (path.endsWith('/close')) return { ...config(), order: order({ attemptStatus: 'CLOSED' }) };
    if (path.endsWith('/retry')) return { ...config(), order: order({ codeUrl: 'weixin://retry', expiresAt: NOW + 600000 }) };
    return { ...config(), order: order({ expiresAt: NOW - 1 }) };
  } });
  await page.controller.open('monthly'); assert.equal(orderView(page.controller.snapshot().order, NOW).phase, 'expired');
  await page.controller.cancel(); await page.controller.retry();
  assert.deepEqual(calls.filter(call => call.path.endsWith('/close') || call.path.endsWith('/retry')).map(call => call.path),
    ['/api/billing/orders/TYPE-ORDER-123/close', '/api/billing/orders/TYPE-ORDER-123/retry']);
});

test('mock completion is available only for mock mode and an unexpired payable order', async () => {
  for (const mode of ['mock', 'live', 'disabled']) {
    const calls = [];
    const page = harness({ request: async (path, body) => { calls.push(path); return path === '/api/billing/plans'
      ? config(mode) : { ...config(mode), order: order() }; } });
    await page.controller.open('monthly'); await page.controller.mockComplete();
    assert.equal(calls.includes('/api/billing/orders/TYPE-ORDER-123/mock-complete'), mode === 'mock');
  }
  const page = harness({ request: async path => path === '/api/billing/plans' ? config() : { ...config(), order: order({ expiresAt: NOW - 1 }) } });
  await page.controller.open('monthly'); assert.equal(await page.controller.mockComplete(), null);
});

test('successful grants clear the local pending intent so a later purchase can be new', async () => {
  const page = harness({ request: async path => path === '/api/billing/plans' ? config() :
    { ...config(), order: order(path.endsWith('/mock-complete') ? { status: 'PAID', paymentStatus: 'PAID', grantedAt: NOW, entitlementEndsAt: NOW + 86400000 } : {}) } });
  await page.controller.open('monthly'); await page.controller.mockComplete();
  assert.equal(page.values.has('zijian-billing-pending:1'), false);
  assert.equal(orderView(page.controller.snapshot().order, NOW).phase, 'paid');
});

test('manual sync and background polling are serialized to avoid duplicate writes', async () => {
  const result = deferred(); let syncCalls = 0;
  const page = harness({ request: async path => {
    if (path === '/api/billing/plans') return config();
    if (path.endsWith('/sync')) { syncCalls++; return result.promise; }
    return { ...config(), order: order() };
  } });
  await page.controller.open('monthly'); const first = page.controller.sync(), second = page.controller.sync(), poll = page.controller.poll();
  await flush(); assert.equal(syncCalls, 1);
  result.resolve({ ...config(), order: order() }); await Promise.all([first, second, poll]); assert.equal(page.controller.snapshot().busy, false);
});

test('logout clears displayed orders and ignores a late order response', async () => {
  const result = deferred();
  const page = harness({ request: async path => path === '/api/billing/plans' ? config() : result.promise });
  const opening = page.controller.open('monthly'); await flush();
  page.setState(user(null)); page.controller.accountChanged();
  result.resolve({ ...config(), order: order() }); await opening;
  assert.equal(page.controller.snapshot().active, false); assert.equal(page.controller.snapshot().order, null);
  assert.equal(page.controller.snapshot().busy, false);
});

test('logout during plan preparation cannot submit an order on the new account', async () => {
  const result = deferred(), calls = [];
  const page = harness({ request: async path => { calls.push(path); return result.promise; } });
  const opening = page.controller.open('monthly'); await flush();
  page.setState(user(2)); page.controller.accountChanged(); result.resolve(config()); await opening;
  assert.deepEqual(calls, ['/api/billing/plans']); assert.equal(page.controller.snapshot().order, null);
});

test('account-scoped storage never resumes another account pending order', async () => {
  const page = harness(); await page.controller.open('monthly'); page.controller.close();
  page.setState(user(2)); page.controller.accountChanged(); await page.controller.open('yearly');
  const created = page.calls.filter(call => call.path === '/api/billing/orders' && call.body);
  assert.equal(created.length, 2); assert.equal(created[1].body.planId, 'yearly');
  assert.notEqual(created[1].body.requestId, created[0].body.requestId);
});

test('a stale history response cannot reveal an old account order after switching accounts', async () => {
  const result = deferred();
  const page = harness({ request: () => result.promise }); const opening = page.controller.openHistory(); await flush();
  page.setState(user(2)); page.controller.accountChanged(); result.resolve({ ...config(), orders: [order()] }); await opening;
  assert.deepEqual(page.controller.snapshot().orders, []); assert.equal(page.controller.snapshot().active, false);
});

test('blocked browser storage still permits an idempotent purchase and server-owned order history', async () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const page = harness({ storage }); await page.controller.open('monthly');
  assert.equal(page.controller.snapshot().order.orderNo, 'TYPE-ORDER-123');
  await page.controller.openHistory(); assert.equal(page.controller.snapshot().orders.length, 1);
});

test('malformed stored recovery metadata cannot inject an order path or price', async () => {
  const page = harness(); page.values.set('zijian-billing-pending:1', JSON.stringify({ planId: 'monthly', requestId: 'a'.repeat(20), orderNo: '../../auth/logout', amountFen: 1 }));
  await page.controller.open('monthly'); assert.equal(page.calls.filter(call => call.body).length, 1);
  assert.equal(page.calls.some(call => call.path.includes('../')), false);
});

test('an existing active order is recovered instead of creating competing purchases', async () => {
  const calls = [];
  const page = harness({ request: async (path, body) => { calls.push({ path, body });
    if (path === '/api/billing/plans') return config();
    if (path === '/api/billing/orders' && body) { const error = new Error('已有进行中的订单'); error.code = 'ACTIVE_ORDER_EXISTS'; throw error; }
    if (path === '/api/billing/orders') return { ...config(), orders: [order({ status: 'PAID', grantedAt: NOW }), order({ orderNo: 'TYPE-PENDING-2' })] };
    return { ...config(), order: order({ orderNo: 'TYPE-PENDING-2' }) };
  } });
  await page.controller.open('yearly'); assert.equal(page.controller.snapshot().order.orderNo, 'TYPE-PENDING-2');
  assert.equal(page.controller.snapshot().error, ''); assert.ok(calls.some(call => call.path === '/api/billing/orders/TYPE-PENDING-2'));
});

test('server clock controls order expiry even when the browser clock is behind', async () => {
  const page = harness({ now: () => NOW - 3600000 }); await page.controller.open('monthly');
  assert.equal(page.controller.snapshot().now, NOW); assert.equal(orderView(page.controller.snapshot().order, page.controller.snapshot().now).phase, 'unpaid');
});
