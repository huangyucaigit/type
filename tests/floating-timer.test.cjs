'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../floating-timer.js');

const STORAGE_KEY = 'mars-ielts-typing:timer-collapsed:v1';
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    writes,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); writes.push([key, String(value)]); },
  };
}

test('first visit and malformed preferences keep the stopwatch collapsed', () => {
  for (const stored of [undefined, '', 'false', 'true', '2', '{broken']) {
    const storage = memoryStorage(stored === undefined ? {} : { [STORAGE_KEY]: stored });
    const controller = createController({ storage });
    assert.equal(controller.snapshot().collapsed, true, `stored=${stored}`);
    assert.equal(controller.snapshot().mode, 'realtime');
    assert.equal(controller.snapshot().value, '00:00');
    assert.equal(controller.snapshot().running, false);
    assert.equal(controller.snapshot().started, false);
    assert.deepEqual(storage.writes, []);
  }
});

test('folding persists a shared browser preference and restores it without starting either clock', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '0' });
  const first = createController({ storage });
  first.setCollapsed(true);
  assert.equal(first.snapshot().collapsed, true);
  assert.equal(storage.getItem(STORAGE_KEY), '1');
  const restored = createController({ storage });
  assert.equal(restored.snapshot().collapsed, true);
  assert.equal(restored.snapshot().running, false);
  assert.equal(restored.snapshot().value, '00:00');
  restored.setCollapsed(false);
  assert.equal(storage.getItem(STORAGE_KEY), '0');
  assert.equal(createController({ storage }).snapshot().collapsed, false);
});

test('blocked browser storage does not prevent folding, expanding or receiving time updates', () => {
  const storage = {
    getItem() { throw new Error('Storage disabled'); },
    setItem() { throw new Error('Quota denied'); },
  };
  const controller = createController({ storage });
  assert.equal(controller.snapshot().collapsed, true);
  assert.doesNotThrow(() => controller.setCollapsed(false));
  assert.doesNotThrow(() => controller.setCollapsed(true));
  controller.update({ mode: 'realtime', value: '00:08', running: true, started: true });
  assert.equal(controller.snapshot().collapsed, true);
  assert.equal(controller.snapshot().value, '00:08');
  assert.equal(controller.snapshot().running, true);
  assert.doesNotThrow(() => controller.setCollapsed(false));
  assert.equal(controller.snapshot().running, true);
});

test('inactive mode updates retain separate readings without replacing the visible stopwatch', () => {
  const controller = createController({ storage: memoryStorage() });
  controller.update({ mode: 'realtime', value: '00:12', running: true, started: true });
  controller.update({ mode: 'sentence', value: '00:03', running: false, started: true });
  assert.equal(controller.snapshot().mode, 'realtime');
  assert.equal(controller.snapshot().value, '00:12');
  assert.equal(controller.snapshot().running, true);
  controller.setCollapsed(true);
  controller.setMode('sentence');
  assert.equal(controller.snapshot().collapsed, true);
  assert.equal(controller.snapshot().value, '00:03');
  assert.equal(controller.snapshot().running, false);
  assert.equal(controller.snapshot().started, true);
  controller.update({ mode: 'realtime', value: '00:15', running: true, started: true });
  assert.equal(controller.snapshot().value, '00:03');
  controller.setMode('realtime');
  assert.equal(controller.snapshot().value, '00:15');
});

test('folding and expanding preserve a running or paused reading including the first second', () => {
  for (const reading of [
    { value: '00:00', running: true, started: true },
    { value: '00:00', running: false, started: true },
    { value: '1:00:02', running: false, started: true },
  ]) {
    const controller = createController({ storage: memoryStorage({ [STORAGE_KEY]: '0' }) });
    controller.update({ mode: 'realtime', ...reading });
    controller.setCollapsed(true);
    for (const [key, value] of Object.entries(reading)) assert.equal(controller.snapshot()[key], value);
    controller.setCollapsed(false);
    for (const [key, value] of Object.entries(reading)) assert.equal(controller.snapshot()[key], value);
  }
});

test('clock refreshes never persist elapsed time or rewrite the folding preference', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '0' });
  const updates = [];
  const controller = createController({ storage, onChange: state => updates.push(state) });
  controller.setCollapsed(true);
  const writeCount = storage.writes.length;
  for (let second = 1; second <= 10; second += 1) {
    controller.update({ mode: 'realtime', value: `00:${String(second).padStart(2, '0')}`, running: true, started: true });
  }
  controller.setMode('sentence');
  assert.equal(storage.writes.length, writeCount);
  assert.deepEqual(storage.writes[0], [STORAGE_KEY, '1']);
  assert.ok(updates.length > 0);
  assert.equal(updates.at(-1).mode, 'sentence');
  assert.equal(updates.at(-1).collapsed, true);
});
