'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const modulePromise = import('../feedback-store.mjs');
const fingerprint = 'a'.repeat(64);
const otherFingerprint = 'b'.repeat(64);
const validMessage = '希望增加更多雅思练习范文。';

async function fixture(t, options = {}) {
  const { createFeedbackStore } = await modulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ielts-feedback-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^ielts-feedback-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const filePath = path.join(root, 'data', 'feedback.json');
  let timestamp = Date.parse('2026-10-11T10:00:00.000Z');
  const now = () => timestamp;
  const store = createFeedbackStore({ filePath, now, ...options });
  return { store, root, filePath, now, advance: value => { timestamp = Date.parse(value); } };
}

async function rejectsWith(promise, status, pattern) {
  const { FeedbackError } = await modulePromise;
  await assert.rejects(promise, error => {
    assert.ok(error instanceof FeedbackError);
    assert.equal(error.status, status);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

function submission(session, overrides = {}) {
  return { cookie: session.cookie, csrfToken: session.csrfToken, fingerprint, message: validMessage, ...overrides };
}

test('read bursts are bounded and cached snapshots stay fresh across writers and external changes', async t => {
  const { store, filePath, now } = await fixture(t);
  const session = await store.read({ fingerprint });
  const results = await Promise.allSettled(Array.from({ length: 200 }, () => store.read()));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 64);
  assert.ok(results.filter(item => item.status === 'rejected').every(item => item.reason.status === 429));
  const { createFeedbackStore } = await modulePromise;
  const other = createFeedbackStore({ filePath, now });
  const posted = await other.submit(submission(session));
  assert.equal((await store.read({ cookie: session.cookie, fingerprint })).messages[0].id, posted.message.id);
  assert.equal((await store.read({ cookie: session.cookie, fingerprint })).canSubmit, false);
  await fs.writeFile(filePath, '{corrupted externally');
  await rejectsWith(store.read(), 503);
});

test('a store that reused a cached snapshot fails closed if its backing file disappears', async t => {
  const { store, filePath, now } = await fixture(t);
  await store.read();
  await store.read();
  const { createFeedbackStore } = await modulePromise;
  const reopened = createFeedbackStore({ filePath, now });
  await reopened.read();
  await fs.unlink(filePath);
  await rejectsWith(reopened.read(), 503);
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
});

test('read provisions an anonymous signed identity and exposes only public message fields', async t => {
  const { store, filePath } = await fixture(t);
  const initial = await store.read();
  assert.match(initial.cookie, /^[a-f0-9]{48}\.[a-f0-9]{64}$/);
  assert.match(initial.csrfToken, /^[a-f0-9]{64}$/);
  assert.equal(initial.canSubmit, null);
  assert.equal(initial.day, '2026-10-11');
  assert.equal(initial.resetAt, '2026-10-11T16:00:00.000Z');
  assert.deepEqual(initial.messages, []);
  assert.equal(initial.nextCursor, null);
  const ready = await store.read({ cookie: initial.cookie, fingerprint });
  assert.equal(ready.cookie, initial.cookie);
  assert.equal(ready.canSubmit, true);
  const result = await store.submit(submission(ready));
  assert.deepEqual(Object.keys(result.message).sort(), ['createdAt', 'id', 'message', 'nickname']);
  assert.equal(result.message.nickname, '匿名同学');
  assert.equal(result.message.message, validMessage);
  const visible = await store.read({ cookie: initial.cookie, fingerprint });
  assert.equal(visible.canSubmit, false);
  assert.deepEqual(visible.messages, [result.message]);
  assert.ok(!JSON.stringify(visible.messages).includes(fingerprint));
  const privateData = await fs.readFile(filePath, 'utf8');
  assert.ok(!privateData.includes(fingerprint));
  assert.ok(!privateData.includes(initial.cookie.split('.')[0]));
});

test('concurrent duplicate submits accept exactly one and include a daily retry interval', async t => {
  const { store } = await fixture(t);
  const session = await store.read({ fingerprint });
  const results = await Promise.allSettled([store.submit(submission(session)), store.submit(submission(session))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected').reason;
  assert.equal(rejected.status, 429);
  assert.equal(rejected.retryAfter, 21600);
  assert.equal((await store.read()).messages.length, 1);
});

test('distinct concurrent visitors retain both writes without losing data', async t => {
  const { store } = await fixture(t);
  const first = await store.read({ fingerprint });
  const second = await store.read({ fingerprint: otherFingerprint });
  const results = await Promise.all([
    store.submit(submission(first, { message: '第一位同学的有效建议。' })),
    store.submit(submission(second, { fingerprint: otherFingerprint, message: '第二位同学的有效建议。' })),
  ]);
  assert.deepEqual((await store.read()).messages.map(item => item.id), results.map(item => item.message.id).reverse());
});

test('either the signed browser identity or fingerprint enforces the same-day quota', async t => {
  const { store } = await fixture(t);
  const first = await store.read({ fingerprint });
  await store.submit(submission(first));
  const changedFingerprint = await store.read({ cookie: first.cookie, fingerprint: otherFingerprint });
  assert.equal(changedFingerprint.canSubmit, false);
  await rejectsWith(store.submit(submission(changedFingerprint, { fingerprint: otherFingerprint })), 429);
  const changedCookie = await store.read({ fingerprint });
  assert.notEqual(changedCookie.cookie, first.cookie);
  assert.equal(changedCookie.canSubmit, false);
  await rejectsWith(store.submit(submission(changedCookie)), 429);
  const unrelated = await store.read({ fingerprint: otherFingerprint });
  assert.equal(unrelated.canSubmit, true);
});

test('restart preserves the signing secret, messages and the same-day limit', async t => {
  const { createFeedbackStore } = await modulePromise;
  const { store, filePath, now } = await fixture(t);
  const before = await store.read({ fingerprint });
  const posted = await store.submit(submission(before));
  const restarted = createFeedbackStore({ filePath, now });
  const after = await restarted.read({ cookie: before.cookie, fingerprint });
  assert.equal(after.cookie, before.cookie);
  assert.equal(after.csrfToken, before.csrfToken);
  assert.equal(after.canSubmit, false);
  assert.deepEqual(after.messages, [posted.message]);
  await rejectsWith(restarted.submit(submission(before)), 429);
});

test('Shanghai midnight resets the quota and CSRF token while pruning old daily hashes', async t => {
  const { store, filePath, advance } = await fixture(t);
  advance('2026-10-11T15:59:59.999Z');
  const old = await store.read({ fingerprint });
  await store.submit(submission(old));
  advance('2026-10-11T16:00:00.000Z');
  await rejectsWith(store.submit(submission(old)), 403);
  const current = await store.read({ cookie: old.cookie, fingerprint });
  assert.equal(current.day, '2026-10-12');
  assert.equal(current.resetAt, '2026-10-12T16:00:00.000Z');
  assert.notEqual(current.csrfToken, old.csrfToken);
  assert.equal(current.canSubmit, true);
  await store.submit(submission(current));
  advance('2026-10-12T16:00:00.000Z');
  await store.read({ cookie: old.cookie, fingerprint });
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(filePath, 'utf8')).quotas), ['2026-10-12']);
});

test('invalid signatures and CSRF tokens cannot submit or consume a quota', async t => {
  const { store } = await fixture(t);
  const session = await store.read({ fingerprint });
  const other = await store.read({ fingerprint: otherFingerprint });
  for (const override of [
    { cookie: '' }, { cookie: 'not-a-cookie' },
    { cookie: `${session.cookie.slice(0, -1)}${session.cookie.at(-1) === '0' ? '1' : '0'}` },
    { csrfToken: '' }, { csrfToken: '0'.repeat(64) }, { csrfToken: other.csrfToken },
  ]) await rejectsWith(store.submit(submission(session, override)), 403);
  const replaced = await store.read({ cookie: 'invalid', fingerprint });
  assert.match(replaced.cookie, /^[a-f0-9]{48}\.[a-f0-9]{64}$/);
  assert.equal((await store.read({ cookie: session.cookie, fingerprint })).canSubmit, true);
  await store.submit(submission(session));
});

test('fingerprints accept only SHA-256 hexadecimal digests and are case-normalized', async t => {
  const { store } = await fixture(t);
  for (const value of [null, 9, {}, [], 'short', 'g'.repeat(64), `${fingerprint}extra`]) {
    await rejectsWith(store.read({ fingerprint: value }), 400);
  }
  const session = await store.read({ fingerprint: fingerprint.toUpperCase() });
  await rejectsWith(store.submit(submission(session, { fingerprint: '' })), 400);
  await store.submit(submission(session, { fingerprint: fingerprint.toUpperCase() }));
  assert.equal((await store.read({ fingerprint })).canSubmit, false);
});

test('invalid feedback, spam and honeypot values do not consume the daily quota', async t => {
  const { store } = await fixture(t);
  const session = await store.read({ fingerprint });
  for (const override of [
    { message: '太短' }, { message: 'a'.repeat(1001) }, { message: null },
    { message: '！！！！！！！' }, { message: '有效内容\u0000但是含控制符' },
    { message: '有效内容\t但是含制表符' }, { message: '啊'.repeat(20) },
    { message: '啊 '.repeat(20) },
    { message: '请看 https://a.test https://b.test https://c.test 三个链接' },
    { nickname: '字'.repeat(21) }, { nickname: '姓名\n换行' }, { nickname: 1 },
    { website: 'https://spam.test' }, { website: ' ' }, { website: null },
  ]) await rejectsWith(store.submit(submission(session, override)), 400);
  assert.equal((await store.read({ cookie: session.cookie, fingerprint })).canSubmit, true);
  const posted = await store.submit(submission(session, {
    nickname: '  同学  ',
    message: '  第一行反馈。\r\n第二行建议，参考 https://www.a.test 和 https://b.test 。  ',
  }));
  assert.equal(posted.message.nickname, '同学');
  assert.equal(posted.message.message, '第一行反馈。\n第二行建议，参考 https://www.a.test 和 https://b.test 。');
});

test('length limits count Unicode characters rather than UTF-16 code units', async t => {
  const { store } = await fixture(t);
  const session = await store.read({ fingerprint });
  const nickname = '𠮷'.repeat(20);
  const message = '建议改进'.repeat(249) + '𠮷𠮷𠮷𠮷';
  assert.equal([...message].length, 1000);
  const posted = await store.submit(submission(session, { nickname, message }));
  assert.equal(posted.message.nickname, nickname);
  assert.equal(posted.message.message, message);
});

test('pagination is newest first, retains the configured bound and rejects stale cursors', async t => {
  const { store } = await fixture(t, { maxMessages: 25 });
  const posted = [];
  for (let index = 0; index < 30; index++) {
    const visitorFingerprint = index.toString(16).padStart(64, '0');
    const session = await store.read({ fingerprint: visitorFingerprint });
    posted.push((await store.submit(submission(session, { fingerprint: visitorFingerprint, message: `第 ${index} 条有效建议。` }))).message);
  }
  const first = await store.read();
  assert.equal(first.messages.length, 20);
  assert.deepEqual(first.messages, posted.slice(10).reverse());
  assert.equal(first.nextCursor, posted[10].id);
  const second = await store.read({ cookie: first.cookie, cursor: first.nextCursor });
  assert.deepEqual(second.messages, posted.slice(5, 10).reverse());
  assert.equal(second.nextCursor, null);
  await rejectsWith(store.read({ cursor: posted[0].id }), 400);
  await rejectsWith(store.read({ cursor: '../private-data' }), 400);
});

test('persisted corruption is rejected without overwriting or returning fake empty messages', async t => {
  const { createFeedbackStore } = await modulePromise;
  const { store, filePath, now } = await fixture(t);
  await store.read();
  for (const corrupt of ['{broken', JSON.stringify({ version: 1, secret: 'bad', messages: [], quotas: {} })]) {
    await fs.writeFile(filePath, corrupt);
    await rejectsWith(store.read(), 503);
    const restarted = createFeedbackStore({ filePath, now });
    await rejectsWith(restarted.read(), 503);
    assert.equal(await fs.readFile(filePath, 'utf8'), corrupt);
  }
});

test('read and write failure never invent success or consume a submission quota', async t => {
  const { store, filePath } = await fixture(t);
  const session = await store.read({ fingerprint });
  const dataDirectory = path.dirname(filePath);
  const backup = `${dataDirectory}-backup`;
  const original = await fs.readFile(filePath, 'utf8');
  await fs.rename(dataDirectory, backup);
  await fs.writeFile(dataDirectory, 'not a directory');
  await rejectsWith(store.read(), 503);
  await rejectsWith(store.submit(submission(session)), 503);
  await fs.unlink(dataDirectory);
  await fs.rename(backup, dataDirectory);
  assert.equal(await fs.readFile(filePath, 'utf8'), original);
  assert.equal((await store.read({ cookie: session.cookie, fingerprint })).canSubmit, true);
  await store.submit(submission(session));
});

test('atomic-write failure after loading leaves the original file and quota unchanged', async t => {
  const { store, filePath } = await fixture(t);
  const session = await store.read({ fingerprint });
  const original = await fs.readFile(filePath, 'utf8');
  // A directory cannot be atomically replaced by a regular file on either OS.
  const backup = `${filePath}.backup`;
  let swapped = false;
  const { createFeedbackStore } = await modulePromise;
  const failingStore = createFeedbackStore({ filePath, now: () => {
    // Synchronous operations make the failure occur after the async load.
    const syncFs = require('node:fs');
    syncFs.renameSync(filePath, backup);
    syncFs.mkdirSync(filePath);
    swapped = true;
    return Date.parse('2026-10-11T10:00:00.000Z');
  } });
  await rejectsWith(failingStore.submit(submission(session)), 503);
  assert.equal(swapped, true);
  await fs.rmdir(filePath);
  await fs.rename(backup, filePath);
  assert.equal(await fs.readFile(filePath, 'utf8'), original);
  assert.equal((await store.read({ cookie: session.cookie, fingerprint })).canSubmit, true);
  assert.ok(!(await fs.readdir(path.dirname(filePath))).some(name => name.endsWith('.tmp')));
});

test('an initialized store fails closed if its data file disappears', async t => {
  const { store, filePath } = await fixture(t);
  await store.read();
  await fs.unlink(filePath);
  await rejectsWith(store.read(), 503);
  await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
});
