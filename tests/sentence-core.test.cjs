'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { splitSentences, sentenceRanges, groupSentences, compareWords } = require('../sentence-core.js');

function words(result) {
  return result.tokens.filter(token => token.actualIndex >= 0);
}

test('provides the same browser and Node interfaces', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sentence-core.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.SentenceCore).sort(), ['compareWords', 'groupSentences', 'sentenceRanges', 'splitSentences']);
  assert.equal(context.SentenceCore.compareWords('Hello.', 'Hello.').completed, true);
});

test('splits normal English punctuation, paragraphs and an unfinished last sentence', () => {
  assert.deepEqual(splitSentences('  First sentence. Next question? Yes!\r\n\r\nNew paragraph\n\nFinal tail  '), [
    'First sentence.', 'Next question?', 'Yes!', 'New paragraph', 'Final tail',
  ]);
  assert.deepEqual(splitSentences('\uFEFF \n \t'), []);
  assert.deepEqual(splitSentences(null), []);
});

test('keeps text-file line wrapping inside a sentence and separates blank-line paragraphs', () => {
  assert.deepEqual(splitSentences('This is a\nlong sentence. Next one.'), [
    'This is a\nlong sentence.', 'Next one.',
  ]);
  assert.deepEqual(splitSentences('A paragraph without\na final full stop\n \t\nAnother paragraph\nwith a tail'), [
    'A paragraph without\na final full stop', 'Another paragraph\nwith a tail',
  ]);
  assert.deepEqual(splitSentences('First sentence.\nSecond sentence.\n\n\nFinal tail'), [
    'First sentence.', 'Second sentence.', 'Final tail',
  ]);
});

test('retains closing quotes and brackets and treats a punctuation run as one ending', () => {
  assert.deepEqual(splitSentences('She asked, “Really?!” He replied, "Yes." (It worked!) Final.'), [
    'She asked, “Really?!”', 'He replied, "Yes."', '(It worked!)', 'Final.',
  ]);
  assert.deepEqual(splitSentences('Wait... maybe later. Then we left... Next stop?'), [
    'Wait... maybe later.', 'Then we left...', 'Next stop?',
  ]);
});

test('keeps quoted dialogue and a lowercase reporting clause in the same sentence', () => {
  assert.deepEqual(splitSentences('"Why?" he asked. Next.'), ['"Why?" he asked.', 'Next.']);
  assert.deepEqual(splitSentences('“Go!” she said. "Really?!"\nhe replied. Then they left.'), [
    '“Go!” she said.', '"Really?!"\nhe replied.', 'Then they left.',
  ]);
});

test('does not split decimals, titles, examples or common country abbreviations', () => {
  assert.deepEqual(splitSentences('Dr. Smith met Mr. Jones and Mrs. Green. The rate is 3.14 percent. Try e.g. reading, i.e. a daily habit. The U.S. economy is large. Done.'), [
    'Dr. Smith met Mr. Jones and Mrs. Green.',
    'The rate is 3.14 percent.',
    'Try e.g. reading, i.e. a daily habit.',
    'The U.S. economy is large.',
    'Done.',
  ]);
  assert.deepEqual(splitSentences('J. Smith lives in the U.S. It is his home. He met the U.S. President.'), [
    'J. Smith lives in the U.S.', 'It is his home.', 'He met the U.S. President.',
  ]);
});

test('sentence ranges retain exact UTF-16 positions through BOM, emoji, CRLF and paragraph spacing', () => {
  const source = '\uFEFF  First 😀 sentence.\r\nSecond sentence!\r\n \t\r\n  Final\r\nwrapped tail  ';
  const expected = ['First 😀 sentence.', 'Second sentence!', 'Final\r\nwrapped tail'];
  const ranges = sentenceRanges(source);
  assert.deepEqual(ranges.map(range => range.text), expected);
  assert.deepEqual(ranges.map(range => [range.start, range.end]), expected.map(text => {
    const start = source.indexOf(text);
    return [start, start + text.length];
  }));
  for (const range of ranges) assert.equal(source.slice(range.start, range.end), range.text);
  assert.deepEqual(splitSentences(source), ['First 😀 sentence.', 'Second sentence!', 'Final\nwrapped tail'],
    'the existing normalized splitSentences contract is preserved');
});

test('sentence ranges use the existing title, initial, decimal and closing-quote boundaries', () => {
  const source = 'Dr. J. Smith paid 3.14 dollars. “Really?!” he asked. Next sentence.';
  const texts = ['Dr. J. Smith paid 3.14 dollars.', '“Really?!” he asked.', 'Next sentence.'];
  assert.deepEqual(sentenceRanges(source), texts.map(text => {
    const start = source.indexOf(text);
    return { start, end: start + text.length, text };
  }));
  assert.deepEqual(sentenceRanges(' \uFEFF\r\n\t'), []);
  assert.deepEqual(sentenceRanges(null), []);
});

test('sentence ranges distinguish repeated identical sentences without searching from the beginning', () => {
  const source = 'Keep going. Keep going.\n\nKeep going.';
  const ranges = sentenceRanges(source);
  assert.deepEqual(ranges.map(range => range.start), [0, 12, 25]);
  assert.deepEqual(ranges.map(range => range.end), [11, 23, 36]);
  assert.ok(ranges.every(range => range.text === 'Keep going.'));
});

test('groups by any positive safe integer and keeps the final smaller group', () => {
  const source = 'One. Two! Three? Four. Five';
  assert.deepEqual(groupSentences(source, 2), [
    { text: 'One. Two!', sentences: ['One.', 'Two!'], start: 0, end: 2 },
    { text: 'Three? Four.', sentences: ['Three?', 'Four.'], start: 2, end: 4 },
    { text: 'Five', sentences: ['Five'], start: 4, end: 5 },
  ]);
  assert.equal(groupSentences(source, 1).length, 5);
  assert.equal(groupSentences(source, 3).length, 2);
  assert.equal(groupSentences(source, 5).length, 1);
  assert.equal(groupSentences(source, Number.MAX_SAFE_INTEGER)[0].text, source);
  assert.deepEqual(groupSentences('', 10), []);
  for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined]) {
    assert.throws(() => groupSentences(source, count), RangeError);
  }
});

test('checks case and punctuation at word level without checking whitespace layout', () => {
  const actual = '  hello,\tWORLD!\r\n Again.  ';
  const result = compareWords('Hello, world! Again.', actual);
  assert.equal(result.tokens.map(token => token.text).join(''), actual);
  assert.deepEqual(words(result), [
    { text: 'hello,', state: 'incorrect', expected: 'Hello,', actualIndex: 0 },
    { text: 'WORLD!', state: 'incorrect', expected: 'world!', actualIndex: 1 },
    { text: 'Again.', state: 'correct', expected: 'Again.', actualIndex: 2 },
  ]);
  assert.equal(result.correct, 1);
  assert.equal(result.errorCount, 2);
  assert.equal(result.completed, false);
  for (const token of result.tokens.filter(token => token.actualIndex === -1)) {
    assert.equal(token.state, 'correct');
    assert.equal(token.expected, token.text);
  }
  assert.equal(compareWords('One two.', ' \n One\t\t two.\n').completed, true);
  assert.equal(compareWords('Hello.', 'Hello!').errorCount, 1);
});

test('a replacement changes only that word and gives the expected correction', () => {
  const result = compareWords('I like green tea.', 'I love green tea.');
  assert.deepEqual(words(result).map(token => token.state), ['correct', 'incorrect', 'correct', 'correct']);
  assert.equal(words(result)[1].expected, 'like');
  assert.equal(result.errorCount, 1);
  assert.deepEqual(result.missing, []);
});

test('inserted words do not make following words incorrect', () => {
  const result = compareWords('I like tea.', 'I really like tea.');
  assert.deepEqual(words(result).map(token => token.state), ['correct', 'extra', 'correct', 'correct']);
  assert.equal(words(result)[1].expected, null);
  assert.equal(result.correct, 3);
  assert.equal(result.errorCount, 1);
});

test('missing words are reported separately without marking later words red', () => {
  const result = compareWords('I like green tea.', 'I like tea.');
  assert.ok(words(result).every(token => token.state === 'correct'));
  assert.deepEqual(result.missing, [{ text: 'green', expectedIndex: 2 }]);
  assert.equal(result.errorCount, 1);
  assert.equal(result.completed, false);
});

test('aligns repeated words and prefers unchanged words for tied edit counts', () => {
  const missing = compareWords('we we like tea.', 'we like tea.');
  assert.equal(missing.correct, 3);
  assert.deepEqual(missing.missing, [{ text: 'we', expectedIndex: 1 }]);
  const extra = compareWords('we like tea.', 'we we like tea.');
  assert.equal(extra.correct, 3);
  assert.equal(extra.errorCount, 1);
  assert.equal(words(extra).filter(token => token.state === 'extra').length, 1);
  const swapped = compareWords('one two', 'two one');
  assert.equal(swapped.errorCount, 2);
  assert.equal(swapped.correct, 1);
});

test('handles multiple replacement, insertion and missing errors together', () => {
  const result = compareWords('We like green tea and fresh fruit today.', 'We really like tea and fresh fruits today!');
  assert.equal(result.correct, 5);
  assert.equal(result.errorCount, 4);
  assert.deepEqual(result.missing, [{ text: 'green', expectedIndex: 2 }]);
  assert.deepEqual(words(result).filter(token => token.state !== 'correct').map(token => [token.text, token.state, token.expected]), [
    ['really', 'extra', null], ['fruits', 'incorrect', 'fruit'], ['today!', 'incorrect', 'today.'],
  ]);
});

test('handles empty input, whitespace input, extra-only input and blank sources', () => {
  assert.deepEqual(compareWords('One two.', ''), {
    tokens: [], missing: [{ text: 'One', expectedIndex: 0 }, { text: 'two.', expectedIndex: 1 }],
    correct: 0, errorCount: 2, completed: false,
  });
  assert.equal(compareWords('One two.', '\n\t ').errorCount, 2);
  assert.equal(compareWords('', '').completed, false);
  const extra = compareWords('', 'Hello.');
  assert.deepEqual(words(extra), [{ text: 'Hello.', state: 'extra', expected: null, actualIndex: 0 }]);
  assert.equal(extra.errorCount, 1);
  assert.equal(compareWords(' \n ', '\t').completed, false);
  assert.equal(compareWords(null, undefined).correct, 0);
});

test('aligns larger groups with bounded-memory alignment and retains every input character', () => {
  const expected = Array.from({ length: 120 }, (_, index) => `word${index}`);
  const actual = expected.slice();
  actual[0] = 'FIRST';
  actual.splice(40, 1);
  actual.splice(75, 0, 'ADDED');
  actual[actual.length - 1] = 'LAST';
  const typed = actual.join('\t');
  const result = compareWords(expected.join(' '), typed);
  assert.equal(result.errorCount, 4);
  assert.equal(result.correct, 117);
  assert.deepEqual(result.missing, [{ text: 'word40', expectedIndex: 40 }]);
  assert.equal(result.tokens.map(token => token.text).join(''), typed);
});
