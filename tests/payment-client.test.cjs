const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const clientPromise = import('../payment-client.mjs');

const apiSecretBase64 = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64');
const notifySecretBase64 = Buffer.alloc(32, 0x87).toString('base64');
const previousSecretBase64 = Buffer.alloc(32, 0x42).toString('base64');
const time = Date.parse('2026-10-16T08:00:00.000Z');
const config = {
  baseUrl: 'https://pay.where.work', projectCode: 'type', apiKeyId: 'api-v1', apiSecretBase64,
  notifyKeyId: 'notify-v1', notifySecretBase64, notifyUrl: 'https://type.where.work/payments/notify',
};
const payment = {
  paymentId: 'payment-opaque', businessOrderNo: 'ORDER-001', amountFen: 990, currency: 'CNY',
  paymentStatus: 'UNPAID', attemptId: 'attempt-opaque', attemptStatus: 'PENDING',
  codeUrl: 'weixin://wxpay/bizpayurl?pr=EXAMPLE_ONLY',
  qrUrl: '/api/v1/payment-attempts/attempt-opaque/qrcode.svg', expiresAt: '2026-10-16T08:15:00Z', needsAttention: false,
};
const event = {
  eventId: 'event-opaque', eventType: 'PAYMENT.SUCCEEDED', projectCode: 'type',
  paymentId: payment.paymentId, attemptId: payment.attemptId, businessOrderNo: payment.businessOrderNo,
  amountFen: payment.amountFen, currency: 'CNY', wechatTransactionId: 'transaction-opaque', paidAt: '2026-10-16T08:00:00Z',
};
const body = { businessOrderNo: 'ORDER-001', amountFen: 990, description: '月度会员', expiresInSeconds: 900 };
const json = (value = payment, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const isError = (status, code) => error => error.status === status && error.statusCode === status && error.code === code;

// Independent test signer; do not use the implementation being verified to
// produce notification signatures or to assert request signatures.
function headersFor(rawBody, overrides = {}) {
  const method = overrides.method || 'POST';
  const rawTarget = overrides.rawTarget || '/payments/notify';
  const project = overrides.project || 'type';
  const keyId = overrides.keyId || 'notify-v1';
  const timestamp = String(overrides.timestamp ?? Math.floor(time / 1000));
  const nonce = overrides.nonce || '0123456789abcdef0123456789abcdef';
  const hash = createHash('sha256').update(rawBody).digest('hex');
  const canonical = ['v1', method, rawTarget, project, keyId, timestamp, nonce, hash, ''].join('\n');
  const signature = createHmac('sha256', Buffer.from(overrides.secret || notifySecretBase64, 'base64')).update(canonical).digest('base64');
  return { 'X-Pay-Project': project, 'X-Pay-Key-Id': keyId, 'X-Pay-Timestamp': timestamp, 'X-Pay-Nonce': nonce, 'X-Pay-Signature': signature };
}

function notification(changed = {}, options = {}) {
  const rawBody = options.rawBody ?? Buffer.from(JSON.stringify({ ...event, ...changed }));
  return { method: 'POST', rawTarget: '/payments/notify', rawBody, config, now: () => time,
    headers: headersFor(rawBody, options), ...options };
}

test('HMAC matches the published pay.where.work fixed vector with a final LF', async () => {
  const { signPaymentRequest } = await clientPromise;
  const signed = signPaymentRequest({ method: 'POST', rawTarget: '/api/v1/payments/native', projectCode: 'doc-project',
    keyId: 'api-v1', timestamp: '1760000000', nonce: '0123456789abcdef0123456789abcdef',
    rawBody: '{"businessOrderNo":"DOC-ORDER-001","amountFen":1,"description":"接入测试","expiresInSeconds":900}', secretBase64: apiSecretBase64 });
  assert.equal(signed.bodySha256, 'f8143af214b62b54c14d4d89a8ff581061a6f116a82ac3f68234a25469b1eec4');
  assert.equal(signed.signature, 'IjHH28M0Xy4R3wLw1q+6rWt9xdaYxgzho50NOvOpYx4=');
  assert.equal(signed.canonical.split('\n').length, 9);
  assert.ok(signed.canonical.endsWith('\n'));
  assert.equal(signed.canonical.includes('\r'), false);
});

test('signer preserves raw query ordering and percent encoding, hashes empty GET body', async () => {
  const { signPaymentRequest } = await clientPromise;
  const target = '/api/v1/payments/ORDER%2f%E4%B8%80?b=2&a=%2F';
  const signed = signPaymentRequest({ method: 'GET', rawTarget: target, projectCode: 'type', keyId: 'api-v1', timestamp: 1,
    nonce: 'abcdefghijklmnop', secretBase64: apiSecretBase64 });
  assert.equal(signed.canonical.split('\n')[2], target);
  assert.equal(signed.bodySha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.throws(() => signPaymentRequest({ method: 'GET', rawTarget: target, projectCode: 'type', keyId: 'api-v1', timestamp: 1,
    nonce: 'abcdefghijklmnop', rawBody: '{}', secretBase64: apiSecretBase64 }), isError(400, 'PAYMENT_REQUEST_INVALID'));
});

test('configuration rejects weak/noncanonical keys, missing key IDs, unsafe origins, shared API/notification key', async () => {
  const { createPaymentClient } = await clientPromise;
  for (const changed of [
    { apiSecretBase64: Buffer.alloc(31).toString('base64') }, { apiSecretBase64: 'not base64' },
    { apiSecretBase64: `${apiSecretBase64}\n` }, { apiSecretBase64: apiSecretBase64.replace(/=$/, '') },
    { apiKeyId: undefined }, { apiKeyId: 'id\r\nsecret: value' }, { projectCode: 'type/other' },
    { baseUrl: 'http://pay.where.work' }, { baseUrl: 'https://user:secret@pay.where.work' },
    { baseUrl: 'https://pay.where.work?injected=true' }, { baseUrl: 'https://pay.where.work/api/' },
    { notifySecretBase64: apiSecretBase64 },
  ]) assert.throws(() => createPaymentClient({ config: { ...config, ...changed }, fetchImpl: () => assert.fail('No network') }), isError(503, 'PAYMENT_CONFIGURATION_INVALID'));
});

test('native creation serializes once, signs exactly sent UTF-8 and retains caller idempotency key', async () => {
  const { createPaymentClient } = await clientPromise;
  let captured;
  const client = createPaymentClient({ config, now: () => time, nonce: () => 'request_nonce_0001', fetchImpl: async (url, options) => {
    captured = { url, ...options };
    return json(payment, 201);
  } });
  const result = await client.createNativePayment({ ...body, injectedAmount: 1 }, 'saved-order-attempt-1');
  assert.deepEqual(result, { statusCode: 201, payment });
  assert.equal(captured.url, 'https://pay.where.work/api/v1/payments/native');
  assert.equal(captured.body, JSON.stringify(body));
  assert.equal(captured.headers['Idempotency-Key'], 'saved-order-attempt-1');
  assert.equal(captured.headers['Content-Type'], 'application/json');
  assert.equal(captured.redirect, 'error');
  assert.ok(captured.signal instanceof AbortSignal);
  const expected = headersFor(Buffer.from(captured.body), { rawTarget: '/api/v1/payments/native', project: 'type', keyId: 'api-v1', secret: apiSecretBase64, nonce: 'request_nonce_0001' });
  for (const [key, value] of Object.entries(expected)) assert.equal(captured.headers[key], value);
});

test('all seven API methods use signed paths, empty zero-byte action bodies and encoded opaque IDs', async () => {
  const { createPaymentClient } = await clientPromise;
  const calls = [];
  let sequence = 0;
  const client = createPaymentClient({ config, now: time, nonce: () => `request_nonce_${String(++sequence).padStart(4, '0')}`,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (url.endsWith('/qrcode.svg')) return new Response('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
      return json(payment, options.method === 'POST' ? 202 : 200);
    } });
  assert.equal((await client.createNativePayment(body, 'saved-key')).statusCode, 202);
  await client.getPayment('opaque/part');
  await client.getByBusinessOrder('订单/一?x=1');
  assert.equal((await client.syncPayment('opaque')).statusCode, 202);
  assert.match(await client.getQrSvg('attempt'), /^<svg/);
  assert.equal((await client.closeAttempt('attempt')).statusCode, 202);
  assert.equal((await client.retryNotification('opaque')).statusCode, 202);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/api/v1/payments/native', '/api/v1/payments/opaque%2Fpart',
    '/api/v1/payments/by-business-order/%E8%AE%A2%E5%8D%95%2F%E4%B8%80%3Fx%3D1',
    '/api/v1/payments/opaque/sync', '/api/v1/payment-attempts/attempt/qrcode.svg',
    '/api/v1/payment-attempts/attempt/close', '/api/v1/payments/opaque/notifications/retry',
  ]);
  assert.equal(new Set(calls.map(call => call.headers['X-Pay-Nonce'])).size, 7);
  for (const call of calls.slice(1)) {
    assert.equal(call.body, call.method === 'GET' ? undefined : '');
    assert.equal(Object.hasOwn(call.headers, 'Idempotency-Key'), false);
  }
});

test('202/CREATING and PAID/RETRY remain snapshots, not local business fulfilment', async () => {
  const { createPaymentClient } = await clientPromise;
  let next = { ...payment, attemptStatus: 'CREATING', codeUrl: null };
  const client = createPaymentClient({ config, fetchImpl: async () => json(next, 202) });
  assert.equal((await client.createNativePayment(body, 'key')).payment.attemptStatus, 'CREATING');
  next = { ...payment, paymentStatus: 'PAID', attemptStatus: 'SUCCEEDED', notificationStatus: 'RETRY', newProviderField: { kept: true } };
  const result = await client.syncPayment(payment.paymentId);
  assert.equal(result.statusCode, 202);
  assert.equal(result.payment.paymentStatus, 'PAID');
  assert.equal(result.payment.notificationStatus, 'RETRY');
  assert.deepEqual(result.payment.newProviderField, { kept: true });
});

test('snapshot parser accepts missing optional fields, does not accept invalid money or currency', async () => {
  const { createPaymentClient } = await clientPromise;
  const minimal = { ...payment };
  for (const field of ['codeUrl', 'qrUrl', 'expiresAt', 'needsAttention']) delete minimal[field];
  let next = minimal;
  const client = createPaymentClient({ config, fetchImpl: async () => json(next) });
  assert.deepEqual((await client.getPayment('payment')).payment, minimal);
  for (const changed of [{ amountFen: '990' }, { amountFen: 1.5 }, { amountFen: 2147483648 }, { currency: 'USD' }, { paymentStatus: 'OK' }, { paymentId: '' }]) {
    next = { ...payment, ...changed };
    await assert.rejects(client.getPayment('payment'), isError(502, 'PAYMENT_RESPONSE_INVALID'));
  }
});

test('timeout or gateway failure never retries, leaks transport details, or changes idempotency', async () => {
  const { createPaymentClient } = await clientPromise;
  const requests = [];
  const client = createPaymentClient({ config, fetchImpl: async (url, options) => {
    requests.push(options);
    throw new Error(`socket timeout with secret ${apiSecretBase64}`);
  } });
  await assert.rejects(client.createNativePayment(body, 'persistent-key'), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'PAYMENT_RESULT_UNKNOWN');
    assert.equal(error.message.includes(apiSecretBase64), false);
    return true;
  });
  assert.equal(requests.length, 1);
  await assert.rejects(client.createNativePayment(body, 'persistent-key'), isError(503, 'PAYMENT_RESULT_UNKNOWN'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
  assert.equal(requests[0].body, requests[1].body);
  assert.notEqual(requests[0].headers['X-Pay-Nonce'], requests[1].headers['X-Pay-Nonce']);
});

test('provider errors retain safe code and status and do not expose untrusted message or HTML', async () => {
  const { createPaymentClient } = await clientPromise;
  let next = json({ code: 'IDEMPOTENCY_CONFLICT', message: `secret:${apiSecretBase64}` }, 409);
  const client = createPaymentClient({ config, fetchImpl: async () => next });
  await assert.rejects(client.createNativePayment(body, 'saved-key'), error => {
    assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(error.statusCode, 409);
    assert.equal(error.message.includes(apiSecretBase64), false);
    return true;
  });
  next = new Response(`<html>${notifySecretBase64}</html>`, { status: 502 });
  await assert.rejects(client.getPayment('id'), error => error.code === 'PAYMENT_UPSTREAM_ERROR' && !error.message.includes(notifySecretBase64));
});

test('malformed JSON, wrong content type, empty successful response and oversized upstream body are safe errors', async () => {
  const { createPaymentClient } = await clientPromise;
  for (const response of [
    new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify(payment), { headers: { 'Content-Type': 'text/html' } }),
    new Response(null, { status: 204 }), new Response('x'.repeat(1024 * 1024 + 1)),
  ]) {
    const client = createPaymentClient({ config, fetchImpl: async () => response });
    await assert.rejects(client.getPayment('id'), error => error instanceof Error && [502, 503].includes(error.status));
  }
});

test('QR response permits provider vector paths and rejects active/external SVG content', async () => {
  const { createPaymentClient } = await clientPromise;
  for (const svg of [
    '<svg><script>alert(1)</script></svg>', '<svg onload="evil()"/>', '<svg><image href="https://evil.test/"/></svg>',
    '<svg><foreignObject><div>bad</div></foreignObject></svg>', '<svg><style>path{fill:url(https://evil.test)}</style></svg>',
    '<!DOCTYPE svg [<!ENTITY bad SYSTEM "file:///secret">]><svg/>', '<html>bad</html>',
  ]) {
    const client = createPaymentClient({ config, fetchImpl: async () => new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } }) });
    await assert.rejects(client.getQrSvg('attempt'), isError(502, 'PAYMENT_QR_INVALID'));
  }
});

test('invalid create parameters fail before transport; explicit null/default lifetime is preserved', async () => {
  const { createPaymentClient } = await clientPromise;
  let calls = 0;
  const client = createPaymentClient({ config, fetchImpl: async (_url, options) => { calls += 1; assert.equal(JSON.parse(options.body).expiresInSeconds, null); return json(); } });
  for (const changed of [
    { businessOrderNo: '' }, { businessOrderNo: 'a'.repeat(65) }, { amountFen: 0 }, { amountFen: '990' }, { amountFen: 1.5 },
    { description: '' }, { description: '😀'.repeat(128) }, { expiresInSeconds: 59 }, { expiresInSeconds: 7201 },
  ]) assert.throws(() => client.createNativePayment({ ...body, ...changed }, 'key'), isError(400, 'PAYMENT_REQUEST_INVALID'));
  for (const key of ['', 'spaces not allowed', 'a'.repeat(129), '换行', 'bad\r\n']) assert.throws(() => client.createNativePayment(body, key), isError(400, 'PAYMENT_REQUEST_INVALID'));
  assert.equal(calls, 0);
  await client.createNativePayment({ ...body, expiresInSeconds: null, description: '😀'.repeat(127) }, 'key');
  assert.equal(calls, 1);
});

test('notification validates raw UTF-8 bytes with independent notification key and preserves added fields', async () => {
  const { verifyNotification } = await clientPromise;
  const original = { ...event, added: { future: true } };
  const rawBody = Buffer.from(JSON.stringify(original));
  const verified = verifyNotification(notification({}, { rawBody }));
  assert.deepEqual(verified, original);
  assert.deepEqual(verifyNotification(notification({}, { rawBody })), original, 'legitimate repeat is left to durable business deduplication');
});

test('API key cannot authenticate notifications; rotation accepts configured previous independent key', async () => {
  const { verifyNotification } = await clientPromise;
  assert.throws(() => verifyNotification(notification({}, { secret: apiSecretBase64 })), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
  assert.throws(() => verifyNotification(notification({}, { config: { ...config, notifySecretBase64: apiSecretBase64 } })), isError(503, 'PAYMENT_CONFIGURATION_INVALID'));
  const rotated = { ...config, notifyKeys: { 'notify-old': previousSecretBase64 } };
  assert.deepEqual(verifyNotification(notification({}, { config: rotated, keyId: 'notify-old', secret: previousSecretBase64 })), event);
  assert.throws(() => verifyNotification(notification({}, { keyId: 'unknown-key' })), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
});

test('notification rejects wrong method, target, query, encoded path and project before JSON handling', async () => {
  const { verifyNotification } = await clientPromise;
  for (const changed of [
    { method: 'GET' }, { rawTarget: '/payments/notify?changed=1' }, { rawTarget: '/payments/%6Eotify' },
    { rawTarget: '/other' }, { project: 'other-app' },
  ]) assert.throws(() => verifyNotification(notification({}, changed)), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
});

test('notification headers must all be present, single and unambiguous including raw Node duplicates', async () => {
  const { verifyNotification } = await clientPromise;
  const input = notification();
  for (const name of Object.keys(input.headers)) {
    const missing = { ...input.headers }; delete missing[name];
    assert.throws(() => verifyNotification({ ...input, headers: missing }), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
    assert.throws(() => verifyNotification({ ...input, headers: { ...input.headers, [name.toLowerCase()]: input.headers[name] } }), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
    assert.throws(() => verifyNotification({ ...input, headers: { ...input.headers, [name]: [input.headers[name]] } }), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
  }
  const rawHeaders = Object.entries(input.headers).flat();
  assert.deepEqual(verifyNotification({ ...input, headers: {}, rawHeaders }), event);
  assert.throws(() => verifyNotification({ ...input, rawHeaders: [...rawHeaders, 'x-pay-project', 'type'] }), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
  assert.throws(() => verifyNotification({ ...input, headers: new Headers({ ...input.headers, 'X-Pay-Nonce': 'nonce-one, nonce-two' }) }), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
});

test('notification timestamp uses seconds and accepts the documented inclusive 300-second window', async () => {
  const { verifyNotification } = await clientPromise;
  const seconds = Math.floor(time / 1000);
  for (const difference of [-300, 300]) assert.deepEqual(verifyNotification(notification({}, { timestamp: seconds + difference })), event);
  for (const timestamp of [seconds - 301, seconds + 301, time, 'not-a-time', '-1', '1e9']) {
    assert.throws(() => verifyNotification(notification({}, { timestamp })), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
  }
});

test('notification rejects short nonce, tampered raw body and noncanonical/wrong signatures', async () => {
  const { verifyNotification } = await clientPromise;
  assert.throws(() => verifyNotification(notification({}, { nonce: 'short' })), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
  const input = notification();
  assert.throws(() => verifyNotification({ ...input, rawBody: Buffer.from(input.rawBody.toString() + ' ') }), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
  for (const signature of [Buffer.alloc(32).toString('base64'), input.headers['X-Pay-Signature'].slice(0, -1), `${input.headers['X-Pay-Signature']}\n`]) {
    assert.throws(() => verifyNotification({ ...input, headers: { ...input.headers, 'X-Pay-Signature': signature } }), isError(401, 'PAYMENT_NOTIFICATION_UNAUTHORIZED'));
  }
});

test('notification invalid UTF-8 and malformed JSON are rejected after valid signature', async () => {
  const { verifyNotification } = await clientPromise;
  for (const rawBody of [Buffer.from([0xc0, 0xaf]), Buffer.from('{malformed'), Buffer.from('null'), Buffer.from('[]')]) {
    assert.throws(() => verifyNotification(notification({}, { rawBody })), isError(400, 'PAYMENT_NOTIFICATION_INVALID'));
  }
});

test('notification body cap accepts exactly 64 KiB and rejects extra byte before authentication', async () => {
  const { verifyNotification } = await clientPromise;
  const padded = { ...event, padding: '' };
  padded.padding = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(padded)));
  const rawBody = Buffer.from(JSON.stringify(padded));
  assert.equal(rawBody.length, 65536);
  assert.equal(verifyNotification(notification({}, { rawBody })).eventId, event.eventId);
  assert.throws(() => verifyNotification({ rawBody: Buffer.alloc(65537) }), isError(413, 'PAYMENT_NOTIFICATION_TOO_LARGE'));
});

test('notification validates exact event type, IDs, positive integer money, CNY and UTC date', async () => {
  const { verifyNotification } = await clientPromise;
  for (const changed of [
    { eventType: 'PAYMENT.PENDING' }, { projectCode: 'other' }, { eventId: '' }, { paymentId: null }, { attemptId: ' ' },
    { businessOrderNo: 'a'.repeat(65) }, { wechatTransactionId: '' }, { amountFen: '990' }, { amountFen: 0 }, { amountFen: 1.1 },
    { amountFen: 2147483648 }, { currency: 'USD' }, { paidAt: '2026-10-16' }, { paidAt: '2026-02-30T08:00:00Z' },
    { paidAt: '2026-10-16T16:00:00+08:00' }, { paidAt: 'not-a-date' },
  ]) assert.throws(() => verifyNotification(notification(changed)), isError(400, 'PAYMENT_NOTIFICATION_INVALID'));
});

test('notification configuration cannot redirect, query-bind or reuse an API key during rotation', async () => {
  const { verifyNotification } = await clientPromise;
  for (const changed of [
    { notifyUrl: 'http://type.where.work/payments/notify' }, { notifyUrl: 'https://type.where.work/payments/notify?key=value' },
    { notifyUrl: 'https://type.where.work/payments/notify#hash' }, { notifyUrl: 'https://user:password@type.where.work/payments/notify' },
    { notifySecretBase64: 'broken' }, { notifyKeyId: undefined }, { notifyKeys: { 'previous': apiSecretBase64 } },
  ]) assert.throws(() => verifyNotification(notification({}, { config: { ...config, ...changed } })), isError(503, 'PAYMENT_CONFIGURATION_INVALID'));
});
