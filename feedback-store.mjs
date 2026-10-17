import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, open, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 86400000;
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;
const PAGE_SIZE = 20;
const queues = new Map();
const queuedCounts = new Map();
const snapshots = new Map();
let queuedTotal = 0;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MESSAGE_FIELDS = ['id', 'nickname', 'message', 'createdAt'];

export class FeedbackError extends Error {
  constructor(status, message, { retryAfter } = {}) {
    super(message);
    this.name = 'FeedbackError';
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

function unavailable() {
  return new FeedbackError(503, '留言板暂时不可用，请稍后重试。');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}

function calendar(timestamp) {
  if (!Number.isFinite(timestamp)) throw unavailable();
  const day = new Date(timestamp + SHANGHAI_OFFSET).toISOString().slice(0, 10);
  const previousDay = new Date(timestamp + SHANGHAI_OFFSET - DAY_MS).toISOString().slice(0, 10);
  const resetAt = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS - SHANGHAI_OFFSET).toISOString();
  return { day, previousDay, resetAt };
}

function fingerprintValue(value, required = false) {
  if (typeof value !== 'string') throw new FeedbackError(400, '浏览器标识无效，请刷新页面后重试。');
  if (!value && !required) return '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new FeedbackError(400, '浏览器标识无效，请刷新页面后重试。');
  return value.toLowerCase();
}

function content({ nickname, message, website }) {
  if (typeof website !== 'string' || website !== '') throw new FeedbackError(400, '反馈未被接受，请检查内容后重试。');
  if (typeof nickname !== 'string' || typeof message !== 'string') throw new FeedbackError(400, '请填写有效的昵称和留言。');
  // Paragraph breaks are useful in bug reports; other control characters are not.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(nickname) ||
      /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message.replace(/\r\n?/g, '\n'))) {
    throw new FeedbackError(400, '留言不能包含控制字符。');
  }
  nickname = nickname.trim() || '匿名同学';
  message = message.replace(/\r\n?/g, '\n').trim();
  if ([...nickname].length > 20) throw new FeedbackError(400, '昵称最多 20 个字。');
  const length = [...message].length;
  if (length < 5 || length > 1000) throw new FeedbackError(400, '留言请填写 5 至 1000 个字。');
  if (!/[\p{L}\p{N}]/u.test(message)) throw new FeedbackError(400, '请填写具体的反馈内容。');
  if (/([\s\S])\1{19,}/u.test(message) || /^([\s\S])\1{19,}$/u.test(message.replace(/\s/gu, ''))) {
    throw new FeedbackError(400, '请减少重复字符，描述具体的问题或建议。');
  }
  if ((message.match(/\b(?:https?:\/\/|www\.)[^\s]+/gi) || []).length > 2) {
    throw new FeedbackError(400, '一条留言最多包含 2 个链接。');
  }
  return { nickname, message };
}

function digest(secret, value) {
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(value).digest('hex');
}

function sameHash(actual, expected) {
  return typeof actual === 'string' && HASH_PATTERN.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function cookieIdentity(cookie, secret) {
  if (typeof cookie !== 'string' || !/^[a-f0-9]{48}\.[a-f0-9]{64}$/.test(cookie)) return null;
  const [id, signature] = cookie.split('.');
  return sameHash(signature, digest(secret, `cookie:${id}`)) ? id : null;
}

function signedCookie(id, secret) {
  return `${id}.${digest(secret, `cookie:${id}`)}`;
}

function validateState(value) {
  if (!fields(value, ['version', 'secret', 'messages', 'quotas']) || value.version !== 1 ||
      typeof value.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.secret) ||
      Buffer.from(value.secret, 'base64url').length !== 32 || !Array.isArray(value.messages) ||
      !plainObject(value.quotas)) throw unavailable();
  const ids = new Set();
  for (const item of value.messages) {
    if (!fields(item, MESSAGE_FIELDS) || typeof item.id !== 'string' || !ID_PATTERN.test(item.id) || ids.has(item.id) ||
        typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) ||
        new Date(item.createdAt).toISOString() !== item.createdAt) throw unavailable();
    try {
      const normalized = content({ nickname: item.nickname, message: item.message, website: '' });
      if (normalized.nickname !== item.nickname || normalized.message !== item.message) throw unavailable();
    } catch { throw unavailable(); }
    ids.add(item.id);
  }
  for (const [day, quota] of Object.entries(value.quotas)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00.000Z`)) ||
        new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day ||
        !fields(quota, ['cookies', 'fingerprints']) ||
        !['cookies', 'fingerprints'].every(key => Array.isArray(quota[key]) && quota[key].every(hash => typeof hash === 'string' && HASH_PATTERN.test(hash)))) {
      throw unavailable();
    }
  }
  return value;
}

function publicMessage(item) {
  return Object.fromEntries(MESSAGE_FIELDS.map(key => [key, item[key]]));
}

export function createFeedbackStore({ filePath, now = Date.now, maxMessages = 2000 } = {}) {
  if (typeof filePath !== 'string' || !filePath || typeof now !== 'function' ||
      !Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 20000) {
    throw new TypeError('Feedback storage requires a file path, a clock and a valid retention limit.');
  }
  filePath = path.resolve(filePath);
  let initialized = false;

  async function persist(state) {
    const tempPath = `${filePath}.${randomBytes(12).toString('hex')}.tmp`;
    let handle;
    try {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, filePath);
      snapshots.delete(filePath);
    } catch {
      throw unavailable();
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
    }
  }

  async function load(writable = false) {
    let raw;
    let signature;
    try {
      const info = await stat(filePath, { bigint: true });
      signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      const cached = snapshots.get(filePath);
      if (cached?.signature === signature) {
        initialized = true;
        return writable ? structuredClone(cached.state) : cached.state;
      }
      raw = await readFile(filePath, 'utf8');
    }
    catch (error) {
      if (error.code !== 'ENOENT' || initialized) throw unavailable();
      const state = { version: 1, secret: randomBytes(32).toString('base64url'), messages: [], quotas: {} };
      await persist(state);
      initialized = true;
      return state;
    }
    let state;
    try { state = validateState(JSON.parse(raw)); }
    catch { throw unavailable(); }
    initialized = true;
    if (snapshots.size >= 100) snapshots.delete(snapshots.keys().next().value);
    snapshots.set(filePath, { signature, state });
    return writable ? structuredClone(state) : state;
  }

  function serialized(operation) {
    if (queuedTotal >= 512 || (queuedCounts.get(filePath) || 0) >= 64) return Promise.reject(new FeedbackError(429, '留言请求较多，请稍后重试。', { retryAfter: 1 }));
    queuedTotal++;
    queuedCounts.set(filePath, (queuedCounts.get(filePath) || 0) + 1);
    const previous = queues.get(filePath) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.then(() => {}, () => {});
    queues.set(filePath, tail);
    tail.then(() => {
      queuedTotal--;
      const count = queuedCounts.get(filePath) - 1;
      if (count) queuedCounts.set(filePath, count); else queuedCounts.delete(filePath);
      if (queues.get(filePath) === tail) queues.delete(filePath);
    });
    return current.catch(error => { throw error instanceof FeedbackError ? error : unavailable(); });
  }

  function prune(state, { day, previousDay }) {
    const keep = [day, previousDay];
    const removed = Object.keys(state.quotas).some(key => !keep.includes(key));
    if (removed) state.quotas = Object.fromEntries(Object.entries(state.quotas).filter(([key]) => keep.includes(key)));
    return removed;
  }

  function quotaKeys(secret, day, id, fingerprint) {
    return {
      cookie: digest(secret, `quota:cookie:${day}:${id}`),
      fingerprint: digest(secret, `quota:fingerprint:${day}:${fingerprint}`),
    };
  }

  function blocked(state, day, keys) {
    return Boolean(state.quotas[day]?.cookies.includes(keys.cookie) || state.quotas[day]?.fingerprints.includes(keys.fingerprint));
  }

  return {
    read({ cookie = '', fingerprint = '', cursor = '' } = {}) {
      return serialized(async () => {
        fingerprint = fingerprintValue(fingerprint);
        if (typeof cursor !== 'string' || (cursor && !ID_PATTERN.test(cursor))) throw new FeedbackError(400, '留言分页位置无效，请刷新后重试。');
        const state = await load();
        const timing = calendar(Number(now()));
        if (Object.keys(state.quotas).some(day => day !== timing.day && day !== timing.previousDay)) {
          const pruned = structuredClone(state);
          prune(pruned, timing);
          await persist(pruned);
        }
        const id = cookieIdentity(cookie, state.secret) || randomBytes(24).toString('hex');
        const messages = state.messages.slice(-maxMessages).reverse();
        const offset = cursor ? messages.findIndex(item => item.id === cursor) + 1 : 0;
        if (cursor && offset === 0) throw new FeedbackError(400, '留言列表已更新，请刷新后重试。');
        const page = messages.slice(offset, offset + PAGE_SIZE).map(publicMessage);
        return {
          cookie: signedCookie(id, state.secret),
          csrfToken: digest(state.secret, `csrf:${timing.day}:${id}`),
          canSubmit: fingerprint ? !blocked(state, timing.day, quotaKeys(state.secret, timing.day, id, fingerprint)) : null,
          day: timing.day,
          resetAt: timing.resetAt,
          messages: page,
          nextCursor: offset + page.length < messages.length ? page.at(-1).id : null,
        };
      });
    },

    submit({ cookie = '', csrfToken = '', fingerprint = '', nickname = '', message = '', website = '' } = {}) {
      return serialized(async () => {
        fingerprint = fingerprintValue(fingerprint, true);
        const normalized = content({ nickname, message, website });
        const state = await load(true);
        const timestamp = Number(now());
        const timing = calendar(timestamp);
        const id = cookieIdentity(cookie, state.secret);
        if (!id || !sameHash(csrfToken, digest(state.secret, `csrf:${timing.day}:${id}`))) {
          throw new FeedbackError(403, '提交凭据已失效，请刷新留言板后重试。');
        }
        prune(state, timing);
        const keys = quotaKeys(state.secret, timing.day, id, fingerprint);
        if (blocked(state, timing.day, keys)) {
          throw new FeedbackError(429, '你今天已经反馈过了，明天再来吧。', {
            retryAfter: Math.max(1, Math.ceil((Date.parse(timing.resetAt) - timestamp) / 1000)),
          });
        }
        const item = { id: randomUUID(), ...normalized, createdAt: new Date(timestamp).toISOString() };
        const quota = state.quotas[timing.day] ||= { cookies: [], fingerprints: [] };
        quota.cookies.push(keys.cookie);
        quota.fingerprints.push(keys.fingerprint);
        state.messages.push(item);
        state.messages = state.messages.slice(-maxMessages);
        await persist(state);
        return { message: publicMessage(item), day: timing.day, resetAt: timing.resetAt };
      });
    },
  };
}
