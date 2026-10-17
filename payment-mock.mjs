import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { signPaymentRequest, PaymentError } from './payment-client.mjs';

// This provider lives entirely inside the application process. It implements the
// public, signed HTTP contract without opening a socket or contacting a merchant.
export function createMockPaymentProvider({ db, now, receiveNotification, options = {} }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_mock_payments (
      payment_id TEXT PRIMARY KEY, business_order_no TEXT NOT NULL UNIQUE,
      amount_fen INTEGER NOT NULL, description TEXT NOT NULL, payment_status TEXT NOT NULL,
      created_at INTEGER NOT NULL, paid_at INTEGER, transaction_id TEXT UNIQUE,
      event_id TEXT UNIQUE, notification_status TEXT NOT NULL DEFAULT 'NONE'
    );
    CREATE TABLE IF NOT EXISTS billing_mock_attempts (
      attempt_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES billing_mock_payments(payment_id),
      idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      attempt_status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_mock_nonces (nonce TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
  `);
  const setting = (key, make) => {
    db.prepare('INSERT OR IGNORE INTO auth_settings(key,value) VALUES(?,?)').run(key, make());
    return db.prepare('SELECT value FROM auth_settings WHERE key=?').get(key).value;
  };
  const config = Object.freeze({
    baseUrl: 'https://payment-mock.invalid', projectCode: 'type_mock', apiKeyId: 'mock_api_v1',
    apiSecretBase64: setting('billing_mock_api_secret', () => randomBytes(32).toString('base64')),
    notifyKeyId: 'mock_notify_v1',
    notifySecretBase64: setting('billing_mock_notify_secret', () => randomBytes(32).toString('base64')),
    notifyUrl: 'https://type.where.work/payments/notify',
  });
  const digest = value => createHash('sha256').update(value).digest('hex');
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const error = (status, code) => json(status, { code });
  const payment = id => db.prepare('SELECT * FROM billing_mock_payments WHERE payment_id=?').get(id);
  const attempt = id => db.prepare('SELECT * FROM billing_mock_attempts WHERE attempt_id=?').get(id);
  const latest = id => db.prepare('SELECT * FROM billing_mock_attempts WHERE payment_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
  function snapshot(row, selected = latest(row.payment_id)) {
    let status = selected.attempt_status;
    if (row.payment_status === 'PAID') status = 'SUCCEEDED';
    else if (status === 'PENDING' && selected.expires_at <= now()) status = 'EXPIRED';
    return { paymentId: row.payment_id, businessOrderNo: row.business_order_no,
      amountFen: row.amount_fen, currency: 'CNY', paymentStatus: row.payment_status,
      attemptId: selected.attempt_id, attemptStatus: status,
      codeUrl: status === 'PENDING' ? `mock-payment://checkout/${selected.attempt_id}` : null,
      qrUrl: null, createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(selected.expires_at).toISOString(),
      paidAt: row.paid_at == null ? null : new Date(row.paid_at).toISOString(),
      wechatTransactionId: row.transaction_id, notificationStatus: row.notification_status,
      needsAttention: row.payment_status === 'PAID' && row.notification_status !== 'ACK',
      lastSyncedAt: new Date(now()).toISOString(), simulation: true };
  }
  function eventFor(row) {
    const succeeded = db.prepare("SELECT * FROM billing_mock_attempts WHERE payment_id=? AND attempt_status='SUCCEEDED' ORDER BY rowid DESC LIMIT 1").get(row.payment_id);
    return { eventId: row.event_id, eventType: 'PAYMENT.SUCCEEDED', projectCode: config.projectCode,
      paymentId: row.payment_id, attemptId: succeeded.attempt_id, businessOrderNo: row.business_order_no,
      amountFen: row.amount_fen, currency: 'CNY', wechatTransactionId: row.transaction_id,
      paidAt: new Date(row.paid_at).toISOString() };
  }
  async function deliver(row) {
    const event = eventFor(row), rawBody = Buffer.from(JSON.stringify(event));
    const rawTarget = new URL(config.notifyUrl).pathname;
    const signed = signPaymentRequest({ method: 'POST', rawTarget, projectCode: config.projectCode,
      keyId: config.notifyKeyId, timestamp: Math.floor(now() / 1000), nonce: randomBytes(24).toString('hex'),
      rawBody, secretBase64: config.notifySecretBase64 });
    try {
      await options.beforeNotification?.({ event, rawBody, headers: signed.headers });
      const ack = await receiveNotification({ request: { method: 'POST', headers: signed.headers },
        rawTarget, rawBody, rawHeaders: Object.entries(signed.headers).flat(), secure: true,
        origin: 'https://type.where.work', mockInternal: true });
      if (ack.eventId !== event.eventId || ack.status !== 'ACK') throw new Error('Notification was not acknowledged.');
      db.prepare("UPDATE billing_mock_payments SET notification_status='ACK' WHERE payment_id=?").run(row.payment_id);
    } catch {
      db.prepare("UPDATE billing_mock_payments SET notification_status='RETRY' WHERE payment_id=?").run(row.payment_id);
    }
    return snapshot(payment(row.payment_id));
  }
  async function complete(businessOrderNo) {
    let row = db.prepare('SELECT * FROM billing_mock_payments WHERE business_order_no=?').get(businessOrderNo);
    if (!row) throw new PaymentError('未找到模拟支付记录。', { status: 404, code: 'PAYMENT_NOT_FOUND' });
    if (row.payment_status !== 'PAID') {
      const selected = latest(row.payment_id);
      if (selected.attempt_status !== 'PENDING' || selected.expires_at <= now()) {
        throw new PaymentError('二维码已关闭或过期，请先关闭原付款请求，再重新生成。', { status: 409, code: 'PAYMENT_ATTEMPT_UNAVAILABLE' });
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        // Re-read under the lock so two completion requests have one payment fact.
        row = payment(row.payment_id);
        if (row.payment_status !== 'PAID') {
          db.prepare("UPDATE billing_mock_payments SET payment_status='PAID',paid_at=?,transaction_id=?,event_id=?,notification_status='PENDING' WHERE payment_id=?")
            .run(now(), `mock_tx_${randomUUID()}`, `mock_evt_${randomUUID()}`, row.payment_id);
          db.prepare("UPDATE billing_mock_attempts SET attempt_status='SUCCEEDED' WHERE attempt_id=?").run(selected.attempt_id);
        }
        db.exec('COMMIT');
      } catch (caught) { db.exec('ROLLBACK'); throw caught; }
    }
    return deliver(payment(row.payment_id));
  }
  async function fetchImpl(urlValue, request) {
    const url = new URL(urlValue), rawTarget = url.pathname + url.search;
    if (url.origin !== config.baseUrl) throw new Error('Mock transport cannot contact an external origin.');
    const headers = new Headers(request.headers), timestamp = headers.get('x-pay-timestamp');
    const nonce = headers.get('x-pay-nonce'), rawBody = request.body || '';
    if (headers.get('x-pay-project') !== config.projectCode || headers.get('x-pay-key-id') !== config.apiKeyId
      || !/^\d+$/.test(timestamp || '') || Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > 300
      || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce || '')) return error(401, 'UNAUTHORIZED');
    const expected = signPaymentRequest({ method: request.method, rawTarget, projectCode: config.projectCode,
      keyId: config.apiKeyId, timestamp, nonce, rawBody, secretBase64: config.apiSecretBase64 }).signature;
    const supplied = headers.get('x-pay-signature') || '';
    if (Buffer.byteLength(expected) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return error(401, 'UNAUTHORIZED');
    db.prepare('DELETE FROM billing_mock_nonces WHERE created_at<?').run(now() - 300000);
    if (db.prepare('SELECT nonce FROM billing_mock_nonces WHERE nonce=?').get(nonce)) return error(401, 'UNAUTHORIZED');
    db.prepare('INSERT INTO billing_mock_nonces(nonce,created_at) VALUES(?,?)').run(nonce, now());
    await options.beforeRequest?.({ rawTarget, request });
    let result;
    if (request.method === 'POST' && rawTarget === '/api/v1/payments/native') {
      const input = JSON.parse(rawBody), key = headers.get('idempotency-key');
      const previous = db.prepare('SELECT * FROM billing_mock_attempts WHERE idempotency_key=?').get(key);
      if (previous) result = previous.request_hash === digest(rawBody) ? json(200, snapshot(payment(previous.payment_id), previous)) : error(409, 'IDEMPOTENCY_CONFLICT');
      else {
        let row = db.prepare('SELECT * FROM billing_mock_payments WHERE business_order_no=?').get(input.businessOrderNo);
        if (row && (row.amount_fen !== input.amountFen || row.description !== input.description)) return error(409, 'BUSINESS_ORDER_CONFLICT');
        if (row?.payment_status === 'PAID') return error(409, 'ALREADY_PAID');
        if (row && !['CLOSED', 'REJECTED'].includes(latest(row.payment_id).attempt_status)) return error(409, 'ACTIVE_PAYMENT_EXISTS');
        db.exec('BEGIN IMMEDIATE');
        try {
          const paymentId = row?.payment_id || `mock_pay_${randomUUID()}`;
          if (!row) db.prepare("INSERT INTO billing_mock_payments(payment_id,business_order_no,amount_fen,description,payment_status,created_at) VALUES(?,?,?,?,'UNPAID',?)")
            .run(paymentId, input.businessOrderNo, input.amountFen, input.description, now());
          const attemptId = `mock_attempt_${randomUUID()}`;
          db.prepare("INSERT INTO billing_mock_attempts(attempt_id,payment_id,idempotency_key,request_hash,attempt_status,created_at,expires_at) VALUES(?,?,?,?,'PENDING',?,?)")
            .run(attemptId, paymentId, key, digest(rawBody), now(), now() + (input.expiresInSeconds || 900) * 1000);
          db.exec('COMMIT');
        } catch (caught) { db.exec('ROLLBACK'); throw caught; }
        row = db.prepare('SELECT * FROM billing_mock_payments WHERE business_order_no=?').get(input.businessOrderNo);
        result = json(201, snapshot(row));
        if (options.completeBeforeCreateResponse) { await complete(input.businessOrderNo); result = json(201, snapshot(payment(row.payment_id))); }
      }
    } else if (request.method === 'GET' && rawTarget.startsWith('/api/v1/payments/by-business-order/')) {
      const no = decodeURIComponent(rawTarget.slice('/api/v1/payments/by-business-order/'.length));
      const row = db.prepare('SELECT * FROM billing_mock_payments WHERE business_order_no=?').get(no);
      result = row ? json(200, snapshot(row)) : error(404, 'NOT_FOUND');
    } else if (/^\/api\/v1\/payments\/[^/]+(?:\/sync|\/notifications\/retry)?$/.test(rawTarget)) {
      const [, , , , encoded, action] = rawTarget.split('/');
      const row = payment(decodeURIComponent(encoded));
      if (!row) return error(404, 'NOT_FOUND');
      if (request.method === 'GET' && !action) result = json(200, snapshot(row));
      else if (request.method === 'POST' && action === 'sync') result = json(202, snapshot(row));
      else if (request.method === 'POST' && action === 'notifications') result = row.payment_status === 'PAID' ? json(202, await deliver(row)) : error(409, 'NOT_PAID');
      else result = error(405, 'METHOD_NOT_ALLOWED');
    } else if (request.method === 'POST' && /^\/api\/v1\/payment-attempts\/[^/]+\/close$/.test(rawTarget)) {
      const selected = attempt(decodeURIComponent(rawTarget.split('/')[4]));
      if (!selected) return error(404, 'NOT_FOUND');
      let row = payment(selected.payment_id);
      if (row.payment_status !== 'PAID') {
        await options.beforeClose?.({ businessOrderNo: row.business_order_no, complete });
        row = payment(selected.payment_id);
        if (row.payment_status !== 'PAID') db.prepare("UPDATE billing_mock_attempts SET attempt_status='CLOSED' WHERE attempt_id=?").run(selected.attempt_id);
      }
      result = json(202, snapshot(payment(selected.payment_id), attempt(selected.attempt_id)));
    } else result = error(404, 'NOT_FOUND');
    await options.afterRequest?.({ rawTarget, request, result });
    return result;
  }
  return Object.freeze({ config, fetchImpl, complete });
}
