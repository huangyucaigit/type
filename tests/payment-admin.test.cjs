'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { mkdtemp, mkdir, copyFile, writeFile, rm } = require('node:fs/promises');
const { existsSync, readdirSync } = require('node:fs');

const SOURCE = path.resolve(__dirname, '..');
const DAY = 86400000;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'type-payment-cli-'));
  const app = path.join(directory, 'application');
  const dotenvData = path.join(directory, 'from-dotenv');
  await mkdir(app);
  // The real CLI resolves .env beside its own source. Copy its exact modules
  // into a private test application to exercise that behavior without touching
  // the repository's private .env or opening its account database.
  for (const filename of ['payment-admin.mjs', 'auth-service.mjs', 'auth-providers.mjs',
    'payment-client.mjs', 'payment-mock.mjs', 'payment-config.mjs']) {
    await copyFile(path.join(SOURCE, filename), path.join(app, filename));
  }
  const envFile = path.join(app, '.env');
  await writeFile(envFile, `ZIJIAN_PAYMENT_MODE=mock\nZIJIAN_ENABLE_REAL_PAYMENTS=0\nZIJIAN_AUTH_DATA_DIR=${dotenvData.replaceAll('\\', '/')}\n`);
  t.after(async () => {
    const target = path.resolve(directory);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(target).startsWith('type-payment-cli-'));
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const safeEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'Path', 'PATH', 'USERPROFILE', 'LANG']) {
    if (process.env[name] !== undefined) safeEnv[name] = process.env[name];
  }
  function run(args, env = {}) {
    const result = spawnSync(process.execPath, [path.join(app, 'payment-admin.mjs'), ...args], {
      cwd: directory, env: { ...safeEnv, NODE_NO_WARNINGS: '1', ZIJIAN_PAYMENT_MODE: 'mock', ZIJIAN_ENABLE_REAL_PAYMENTS: '0', ...env },
      encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null);
    let data; try { data = JSON.parse(result.stdout); } catch { /* Help and failure output is plain text. */ }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, data };
  }
  return { directory, app, dotenvData, envFile, run };
}

async function seed(filename, { paid = false, failedNotification = false, planId = 'monthly', withOrder = true } = {}) {
  const { createAuthService } = await import('../auth-service.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const service = createAuthService({ filename, drawStarterDays: () => 3, providers: {},
    paymentOptions: { mode: 'mock', mockOptions: failedNotification ? {
      beforeNotification: async () => { throw new Error('simulated temporary delivery outage'); },
    } : {} },
  });
  const cookies = new Map();
  let csrfToken;
  async function call(pathname, body) {
    const captured = new Map();
    const response = { getHeader: name => captured.get(name), setHeader: (name, value) => captured.set(name, value) };
    const request = { method: body === undefined ? 'GET' : 'POST', headers: {
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      'x-csrf-token': csrfToken, 'user-agent': 'Payment operator CLI fixture',
    } };
    const result = await service.handle({ request, response, pathname, body,
      origin: 'http://127.0.0.1:4174', clientIp: '127.0.0.1', allowMock: true });
    for (const cookie of captured.get('Set-Cookie') || []) {
      const pair = cookie.split(';')[0], equals = pair.indexOf('=');
      cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    csrfToken = result.csrfToken || csrfToken;
    return result;
  }
  let order, userId;
  try {
    await call('/api/auth/session');
    userId = (await call('/api/auth/register', { nickname: '练习同学', email: `operator-${randomUUID()}@example.test`, password: 'Operator-test-password-1234' })).user.id;
    if (withOrder) {
      order = (await call('/api/billing/orders', { planId, requestId: randomUUID() })).order;
      if (paid) order = (await call(`/api/billing/orders/${order.orderNo}/mock-complete`, {})).order;
      assert.deepEqual(service.getBillingOrder(order.orderNo), order);
    }
  } finally { service.close(); }
  function query(sql, ...parameters) {
    const db = new DatabaseSync(filename, { readOnly: true });
    try { return db.prepare(sql).get(...parameters); } finally { db.close(); }
  }
  const secrets = [
    query('SELECT value FROM auth_settings WHERE key=?', 'billing_mock_api_secret').value,
    query('SELECT value FROM auth_settings WHERE key=?', 'billing_mock_notify_secret').value,
  ];
  async function complete(orderNo) {
    const reopened = createAuthService({ filename, paymentOptions: { mode: 'mock' } });
    const captured = new Map();
    try {
      return await reopened.handle({
        request: { method: 'POST', headers: { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          'x-csrf-token': csrfToken, 'user-agent': 'Payment operator CLI fixture' } },
        response: { getHeader: name => captured.get(name), setHeader: (name, value) => captured.set(name, value) },
        pathname: `/api/billing/orders/${orderNo}/mock-complete`, body: {},
        origin: 'http://127.0.0.1:4174', clientIp: '127.0.0.1', allowMock: true,
      });
    } finally { reopened.close(); }
  }
  return { order, userId, secrets, query, complete };
}

function sanitized(result, secrets = []) {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const value of [...secrets, 'apiSecretBase64', 'notifySecretBase64', 'apiKeyId', 'notifyKeyId',
    'billing_mock_api_secret', 'billing_mock_notify_secret']) assert.equal(output.includes(value), false);
}

test('help and no-argument help open no database and do not read invalid payment configuration', async t => {
  const f = await fixture(t);
  const absentDirectory = path.join(f.directory, 'must-not-be-created');
  const initial = readdirSync(f.app).sort();
  for (const args of [[], ['--help'], ['unsupported-command', '--help']]) {
    const result = f.run(args, { ZIJIAN_AUTH_DATA_DIR: absentDirectory, ZIJIAN_PAYMENT_MODE: 'invalid-but-unused' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: node payment-admin\.mjs/);
    assert.match(result.stdout, /retry-notification/);
    assert.match(result.stdout, /create-acceptance --user <existingUserId> --request <stableUUID>/);
    assert.equal(result.stderr, '');
  }
  assert.deepEqual(readdirSync(f.app).sort(), initial);
  assert.equal(existsSync(absentDirectory), false);
  assert.equal(existsSync(f.dotenvData), false);
  assert.equal(existsSync(path.join(f.app, '.data')), false);
});

test('bad commands and ambiguous arguments fail safely before creating storage', async t => {
  const f = await fixture(t);
  const missing = path.join(f.directory, 'absent.sqlite');
  for (const args of [
    ['create'], ['status'], ['status', '--order'], ['status', '--order', '../private.sqlite'],
    ['status', '--order', 'with spaces'], ['status', '--order', 'order-1', '--unknown', 'sensitive-value'],
    ['status', '--order', 'order-1', '--order', 'order-2'],
    ['status', '--order', 'order-1', '--database', missing, '--database', missing],
    ['status', '--order', 'order-1', 'extra-positional-value'],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Payment management operation failed/);
    assert.equal(result.stderr.includes('sensitive-value'), false);
    sanitized(result);
  }
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(f.dotenvData), false);
});

test('a missing database or directory selection fails without creating an empty account database', async t => {
  const f = await fixture(t);
  const absent = path.join(f.directory, 'nested', 'missing.sqlite');
  for (const args of [
    ['status', '--order', 'unknown-order'],
    ['status', '--order', 'unknown-order', '--database', absent],
    ['retry-notification', '--order', 'unknown-order', '--database', absent],
    ['status', '--order', 'unknown-order', '--database', f.app],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    sanitized(result);
  }
  assert.equal(existsSync(absent), false);
  assert.equal(existsSync(path.dirname(absent)), false);
  assert.equal(existsSync(f.dotenvData), false);
});

test('CLI resolves the application dotenv data directory even from a different working directory', async t => {
  const f = await fixture(t);
  const data = await seed(path.join(f.dotenvData, 'auth.sqlite'));
  const result = f.run(['status', '--order', data.order.orderNo]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.data, data.order);
  assert.equal(result.data.amountFen, 990);
  assert.equal(result.data.status, 'UNPAID');
  sanitized(result, data.secrets);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_orders').count, 1);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_events').count, 0);
  assert.equal(existsSync(path.join(f.app, '.data')), false);
});

test('external environment data directory takes priority over application dotenv', async t => {
  const f = await fixture(t);
  const dotenv = await seed(path.join(f.dotenvData, 'auth.sqlite'));
  const fromProcess = path.join(f.directory, 'from-process');
  const processData = await seed(path.join(fromProcess, 'auth.sqlite'), { planId: 'yearly' });
  const result = f.run(['status', '--order', processData.order.orderNo], { ZIJIAN_AUTH_DATA_DIR: fromProcess });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.data.orderNo, processData.order.orderNo);
  assert.equal(result.data.amountFen, 5990);
  assert.equal(result.data.days, 365);
  assert.equal(dotenv.query('SELECT count(*) AS count FROM billing_orders').count, 1);
  sanitized(result, [...dotenv.secrets, ...processData.secrets]);
});

test('explicit --database wins over both process environment and dotenv without opening another location', async t => {
  const f = await fixture(t);
  const dotenv = await seed(path.join(f.dotenvData, 'auth.sqlite'));
  const selectedFilename = path.join(f.directory, 'explicit.sqlite');
  const selected = await seed(selectedFilename, { planId: 'quarterly' });
  const unusedDirectory = path.join(f.directory, 'unused-process-directory');
  const result = f.run(['status', '--order', selected.order.orderNo, '--database', selectedFilename], { ZIJIAN_AUTH_DATA_DIR: unusedDirectory });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.data.orderNo, selected.order.orderNo);
  assert.equal(result.data.amountFen, 1990);
  assert.equal(result.data.days, 90);
  assert.equal(existsSync(unusedDirectory), false);
  assert.equal(dotenv.query('SELECT count(*) AS count FROM billing_orders').count, 1);
  sanitized(result, [...dotenv.secrets, ...selected.secrets]);
});

test('operator cannot retry an unpaid or unknown order and exposes no secrets on failure', async t => {
  const f = await fixture(t);
  const filename = path.join(f.directory, 'orders.sqlite');
  const data = await seed(filename);
  const unpaid = f.run(['retry-notification', '--order', data.order.orderNo, '--database', filename]);
  assert.equal(unpaid.status, 1);
  assert.equal(unpaid.stdout, '');
  assert.match(unpaid.stderr, /尚未确认付款/);
  sanitized(unpaid, data.secrets);
  const missing = f.run(['status', '--order', 'unknown-order', '--database', filename]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /订单不存在/);
  sanitized(missing, data.secrets);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_mock_payments').count, 1);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_events').count, 0);
  assert.equal(data.query('SELECT account_ends_at FROM auth_users').account_ends_at, null);
});

test('child CLI retries a persisted paid event after receiver outage and grants time only once across restarts', async t => {
  const f = await fixture(t);
  const filename = path.join(f.directory, 'recover.sqlite');
  const data = await seed(filename, { paid: true, failedNotification: true });
  assert.equal(data.order.paymentStatus, 'PAID');
  assert.equal(data.order.status, 'UNPAID');
  assert.equal(data.order.needsAttention, true);
  assert.equal(data.order.entitlementEndsAt, null);
  const original = data.query('SELECT payment_id,event_id,transaction_id,notification_status FROM billing_mock_payments');
  assert.equal(original.notification_status, 'RETRY');
  assert.equal(data.query('SELECT count(*) AS count FROM billing_events').count, 0);
  const command = ['retry-notification', '--order', data.order.orderNo, '--database', filename];
  const recovered = f.run(command);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.data.status, 'PAID');
  assert.equal(recovered.data.notificationStatus, 'ACK');
  assert.equal(recovered.data.needsAttention, false);
  assert.equal(recovered.data.paymentId, original.payment_id);
  assert.equal(recovered.data.wechatTransactionId, original.transaction_id);
  assert.equal(recovered.data.entitlementEndsAt, recovered.data.grantedAt + 30 * DAY);
  assert.equal(data.query('SELECT account_ends_at FROM auth_users').account_ends_at, recovered.data.entitlementEndsAt);
  assert.equal(data.query('SELECT event_id FROM billing_events').event_id, original.event_id);
  assert.equal(data.query('SELECT notification_status FROM billing_mock_payments').notification_status, 'ACK');
  sanitized(recovered, data.secrets);
  const repeated = f.run(command);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.data.entitlementEndsAt, recovered.data.entitlementEndsAt);
  assert.equal(repeated.data.grantedAt, recovered.data.grantedAt);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_events').count, 1);
  assert.equal(data.query('SELECT event_id FROM billing_mock_payments').event_id, original.event_id);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_mock_payments').count, 1);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_mock_attempts').count, 1);
  sanitized(repeated, data.secrets);
});

test('acceptance command requires its own exact arguments and rejects custom price or duration before storage access', async t => {
  const f = await fixture(t);
  const userId = randomUUID(), requestId = randomUUID();
  const base = ['create-acceptance', '--user', userId, '--request', requestId];
  for (const args of [
    ['create-acceptance'], ['create-acceptance', '--user', userId], ['create-acceptance', '--request', requestId],
    ['create-acceptance', '--user', '../not-a-user', '--request', requestId],
    ['create-acceptance', '--user', userId, '--request', 'not-a-stable-uuid'],
    [...base, '--user', userId], [...base, '--request', requestId],
    [...base, '--amount', '1'], [...base, '--days', '365'], [...base, '--order', 'existing-order'],
    ['status', '--order', 'existing-order', '--user', userId],
    ['retry-notification', '--order', 'existing-order', '--request', requestId],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Payment management operation failed/);
    sanitized(result);
  }
  assert.equal(existsSync(f.dotenvData), false);
});

test('acceptance CLI creates a fixed 1-fen/1-day order for an existing user and resumes it after process restart', async t => {
  const f = await fixture(t);
  const filename = path.join(f.directory, 'acceptance.sqlite');
  const data = await seed(filename, { withOrder: false });
  const requestId = randomUUID();
  const args = ['create-acceptance', '--user', data.userId, '--request', requestId, '--database', filename];
  const created = f.run(args);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.data.planId, 'acceptance_1fen');
  assert.equal(created.data.amountFen, 1);
  assert.equal(created.data.days, 1);
  assert.equal(created.data.currency, 'CNY');
  assert.equal(created.data.mode, 'mock');
  assert.equal(created.data.status, 'UNPAID');
  assert.equal(created.data.attemptStatus, 'PENDING');
  assert.match(created.data.codeUrl, /^mock-payment:\/\//);
  assert.equal(created.data.entitlementEndsAt, null);
  assert.equal(data.query('SELECT user_id FROM billing_orders').user_id, data.userId);
  assert.equal(data.query('SELECT amount_fen FROM billing_mock_payments').amount_fen, 1);
  assert.equal(data.query('SELECT account_ends_at FROM auth_users').account_ends_at, null);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_events').count, 0);
  sanitized(created, data.secrets);
  const resumed = f.run(args);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.data.orderNo, created.data.orderNo);
  assert.equal(resumed.data.paymentId, created.data.paymentId);
  assert.equal(resumed.data.attemptId, created.data.attemptId);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_orders').count, 1);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_mock_payments').count, 1);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_mock_attempts').count, 1);
  assert.equal(data.query('SELECT request_id FROM billing_requests').request_id, requestId);
  sanitized(resumed, data.secrets);
  const stored = f.run(['status', '--order', created.data.orderNo, '--database', filename]);
  assert.equal(stored.status, 0, stored.stderr);
  assert.deepEqual(stored.data, resumed.data);
  const completed = await data.complete(created.data.orderNo);
  assert.equal(completed.order.status, 'PAID');
  assert.equal(completed.order.entitlementEndsAt, completed.order.grantedAt + DAY);
  const afterPaidCreate = f.run(args);
  assert.equal(afterPaidCreate.status, 0, afterPaidCreate.stderr);
  assert.equal(afterPaidCreate.data.orderNo, created.data.orderNo);
  assert.equal(afterPaidCreate.data.entitlementEndsAt, completed.order.entitlementEndsAt);
  const replay = f.run(['retry-notification', '--order', created.data.orderNo, '--database', filename]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(replay.data.entitlementEndsAt, completed.order.entitlementEndsAt);
  assert.equal(replay.data.grantedAt, completed.order.grantedAt);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_events').count, 1);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_mock_payments').count, 1);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_mock_attempts').count, 1);
  sanitized(replay, data.secrets);
});

test('acceptance CLI rejects missing users without creating an account, payment or business order', async t => {
  const f = await fixture(t);
  const filename = path.join(f.directory, 'existing-users.sqlite');
  const data = await seed(filename, { withOrder: false });
  const result = f.run(['create-acceptance', '--user', randomUUID(), '--request', randomUUID(), '--database', filename]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /验收账号不存在/);
  assert.equal(data.query('SELECT count(*) AS count FROM auth_users').count, 1);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_orders').count, 0);
  assert.equal(data.query('SELECT count(*) AS count FROM billing_mock_payments').count, 0);
  sanitized(result, data.secrets);
  const absent = path.join(f.directory, 'not-created.sqlite');
  const missingDatabase = f.run(['create-acceptance', '--user', data.userId, '--request', randomUUID(), '--database', absent]);
  assert.equal(missingDatabase.status, 1);
  assert.equal(existsSync(absent), false);
  sanitized(missingDatabase, data.secrets);
});
