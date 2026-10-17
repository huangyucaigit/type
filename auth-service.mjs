import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, randomUUID, createHash, createHmac, timingSafeEqual, scrypt as nodeScrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthProviderError } from './auth-providers.mjs';
import { createPaymentClient, verifyNotification } from './payment-client.mjs';
import { createMockPaymentProvider } from './payment-mock.mjs';

const scrypt = promisify(nodeScrypt);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;
const SESSION_MS = 365 * DAY;
const GUEST_MS = DAY;
const STARTER_CLAIM_MS = 7 * DAY;
const REFERRAL_ATTRIBUTION_MS = 30 * DAY;
const REFERRAL_REWARD_LIMIT = 3;
const CODE_MS = 5 * 60000;
const TOKEN_MS = 30 * 60000;
const SESSION_COOKIE = 'zijian_session';
const DEVICE_COOKIE = 'zijian_device';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const BILLING_PLANS = Object.freeze([
  Object.freeze({ id: 'monthly', name: '月度套餐', amountFen: 990, days: 30, currency: 'CNY' }),
  Object.freeze({ id: 'quarterly', name: '季度套餐', amountFen: 1990, days: 90, currency: 'CNY' }),
  Object.freeze({ id: 'yearly', name: '年度套餐', amountFen: 5990, days: 365, currency: 'CNY' }),
]);
// Operator acceptance only: never included in the public catalogue or accepted
// as a browser-selected plan. It uses the normal order and fulfilment pipeline.
const PAYMENT_ACCEPTANCE_PLAN = Object.freeze({ id: 'acceptance_1fen', name: '支付接入验收', amountFen: 1, days: 1, currency: 'CNY' });
const BILLING_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AuthError extends Error {
  constructor(status, message, code = 'AUTH_ERROR', retryAfter) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

function emailValue(value) {
  if (typeof value !== 'string') throw new AuthError(400, '请输入有效的邮箱地址。', 'INVALID_EMAIL');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)) {
    throw new AuthError(400, '请输入有效的邮箱地址。', 'INVALID_EMAIL');
  }
  return email;
}

function phoneValue(value) {
  if (typeof value !== 'string') throw new AuthError(400, '请输入中国大陆 11 位手机号。', 'INVALID_PHONE');
  const phone = value.trim().replace(/^\+86\s?/, '');
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new AuthError(400, '请输入中国大陆 11 位手机号。', 'INVALID_PHONE');
  return phone;
}

function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || Buffer.byteLength(value) > 512) {
    throw new AuthError(400, '密码需要 8 至 128 个字符。', 'INVALID_PASSWORD');
  }
  return value;
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function passwordHash(password) {
  const salt = randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt}$${derived.toString('base64url')}`;
}

async function passwordMatches(password, stored) {
  if (typeof password !== 'string' || password.length > 128 || Buffer.byteLength(password) > 512 || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$16384$8$1') return false;
  const actual = await scrypt(password, parts[4], 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return equal(actual.toString('base64url'), parts[5]);
}

function cookies(request) {
  const raw = request?.headers?.cookie;
  if (typeof raw !== 'string' || raw.length > 16000) return {};
  return Object.fromEntries(raw.split(';').map(item => {
    const pair = item.trim(), separator = pair.indexOf('=');
    return separator < 0 ? ['', ''] : [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

function setCookie(response, name, value, expiresAt, secure, timestamp) {
  const maxAge = Math.max(0, Math.floor((expiresAt - timestamp) / 1000));
  const cookie = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}${secure ? '; Secure' : ''}`;
  const previous = response.getHeader?.('Set-Cookie');
  response.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), cookie]);
}

function noProvider() { throw new AuthError(503, '发送服务尚未配置，请稍后重试。', 'PROVIDER_UNAVAILABLE'); }

/** The database is private server state. No caller-provided time or browser flag grants access. */
export function createAuthService({ filename = path.join(process.env.ZIJIAN_AUTH_DATA_DIR || path.join(ROOT, '.data'), 'auth.sqlite'), now = Date.now, providers = {}, drawStarterDays = () => randomInt(3, 8), drawReferralDays = () => randomInt(3, 8), paymentOptions = {} } = {}) {
  if (typeof filename !== 'string' || !filename || typeof now !== 'function' || typeof drawStarterDays !== 'function' || typeof drawReferralDays !== 'function') throw new TypeError('Invalid authentication service configuration.');
  if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS auth_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE, phone TEXT UNIQUE, password_hash TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      trial_started_at INTEGER, trial_ends_at INTEGER, paid_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_trial_claims (
      device_hash TEXT PRIMARY KEY, fingerprint_hash TEXT UNIQUE, user_id TEXT NOT NULL REFERENCES auth_users(id), claimed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sms_codes (
      phone TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(phone, purpose)
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      email TEXT, password_hash TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_rates (
      scope TEXT NOT NULL, key_hash TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY(scope, key_hash)
    );
    CREATE TABLE IF NOT EXISTS access_guests (
      id TEXT PRIMARY KEY, fingerprint_hash TEXT UNIQUE, started_at INTEGER, ends_at INTEGER,
      transferred_to TEXT REFERENCES auth_users(id), transferred_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS access_devices (
      device_hash TEXT PRIMARY KEY, guest_id TEXT NOT NULL REFERENCES access_guests(id)
    );
    CREATE TABLE IF NOT EXISTS access_starters (
      user_id TEXT PRIMARY KEY REFERENCES auth_users(id), days INTEGER, claimed_at INTEGER NOT NULL,
      legacy INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS access_starter_draws (
      guest_id TEXT PRIMARY KEY REFERENCES access_guests(id),
      days INTEGER NOT NULL CHECK(days BETWEEN 3 AND 7), drawn_at INTEGER NOT NULL,
      claimed_by TEXT REFERENCES auth_users(id), claimed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS access_guest_transfers (
      user_id TEXT PRIMARY KEY REFERENCES auth_users(id), guest_id TEXT UNIQUE NOT NULL REFERENCES access_guests(id),
      duration_ms INTEGER NOT NULL, transferred_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_campaigns (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, days INTEGER NOT NULL, starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, max_redemptions INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS access_coupon_codes (
      code TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES access_campaigns(id), channel TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_redemptions (
      user_id TEXT NOT NULL REFERENCES auth_users(id), campaign_id TEXT NOT NULL REFERENCES access_campaigns(id),
      code TEXT NOT NULL REFERENCES access_coupon_codes(code), channel TEXT NOT NULL, redeemed_at INTEGER NOT NULL,
      days INTEGER NOT NULL, PRIMARY KEY(user_id, campaign_id)
    );
    CREATE TABLE IF NOT EXISTS access_referral_codes (
      user_id TEXT PRIMARY KEY REFERENCES auth_users(id), code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_referral_accounts (
      user_id TEXT NOT NULL REFERENCES auth_users(id), device_hash TEXT NOT NULL,
      guest_id TEXT REFERENCES access_guests(id), seen_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, device_hash)
    );
    CREATE INDEX IF NOT EXISTS access_referral_accounts_guest ON access_referral_accounts(guest_id);
    CREATE INDEX IF NOT EXISTS access_referral_accounts_device ON access_referral_accounts(device_hash);
    CREATE TABLE IF NOT EXISTS access_referral_attributions (
      guest_id TEXT PRIMARY KEY REFERENCES access_guests(id), inviter_id TEXT NOT NULL REFERENCES auth_users(id),
      visited_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      consumed_by TEXT REFERENCES auth_users(id), consumed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS access_referral_rewards (
      invitee_id TEXT PRIMARY KEY REFERENCES auth_users(id), inviter_id TEXT NOT NULL REFERENCES auth_users(id),
      guest_id TEXT NOT NULL UNIQUE REFERENCES access_guests(id),
      days INTEGER NOT NULL CHECK(days BETWEEN 3 AND 7), granted_at INTEGER NOT NULL
    );`);
  if (!db.prepare('PRAGMA table_info(auth_users)').all().some(column => column.name === 'account_ends_at')) {
    db.exec('ALTER TABLE auth_users ADD COLUMN account_ends_at INTEGER');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_orders (
      order_no TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id), plan_id TEXT NOT NULL,
      amount_fen INTEGER NOT NULL, days INTEGER NOT NULL, currency TEXT NOT NULL,
      project_code TEXT, description TEXT, plan_name TEXT,
      mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'UNPAID', active INTEGER NOT NULL DEFAULT 1,
      payment_id TEXT UNIQUE, payment_status TEXT NOT NULL DEFAULT 'UNPAID',
      created_at INTEGER NOT NULL, paid_at INTEGER, granted_at INTEGER, entitlement_ends_at INTEGER,
      transaction_id TEXT UNIQUE, needs_attention INTEGER NOT NULL DEFAULT 0,
      notification_status TEXT NOT NULL DEFAULT 'NONE'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_one_active ON billing_orders(user_id) WHERE active=1;
    CREATE INDEX IF NOT EXISTS billing_orders_user ON billing_orders(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS billing_requests (
      user_id TEXT NOT NULL REFERENCES auth_users(id), request_id TEXT NOT NULL,
      order_no TEXT NOT NULL REFERENCES billing_orders(order_no), plan_id TEXT NOT NULL,
      PRIMARY KEY(user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS billing_attempts (
      id TEXT PRIMARY KEY, order_no TEXT NOT NULL REFERENCES billing_orders(order_no),
      generation INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      provider_attempt_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'CREATING',
      code_url TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, last_error TEXT,
      UNIQUE(order_no,generation)
    );
    CREATE TABLE IF NOT EXISTS billing_events (
      event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, order_no TEXT NOT NULL REFERENCES billing_orders(order_no),
      payment_id TEXT NOT NULL, transaction_id TEXT NOT NULL, received_at INTEGER NOT NULL
    );
  `);
  if (filename !== ':memory:') {
    try { chmodSync(filename, 0o600); } catch { /* Windows permissions are managed by the host. */ }
  }
  db.prepare('INSERT OR IGNORE INTO auth_settings (key, value) VALUES (?, ?)').run('secret', randomBytes(32).toString('base64url'));
  const secret = db.prepare('SELECT value FROM auth_settings WHERE key = ?').get('secret').value;
  const mac = value => createHmac('sha256', secret).update(value).digest('hex');
  // Preserve old 72-hour claims and paid access exactly once. A claimed legacy
  // account/browser must not receive the new signup reward a second time.
  if (!db.prepare('SELECT value FROM auth_settings WHERE key=?').get('access_v2_migrated')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('SELECT value FROM auth_settings WHERE key=?').get('access_v2_migrated')) {
        db.prepare('UPDATE auth_users SET account_ends_at=max(coalesce(trial_ends_at,0),coalesce(paid_until,0)) WHERE trial_ends_at IS NOT NULL OR paid_until IS NOT NULL').run();
        db.prepare('INSERT OR IGNORE INTO access_starters (user_id,days,claimed_at,legacy) SELECT id,NULL,coalesce(trial_started_at,created_at),1 FROM auth_users WHERE trial_ends_at IS NOT NULL').run();
        for (const claim of db.prepare('SELECT * FROM auth_trial_claims').all()) {
          const guestId = randomUUID();
          db.prepare('INSERT INTO access_guests (id,fingerprint_hash,transferred_to,transferred_at) VALUES (?,?,?,?)').run(guestId, claim.fingerprint_hash, claim.user_id, claim.claimed_at);
          db.prepare('INSERT INTO access_devices (device_hash,guest_id) VALUES (?,?)').run(claim.device_hash, guestId);
        }
        db.prepare('INSERT INTO auth_settings (key,value) VALUES (?,?)').run('access_v2_migrated', '1');
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  const providerStatus = { sms: Boolean(providers.status?.sms), email: Boolean(providers.status?.email) };
  let closed = false;
  let lastCleanup = -Infinity;
  const paymentMode = paymentOptions.mode || 'disabled';
  if (!['disabled', 'mock', 'live'].includes(paymentMode)) { db.close(); throw new TypeError('Invalid payment mode.'); }
  const mockProvider = paymentMode === 'mock' ? createMockPaymentProvider({ db, now: time,
    receiveNotification: receivePaymentNotification, options: paymentOptions.mockOptions || {} }) : null;
  const paymentConfig = mockProvider?.config || paymentOptions.config;
  for (const column of ['project_code', 'description', 'plan_name']) {
    if (!db.prepare('PRAGMA table_info(billing_orders)').all().some(item => item.name === column)) db.exec(`ALTER TABLE billing_orders ADD COLUMN ${column} TEXT`);
  }
  for (const row of db.prepare('SELECT order_no,plan_id,mode FROM billing_orders WHERE project_code IS NULL OR description IS NULL OR plan_name IS NULL').all()) {
    const projectCode = row.mode === 'mock' ? 'type_mock' : paymentConfig?.projectCode || null;
    const planName = (row.plan_id === PAYMENT_ACCEPTANCE_PLAN.id ? PAYMENT_ACCEPTANCE_PLAN : BILLING_PLANS.find(item => item.id === row.plan_id))?.name || '使用时长套餐';
    const description = `火星叔叔雅思作文练习 - ${planName}`;
    db.prepare('UPDATE billing_orders SET project_code=coalesce(project_code,?),description=coalesce(description,?),plan_name=coalesce(plan_name,?) WHERE order_no=?').run(projectCode, description, planName, row.order_no);
  }
  const paymentClient = paymentMode === 'disabled' ? null : createPaymentClient({ config: paymentConfig,
    now: time, ...(mockProvider ? { fetchImpl: mockProvider.fetchImpl } : paymentOptions.fetchImpl ? { fetchImpl: paymentOptions.fetchImpl } : {}) });
  const billingLocks = new Map();

  function time() {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new AuthError(503, '账号服务暂时不可用。', 'AUTH_UNAVAILABLE');
    return timestamp;
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function rate(scope, key, limit, period, timestamp) {
    const keyHash = mac(`rate:${scope}:${key || 'unknown'}`);
    transaction(() => {
      const row = db.prepare('SELECT * FROM auth_rates WHERE scope = ? AND key_hash = ?').get(scope, keyHash);
      if (row && timestamp < row.window_start + period) {
        if (row.count >= limit) throw new AuthError(429, '操作过于频繁，请稍后重试。', 'RATE_LIMITED', Math.ceil((row.window_start + period - timestamp) / 1000));
        db.prepare('UPDATE auth_rates SET count = count + 1 WHERE scope = ? AND key_hash = ?').run(scope, keyHash);
      } else {
        db.prepare('INSERT INTO auth_rates (scope,key_hash,window_start,count) VALUES (?,?,?,1) ON CONFLICT(scope,key_hash) DO UPDATE SET window_start=excluded.window_start,count=1').run(scope, keyHash, timestamp);
      }
    });
  }
  function deviceIdentity(request) {
    const cookie = cookies(request)[DEVICE_COOKIE];
    if (typeof cookie !== 'string' || !/^[A-Za-z0-9_-]{43}\.[a-f0-9]{64}$/.test(cookie)) return null;
    const [id, signature] = cookie.split('.');
    return equal(signature, mac(`device:${id}`)) ? id : null;
  }
  function sessionUser(request, timestamp = time()) {
    const token = cookies(request)[SESSION_COOKIE];
    if (!TOKEN_RE.test(token || '')) return null;
    return db.prepare(`SELECT u.* FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>?`).get(hash(token), timestamp) || null;
  }
  function requireUser(request, timestamp) {
    const user = sessionUser(request, timestamp);
    if (!user) throw new AuthError(401, '请先登录。', 'LOGIN_REQUIRED');
    return user;
  }
  const deviceHashOf = deviceId => deviceId ? mac(`device-claim:${deviceId}`) : '';
  function guestRecord(deviceId) {
    return deviceId ? db.prepare('SELECT g.* FROM access_devices d JOIN access_guests g ON g.id=d.guest_id WHERE d.device_hash=?').get(deviceHashOf(deviceId)) : null;
  }
  function guestState(deviceId, timestamp) {
    const guest = guestRecord(deviceId);
    return { status: guest?.transferred_to ? 'transferred' : guest?.started_at !== null && guest?.started_at !== undefined ? (guest.ends_at > timestamp ? 'active' : 'expired') : 'available', startedAt: guest?.started_at ?? null, endsAt: guest?.ends_at ?? null };
  }
  function starterState(user, deviceId, timestamp) {
    if (!user) return { status: 'login_required', days: null, claimDeadline: null };
    const claim = db.prepare('SELECT * FROM access_starters WHERE user_id=?').get(user.id);
    const claimDeadline = user.created_at + STARTER_CLAIM_MS;
    if (claim) return { status: claim.legacy ? 'legacy_claimed' : 'claimed', days: claim.days ?? null, claimDeadline };
    if (timestamp >= claimDeadline) return { status: 'expired', days: null, claimDeadline };
    const browserClaim = db.prepare('SELECT user_id FROM auth_trial_claims WHERE device_hash=?').get(deviceHashOf(deviceId));
    const guest = guestRecord(deviceId);
    return { status: (browserClaim && browserClaim.user_id !== user.id) || (guest?.transferred_to && guest.transferred_to !== user.id) ? 'browser_used' : 'available', days: null, claimDeadline };
  }
  function starterDrawState(user, deviceId, timestamp) {
    const starter = starterState(user, deviceId, timestamp);
    const guest = guestRecord(deviceId);
    const draw = guest ? db.prepare('SELECT * FROM access_starter_draws WHERE guest_id=?').get(guest.id) : null;
    if (starter.status === 'claimed') return { status: 'claimed', days: starter.days, drawnAt: draw?.claimed_by === user.id ? draw.drawn_at : null };
    if (['legacy_claimed', 'expired', 'browser_used'].includes(starter.status)) return { status: 'ineligible', days: null, drawnAt: null };
    if (draw?.claimed_by) return { status: 'claimed', days: draw.days, drawnAt: draw.drawn_at };
    if (guest?.transferred_to || db.prepare('SELECT user_id FROM auth_trial_claims WHERE device_hash=? OR fingerprint_hash=?').get(deviceHashOf(deviceId), guest?.fingerprint_hash ?? null)) {
      return { status: 'ineligible', days: null, drawnAt: null };
    }
    return { status: draw ? 'pending' : 'available', days: draw?.days ?? null, drawnAt: draw?.drawn_at ?? null };
  }
  function entitlement(user, deviceId, timestamp) {
    const guest = guestState(deviceId, timestamp);
    const accountEndsAt = user?.account_ends_at || null;
    const common = { trialStartedAt: user?.trial_started_at ?? null, trialEndsAt: user?.trial_ends_at ?? null, paidUntil: user?.paid_until ?? null, accountEndsAt };
    if (accountEndsAt > timestamp) return { status: 'active', hasAccess: true, source: 'account', expiresAt: accountEndsAt, ...common };
    if (guest.status === 'active') return { status: 'guest', hasAccess: true, source: 'guest', expiresAt: guest.endsAt, ...common };
    return { status: guest.status === 'available' ? 'guest_available' : 'expired', hasAccess: false, source: null, expiresAt: accountEndsAt || guest.endsAt, ...common };
  }
  function referralState(user, timestamp) {
    const common = { rewardedCount: 0, rewardLimit: REFERRAL_REWARD_LIMIT, totalDays: 0, remaining: REFERRAL_REWARD_LIMIT };
    if (!user) return { code: null, ...common };
    let row = db.prepare('SELECT code FROM access_referral_codes WHERE user_id=?').get(user.id);
    while (!row) {
      db.prepare('INSERT OR IGNORE INTO access_referral_codes (user_id,code,created_at) VALUES (?,?,?)').run(user.id, randomBytes(18).toString('base64url'), timestamp);
      row = db.prepare('SELECT code FROM access_referral_codes WHERE user_id=?').get(user.id);
    }
    const rewards = db.prepare('SELECT count(*) AS count,coalesce(sum(days),0) AS days FROM access_referral_rewards WHERE inviter_id=?').get(user.id);
    return { code: row.code, rewardedCount: rewards.count, rewardLimit: REFERRAL_REWARD_LIMIT, totalDays: rewards.days, remaining: Math.max(0, REFERRAL_REWARD_LIMIT - rewards.count) };
  }
  function state(request, deviceId, timestamp, message) {
    const user = sessionUser(request, timestamp);
    if (user) rememberAccountBrowser(user.id, deviceId, guestRecord(deviceId), timestamp);
    return {
      user: user ? { id: user.id, email: user.email, phone: user.phone, emailVerified: Boolean(user.email_verified) } : null,
      entitlement: entitlement(user, deviceId, timestamp), guest: guestState(deviceId, timestamp), starter: starterState(user, deviceId, timestamp), starterDraw: starterDrawState(user, deviceId, timestamp), serverTime: timestamp,
      csrfToken: mac(`csrf:${deviceId}`), providers: providerStatus, referral: referralState(user, timestamp),
      ...(message ? { message } : {}),
    };
  }
  function authenticate(request, response, userId, secure, timestamp) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO auth_sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(hash(token), userId, timestamp, timestamp + SESSION_MS);
    setCookie(response, SESSION_COOKIE, token, timestamp + SESSION_MS, secure, timestamp);
    request = { ...request, headers: { ...request.headers, cookie: `${request.headers?.cookie || ''}; ${SESSION_COOKIE}=${token}` } };
    return request;
  }
  function revokeUser(userId) { db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(userId); }
  function clearSession(response, secure, timestamp) { setCookie(response, SESSION_COOKIE, '', 0, secure, timestamp); }
  function validateCode(body) {
    if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw new AuthError(400, '请输入 6 位短信验证码。', 'INVALID_CODE');
    return body.code;
  }
  // A failed attempt must commit, including the fifth attempt which removes the code.
  function consumeCode(phone, purpose, code, timestamp) {
    const result = transaction(() => {
      const item = db.prepare('SELECT * FROM auth_sms_codes WHERE phone=? AND purpose=?').get(phone, purpose);
      if (!item || item.expires_at <= timestamp || item.attempts >= 5) {
        db.prepare('DELETE FROM auth_sms_codes WHERE phone=? AND purpose=?').run(phone, purpose);
        return false;
      }
      if (!equal(item.code_hash, mac(`sms:${phone}:${purpose}:${code}`))) {
        if (item.attempts + 1 >= 5) db.prepare('DELETE FROM auth_sms_codes WHERE phone=? AND purpose=?').run(phone, purpose);
        else db.prepare('UPDATE auth_sms_codes SET attempts=attempts+1 WHERE phone=? AND purpose=?').run(phone, purpose);
        return false;
      }
      db.prepare('DELETE FROM auth_sms_codes WHERE phone=? AND purpose=?').run(phone, purpose);
      return true;
    });
    if (!result) throw new AuthError(400, '验证码错误或已过期，请重新获取。', 'INVALID_CODE');
  }
  async function send(method, input) {
    try {
      if (typeof providers[method] !== 'function') noProvider();
      await providers[method](input);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (error instanceof AuthProviderError) throw new AuthError(error.status, error.message, error.code);
      throw new AuthError(503, method === 'sendSms' ? '短信暂时无法发送，请稍后重试。' : '邮件暂时无法发送，请稍后重试。', 'DELIVERY_UNAVAILABLE');
    }
  }
  function link(origin, kind, token) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      url.pathname = '/'; url.search = ''; url.hash = '';
      url.searchParams.set(kind, token);
      return url.toString();
    } catch { throw new AuthError(503, '暂时无法生成邮件链接，请稍后重试。', 'AUTH_UNAVAILABLE'); }
  }
  function tokenValue(value) {
    if (typeof value !== 'string' || !TOKEN_RE.test(value)) throw new AuthError(400, '链接无效或已过期，请重新申请。', 'INVALID_TOKEN');
    return hash(value);
  }
  function fingerprintOf(body, request, clientIp) {
    if (typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(body.fingerprint)) throw new AuthError(400, '浏览器标识无效，请刷新页面后重试。', 'INVALID_FINGERPRINT');
    // Hash browser characteristics together with IP and UA: matching common
    // characteristics alone never deny an unrelated visitor. No raw signal is kept.
    return mac(`fingerprint:${JSON.stringify([String(clientIp), String(request.headers?.['user-agent'] || '').slice(0, 1024), body.fingerprint.toLowerCase()])}`);
  }
  function resolveGuest(deviceId, fingerprintHash) {
    const deviceHash = deviceHashOf(deviceId);
    let guest = guestRecord(deviceId);
    if (guest) return guest;
    guest = db.prepare('SELECT * FROM access_guests WHERE fingerprint_hash=?').get(fingerprintHash);
    if (!guest) {
      const id = randomUUID();
      db.prepare('INSERT INTO access_guests (id,fingerprint_hash) VALUES (?,?)').run(id, fingerprintHash);
      guest = db.prepare('SELECT * FROM access_guests WHERE id=?').get(id);
    }
    db.prepare('INSERT INTO access_devices (device_hash,guest_id) VALUES (?,?)').run(deviceHash, guest.id);
    return guest;
  }
  function optionalRegistrationGuest(body, request, deviceId, clientIp) {
    return Object.prototype.hasOwnProperty.call(body, 'fingerprint') ? resolveGuest(deviceId, fingerprintOf(body, request, clientIp)) : guestRecord(deviceId);
  }
  function rememberAccountBrowser(userId, deviceId, guest, timestamp) {
    db.prepare(`INSERT INTO access_referral_accounts (user_id,device_hash,guest_id,seen_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id,device_hash) DO UPDATE SET guest_id=coalesce(excluded.guest_id,access_referral_accounts.guest_id),seen_at=excluded.seen_at`).run(userId, deviceHashOf(deviceId), guest?.id ?? null, timestamp);
  }
  function knownAccountBrowser(deviceId, guest) {
    return Boolean(db.prepare('SELECT user_id FROM access_referral_accounts WHERE device_hash=? OR guest_id=? LIMIT 1').get(deviceHashOf(deviceId), guest?.id ?? null) || guest?.transferred_to);
  }
  // Registration and reward insertion share one write transaction. A consumed
  // browser attribution cannot be reused by another email or after cookie loss.
  function consumeReferral(userId, deviceId, guest, timestamp, isNew, priorAccount) {
    if (!guest) return;
    const attribution = db.prepare('SELECT * FROM access_referral_attributions WHERE guest_id=?').get(guest.id);
    if (!attribution || attribution.consumed_at !== null) return;
    db.prepare('UPDATE access_referral_attributions SET consumed_by=?,consumed_at=? WHERE guest_id=?').run(userId, timestamp, guest.id);
    if (!isNew || priorAccount || attribution.expires_at <= timestamp || attribution.inviter_id === userId || knownAccountBrowser(deviceId, guest)) return;
    const rewards = db.prepare('SELECT count(*) AS count FROM access_referral_rewards WHERE inviter_id=?').get(attribution.inviter_id).count;
    if (rewards >= REFERRAL_REWARD_LIMIT || db.prepare('SELECT invitee_id FROM access_referral_rewards WHERE invitee_id=? OR guest_id=?').get(userId, guest.id)) return;
    const days = drawReferralDays();
    if (!Number.isInteger(days) || days < 3 || days > 7) throw new AuthError(503, '邀请奖励暂时不可用，请稍后重试。', 'REFERRAL_UNAVAILABLE');
    grantDuration(attribution.inviter_id, days * DAY, timestamp);
    db.prepare('INSERT INTO access_referral_rewards (invitee_id,inviter_id,guest_id,days,granted_at) VALUES (?,?,?,?,?)').run(userId, attribution.inviter_id, guest.id, days, timestamp);
  }
  // Call only inside the same transaction as eligibility checks or the grant.
  // A pending draw is durable browser state; it never starts either access clock.
  function resolveStarterDraw(guest, timestamp) {
    const previous = db.prepare('SELECT * FROM access_starter_draws WHERE guest_id=?').get(guest.id);
    if (previous) return previous;
    const days = drawStarterDays();
    if (!Number.isInteger(days) || days < 3 || days > 7) throw new AuthError(503, '时长券服务暂时不可用。', 'COUPON_UNAVAILABLE');
    db.prepare('INSERT INTO access_starter_draws (guest_id,days,drawn_at) VALUES (?,?,?)').run(guest.id, days, timestamp);
    return db.prepare('SELECT * FROM access_starter_draws WHERE guest_id=?').get(guest.id);
  }
  function grantDuration(userId, duration, timestamp) {
    const user = db.prepare('SELECT account_ends_at FROM auth_users WHERE id=?').get(userId);
    const endsAt = Math.max(timestamp, user.account_ends_at || 0) + duration;
    if (!Number.isSafeInteger(endsAt)) throw new AuthError(400, '账号累计时长超出上限。', 'DURATION_LIMIT');
    db.prepare('UPDATE auth_users SET account_ends_at=? WHERE id=?').run(endsAt, userId);
    return endsAt;
  }
  function couponCode(value) {
    if (typeof value !== 'string' || !/^[A-Z0-9_-]{3,64}$/.test(value.trim().toUpperCase())) throw new AuthError(400, '请输入有效的时长券兑换码。', 'INVALID_COUPON');
    return value.trim().toUpperCase();
  }
  function campaignRow(id) {
    const row = db.prepare('SELECT * FROM access_campaigns WHERE id=?').get(id);
    if (!row) throw new AuthError(404, '活动不存在。', 'CAMPAIGN_NOT_FOUND');
    const count = db.prepare('SELECT count(*) AS count FROM access_redemptions WHERE campaign_id=?').get(id).count;
    const codes = db.prepare('SELECT c.code,c.channel,count(r.user_id) AS redemptions FROM access_coupon_codes c LEFT JOIN access_redemptions r ON r.code=c.code WHERE c.campaign_id=? GROUP BY c.code ORDER BY c.code').all(id);
    return { id: row.id, title: row.title, days: row.days, startsAt: row.starts_at, endsAt: row.ends_at, maxRedemptions: row.max_redemptions, redemptions: count, enabled: Boolean(row.enabled), codes: codes.map(item => ({ ...item })) };
  }
  // Trusted operator API only. The HTTP server never exposes campaign creation.
  function createCampaign(input) {
    if (closed) throw new AuthError(503, '账号服务暂时不可用。', 'AUTH_UNAVAILABLE');
    const { id, title, days, endsAt, maxRedemptions, codes } = input || {};
    const startsAt = input?.startsAt ?? time();
    const valid = typeof id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(id) && typeof title === 'string' && title.trim().length >= 1 && title.trim().length <= 100 && Number.isInteger(days) && days >= 1 && days <= 365 && Number.isSafeInteger(startsAt) && startsAt >= 0 && Number.isSafeInteger(endsAt) && endsAt > startsAt && Number.isInteger(maxRedemptions) && maxRedemptions >= 1 && maxRedemptions <= 1000000 && Array.isArray(codes) && codes.length >= 1 && codes.length <= 1000;
    if (!valid) throw new AuthError(400, '活动配置无效。', 'INVALID_CAMPAIGN');
    const normalized = codes.map(item => {
      let code;
      try { code = couponCode(item?.code); } catch { throw new AuthError(400, '活动兑换码无效。', 'INVALID_CAMPAIGN'); }
      if (typeof item.channel !== 'string' || item.channel.trim().length < 1 || item.channel.trim().length > 64) throw new AuthError(400, '活动渠道名称无效。', 'INVALID_CAMPAIGN');
      return { code, channel: item.channel.trim() };
    });
    if (new Set(normalized.map(item => item.code)).size !== normalized.length) throw new AuthError(409, '活动或兑换码已存在。', 'CAMPAIGN_CONFLICT');
    return transaction(() => {
      if (db.prepare('SELECT id FROM access_campaigns WHERE id=?').get(id) || normalized.some(item => db.prepare('SELECT code FROM access_coupon_codes WHERE code=?').get(item.code))) throw new AuthError(409, '活动或兑换码已存在。', 'CAMPAIGN_CONFLICT');
      db.prepare('INSERT INTO access_campaigns (id,title,days,starts_at,ends_at,max_redemptions) VALUES (?,?,?,?,?,?)').run(id, title.trim(), days, startsAt, endsAt, maxRedemptions);
      for (const item of normalized) db.prepare('INSERT INTO access_coupon_codes (code,campaign_id,channel) VALUES (?,?,?)').run(item.code, id, item.channel);
      return campaignRow(id);
    });
  }
  function getCampaigns() {
    if (closed) throw new AuthError(503, '账号服务暂时不可用。', 'AUTH_UNAVAILABLE');
    return db.prepare('SELECT id FROM access_campaigns ORDER BY starts_at DESC,id').all().map(row => campaignRow(row.id));
  }
  function setCampaignEnabled(id, enabled) {
    if (closed) throw new AuthError(503, '账号服务暂时不可用。', 'AUTH_UNAVAILABLE');
    if (typeof enabled !== 'boolean') throw new AuthError(400, '活动启用状态无效。', 'INVALID_CAMPAIGN');
    return transaction(() => {
      campaignRow(id);
      db.prepare('UPDATE access_campaigns SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
      return campaignRow(id);
    });
  }

  function billingMetadata(allowMock = false) {
    const enabled = paymentMode !== 'disabled' && (paymentMode !== 'mock' || allowMock);
    return { mode: paymentMode, enabled, available: enabled, simulation: paymentMode === 'mock', plans: BILLING_PLANS };
  }
  function ensureBilling(allowMock) {
    if (paymentMode === 'disabled') throw new AuthError(503, '支付功能暂未开放。', 'PAYMENT_DISABLED');
    if (paymentMode === 'mock' && !allowMock) throw new AuthError(403, '模拟支付仅可在本地预览使用。', 'MOCK_PAYMENT_LOCAL_ONLY');
  }
  function findOrder(orderNo, userId) {
    const row = db.prepare('SELECT * FROM billing_orders WHERE order_no=? AND user_id=?').get(orderNo, userId);
    if (!row) throw new AuthError(404, '订单不存在。', 'ORDER_NOT_FOUND');
    return row;
  }
  function currentAttempt(orderNo) {
    return db.prepare('SELECT * FROM billing_attempts WHERE order_no=? ORDER BY generation DESC LIMIT 1').get(orderNo);
  }
  function orderView(row) {
    const selected = currentAttempt(row.order_no), plan = BILLING_PLANS.find(item => item.id === row.plan_id);
    let attemptStatus = selected?.status || 'CREATING';
    if (row.status === 'PAID') attemptStatus = 'SUCCEEDED';
    else if (attemptStatus === 'PENDING' && selected.expires_at != null && selected.expires_at <= time()) attemptStatus = 'EXPIRED';
    return { orderNo: row.order_no, planId: row.plan_id, planName: row.plan_name || plan?.name || '使用时长套餐',
      amountFen: row.amount_fen, days: row.days, currency: row.currency, status: row.status,
      paymentStatus: row.payment_status, paymentId: row.payment_id, attemptId: selected?.provider_attempt_id || null,
      attemptStatus, codeUrl: row.status === 'UNPAID' && row.payment_status === 'UNPAID' && attemptStatus === 'PENDING' ? selected.code_url : null,
      expiresAt: selected?.expires_at || null, createdAt: row.created_at, paidAt: row.paid_at,
      grantedAt: row.granted_at, entitlementEndsAt: row.entitlement_ends_at,
      wechatTransactionId: row.transaction_id, needsAttention: Boolean(row.needs_attention),
      notificationStatus: row.notification_status, mode: row.mode,
      lastError: selected?.last_error || null, active: Boolean(row.active) };
  }
  function billingResult(request, deviceId, allowMock, extra = {}) {
    return { ...state(request, deviceId, time()), billing: billingMetadata(allowMock), plans: BILLING_PLANS, ...extra };
  }
  async function orderLock(orderNo, operation) {
    const previous = billingLocks.get(orderNo) || Promise.resolve();
    let unlock;
    const gate = new Promise(resolve => { unlock = resolve; });
    const next = previous.catch(() => {}).then(() => gate);
    billingLocks.set(orderNo, next);
    await previous.catch(() => {});
    try { return await operation(); }
    finally { unlock(); if (billingLocks.get(orderNo) === next) billingLocks.delete(orderNo); }
  }
  function assertOrderMode(row) {
    if (row.mode !== paymentMode) throw new AuthError(409, '此订单属于另一支付环境，请查看当前环境的订单。', 'PAYMENT_MODE_MISMATCH');
    if (row.project_code !== paymentConfig?.projectCode) throw new AuthError(409, '此订单属于另一支付项目，请联系管理员。', 'PAYMENT_ORDER_MISMATCH');
  }
  function newAttempt(orderNo, timestamp) {
    const selected = currentAttempt(orderNo), generation = (selected?.generation || 0) + 1;
    db.prepare('INSERT INTO billing_attempts(id,order_no,generation,idempotency_key,created_at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), orderNo, generation, `type_${randomUUID()}`, timestamp);
    return currentAttempt(orderNo);
  }
  function saveBillingIntent(userId, plan, requestId) {
    return transaction(() => {
      const previous = db.prepare('SELECT * FROM billing_requests WHERE user_id=? AND request_id=?').get(userId, requestId);
      if (previous) {
        if (previous.plan_id !== plan.id) throw new AuthError(409, '该请求已用于另一套餐。', 'ORDER_REQUEST_CONFLICT');
        return findOrder(previous.order_no, userId);
      }
      const active = db.prepare('SELECT * FROM billing_orders WHERE user_id=? AND active=1').get(userId);
      if (active && (active.plan_id !== plan.id || active.mode !== paymentMode)) throw new AuthError(409, '您还有未完成的订单，请先查看或关闭原订单。', 'ACTIVE_ORDER_EXISTS');
      const no = active?.order_no || `type_${randomUUID().replaceAll('-', '')}`;
      if (!active) {
        db.prepare('INSERT INTO billing_orders(order_no,user_id,plan_id,amount_fen,days,currency,project_code,description,plan_name,mode,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(no, userId, plan.id, plan.amountFen, plan.days, plan.currency, paymentConfig.projectCode,
            `火星叔叔雅思作文练习 - ${plan.name}`, plan.name, paymentMode, time());
        newAttempt(no, time());
      }
      db.prepare('INSERT INTO billing_requests(user_id,request_id,order_no,plan_id) VALUES(?,?,?,?)').run(userId, requestId, no, plan.id);
      return findOrder(no, userId);
    });
  }
  function snapshotExpiry(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  function acceptSnapshot(orderNo, localAttemptId, payment) {
    return transaction(() => {
      const row = db.prepare('SELECT * FROM billing_orders WHERE order_no=?').get(orderNo);
      const selected = db.prepare('SELECT * FROM billing_attempts WHERE id=? AND order_no=?').get(localAttemptId, orderNo);
      if (!row || !selected || row.project_code !== paymentConfig.projectCode || payment.businessOrderNo !== row.order_no || payment.amountFen !== row.amount_fen
        || payment.currency !== row.currency || (row.payment_id && row.payment_id !== payment.paymentId)) {
        throw new AuthError(409, '支付记录与业务订单不一致，请联系管理员。', 'PAYMENT_ORDER_MISMATCH');
      }
      // Another application process may have started the next attempt while
      // this query was in flight. Its stale snapshot cannot deactivate or
      // overwrite the current attempt, nor regress a committed notification.
      if (currentAttempt(orderNo).id !== selected.id || (row.status === 'PAID' && selected.provider_attempt_id !== payment.attemptId)) return row;
      if (selected.provider_attempt_id && selected.provider_attempt_id !== payment.attemptId) throw new AuthError(409, '付款请求与业务订单不一致。', 'PAYMENT_ORDER_MISMATCH');
      const otherPayment = db.prepare('SELECT order_no FROM billing_orders WHERE payment_id=? AND order_no<>?').get(payment.paymentId, orderNo);
      const otherAttempt = db.prepare('SELECT order_no FROM billing_attempts WHERE provider_attempt_id=? AND id<>?').get(payment.attemptId, selected.id);
      if (otherPayment || otherAttempt) throw new AuthError(409, '支付记录已绑定其他订单。', 'PAYMENT_ORDER_MISMATCH');
      const paid = row.status === 'PAID', providerPaid = paid || payment.paymentStatus === 'PAID' || row.payment_status === 'PAID';
      const status = paid ? 'SUCCEEDED' : payment.attemptStatus;
      const usable = status === 'PENDING' && !providerPaid && typeof payment.codeUrl === 'string' && payment.codeUrl.length <= 8192;
      db.prepare('UPDATE billing_attempts SET provider_attempt_id=?,status=?,code_url=?,expires_at=?,last_error=NULL WHERE id=?')
        .run(payment.attemptId, status, usable ? payment.codeUrl : null, snapshotExpiry(payment.expiresAt), selected.id);
      db.prepare('UPDATE billing_orders SET payment_id=?,payment_status=?,needs_attention=?,notification_status=?,active=? WHERE order_no=?')
        .run(payment.paymentId, providerPaid ? 'PAID' : 'UNPAID', providerPaid && !paid ? 1 : 0,
          paid ? 'ACK' : typeof payment.notificationStatus === 'string' ? payment.notificationStatus : row.notification_status,
          paid || ['CLOSED', 'REJECTED'].includes(status) ? 0 : 1, orderNo);
      return db.prepare('SELECT * FROM billing_orders WHERE order_no=?').get(orderNo);
    });
  }
  function uncertainAttempt(selected, error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'PAYMENT_RESULT_UNKNOWN';
    db.prepare("UPDATE billing_attempts SET status=CASE WHEN provider_attempt_id IS NULL THEN 'UNKNOWN' ELSE status END,last_error=? WHERE id=? AND status<>'SUCCEEDED'")
      .run(code, selected.id);
  }
  async function obtainPayment(orderNo, { createIfMissing = false, sync = false } = {}) {
    let row = db.prepare('SELECT * FROM billing_orders WHERE order_no=?').get(orderNo), selected = currentAttempt(orderNo);
    assertOrderMode(row);
    if (row.status === 'PAID') return row;
    let result;
    try {
      // A lost create response never allocates a second request. Reconcile the
      // business number, then replay its exact persisted idempotency key only
      // when the provider explicitly confirms there is no payment record.
      if (selected.provider_attempt_id && row.payment_id) {
        result = sync ? await paymentClient.syncPayment(row.payment_id) : await paymentClient.getPayment(row.payment_id);
      } else if (selected.status !== 'CREATING' || !createIfMissing) {
        try { result = await paymentClient.getByBusinessOrder(orderNo); }
        catch (error) {
          if (error.code !== 'NOT_FOUND' || !createIfMissing) throw error;
        }
      }
      if (!result && createIfMissing) result = await paymentClient.createNativePayment({
        businessOrderNo: row.order_no, amountFen: row.amount_fen,
        description: row.description,
        expiresInSeconds: 900,
      }, selected.idempotency_key);
      if (!result) return row;
      row = acceptSnapshot(orderNo, selected.id, result.payment);
      if (row.payment_status === 'PAID' && row.status !== 'PAID') {
        // A query is useful for recovery, but time is only granted by the
        // authenticated business notification, including in mock mode.
        try {
          const retried = await paymentClient.retryNotification(row.payment_id);
          acceptSnapshot(orderNo, selected.id, retried.payment);
        } catch { /* Keep PAID + needsAttention visible for safe retry. */ }
      }
      return db.prepare('SELECT * FROM billing_orders WHERE order_no=?').get(orderNo);
    } catch (error) {
      uncertainAttempt(selected, error);
      // API transport failure means an uncertain order, never a cancelled one.
      // The next GET or retry resumes the same order and idempotency key.
      if (error.code === 'PAYMENT_ORDER_MISMATCH') throw error;
      return db.prepare('SELECT * FROM billing_orders WHERE order_no=?').get(orderNo);
    }
  }
  async function receivePaymentNotification({ request, rawTarget, rawBody, rawHeaders, headers, allowMock = false, mockInternal = false } = {}) {
    if (closed) throw new AuthError(503, '账号服务暂时不可用。', 'AUTH_UNAVAILABLE');
    ensureBilling(allowMock || mockInternal);
    const event = verifyNotification({ method: request?.method || 'POST', rawTarget,
      headers: headers || request?.headers, rawHeaders, rawBody, config: paymentConfig, now: time });
    const payloadHash = hash(rawBody);
    transaction(() => {
      const row = db.prepare('SELECT * FROM billing_orders WHERE order_no=?').get(event.businessOrderNo);
      if (!row || row.mode !== paymentMode) throw new AuthError(404, '通知对应的业务订单不存在。', 'PAYMENT_ORDER_NOT_FOUND');
      if (event.projectCode !== row.project_code || event.amountFen !== row.amount_fen || event.currency !== row.currency
        || (row.payment_id && row.payment_id !== event.paymentId)
        || (row.transaction_id && row.transaction_id !== event.wechatTransactionId)) {
        throw new AuthError(409, '支付通知与业务订单不一致。', 'PAYMENT_ORDER_MISMATCH');
      }
      const previous = db.prepare('SELECT * FROM billing_events WHERE event_id=?').get(event.eventId);
      if (previous) {
        if (previous.payload_hash !== payloadHash || previous.order_no !== row.order_no) throw new AuthError(409, '支付事件内容发生冲突。', 'PAYMENT_EVENT_CONFLICT');
        return;
      }
      const transactionOwner = db.prepare('SELECT order_no FROM billing_orders WHERE transaction_id=? AND order_no<>?').get(event.wechatTransactionId, row.order_no);
      const paymentOwner = db.prepare('SELECT order_no FROM billing_orders WHERE payment_id=? AND order_no<>?').get(event.paymentId, row.order_no);
      if (transactionOwner || paymentOwner) throw new AuthError(409, '支付凭据已用于其他订单。', 'PAYMENT_ORDER_MISMATCH');
      let selected = db.prepare('SELECT * FROM billing_attempts WHERE provider_attempt_id=?').get(event.attemptId);
      if (selected && selected.order_no !== row.order_no) throw new AuthError(409, '付款请求与业务订单不一致。', 'PAYMENT_ORDER_MISMATCH');
      if (!selected) {
        selected = currentAttempt(row.order_no);
        if (!selected || selected.provider_attempt_id || !['CREATING', 'UNKNOWN'].includes(selected.status)) throw new AuthError(409, '付款请求尚未匹配，请重试通知。', 'PAYMENT_ATTEMPT_MISMATCH');
      }
      const paidAt = Date.parse(event.paidAt);
      if (paidAt < row.created_at - 300000 || paidAt > time() + 300000) throw new AuthError(409, '付款时间与业务订单不一致。', 'PAYMENT_ORDER_MISMATCH');
      db.prepare('INSERT INTO billing_events(event_id,payload_hash,order_no,payment_id,transaction_id,received_at) VALUES(?,?,?,?,?,?)')
        .run(event.eventId, payloadHash, row.order_no, event.paymentId, event.wechatTransactionId, time());
      db.prepare("UPDATE billing_attempts SET provider_attempt_id=?,status='SUCCEEDED',code_url=NULL,last_error=NULL WHERE id=?").run(event.attemptId, selected.id);
      if (row.status !== 'PAID') {
        const grantedAt = time(), endsAt = grantDuration(row.user_id, row.days * DAY, grantedAt);
        db.prepare('UPDATE auth_users SET paid_until=? WHERE id=?').run(endsAt, row.user_id);
        db.prepare("UPDATE billing_orders SET status='PAID',payment_status='PAID',active=0,payment_id=?,paid_at=?,granted_at=?,entitlement_ends_at=?,transaction_id=?,needs_attention=0,notification_status='ACK' WHERE order_no=?")
          .run(event.paymentId, paidAt, grantedAt, endsAt, event.wechatTransactionId, row.order_no);
      }
    });
    // This ACK is returned only after both order and entitlement have committed.
    return { eventId: event.eventId, status: 'ACK' };
  }
  // Trusted operator methods only. There is deliberately no HTTP admin route.
  async function createPaymentAcceptanceOrder(input) {
    if (closed) throw new AuthError(503, '账号服务暂时不可用。', 'AUTH_UNAVAILABLE');
    ensureBilling(true);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['userId', 'requestId'].includes(key))
      || typeof input.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.userId)
      || typeof input.requestId !== 'string' || !BILLING_REQUEST_ID.test(input.requestId)) {
      throw new AuthError(400, '请指定既有账号和有效的验收请求编号。', 'INVALID_ACCEPTANCE_ORDER');
    }
    if (!db.prepare('SELECT id FROM auth_users WHERE id=?').get(input.userId)) throw new AuthError(404, '验收账号不存在，请先注册账号。', 'USER_NOT_FOUND');
    const row = saveBillingIntent(input.userId, PAYMENT_ACCEPTANCE_PLAN, input.requestId);
    const recovered = await orderLock(row.order_no, () => obtainPayment(row.order_no, { createIfMissing: true }));
    return orderView(recovered);
  }
  function getBillingOrder(orderNo) {
    if (closed) throw new AuthError(503, '账号服务暂时不可用。', 'AUTH_UNAVAILABLE');
    const row = typeof orderNo === 'string' ? db.prepare('SELECT * FROM billing_orders WHERE order_no=?').get(orderNo) : null;
    if (!row) throw new AuthError(404, '订单不存在。', 'ORDER_NOT_FOUND');
    return orderView(row);
  }
  async function retryBillingNotification(orderNo) {
    if (closed) throw new AuthError(503, '账号服务暂时不可用。', 'AUTH_UNAVAILABLE');
    ensureBilling(true);
    getBillingOrder(orderNo);
    return orderLock(orderNo, async () => {
      const row = db.prepare('SELECT * FROM billing_orders WHERE order_no=?').get(orderNo);
      assertOrderMode(row);
      if (row.payment_status !== 'PAID' || !row.payment_id) throw new AuthError(409, '此订单尚未确认付款，请先核实原订单状态。', 'NOT_PAID');
      const result = await paymentClient.retryNotification(row.payment_id);
      acceptSnapshot(orderNo, currentAttempt(orderNo).id, result.payment);
      return getBillingOrder(orderNo);
    });
  }
  async function handleBilling({ request, response, pathname, body, deviceId, secure, clientIp, allowMock }) {
    if (request.method === 'GET' && pathname === '/api/billing/plans') {
      if (!deviceId) {
        deviceId = randomBytes(32).toString('base64url');
        setCookie(response, DEVICE_COOKIE, `${deviceId}.${mac(`device:${deviceId}`)}`, time() + SESSION_MS, secure, time());
      }
      return billingResult(request, deviceId, allowMock);
    }
    ensureBilling(allowMock);
    const user = requireUser(request, time());
    const route = /^\/api\/billing\/orders(?:\/([A-Za-z0-9_-]{1,64})(?:\/(sync|close|retry|mock-complete|mock-notify-retry))?)?$/.exec(pathname);
    if (!route) throw new AuthError(404, '接口不存在。', 'NOT_FOUND');
    const orderNo = route[1], action = route[2];
    if (request.method === 'GET' && !action) {
      if (!orderNo) {
        const orders = db.prepare('SELECT * FROM billing_orders WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(user.id).map(orderView);
        return billingResult(request, deviceId, allowMock, { orders });
      }
      const row = findOrder(orderNo, user.id);
      const recovered = row.mode === paymentMode && row.status !== 'PAID'
        ? await orderLock(orderNo, () => obtainPayment(orderNo)) : row;
      return billingResult(request, deviceId, allowMock, { order: orderView(recovered) });
    }
    if (request.method !== 'POST' || (orderNo && !action) || (!orderNo && action)) throw new AuthError(405, '请求方法不受支持。', 'METHOD_NOT_ALLOWED');
    if (!deviceId || !equal(request.headers?.['x-csrf-token'], mac(`csrf:${deviceId}`))) throw new AuthError(403, '页面验证已失效，请刷新后重试。', 'CSRF_INVALID');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError(400, '请求内容无效。', 'INVALID_BODY');
    if (!orderNo) {
      const plan = BILLING_PLANS.find(item => item.id === body.planId);
      if (!plan || typeof body.requestId !== 'string' || !BILLING_REQUEST_ID.test(body.requestId)) throw new AuthError(400, '请选择有效套餐后重试。', 'INVALID_ORDER');
      const allowed = new Set(['planId', 'requestId']);
      if (Object.keys(body).some(key => !allowed.has(key))) throw new AuthError(400, '套餐价格和时长由服务器确定。', 'INVALID_ORDER');
      rate('billing-create-user', user.id, 30, 3600000, time());
      rate('billing-create-ip', clientIp, 120, 3600000, time());
      const row = saveBillingIntent(user.id, plan, body.requestId);
      const recovered = await orderLock(row.order_no, () => obtainPayment(row.order_no, { createIfMissing: true }));
      return billingResult(request, deviceId, allowMock, { order: orderView(recovered) });
    }
    findOrder(orderNo, user.id);
    rate('billing-action-user', user.id, 120, 60000, time());
    const row = await orderLock(orderNo, async () => {
      let order = findOrder(orderNo, user.id);
      assertOrderMode(order);
      if (action.startsWith('mock-') && paymentMode !== 'mock') throw new AuthError(403, '当前环境不支持模拟支付。', 'MOCK_PAYMENT_DISABLED');
      if (action === 'mock-complete') {
        await mockProvider.complete(orderNo);
        return obtainPayment(orderNo);
      }
      if (action === 'mock-notify-retry') {
        if (!order.payment_id) throw new AuthError(409, '支付请求尚未确认。', 'PAYMENT_RESULT_UNKNOWN');
        const result = await paymentClient.retryNotification(order.payment_id);
        acceptSnapshot(orderNo, currentAttempt(orderNo).id, result.payment);
        return findOrder(orderNo, user.id);
      }
      order = await obtainPayment(orderNo, { sync: action === 'sync' || action === 'close' });
      if (order.status === 'PAID') return order;
      let selected = currentAttempt(orderNo);
      if (action === 'close') {
        // Always reconcile payment before attempting closure. A payment that
        // wins this race is fulfilled; it is never relabelled as cancelled.
        if (order.payment_status === 'PAID') return order;
        if (!selected.provider_attempt_id) throw new AuthError(409, '付款请求结果尚未确认，请刷新原订单后再关闭。', 'PAYMENT_RESULT_UNKNOWN');
        try { return acceptSnapshot(orderNo, selected.id, (await paymentClient.closeAttempt(selected.provider_attempt_id)).payment); }
        catch (error) { uncertainAttempt(selected, error); return findOrder(orderNo, user.id); }
      }
      if (action === 'retry') {
        if (order.payment_status === 'PAID') return order;
        if (['CLOSED', 'REJECTED'].includes(selected.status)) {
          transaction(() => {
            order = findOrder(orderNo, user.id);
            selected = currentAttempt(orderNo);
            if (order.status === 'PAID' || !['CLOSED', 'REJECTED'].includes(selected.status)) return;
            const active = db.prepare('SELECT order_no FROM billing_orders WHERE user_id=? AND active=1 AND order_no<>?').get(user.id, orderNo);
            if (active) throw new AuthError(409, '请先完成或关闭当前订单。', 'ACTIVE_ORDER_EXISTS');
            db.prepare('UPDATE billing_orders SET active=1 WHERE order_no=?').run(orderNo);
            newAttempt(orderNo, time());
          });
          return obtainPayment(orderNo, { createIfMissing: true });
        }
        return obtainPayment(orderNo, { createIfMissing: true });
      }
      return order;
    });
    return billingResult(request, deviceId, allowMock, { order: orderView(row) });
  }

  async function handle({ request, response, pathname, body = {}, origin, clientIp = '', secure = false, allowMock = false }) {
    if (closed) throw new AuthError(503, '账号服务暂时不可用。', 'AUTH_UNAVAILABLE');
    const timestamp = time();
    if (timestamp >= lastCleanup + 3600000) {
      transaction(() => {
        db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(timestamp);
        db.prepare('DELETE FROM auth_tokens WHERE expires_at<=?').run(timestamp);
        db.prepare('DELETE FROM auth_sms_codes WHERE expires_at<=?').run(timestamp);
        db.prepare('DELETE FROM auth_rates WHERE window_start<=?').run(timestamp - DAY);
      });
      lastCleanup = timestamp;
    }
    let deviceId = deviceIdentity(request);
    if (pathname.startsWith('/api/billing/')) return handleBilling({ request, response, pathname, body, deviceId, secure, clientIp, allowMock });
    if (request.method === 'GET' && pathname === '/api/auth/session') {
      if (!deviceId) {
        deviceId = randomBytes(32).toString('base64url');
        setCookie(response, DEVICE_COOKIE, `${deviceId}.${mac(`device:${deviceId}`)}`, timestamp + SESSION_MS, secure, timestamp);
      }
      return state(request, deviceId, timestamp);
    }
    const known = new Set(['/api/auth/register', '/api/auth/login', '/api/auth/sms/send', '/api/auth/sms/login', '/api/auth/logout', '/api/auth/password/forgot', '/api/auth/password/reset', '/api/auth/password/change', '/api/auth/email/bind', '/api/auth/email/confirm', '/api/auth/phone/bind', '/api/guest/start', '/api/coupons/starter/draw', '/api/coupons/starter/claim', '/api/coupons/redeem', '/api/referrals/visit', '/api/referrals/prepare']);
    if (!known.has(pathname)) throw new AuthError(404, '接口不存在。', 'NOT_FOUND');
    if (request.method !== 'POST') throw new AuthError(405, '请求方法不受支持。', 'METHOD_NOT_ALLOWED');
    if (!deviceId || !equal(request.headers?.['x-csrf-token'], mac(`csrf:${deviceId}`))) throw new AuthError(403, '页面验证已失效，请刷新后重试。', 'CSRF_INVALID');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError(400, '请求内容无效。', 'INVALID_BODY');

    if (pathname === '/api/referrals/prepare') {
      const user = requireUser(request, timestamp), fingerprintHash = fingerprintOf(body, request, clientIp);
      transaction(() => {
        const guest = resolveGuest(deviceId, fingerprintHash);
        rememberAccountBrowser(user.id, deviceId, guest, timestamp);
      });
      return state(request, deviceId, time());
    }
    if (pathname === '/api/referrals/visit') {
      if (typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(body.code)) throw new AuthError(400, '邀请链接无效，请使用最新分享卡片。', 'INVALID_REFERRAL');
      const fingerprintHash = fingerprintOf(body, request, clientIp);
      rate('referral-visit-ip', clientIp, 120, 3600000, timestamp);
      const status = transaction(() => {
        const inviter = db.prepare('SELECT user_id FROM access_referral_codes WHERE code=?').get(body.code);
        if (!inviter) throw new AuthError(404, '邀请链接不存在，请直接开始练习。', 'REFERRAL_NOT_FOUND');
        const guest = resolveGuest(deviceId, fingerprintHash), user = sessionUser(request, timestamp);
        if (user) rememberAccountBrowser(user.id, deviceId, guest, timestamp);
        if (user || knownAccountBrowser(deviceId, guest)) return 'ignored';
        const previous = db.prepare('SELECT * FROM access_referral_attributions WHERE guest_id=?').get(guest.id);
        if (previous?.consumed_at !== null && previous?.consumed_at !== undefined) return 'ignored';
        if (previous && previous.expires_at > timestamp) return 'existing';
        db.prepare(`INSERT INTO access_referral_attributions (guest_id,inviter_id,visited_at,expires_at) VALUES (?,?,?,?)
          ON CONFLICT(guest_id) DO UPDATE SET inviter_id=excluded.inviter_id,visited_at=excluded.visited_at,expires_at=excluded.expires_at`).run(guest.id, inviter.user_id, timestamp, timestamp + REFERRAL_ATTRIBUTION_MS);
        return 'recorded';
      });
      return { ...state(request, deviceId, time()), referralVisit: { status } };
    }
    if (pathname === '/api/auth/register') {
      const email = emailValue(body.email), password = passwordValue(body.password);
      rate('register-ip', clientIp, 10, 3600000, timestamp);
      const encoded = await passwordHash(password);
      const userId = transaction(() => {
        if (db.prepare('SELECT id FROM auth_users WHERE email=?').get(email)) throw new AuthError(409, '该邮箱已注册，请直接登录或找回密码。', 'EMAIL_IN_USE');
        const guest = optionalRegistrationGuest(body, request, deviceId, clientIp);
        const priorAccount = sessionUser(request, timestamp);
        const id = randomUUID();
        db.prepare('INSERT INTO auth_users (id,email,password_hash,created_at) VALUES (?,?,?,?)').run(id, email, encoded, timestamp);
        consumeReferral(id, deviceId, guest, timestamp, true, priorAccount);
        rememberAccountBrowser(id, deviceId, guest, timestamp);
        return id;
      });
      const loggedRequest = authenticate(request, response, userId, secure, time());
      return state(loggedRequest, deviceId, time(), '注册成功，7 天内可领取一张 3–7 天新手时长券。');
    }
    if (pathname === '/api/auth/login') {
      const email = emailValue(body.email);
      if (typeof body.password !== 'string' || body.password.length > 128) throw new AuthError(400, '邮箱或密码错误。', 'INVALID_CREDENTIALS');
      rate('login-ip', clientIp, 30, 15 * 60000, timestamp);
      rate('login-email', email, 10, 15 * 60000, timestamp);
      const user = db.prepare('SELECT * FROM auth_users WHERE email=?').get(email);
      // A dummy KDF keeps unknown-account checks from becoming a cheap lookup oracle.
      const matches = user?.password_hash ? await passwordMatches(body.password, user.password_hash) : (await passwordHash(body.password), false);
      if (!matches) throw new AuthError(401, '邮箱或密码错误。', 'INVALID_CREDENTIALS');
      const current = db.prepare('SELECT password_hash FROM auth_users WHERE id=?').get(user.id);
      if (!current || current.password_hash !== user.password_hash) throw new AuthError(401, '邮箱或密码错误。', 'INVALID_CREDENTIALS');
      transaction(() => {
        const guest = optionalRegistrationGuest(body, request, deviceId, clientIp);
        consumeReferral(user.id, deviceId, guest, timestamp, false);
        rememberAccountBrowser(user.id, deviceId, guest, timestamp);
      });
      return state(authenticate(request, response, user.id, secure, time()), deviceId, time(), '登录成功。');
    }
    if (pathname === '/api/auth/sms/send') {
      const phone = phoneValue(body.phone), purpose = body.purpose || 'login';
      if (!['login', 'bind'].includes(purpose)) throw new AuthError(400, '验证码用途无效。', 'INVALID_PURPOSE');
      if (purpose === 'bind') {
        const user = requireUser(request, timestamp);
        if (user.email && !user.email_verified) throw new AuthError(403, '请先验证当前邮箱，再绑定手机号。', 'EMAIL_UNVERIFIED');
        if (user.phone && user.phone !== phone) throw new AuthError(409, '此账号已经绑定手机号，暂不支持更换。', 'PHONE_ALREADY_BOUND');
      }
      if (!providerStatus.sms) noProvider();
      rate('sms-ip', clientIp, 20, 3600000, timestamp);
      rate('sms-phone', phone, 5, 3600000, timestamp);
      const code = randomInt(0, 1000000).toString().padStart(6, '0');
      const codeHash = mac(`sms:${phone}:${purpose}:${code}`);
      transaction(() => {
        const previous = db.prepare('SELECT created_at FROM auth_sms_codes WHERE phone=? AND purpose=?').get(phone, purpose);
        if (previous && timestamp < previous.created_at + 60000) throw new AuthError(429, '请等待 60 秒后再获取验证码。', 'SMS_COOLDOWN', Math.ceil((previous.created_at + 60000 - timestamp) / 1000));
        db.prepare('INSERT INTO auth_sms_codes (phone,purpose,code_hash,created_at,expires_at,attempts) VALUES (?,?,?,?,?,0) ON CONFLICT(phone,purpose) DO UPDATE SET code_hash=excluded.code_hash,created_at=excluded.created_at,expires_at=excluded.expires_at,attempts=0').run(phone, purpose, codeHash, timestamp, timestamp + CODE_MS);
      });
      try { await send('sendSms', { phone, code }); }
      catch (error) {
        db.prepare('DELETE FROM auth_sms_codes WHERE phone=? AND purpose=? AND code_hash=?').run(phone, purpose, codeHash);
        throw error;
      }
      return { message: '验证码已发送，5 分钟内有效。', retryAfter: 60 };
    }
    if (pathname === '/api/auth/sms/login') {
      const phone = phoneValue(body.phone), code = validateCode(body);
      rate('sms-login-ip', clientIp, 30, 15 * 60000, timestamp);
      consumeCode(phone, 'login', code, timestamp);
      const userId = transaction(() => {
        const guest = optionalRegistrationGuest(body, request, deviceId, clientIp), priorAccount = sessionUser(request, timestamp);
        const previous = db.prepare('SELECT id FROM auth_users WHERE phone=?').get(phone);
        if (previous) {
          consumeReferral(previous.id, deviceId, guest, timestamp, false);
          rememberAccountBrowser(previous.id, deviceId, guest, timestamp);
          return previous.id;
        }
        const id = randomUUID();
        db.prepare('INSERT INTO auth_users (id,phone,created_at) VALUES (?,?,?)').run(id, phone, timestamp);
        consumeReferral(id, deviceId, guest, timestamp, true, priorAccount);
        rememberAccountBrowser(id, deviceId, guest, timestamp);
        return id;
      });
      return state(authenticate(request, response, userId, secure, time()), deviceId, time(), '登录成功。');
    }
    if (pathname === '/api/auth/logout') {
      const token = cookies(request)[SESSION_COOKIE];
      if (TOKEN_RE.test(token || '')) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash(token));
      clearSession(response, secure, timestamp);
      return state({ headers: {} }, deviceId, timestamp, '已退出登录。');
    }
    if (pathname === '/api/auth/password/forgot') {
      const email = emailValue(body.email);
      if (!providerStatus.email) noProvider();
      rate('forgot-ip', clientIp, 10, 3600000, timestamp);
      rate('forgot-email', email, 3, 3600000, timestamp);
      const message = '如果该邮箱已注册，我们会发送密码重置邮件，请检查收件箱和垃圾邮件。';
      const user = db.prepare('SELECT * FROM auth_users WHERE email=?').get(email);
      if (user) {
        const token = randomBytes(32).toString('base64url'), tokenHash = hash(token);
        db.prepare('INSERT INTO auth_tokens (token_hash,purpose,user_id,email,created_at,expires_at) VALUES (?,\'reset\',?,?,?,?)').run(tokenHash, user.id, email, timestamp, timestamp + TOKEN_MS);
        try { await send('sendResetEmail', { email, url: link(origin, 'reset', token) }); }
        catch { db.prepare('DELETE FROM auth_tokens WHERE token_hash=?').run(tokenHash); }
      }
      return { message };
    }
    if (pathname === '/api/auth/password/reset') {
      const tokenHash = tokenValue(body.token), password = passwordValue(body.password);
      rate('reset-ip', clientIp, 20, 3600000, timestamp);
      const token = db.prepare('SELECT * FROM auth_tokens WHERE token_hash=? AND purpose=\'reset\' AND expires_at>?').get(tokenHash, timestamp);
      if (!token) throw new AuthError(400, '链接无效或已过期，请重新申请。', 'INVALID_TOKEN');
      const encoded = await passwordHash(password);
      transaction(() => {
        const current = db.prepare('SELECT * FROM auth_tokens WHERE token_hash=? AND purpose=\'reset\' AND expires_at>?').get(tokenHash, time());
        const user = current && db.prepare('SELECT * FROM auth_users WHERE id=?').get(current.user_id);
        if (!current || !user || user.email !== current.email) throw new AuthError(400, '链接无效或已过期，请重新申请。', 'INVALID_TOKEN');
        db.prepare('UPDATE auth_users SET password_hash=?,email_verified=1 WHERE id=?').run(encoded, current.user_id);
        db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(current.user_id);
        revokeUser(current.user_id);
      });
      clearSession(response, secure, time());
      return state({ headers: {} }, deviceId, time(), '密码已重置，请使用新密码重新登录。');
    }
    if (pathname === '/api/auth/password/change') {
      const user = requireUser(request, timestamp), password = passwordValue(body.password);
      rate('change-user', user.id, 10, 3600000, timestamp);
      if (!user.password_hash || !await passwordMatches(body.currentPassword, user.password_hash)) throw new AuthError(401, '当前密码错误。', 'INVALID_CREDENTIALS');
      const encoded = await passwordHash(password);
      transaction(() => {
        requireUser(request, time());
        const current = db.prepare('SELECT password_hash FROM auth_users WHERE id=?').get(user.id);
        if (!current || current.password_hash !== user.password_hash) throw new AuthError(401, '密码已变更，请重新登录。', 'LOGIN_REQUIRED');
        db.prepare('UPDATE auth_users SET password_hash=? WHERE id=?').run(encoded, user.id);
        db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(user.id);
        revokeUser(user.id);
      });
      clearSession(response, secure, time());
      return state({ headers: {} }, deviceId, time(), '密码已修改，请重新登录。');
    }
    if (pathname === '/api/auth/email/bind') {
      const user = requireUser(request, timestamp), email = emailValue(body.email), password = passwordValue(body.password);
      if (user.email && user.email !== email) throw new AuthError(409, '此账号已经绑定邮箱，暂不支持更换。', 'EMAIL_ALREADY_BOUND');
      if (user.email_verified) return state(request, deviceId, timestamp, '此邮箱已验证。');
      if (!providerStatus.email) noProvider();
      rate('bind-email-user', user.id, 3, 3600000, timestamp);
      const occupied = db.prepare('SELECT id FROM auth_users WHERE email=?').get(email);
      if (occupied && occupied.id !== user.id) throw new AuthError(409, '该邮箱已属于其他账号，请使用原账号登录。', 'EMAIL_IN_USE');
      const encoded = await passwordHash(password), token = randomBytes(32).toString('base64url'), tokenHash = hash(token);
      transaction(() => {
        const current = requireUser(request, time());
        if (current.id !== user.id || current.password_hash !== user.password_hash || current.email !== user.email || current.email_verified !== user.email_verified) {
          throw new AuthError(401, '账号状态已变更，请重新登录后重试。', 'LOGIN_REQUIRED');
        }
        db.prepare('INSERT INTO auth_tokens (token_hash,purpose,user_id,email,password_hash,created_at,expires_at) VALUES (?,\'bind\',?,?,?,?,?)').run(tokenHash, user.id, email, encoded, time(), time() + TOKEN_MS);
      });
      try { await send('sendBindEmail', { email, url: link(origin, 'bind', token) }); }
      catch (error) { db.prepare('DELETE FROM auth_tokens WHERE token_hash=?').run(tokenHash); throw error; }
      return state(request, deviceId, time(), '验证邮件已发送，请在 30 分钟内打开邮件链接确认绑定。');
    }
    if (pathname === '/api/auth/email/confirm') {
      const tokenHash = tokenValue(body.token);
      const currentUser = requireUser(request, timestamp);
      rate('bind-confirm-ip', clientIp, 20, 3600000, timestamp);
      transaction(() => {
        const liveUser = requireUser(request, time());
        if (liveUser.id !== currentUser.id) throw new AuthError(401, '账号状态已变更，请重新登录后重试。', 'LOGIN_REQUIRED');
        const token = db.prepare('SELECT * FROM auth_tokens WHERE token_hash=? AND purpose=\'bind\' AND expires_at>?').get(tokenHash, timestamp);
        if (!token) throw new AuthError(400, '链接无效或已过期，请重新申请。', 'INVALID_TOKEN');
        if (token.user_id !== currentUser.id) throw new AuthError(403, '请先登录申请绑定邮箱的原账号，再打开此链接。', 'BIND_ACCOUNT_MISMATCH');
        const user = db.prepare('SELECT * FROM auth_users WHERE id=?').get(token.user_id);
        if (!user || (user.email && user.email !== token.email)) throw new AuthError(400, '链接无效或已过期，请重新申请。', 'INVALID_TOKEN');
        const occupied = db.prepare('SELECT id FROM auth_users WHERE email=?').get(token.email);
        if (occupied && occupied.id !== user.id) throw new AuthError(409, '该邮箱已属于其他账号，请使用原账号登录。', 'EMAIL_IN_USE');
        db.prepare('UPDATE auth_users SET email=?,password_hash=?,email_verified=1 WHERE id=?').run(token.email, token.password_hash, user.id);
        db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(user.id);
        const currentTokenHash = hash(cookies(request)[SESSION_COOKIE]);
        db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?').run(user.id, currentTokenHash);
      });
      return state(request, deviceId, time(), '邮箱已验证，可以使用邮箱和密码登录。');
    }
    if (pathname === '/api/auth/phone/bind') {
      const user = requireUser(request, timestamp), phone = phoneValue(body.phone), code = validateCode(body);
      if (user.email && !user.email_verified) throw new AuthError(403, '请先验证当前邮箱，再绑定手机号。', 'EMAIL_UNVERIFIED');
      if (user.phone && user.phone !== phone) throw new AuthError(409, '此账号已经绑定手机号，暂不支持更换。', 'PHONE_ALREADY_BOUND');
      const occupied = db.prepare('SELECT id FROM auth_users WHERE phone=?').get(phone);
      if (occupied && occupied.id !== user.id) throw new AuthError(409, '该手机号已属于其他账号，请使用原账号登录。', 'PHONE_IN_USE');
      consumeCode(phone, 'bind', code, timestamp);
      transaction(() => {
        const liveUser = requireUser(request, time());
        if (liveUser.id !== user.id || (liveUser.email && !liveUser.email_verified)) throw new AuthError(401, '账号状态已变更，请重新登录后重试。', 'LOGIN_REQUIRED');
        const current = db.prepare('SELECT * FROM auth_users WHERE id=?').get(user.id);
        const owner = db.prepare('SELECT id FROM auth_users WHERE phone=?').get(phone);
        if (!current || (current.phone && current.phone !== phone) || (owner && owner.id !== user.id)) throw new AuthError(409, '该手机号无法绑定，请重新登录后重试。', 'PHONE_IN_USE');
        db.prepare('UPDATE auth_users SET phone=? WHERE id=?').run(phone, user.id);
      });
      return state(request, deviceId, time(), '手机号绑定成功。');
    }
    if (pathname === '/api/guest/start') {
      const fingerprintHash = fingerprintOf(body, request, clientIp);
      rate('guest-ip', clientIp, 60, 3600000, timestamp);
      transaction(() => {
        const guest = resolveGuest(deviceId, fingerprintHash);
        if (guest.transferred_to || guest.started_at !== null) return;
        db.prepare('UPDATE access_guests SET started_at=?,ends_at=? WHERE id=?').run(timestamp, timestamp + GUEST_MS, guest.id);
      });
      return state(request, deviceId, time(), '游客体验按首次练习时间连续计算 24 小时。');
    }
    if (pathname === '/api/coupons/starter/draw') {
      const fingerprintHash = fingerprintOf(body, request, clientIp);
      rate('starter-draw-ip', clientIp, 60, 3600000, timestamp);
      const denied = transaction(() => {
        const user = sessionUser(request, timestamp);
        if (user && db.prepare('SELECT user_id FROM access_starters WHERE user_id=?').get(user.id)) throw new AuthError(403, '此账号已领取过新手奖励。', 'STARTER_ALREADY_CLAIMED');
        if (user && timestamp >= user.created_at + STARTER_CLAIM_MS) throw new AuthError(403, '新手时长券领取期限已过，注册后 7 天内可领取。', 'STARTER_CLAIM_EXPIRED');
        const guest = resolveGuest(deviceId, fingerprintHash);
        const previous = db.prepare('SELECT user_id FROM auth_trial_claims WHERE device_hash=? OR fingerprint_hash=? OR fingerprint_hash=?').get(deviceHashOf(deviceId), fingerprintHash, guest.fingerprint_hash);
        // Retain a recovered cookie-to-browser association even when its reward
        // was consumed. The next session read can then hide the draw entry.
        if (previous || guest.transferred_to) return new AuthError(403, '此浏览器已领取过新手奖励，请使用原账号继续使用。', 'STARTER_BROWSER_USED');
        resolveStarterDraw(guest, timestamp);
      });
      if (denied) throw denied;
      return state(request, deviceId, time(), '抽奖结果已保存，登录或注册后即可领取。');
    }
    if (pathname === '/api/coupons/starter/claim') {
      const user = requireUser(request, timestamp);
      const fingerprintHash = fingerprintOf(body, request, clientIp);
      rate('starter-ip', clientIp, 30, 3600000, timestamp);
      const grant = transaction(() => {
        const current = requireUser(request, timestamp);
        if (current.id !== user.id) throw new AuthError(401, '账号状态已变更，请重新登录。', 'LOGIN_REQUIRED');
        if (db.prepare('SELECT user_id FROM access_starters WHERE user_id=?').get(user.id)) return null;
        if (timestamp >= current.created_at + STARTER_CLAIM_MS) throw new AuthError(403, '新手时长券领取期限已过，注册后 7 天内可领取。', 'STARTER_CLAIM_EXPIRED');
        const guest = resolveGuest(deviceId, fingerprintHash);
        const previous = db.prepare('SELECT user_id FROM auth_trial_claims WHERE device_hash=? OR fingerprint_hash=? OR fingerprint_hash=?').all(deviceHashOf(deviceId), fingerprintHash, guest.fingerprint_hash);
        if (previous.some(claim => claim.user_id !== user.id) || (guest.transferred_to && guest.transferred_to !== user.id)) throw new AuthError(403, '此浏览器已领取过新手奖励，请使用原账号继续使用。', 'STARTER_BROWSER_USED');
        const draw = resolveStarterDraw(guest, timestamp), days = draw.days;
        if (draw.claimed_by && draw.claimed_by !== user.id) throw new AuthError(403, '此浏览器已领取过新手奖励，请使用原账号继续使用。', 'STARTER_BROWSER_USED');
        const alreadyTransferred = db.prepare('SELECT user_id FROM access_guest_transfers WHERE user_id=? OR guest_id=?').get(user.id, guest.id);
        const inherited = alreadyTransferred || guest.transferred_to ? 0 : guest.started_at === null ? GUEST_MS : Math.max(0, guest.ends_at - timestamp);
        const expiresAt = grantDuration(user.id, days * DAY + inherited, timestamp);
        db.prepare('INSERT INTO access_starters (user_id,days,claimed_at) VALUES (?,?,?)').run(user.id, days, timestamp);
        db.prepare('UPDATE access_starter_draws SET claimed_by=?,claimed_at=? WHERE guest_id=?').run(user.id, timestamp, guest.id);
        db.prepare('INSERT INTO auth_trial_claims (device_hash,fingerprint_hash,user_id,claimed_at) VALUES (?,?,?,?)').run(deviceHashOf(deviceId), guest.fingerprint_hash || fingerprintHash, user.id, timestamp);
        if (!alreadyTransferred && !guest.transferred_to) {
          db.prepare('INSERT INTO access_guest_transfers (user_id,guest_id,duration_ms,transferred_at) VALUES (?,?,?,?)').run(user.id, guest.id, inherited, timestamp);
          db.prepare('UPDATE access_guests SET transferred_to=?,transferred_at=? WHERE id=?').run(user.id, timestamp, guest.id);
        }
        return { kind: 'starter', days, inheritedMs: inherited, expiresAt };
      });
      return { ...state(request, deviceId, time(), grant ? `已领取 ${grant.days} 天新手时长券，游客剩余时间已一并保留。` : '此账号已领取过新手奖励，领取结果和到期时间不会改变。'), ...(grant ? { lastGrant: grant } : {}) };
    }
    if (pathname === '/api/coupons/redeem') {
      const user = requireUser(request, timestamp), code = couponCode(body.code);
      rate('redeem-ip', clientIp, 60, 3600000, timestamp);
      rate('redeem-user', user.id, 20, 3600000, timestamp);
      const grant = transaction(() => {
        requireUser(request, timestamp);
        const coupon = db.prepare('SELECT c.*,p.title,p.days,p.starts_at,p.ends_at,p.max_redemptions,p.enabled FROM access_coupon_codes c JOIN access_campaigns p ON p.id=c.campaign_id WHERE c.code=?').get(code);
        if (!coupon) throw new AuthError(400, '兑换码不存在，请检查后重试。', 'COUPON_NOT_FOUND');
        if (db.prepare('SELECT user_id FROM access_redemptions WHERE user_id=? AND campaign_id=?').get(user.id, coupon.campaign_id)) throw new AuthError(409, '此账号已经兑换过本次活动的时长券。', 'COUPON_ALREADY_REDEEMED');
        if (!coupon.enabled) throw new AuthError(403, '此活动已暂停兑换。', 'COUPON_DISABLED');
        if (timestamp < coupon.starts_at) throw new AuthError(403, '此活动尚未开始。', 'COUPON_NOT_STARTED');
        if (timestamp >= coupon.ends_at) throw new AuthError(403, '此时长券已超过兑换截止时间。', 'COUPON_EXPIRED');
        const count = db.prepare('SELECT count(*) AS count FROM access_redemptions WHERE campaign_id=?').get(coupon.campaign_id).count;
        if (count >= coupon.max_redemptions) throw new AuthError(409, '此活动的时长券已领完。', 'COUPON_EXHAUSTED');
        const expiresAt = grantDuration(user.id, coupon.days * DAY, timestamp);
        db.prepare('INSERT INTO access_redemptions (user_id,campaign_id,code,channel,redeemed_at,days) VALUES (?,?,?,?,?,?)').run(user.id, coupon.campaign_id, code, coupon.channel, timestamp, coupon.days);
        return { kind: 'campaign', days: coupon.days, title: coupon.title, expiresAt };
      });
      return { ...state(request, deviceId, time(), `兑换成功，${grant.days} 天已追加到账号有效期。`), lastGrant: grant };
    }
    throw new AuthError(404, '接口不存在。', 'NOT_FOUND');
  }

  async function requireAccess(request) {
    if (closed) throw new AuthError(503, '账号服务暂时不可用。', 'AUTH_UNAVAILABLE');
    const timestamp = time(), user = sessionUser(request, timestamp);
    const access = entitlement(user, deviceIdentity(request), timestamp);
    if (!access.hasAccess) {
      if (access.status === 'guest_available') throw new AuthError(403, '首次开始练习即可免费体验 24 小时。', 'GUEST_REQUIRED');
      throw new AuthError(403, user ? '当前使用时长已结束，可领取或兑换时长券后继续使用。' : '游客体验已结束，登录后可领取或兑换时长券。', 'ACCESS_EXPIRED');
    }
    return { user: user ? { id: user.id, email: user.email, phone: user.phone } : null, entitlement: access };
  }

  return { handle, receivePaymentNotification, createPaymentAcceptanceOrder, getBillingOrder, retryBillingNotification, requireAccess, createCampaign, getCampaigns, setCampaignEnabled, close() { if (!closed) { closed = true; db.close(); } } };
}
