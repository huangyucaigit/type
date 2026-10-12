'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  normalizeSource,
  normalizeInput,
  compare,
  formatDuration,
  PracticeClock,
} = require('../typing-core.js');

test('exports the same interface in a browser without Node globals', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'typing-core.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.TypingCore).sort(), [
    'PracticeClock', 'compare', 'formatDuration', 'normalizeInput', 'normalizeSource',
  ].sort());
  assert.equal(context.TypingCore.compare('Essay.', 'Essay.').completed, true);
});

test('normalizes imported source while retaining internal spaces and paragraphs', () => {
  assert.equal(
    normalizeSource('\uFEFF \tFirst\tparagraph.\r\n\r\nSecond\rThird.  \t'),
    'First paragraph.\n\nSecond\nThird.',
  );
  assert.equal(normalizeSource('A  B\t\tC'), 'A  B  C');
  assert.equal(normalizeSource(' \t\r\n '), '');
  assert.equal(normalizeSource(null), '');
});

test('normalizes input line endings without trimming or replacing tabs or BOM', () => {
  assert.equal(normalizeInput('\uFEFF A\tB\r\nC\rD\n '), '\uFEFF A\tB\nC\nD\n ');
  assert.equal(normalizeInput('  '), '  ');
});

test('marks untouched characters pending and exact text complete', () => {
  assert.deepEqual(compare('ab', ''), {
    characters: [
      { index: 0, expected: 'a', actual: null, state: 'pending' },
      { index: 1, expected: 'b', actual: null, state: 'pending' },
    ],
    total: 2, typed: 0, correct: 0, errorCount: 0, firstError: null, completed: false,
  });
  const completed = compare('Hello, IELTS!\nNext.', 'Hello, IELTS!\nNext.');
  assert.equal(completed.completed, true);
  assert.equal(completed.correct, completed.total);
  assert.equal(completed.firstError, null);
  assert.ok(completed.characters.every(character => character.state === 'correct'));
});

test('keeps a correct prefix black and the remaining source pending', () => {
  const result = compare('essay', 'es');
  assert.deepEqual(result.characters.map(character => character.state), [
    'correct', 'correct', 'pending', 'pending', 'pending',
  ]);
  assert.equal(result.typed, 2);
  assert.equal(result.correct, 2);
  assert.equal(result.errorCount, 0);
  assert.equal(result.completed, false);
});

test('case, punctuation, spaces, and paragraph breaks must match exactly', () => {
  for (const [source, input, firstError] of [
    ['Essay', 'essay', 0],
    ['Hi.', 'Hi!', 2],
    ['a b', 'a\tb', 1],
    ['a\nb', 'a b', 1],
    ['a  b', 'a b', 2],
  ]) {
    const result = compare(source, input);
    assert.equal(result.completed, false, `${JSON.stringify(input)} must not match ${JSON.stringify(source)}`);
    assert.equal(result.firstError, firstError);
    assert.ok(result.errorCount > 0);
  }
});

test('does not implicitly normalize either comparison operand', () => {
  assert.equal(compare('a\nb', 'a\r\nb').completed, false);
  assert.equal(compare('a\nb', normalizeInput('a\r\nb')).completed, true);
  assert.equal(compare('a', 'a ').completed, false);
});

test('insertions and deletions shift all subsequent character positions', () => {
  const inserted = compare('abcd', 'axbcd');
  assert.deepEqual(inserted.characters.map(character => character.state), [
    'correct', 'incorrect', 'incorrect', 'incorrect', 'extra',
  ]);
  assert.equal(inserted.errorCount, 4);
  assert.equal(inserted.firstError, 1);

  const deleted = compare('abcd', 'acd');
  assert.deepEqual(deleted.characters.map(character => character.state), [
    'correct', 'incorrect', 'incorrect', 'pending',
  ]);
  assert.equal(deleted.errorCount, 2);
  assert.equal(deleted.firstError, 1);
});

test('tracks excess input even after an otherwise perfect article', () => {
  const result = compare('ab', 'abXY');
  assert.deepEqual(result.characters.slice(2), [
    { index: 2, expected: null, actual: 'X', state: 'extra' },
    { index: 3, expected: null, actual: 'Y', state: 'extra' },
  ]);
  assert.equal(result.total, 2);
  assert.equal(result.typed, 4);
  assert.equal(result.correct, 2);
  assert.equal(result.errorCount, 2);
  assert.equal(result.firstError, 2);
  assert.equal(result.completed, false);
});

test('empty source is never complete and nonempty input is entirely extra', () => {
  assert.equal(compare('', '').completed, false);
  const result = compare('', 'x');
  assert.equal(result.errorCount, 1);
  assert.equal(result.firstError, 0);
  assert.equal(result.characters[0].state, 'extra');
});

test('uses Unicode code points rather than UTF-16 code units', () => {
  const result = compare('A😀文', 'A😃文');
  assert.equal(result.total, 3);
  assert.equal(result.typed, 3);
  assert.equal(result.correct, 2);
  assert.equal(result.errorCount, 1);
  assert.deepEqual(result.characters[1], {
    index: 1, expected: '😀', actual: '😃', state: 'incorrect',
  });
  assert.equal(compare('😀', '😀').completed, true);
  assert.equal(compare('é', 'e\u0301').completed, false);
});

test('recomputes current errors after backspace or replacement without historical errors', () => {
  assert.equal(compare('hello', 'hex').errorCount, 1);
  assert.equal(compare('hello', 'he').errorCount, 0);
  assert.equal(compare('hello', 'hello').completed, true);
  assert.equal(compare('hello', 'hell').completed, false);
});

test('accepts a pasted complete article through the same comparison', () => {
  const source = normalizeSource('Paragraph one.\r\n\r\nParagraph two.');
  const pastedInput = normalizeInput('Paragraph one.\r\n\r\nParagraph two.');
  assert.equal(compare(source, pastedInput).completed, true);
});

test('formats durations at second, minute, and hour boundaries', () => {
  for (const [milliseconds, expected] of [
    [0, '00:00'],
    [999, '00:00'],
    [1000, '00:01'],
    [59_999, '00:59'],
    [60_000, '01:00'],
    [3_599_999, '59:59'],
    [3_600_000, '1:00:00'],
    [3_661_000, '1:01:01'],
    [360_000_000, '100:00:00'],
    [-1000, '00:00'],
    [NaN, '00:00'],
    [Infinity, '00:00'],
  ]) {
    assert.equal(formatDuration(milliseconds), expected);
  }
});

test('starts idle, does not consume time until started, and starts only once', () => {
  let now = 100;
  const clock = new PracticeClock(() => now);
  assert.equal(clock.state, 'idle');
  now = 5000;
  assert.equal(clock.elapsed(), 0);
  clock.stop();
  assert.equal(clock.state, 'idle');
  clock.start();
  assert.equal(clock.state, 'running');
  now = 5500;
  clock.start();
  now = 6000;
  assert.equal(clock.elapsed(), 1000);
});

test('stop freezes time and reset allows an independent new practice', () => {
  let now = 1000;
  const clock = new PracticeClock(() => now);
  clock.start();
  now = 2750;
  clock.stop();
  assert.equal(clock.state, 'stopped');
  assert.equal(clock.elapsed(), 1750);
  now = 10_000;
  clock.stop();
  clock.start();
  assert.equal(clock.elapsed(), 1750);
  clock.reset();
  assert.equal(clock.state, 'idle');
  assert.equal(clock.elapsed(), 0);
  clock.start();
  now = 10_750;
  assert.equal(clock.elapsed(), 750);
  clock.reset();
  assert.equal(clock.elapsed(), 0);
});

test('elapsed time advances without display polling or a visible timer', () => {
  let now = 0;
  const clock = new PracticeClock(() => now);
  clock.start();
  assert.equal(formatDuration(clock.elapsed()), '00:00');
  // No display reads occur while the timer is hidden or the page is in the background.
  now = 125_400;
  assert.equal(clock.state, 'running');
  assert.equal(formatDuration(clock.elapsed()), '02:05');
  clock.stop();
  now = 200_000;
  assert.equal(clock.elapsed(), 125_400);
});

test('pause and resume accumulate only running intervals across repeated fractional seconds', () => {
  let now = 0;
  const clock = new PracticeClock(() => now);
  clock.pause();
  assert.equal(clock.state, 'idle');
  clock.start();
  now = 1550;
  clock.pause();
  assert.equal(clock.elapsed(), 1550);
  assert.equal(clock.state, 'stopped');
  now = 10000;
  clock.pause();
  assert.equal(clock.elapsed(), 1550);
  clock.start();
  now = 10450;
  assert.equal(clock.elapsed(), 2000);
  clock.start();
  now = 10800;
  clock.pause();
  assert.equal(clock.elapsed(), 2350);
  now = 20000;
  assert.equal(clock.elapsed(), 2350);
  clock.start();
  now = 20650;
  assert.equal(clock.elapsed(), 3000);
  clock.reset();
  now = 22000;
  assert.equal(clock.elapsed(), 0);
  assert.equal(clock.state, 'idle');
  clock.start();
  now = 22500;
  assert.equal(clock.elapsed(), 500);
});

test('uses a working default clock and rejects invalid now callbacks', () => {
  const clock = new PracticeClock();
  clock.start();
  assert.ok(clock.elapsed() >= 0);
  clock.stop();
  assert.ok(Number.isFinite(clock.elapsed()));
  assert.throws(() => new PracticeClock(0), TypeError);
});
