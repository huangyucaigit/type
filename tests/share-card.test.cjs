'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildShareModel, createController, drawCard, CARD_WIDTH, CARD_HEIGHT } = require('../share-card.js');
const qrcode = require('../qr-code.js');
const CODE = 'aBcD_0123456789zYxW-abcdef';
const account = (id = 1, code = CODE, count = 0, days = 0) => ({ user: { id, email: `qa${id}@example.com` },
  referral: { code, rewardedCount: count, rewardLimit: 3, totalDays: days } });
const guest = () => ({ user: null, referral: null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('production cards have one canonical address and discard current-page tokens and parameters', () => {
  const model = buildShareModel(account(), 'https://untrusted.example/path?reset=secret&ref=other#private');
  assert.equal(model.url, `https://type.where.work/?ref=${CODE}`);
  assert.equal(model.personal, true);
  assert.equal(model.local, false);
  assert.ok(!model.url.includes('secret'));
});

test('only loopback HTTP(S) previews retain their origin, with an explicit local marker', () => {
  for (const origin of ['http://127.0.0.1:4174', 'http://localhost:4173', 'https://[::1]:4173']) {
    const model = buildShareModel(account(), `${origin}/?reset=do-not-share`);
    assert.equal(model.url, `${origin}/?ref=${CODE}`);
    assert.equal(model.local, true);
  }
  for (const href of ['http://localhost.evil.example', 'file:///C:/workspace/index.html', 'javascript:alert(1)', 'not a URL']) {
    assert.equal(buildShareModel(guest(), href).url, 'https://type.where.work/');
  }
});

test('anonymous cards never reuse a signed-in referral code and unsafe codes never become links', () => {
  assert.equal(buildShareModel({ user: null, referral: { code: CODE } }).url, 'https://type.where.work/');
  for (const code of ['short', 'x'.repeat(81), 'a'.repeat(20) + '&ref=other', '<img src=x onerror=1>']) {
    const model = buildShareModel(account(1, code));
    assert.equal(model.personal, false);
    assert.equal(model.url, 'https://type.where.work/');
  }
});

test('invitation progress shows the three reward cap even when malformed state contains larger values', () => {
  const model = buildShareModel(account(1, CODE, 2, 11));
  assert.equal(model.remaining, 1);
  assert.match(model.rules, /已获奖 2 \/ 3 次，累计 11 天/);
  assert.match(model.rules, /朋友仍可领取新手券/);
  const capped = buildShareModel({ ...account(1, CODE, 99, 99), referral: { code: CODE, rewardedCount: 99, totalDays: 99, rewardLimit: 99 } });
  assert.equal(capped.rewardedCount, 3);
  assert.equal(capped.totalDays, 21);
  assert.equal(capped.remaining, 0);
  assert.equal(buildShareModel(account(1, CODE, -3, '7')).rewardedCount, 0);
});

function controllerHarness(initial = guest(), overrides = {}) {
  let state = initial, preparations = 0;
  const rendered = [], changed = [];
  const controller = createController({
    getState: () => state,
    ready: () => Promise.resolve(),
    prepare: async () => { preparations++; },
    href: () => 'https://type.where.work/',
    render: async model => { rendered.push(model); return { dataUrl: `data:image/png;${model.url}` }; },
    onChange: view => changed.push(view),
    ...overrides,
  });
  return { controller, rendered, changed, setState: next => { state = next; }, preparations: () => preparations };
}

test('guests can generate a generic card without login or referral preparation', async () => {
  const page = controllerHarness();
  const model = await page.controller.open();
  assert.equal(model.signedIn, false);
  assert.equal(model.url, 'https://type.where.work/');
  assert.equal(page.preparations(), 0);
  assert.equal(page.controller.snapshot().phase, 'ready');
});

test('a personal card waits for preparation and uses the latest server snapshot without looping on authchange', async () => {
  const response = deferred();
  let requests = 0;
  const page = controllerHarness(account(1, null), { prepare: async () => {
    requests++;
    await response.promise;
    page.setState(account(1, CODE, 1, 5));
    page.controller.authChanged();
  } });
  const opened = page.controller.open();
  await flush();
  assert.equal(page.controller.snapshot().phase, 'preparing');
  assert.equal(page.rendered.length, 0);
  response.resolve();
  const model = await opened;
  assert.equal(requests, 1);
  assert.equal(model.personal, true);
  assert.equal(model.rewardedCount, 1);
  assert.match(page.controller.snapshot().image.dataUrl, new RegExp(CODE));
});

test('failed preparation cannot produce a misleading reward link and reopening retries', async () => {
  let attempts = 0;
  const page = controllerHarness(account(), { prepare: async () => {
    if (++attempts === 1) throw new Error('网络暂时不可用');
  } });
  assert.equal(await page.controller.open(), null);
  assert.equal(page.controller.snapshot().phase, 'error');
  assert.equal(page.controller.snapshot().model, null);
  assert.equal(page.rendered.length, 0);
  page.controller.close();
  assert.equal((await page.controller.open()).personal, true);
  assert.equal(attempts, 2);
});

test('missing server referral after successful preparation is an error, not a fabricated personal card', async () => {
  const page = controllerHarness(account(1, null));
  assert.equal(await page.controller.open(), null);
  assert.match(page.controller.snapshot().error, /邀请链接/);
  assert.equal(page.rendered.length, 0);
});

test('logout while preparation is pending clears the old link and ignores the late response', async () => {
  const response = deferred();
  const page = controllerHarness(account(), { prepare: () => response.promise });
  const oldOpen = page.controller.open();
  await flush();
  page.setState(guest());
  await page.controller.authChanged();
  assert.equal(page.controller.snapshot().model.personal, false);
  response.resolve();
  assert.equal(await oldOpen, null);
  assert.equal(page.controller.snapshot().model.url, 'https://type.where.work/');
  assert.equal(page.rendered.some(model => model.personal), false);
});

test('a delayed render cannot restore a closed card or another account invitation', async () => {
  const first = deferred();
  let renderCount = 0;
  const page = controllerHarness(account(), { render: model => ++renderCount === 1 ? first.promise : Promise.resolve({ dataUrl: model.url }) });
  const oldOpen = page.controller.open();
  await flush();
  page.setState(account(2, 'b'.repeat(24)));
  await page.controller.authChanged();
  assert.equal(page.controller.snapshot().model.url, `https://type.where.work/?ref=${'b'.repeat(24)}`);
  first.resolve({ dataUrl: `https://type.where.work/?ref=${CODE}` });
  await oldOpen;
  assert.equal(page.controller.snapshot().model.url.includes(CODE), false);
  page.controller.close();
  assert.equal(page.controller.snapshot().phase, 'closed');
  assert.equal(page.controller.snapshot().image, null);
});

test('progress updates rerender a prepared card without preparing again, reopening prepares anew', async () => {
  const page = controllerHarness(account());
  await page.controller.open();
  page.setState(account(1, CODE, 3, 15));
  await page.controller.authChanged();
  assert.equal(page.controller.snapshot().model.remaining, 0);
  assert.equal(page.preparations(), 1);
  page.controller.close();
  await page.controller.open();
  assert.equal(page.preparations(), 2);
});

test('card drawing uses the exact invitation URL, four quiet modules and integer QR pixels', () => {
  const calls = [], written = [];
  const context = {
    beginPath() {}, roundRect() {}, fill() {}, stroke() {},
    fillRect(...args) { calls.push({ args, fill: this.fillStyle }); },
    fillText(text) { written.push(text); },
    measureText: text => ({ width: text.length * 12 }),
  };
  const canvas = { getContext: () => context };
  const model = buildShareModel(account(), 'http://127.0.0.1:4174');
  let encoded = '';
  drawCard(canvas, model, (...args) => {
    assert.deepEqual(args, [0, 'M']);
    const qr = qrcode(...args);
    return { ...qr, addData(value, mode) { encoded = value; qr.addData(value, mode); } };
  });
  assert.equal(encoded, model.url);
  assert.equal(canvas.width, CARD_WIDTH);
  assert.equal(canvas.height, CARD_HEIGHT);
  assert.ok(written.includes(model.url));
  assert.ok(written.includes('本地预览'));
  const modules = calls.filter(call => call.fill === '#263d2e');
  assert.ok(modules.length > 100);
  for (const { args: [x, y, width, height] } of modules) {
    assert.ok([x, y, width, height].every(Number.isInteger));
    assert.equal(width, height);
    assert.ok(x >= 98 + 4 * width);
    assert.ok(y >= 908 + 4 * width);
    assert.ok(x + width <= 432 - 4 * width);
    assert.ok(y + height <= 1242 - 4 * width);
  }
});

test('canvas or QR generator failures produce recoverable errors without incomplete images', () => {
  assert.throws(() => drawCard({}, buildShareModel(guest())), /二维码/);
  assert.throws(() => drawCard({ getContext: () => null }, buildShareModel(guest()), qrcode), /复制链接/);
});
