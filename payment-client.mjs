import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// pay.where.work/docs/integration.md, HTTP contract V0.1 (2026-10-16).
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const AUTH_HEADERS = ['x-pay-project', 'x-pay-key-id', 'x-pay-timestamp', 'x-pay-nonce', 'x-pay-signature'];
const encoder = new TextDecoder('utf-8', { fatal: true });

export class PaymentError extends Error {
  constructor(message = '支付服务暂时不可用，请稍后重试。', { status = 503, statusCode = status, code = 'PAYMENT_UNAVAILABLE' } = {}) {
    super(message);
    this.name = 'PaymentError';
    this.status = statusCode;
    this.statusCode = statusCode;
    this.code = code;
  }
}

function invalidConfig() {
  return new PaymentError('支付配置尚未完成，请联系管理员。', { status: 503, code: 'PAYMENT_CONFIGURATION_INVALID' });
}

function authFailure() {
  return new PaymentError('支付通知认证失败。', { status: 401, code: 'PAYMENT_NOTIFICATION_UNAUTHORIZED' });
}

function invalidEvent() {
  return new PaymentError('支付通知内容不符合约定。', { status: 400, code: 'PAYMENT_NOTIFICATION_INVALID' });
}

function decodeSecret(value, failure = invalidConfig) {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw failure();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 32 || bytes.toString('base64') !== value) throw failure();
  return bytes;
}

function bytes(value = '') {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new PaymentError('支付请求内容不符合约定。', { status: 400, code: 'PAYMENT_REQUEST_INVALID' });
}

function projectValue(config) {
  if (!config || typeof config.projectCode !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(config.projectCode)) throw invalidConfig();
  return config.projectCode;
}

function httpsUrl(value, { originOnly = false } = {}) {
  try {
    if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f?#]/.test(value)) throw invalidConfig();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (originOnly && url.pathname !== '/')) throw invalidConfig();
    return url;
  } catch { throw invalidConfig(); }
}

function unixSeconds(now) {
  const value = typeof now === 'function' ? now() : now;
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw invalidConfig();
  return Math.floor(milliseconds / 1000);
}

function canonicalString({ method, rawTarget, projectCode, keyId, timestamp, nonce, rawBody }) {
  if (!['GET', 'POST'].includes(method) || typeof rawTarget !== 'string' || !rawTarget.startsWith('/')
    || rawTarget.startsWith('//') || /[\r\n\u0000#]/.test(rawTarget)
    || !/^[A-Za-z0-9_-]{1,32}$/.test(projectCode) || typeof keyId !== 'string' || !TOKEN.test(keyId)
    || !/^\d{1,16}$/.test(String(timestamp)) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new PaymentError('支付请求签名参数不符合约定。', { status: 400, code: 'PAYMENT_REQUEST_INVALID' });
  }
  const body = bytes(rawBody);
  if (method === 'GET' && body.length) throw new PaymentError('查询支付时不能附带请求正文。', { status: 400, code: 'PAYMENT_REQUEST_INVALID' });
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  return { canonical: ['v1', method, rawTarget, projectCode, keyId, String(timestamp), nonce, bodySha256, ''].join('\n'), bodySha256 };
}

export function signPaymentRequest({ method, rawTarget, projectCode, keyId, timestamp, nonce, rawBody = '', secretBase64 }) {
  const signed = canonicalString({ method, rawTarget, projectCode, keyId, timestamp, nonce, rawBody });
  const signature = createHmac('sha256', decodeSecret(secretBase64)).update(signed.canonical, 'utf8').digest('base64');
  return {
    ...signed,
    signature,
    headers: {
      'X-Pay-Project': projectCode,
      'X-Pay-Key-Id': keyId,
      'X-Pay-Timestamp': String(timestamp),
      'X-Pay-Nonce': nonce,
      'X-Pay-Signature': signature,
    },
  };
}

function identifier(value, { max = 512 } = {}) {
  if (typeof value !== 'string' || !value || [...value].length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PaymentError('支付订单标识不符合约定。', { status: 400, code: 'PAYMENT_REQUEST_INVALID' });
  }
  // encodeURIComponent leaves these legal characters unescaped, but explicit
  // encoding keeps the identifier a single opaque path segment for proxies.
  try {
    return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch { throw new PaymentError('支付订单标识不符合约定。', { status: 400, code: 'PAYMENT_REQUEST_INVALID' }); }
}

function safeRemoteCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'PAYMENT_UPSTREAM_ERROR';
}

function remoteMessage(code) {
  const messages = {
    UNAUTHORIZED: '支付服务认证失败，请联系管理员。',
    NOT_FOUND: '未找到支付记录，请刷新订单状态。',
    IDEMPOTENCY_CONFLICT: '支付请求与原订单不一致，请刷新订单状态。',
    BUSINESS_ORDER_CONFLICT: '支付金额或商品与原订单不一致。',
    ACTIVE_PAYMENT_EXISTS: '订单已有付款请求，请查看原订单。',
    ALREADY_PAID: '该订单已经支付，请刷新订单状态。',
    QRCODE_UNAVAILABLE: '付款二维码暂不可用，请刷新订单状态。',
    NOT_PAID: '订单尚未确认付款。',
    NOTIFICATION_BUSY: '付款通知正在处理中，请稍后再试。',
    WECHAT_REJECTED: '微信暂未接受付款请求，请刷新订单状态。',
  };
  return messages[code] || '支付服务暂时不可用，请稍后重试。';
}

async function boundedText(response) {
  const advertised = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) throw new PaymentError();
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new PaymentError();
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PaymentError();
      }
      chunks.push(Buffer.from(item.value));
    }
    return encoder.decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}

function objectJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new PaymentError('支付服务返回了无法识别的结果，请刷新订单状态。', { status: 502, code: 'PAYMENT_RESPONSE_INVALID' }); }
}

function snapshot(payment) {
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
  if (!validId(payment.paymentId) || !validId(payment.businessOrderNo) || !Number.isInteger(payment.amountFen)
    || payment.amountFen < 1 || payment.amountFen > 2147483647 || payment.currency !== 'CNY'
    || !['UNPAID', 'PAID'].includes(payment.paymentStatus)
    || !validId(payment.attemptId) || typeof payment.attemptStatus !== 'string' || !payment.attemptStatus
    || (payment.codeUrl != null && (typeof payment.codeUrl !== 'string' || payment.codeUrl.length > 8192))
    || (payment.qrUrl != null && (typeof payment.qrUrl !== 'string' || payment.qrUrl.length > 8192))) {
    throw new PaymentError('支付服务返回了无法识别的订单，请刷新订单状态。', { status: 502, code: 'PAYMENT_RESPONSE_INVALID' });
  }
  // Optional fields and added provider fields are intentionally preserved.
  return payment;
}

export function createPaymentClient({ config, fetchImpl = fetch, now = Date.now,
  nonce = () => randomBytes(24).toString('hex'), timeoutMs = 10000 } = {}) {
  const projectCode = projectValue(config);
  const origin = httpsUrl(config.baseUrl, { originOnly: true }).origin;
  if (typeof config.apiKeyId !== 'string' || !TOKEN.test(config.apiKeyId)) throw invalidConfig();
  const apiKey = decodeSecret(config.apiSecretBase64);
  if (config.notifySecretBase64 && apiKey.equals(decodeSecret(config.notifySecretBase64))) throw invalidConfig();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || typeof fetchImpl !== 'function') throw invalidConfig();

  async function request(method, rawTarget, { rawBody = '', idempotencyKey, svg = false } = {}) {
    const signed = signPaymentRequest({ method, rawTarget, projectCode, keyId: config.apiKeyId,
      timestamp: unixSeconds(now), nonce: nonce(), rawBody, secretBase64: config.apiSecretBase64 });
    const headers = { ...signed.headers, Accept: svg ? 'image/svg+xml' : 'application/json' };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    let text;
    try {
      // The payment service may accept a request before transport fails. Never
      // retry automatically or invent an idempotency key at this boundary.
      response = await fetchImpl(`${origin}${rawTarget}`, {
        method, headers, body: method === 'GET' ? undefined : rawBody,
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      text = await boundedText(response);
    } catch {
      throw new PaymentError('支付结果暂未确认，请稍后刷新原订单。', { status: 503, code: 'PAYMENT_RESULT_UNKNOWN' });
    }
    if (!response.ok) {
      let code = 'PAYMENT_UPSTREAM_ERROR';
      try { code = safeRemoteCode(JSON.parse(text).code); } catch { /* Never expose upstream text. */ }
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
      throw new PaymentError(remoteMessage(code), { status, code });
    }
    const contentType = response.headers?.get?.('content-type')?.toLowerCase() || '';
    if (svg) {
      if (response.status !== 200 || !/^image\/svg\+xml(?:;|$)/.test(contentType)
        || !/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)
        || /<\s*(?:script|foreignObject|iframe|object|embed|image|use|style|animate\w*|set)\b|\bon\w+\s*=|(?:href|src)\s*=|<!DOCTYPE|<!ENTITY|url\s*\(/i.test(text)) {
        throw new PaymentError('支付二维码暂不可用，请刷新订单状态。', { status: 502, code: 'PAYMENT_QR_INVALID' });
      }
      return text;
    }
    if (!/^application\/json(?:;|$)/.test(contentType) || ![200, 201, 202].includes(response.status)) {
      throw new PaymentError('支付服务返回了无法识别的结果，请刷新订单状态。', { status: 502, code: 'PAYMENT_RESPONSE_INVALID' });
    }
    return { statusCode: response.status, payment: snapshot(objectJson(text)) };
  }

  return Object.freeze({
    createNativePayment(input, idempotencyKey) {
      if (!input || typeof input.businessOrderNo !== 'string' || !input.businessOrderNo.trim()
        || [...input.businessOrderNo].length > 64 || /[\u0000-\u001f\u007f]/.test(input.businessOrderNo)
        || !Number.isInteger(input.amountFen) || input.amountFen < 1 || input.amountFen > 2147483647
        || typeof input.description !== 'string' || !input.description.trim() || [...input.description].length > 127
        || /[\u0000-\u001f\u007f]/.test(input.description)
        || (input.expiresInSeconds != null && (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 60 || input.expiresInSeconds > 7200))
        || typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
        throw new PaymentError('支付请求内容不符合约定。', { status: 400, code: 'PAYMENT_REQUEST_INVALID' });
      }
      const body = { businessOrderNo: input.businessOrderNo, amountFen: input.amountFen, description: input.description };
      if (input.expiresInSeconds !== undefined) body.expiresInSeconds = input.expiresInSeconds;
      const rawBody = JSON.stringify(body);
      return request('POST', '/api/v1/payments/native', { rawBody, idempotencyKey });
    },
    getPayment(paymentId) { return request('GET', `/api/v1/payments/${identifier(paymentId)}`); },
    getByBusinessOrder(businessOrderNo) { return request('GET', `/api/v1/payments/by-business-order/${identifier(businessOrderNo, { max: 64 })}`); },
    syncPayment(paymentId) { return request('POST', `/api/v1/payments/${identifier(paymentId)}/sync`); },
    getQrSvg(attemptId) { return request('GET', `/api/v1/payment-attempts/${identifier(attemptId)}/qrcode.svg`, { svg: true }); },
    closeAttempt(attemptId) { return request('POST', `/api/v1/payment-attempts/${identifier(attemptId)}/close`); },
    retryNotification(paymentId) { return request('POST', `/api/v1/payments/${identifier(paymentId)}/notifications/retry`); },
  });
}

function notificationHeaders(headers, rawHeaders) {
  const entries = [];
  if (rawHeaders !== undefined) {
    if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) throw authFailure();
    for (let index = 0; index < rawHeaders.length; index += 2) entries.push([rawHeaders[index], rawHeaders[index + 1]]);
  } else if (headers?.entries && typeof headers.entries === 'function') {
    entries.push(...headers.entries());
  } else if (headers && typeof headers === 'object') {
    entries.push(...Object.entries(headers));
  } else throw authFailure();
  const result = Object.create(null);
  for (const [name, value] of entries) {
    if (typeof name !== 'string') throw authFailure();
    const lower = name.toLowerCase();
    if (!AUTH_HEADERS.includes(lower)) continue;
    if (typeof value !== 'string' || Object.hasOwn(result, lower)) throw authFailure();
    result[lower] = value;
  }
  if (AUTH_HEADERS.some(name => !Object.hasOwn(result, name))) throw authFailure();
  return result;
}

function notificationKey(config, keyId) {
  const keys = new Map();
  if (config.notifyKeyId != null || config.notifySecretBase64 != null) {
    if (typeof config.notifyKeyId !== 'string' || !TOKEN.test(config.notifyKeyId)) throw invalidConfig();
    keys.set(config.notifyKeyId, decodeSecret(config.notifySecretBase64));
  }
  if (config.notifyKeys != null) {
    if (typeof config.notifyKeys !== 'object' || Array.isArray(config.notifyKeys)) throw invalidConfig();
    for (const [id, value] of Object.entries(config.notifyKeys)) {
      if (!TOKEN.test(id)) throw invalidConfig();
      const secret = decodeSecret(value);
      if (keys.has(id) && !keys.get(id).equals(secret)) throw invalidConfig();
      keys.set(id, secret);
    }
  }
  if (!keys.size) throw invalidConfig();
  if (config.apiSecretBase64) {
    const apiSecret = decodeSecret(config.apiSecretBase64);
    if ([...keys.values()].some(key => key.equals(apiSecret))) throw invalidConfig();
  }
  if (!keys.has(keyId)) throw authFailure();
  return keys.get(keyId);
}

function validUtcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  // Reject dates that JavaScript would otherwise silently normalize (Feb 30).
  return parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

export function verifyNotification({ method, rawTarget, headers, rawHeaders, rawBody, config, now = Date.now } = {}) {
  const body = bytes(rawBody);
  if (body.length > MAX_BODY_BYTES) throw new PaymentError('支付通知正文过大。', { status: 413, code: 'PAYMENT_NOTIFICATION_TOO_LARGE' });
  const projectCode = projectValue(config);
  const callback = httpsUrl(config.notifyUrl);
  if (method !== 'POST' || rawTarget !== callback.pathname) throw authFailure();
  const signed = notificationHeaders(headers, rawHeaders);
  const keyId = signed['x-pay-key-id'];
  const timestamp = signed['x-pay-timestamp'];
  const nonce = signed['x-pay-nonce'];
  const signature = signed['x-pay-signature'];
  if (signed['x-pay-project'] !== projectCode || !TOKEN.test(keyId) || !/^\d{1,16}$/.test(timestamp)
    || !Number.isSafeInteger(Number(timestamp)) || Math.abs(unixSeconds(now) - Number(timestamp)) > 300
    || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)
    || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) throw authFailure();
  const key = notificationKey(config, keyId);
  const { canonical } = canonicalString({ method, rawTarget, projectCode, keyId, timestamp, nonce, rawBody: body });
  const expected = createHmac('sha256', key).update(canonical, 'utf8').digest();
  const actual = Buffer.from(signature, 'base64');
  if (actual.length !== expected.length || actual.toString('base64') !== signature || !timingSafeEqual(expected, actual)) throw authFailure();
  let event;
  try {
    event = JSON.parse(encoder.decode(body));
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error();
  } catch { throw invalidEvent(); }
  const validId = (value, max = 512) => typeof value === 'string' && value.trim().length > 0 && [...value].length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  if (event.eventType !== 'PAYMENT.SUCCEEDED' || event.projectCode !== projectCode
    || !validId(event.eventId) || !validId(event.paymentId) || !validId(event.attemptId)
    || !validId(event.businessOrderNo, 64) || !validId(event.wechatTransactionId)
    || !Number.isInteger(event.amountFen) || event.amountFen < 1 || event.amountFen > 2147483647
    || event.currency !== 'CNY' || !validUtcTimestamp(event.paidAt)) throw invalidEvent();
  // Retries deliberately remain valid: the order transaction durably ensures
  // payment IDs/transaction IDs grant access only once before returning ACK.
  return event;
}
