'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { winningRotation, createController } = require('../starter-wheel.js');

const state = (status = 'available', days = null, user = null) => ({ user, starterDraw: { status, days, drawnAt: days ? 1000 : null } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('each of the five equal segments lands its center under the top pointer', () => {
  for (const [index, days] of [3, 4, 5, 6, 7].entries()) {
    for (const previous of [0, 72, 1440, 1578, -20]) {
      const rotation = winningRotation(days, previous);
      assert.ok(rotation - previous >= 1440, 'a fresh draw makes at least four turns');
      assert.equal(((index * 72 + rotation) % 360 + 360) % 360, 0, `${days} days must be centered at twelve o'clock`);
    }
  }
  for (const invalid of [null, 0, 2, 8, '5', 3.5, NaN]) assert.throws(() => winningRotation(invalid), RangeError);
});

test('rapid clicks share a single draw and the result appears only when animation finishes', async () => {
  let latest = state(), requests = 0;
  const response = deferred(), animation = deferred(), displayed = [];
  const controller = createController({
    getState: () => latest,
    draw: () => { requests++; return response.promise; },
    animate: days => { assert.equal(days, 6); return animation.promise; },
    onChange: view => displayed.push(view),
  });
  const first = controller.spin(), second = controller.spin();
  assert.equal(first, second);
  await flush();
  assert.equal(requests, 1);
  latest = state('pending', 6);
  controller.refresh(latest); // The auth client emits before returning its draw.
  response.resolve(latest);
  await flush();
  assert.equal(controller.snapshot().days, null);
  assert.equal(controller.snapshot().phase, 'drawing');
  assert.equal(displayed.some(view => view.days), false);
  animation.resolve();
  assert.equal(await first, latest);
  assert.equal(controller.snapshot().days, 6);
  assert.equal(controller.snapshot().phase, 'ready');
});

test('a saved pending result survives refresh and controller recreation without another draw', async () => {
  const saved = state('pending', 4);
  let requests = 0, animations = 0;
  for (let refresh = 0; refresh < 2; refresh++) {
    const controller = createController({
      getState: () => saved,
      draw: () => { requests++; return saved; },
      animate: () => { animations++; },
    });
    controller.refresh();
    assert.equal(controller.snapshot().days, 4);
    await controller.spin();
    assert.equal(controller.snapshot().days, 4);
  }
  assert.equal(requests, 0);
  assert.equal(animations, 0);
});

test('failed requests show no invented result and can retry', async () => {
  let latest = state(), requests = 0;
  const controller = createController({
    getState: () => latest,
    draw: async () => {
      if (++requests === 1) throw new Error('连接失败，请重试。');
      latest = state('pending', 7); return latest;
    },
  });
  assert.equal(await controller.spin(), null);
  assert.equal(controller.snapshot().days, null);
  assert.equal(controller.snapshot().phase, 'ready');
  assert.match(controller.snapshot().error, /连接失败/);
  await controller.spin();
  assert.equal(requests, 2);
  assert.equal(controller.snapshot().days, 7);
  assert.equal(controller.snapshot().error, '');
});

test('eligibility changes during a request do not animate or announce a false prize', async () => {
  let latest = state(), animations = 0;
  const controller = createController({
    getState: () => latest,
    draw: async () => { latest = state('ineligible'); return latest; },
    animate: () => { animations++; },
  });
  await controller.spin();
  assert.equal(controller.snapshot().state.starterDraw.status, 'ineligible');
  assert.equal(controller.snapshot().days, null);
  assert.equal(animations, 0);
  await controller.spin();
  assert.equal(animations, 0);
});

test('malformed server durations cannot be displayed as prizes', async () => {
  let latest = state();
  const controller = createController({ getState: () => latest,
    draw: async () => { latest = state('pending', 99); return latest; },
  });
  await controller.spin();
  assert.equal(controller.snapshot().days, null);
  assert.match(controller.snapshot().error, /结果暂时无法读取/);
});

test('anonymous winners enter registration without claiming or drawing again', async () => {
  const saved = state('pending', 5);
  let registrations = 0, claims = 0;
  const controller = createController({
    getState: () => saved,
    register: () => { registrations++; },
    claim: () => { claims++; },
  });
  await controller.claim();
  assert.equal(registrations, 1);
  assert.equal(claims, 0);
  assert.equal(controller.snapshot().days, 5);
});

test('claiming is single flight and clears the displayed reward after the server confirms it', async () => {
  let latest = state('pending', 3, { id: 1 }), claims = 0;
  const response = deferred();
  const controller = createController({
    getState: () => latest,
    claim: () => { claims++; return response.promise; },
  });
  const first = controller.claim(), second = controller.claim();
  assert.equal(first, second);
  await flush();
  assert.equal(claims, 1);
  latest = state('claimed', 3, { id: 1 });
  response.resolve(true); // Auth's claim method confirms success with a boolean.
  await first;
  assert.equal(controller.snapshot().days, null);
  assert.equal(controller.snapshot().state.starterDraw.status, 'claimed');
  assert.equal(controller.snapshot().phase, 'ready');
});

test('a failed claim preserves the exact pending result for retry', async () => {
  const saved = state('pending', 6, { id: 1 });
  let claims = 0;
  const controller = createController({ getState: () => saved,
    claim: async () => { claims++; throw new Error('领取服务暂时不可用'); },
  });
  await controller.claim();
  assert.equal(controller.snapshot().days, 6);
  assert.equal(controller.snapshot().phase, 'ready');
  assert.match(controller.snapshot().error, /领取服务/);
  await controller.claim();
  assert.equal(claims, 2);
  assert.equal(controller.snapshot().days, 6);
});
