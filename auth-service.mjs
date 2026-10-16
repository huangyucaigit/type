import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, randomUUID, createHash, createHmac, timingSafeEqual, scrypt as nodeScrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthProviderError } from './auth-providers.mjs';

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
export function createAuthService({ filename = path.join(process.env.ZIJIAN_AUTH_DATA_DIR || path.join(ROOT, '.data'), 'auth.sqlite'), now = Date.now, providers = {}, drawStarterDays = () => randomInt(3, 8), drawReferralDays = () => randomInt(3, 8) } = {}) {
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

  async function handle({ request, response, pathname, body = {}, origin, clientIp = '', secure = false }) {
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

  return { handle, requireAccess, createCampaign, getCampaigns, setCampaignEnabled, close() { if (!closed) { closed = true; db.close(); } } };
}
