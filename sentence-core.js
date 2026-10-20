(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SentenceCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TITLES = /^(?:mr|mrs|ms|dr|prof|sr|jr|st|rev|fr|gen|col|lt|capt|sgt|hon|pres|gov|sen|rep)\.$/i;
  const CONTINUING_ABBREVIATIONS = /^(?:e\.g|i\.e|vs|no|fig|vol|dept|approx)\.$/i;
  const INITIALISM = /^(?:[a-z]\.){2,}$|^[A-Z]\.$/i;
  const SENTENCE_START = /^(?:I|He|She|It|We|You|They|This|That|These|Those|The|There|However|Therefore|Nevertheless|Meanwhile|Next|Another|Today|Tomorrow|Yesterday|A|An|In|On|At|But|And)$/;
  const CLOSING_MARK = /["'\u2019\u201d)\]}]/;

  function isAbbreviation(source, period, next) {
    const match = source.slice(0, period + 1).match(/[A-Za-z]+(?:\.[A-Za-z]+)*\.$/);
    if (!match) return false;
    const word = match[0];
    if (TITLES.test(word) || CONTINUING_ABBREVIATIONS.test(word)) return true;

    // Initials and country abbreviations usually continue a sentence. Common
    // sentence starters also let "in the U.S. It ..." end naturally.
    if (INITIALISM.test(word)) return !SENTENCE_START.test(next);
    if (/^(?:etc|a\.m|p\.m|inc|ltd|ph\.d)\.$/i.test(word)) {
      return Boolean(next) && /^[a-z]/.test(next);
    }
    return false;
  }

  function sentenceRanges(text) {
    const source = String(text ?? '');
    const sentences = [];
    let start = 0;

    function append(end) {
      const raw = source.slice(start, end);
      const sentence = raw.trim();
      if (sentence) sentences.push({ text: sentence, start: start + raw.length - raw.trimStart().length,
        end: end - (raw.length - raw.trimEnd().length) });
      start = end;
    }

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '\n') {
        const paragraphBreak = source.slice(index).match(/^\n[\t \r]*\n(?:[\t \r]*\n)*/);
        if (paragraphBreak) {
          append(index);
          start = index + paragraphBreak[0].length;
          index = start - 1;
        }
        continue;
      }
      if (!/[.!?\u3002\uff01\uff1f]/.test(character)) continue;
      if (character === '.' && /\d/.test(source[index - 1] ?? '') && /\d/.test(source[index + 1] ?? '')) continue;

      let punctuationEnd = index + 1;
      while (/[.!?\u3002\uff01\uff1f]/.test(source[punctuationEnd] ?? '') && punctuationEnd < source.length) punctuationEnd += 1;
      let end = punctuationEnd;
      while (end < source.length && CLOSING_MARK.test(source[end])) end += 1;
      if (end < source.length && !/\s/.test(source[end])) continue;

      const nextWord = source.slice(end).match(/^\s*["'\u2018\u201c([{]*([A-Za-z]+)/)?.[1] ?? '';
      const punctuation = source.slice(index, punctuationEnd);
      if (punctuation === '.' && isAbbreviation(source, index, nextWord)) continue;
      if (/["'\u2019\u201d]/.test(source.slice(punctuationEnd, end)) && /^[a-z]/.test(nextWord)) {
        index = end - 1;
        continue;
      }
      if (/^\.{2,}$/.test(punctuation) && /^[a-z]/.test(nextWord)) {
        index = punctuationEnd - 1;
        continue;
      }

      append(end);
      index = end - 1;
    }
    append(source.length);
    return sentences;
  }

  function splitSentences(text) {
    const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    return sentenceRanges(source).map(sentence => sentence.text);
  }

  function groupSentences(text, count) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError('每组句数必须是正安全整数。');
    }
    const sentences = splitSentences(text);
    const groups = [];
    for (let start = 0; start < sentences.length; start += count) {
      const end = Math.min(start + count, sentences.length);
      const group = sentences.slice(start, end);
      groups.push({ text: group.join(' '), sentences: group, start, end });
    }
    return groups;
  }

  // Minimize edits first, then prefer more unchanged words. The latter avoids
  // marking two exchanged/repeated words as replacements when an equally
  // short alignment can preserve a correct word.
  function alignmentScores(expected, actual, eStart, eEnd, aStart, aEnd, backwards, editCost) {
    const width = aEnd - aStart;
    let previous = new Float64Array(width + 1);
    let current = new Float64Array(width + 1);
    for (let index = 0; index <= width; index += 1) previous[index] = index * editCost;
    for (let row = 1; row <= eEnd - eStart; row += 1) {
      current[0] = row * editCost;
      const expectedWord = expected[backwards ? eEnd - row : eStart + row - 1];
      for (let column = 1; column <= width; column += 1) {
        const actualWord = actual[backwards ? aEnd - column : aStart + column - 1];
        current[column] = Math.min(
          previous[column - 1] + (expectedWord === actualWord ? -1 : editCost),
          previous[column] + editCost,
          current[column - 1] + editCost,
        );
      }
      [previous, current] = [current, previous];
    }
    return previous;
  }

  function smallAlignment(expected, actual, eStart, eEnd, aStart, aEnd, editCost, output) {
    const height = eEnd - eStart;
    const width = aEnd - aStart;
    const scores = Array.from({ length: height + 1 }, () => new Float64Array(width + 1));
    for (let row = height; row >= 0; row -= 1) scores[row][width] = (height - row) * editCost;
    for (let column = width; column >= 0; column -= 1) scores[height][column] = (width - column) * editCost;
    for (let row = height - 1; row >= 0; row -= 1) {
      for (let column = width - 1; column >= 0; column -= 1) {
        scores[row][column] = Math.min(
          scores[row + 1][column + 1] + (expected[eStart + row] === actual[aStart + column] ? -1 : editCost),
          scores[row + 1][column] + editCost,
          scores[row][column + 1] + editCost,
        );
      }
    }
    let row = 0;
    let column = 0;
    while (row < height || column < width) {
      if (row < height && column < width) {
        const matches = expected[eStart + row] === actual[aStart + column];
        if (scores[row][column] === scores[row + 1][column + 1] + (matches ? -1 : editCost)) {
          output.push({ state: matches ? 'correct' : 'incorrect', expectedIndex: eStart + row, actualIndex: aStart + column });
          row += 1;
          column += 1;
          continue;
        }
      }
      if (row < height && scores[row][column] === scores[row + 1][column] + editCost) {
        output.push({ state: 'missing', expectedIndex: eStart + row, actualIndex: -1 });
        row += 1;
      } else {
        output.push({ state: 'extra', expectedIndex: -1, actualIndex: aStart + column });
        column += 1;
      }
    }
  }

  function alignWords(expected, actual) {
    const output = [];
    const editCost = Math.min(expected.length, actual.length) + 1;

    function align(eStart, eEnd, aStart, aEnd) {
      while (eStart < eEnd && aStart < aEnd && expected[eStart] === actual[aStart]) {
        output.push({ state: 'correct', expectedIndex: eStart, actualIndex: aStart });
        eStart += 1;
        aStart += 1;
      }
      let suffixLength = 0;
      while (eStart < eEnd && aStart < aEnd && expected[eEnd - 1] === actual[aEnd - 1]) {
        suffixLength += 1;
        eEnd -= 1;
        aEnd -= 1;
      }

      if (eStart === eEnd) {
        for (let index = aStart; index < aEnd; index += 1) output.push({ state: 'extra', expectedIndex: -1, actualIndex: index });
      } else if (aStart === aEnd) {
        for (let index = eStart; index < eEnd; index += 1) output.push({ state: 'missing', expectedIndex: index, actualIndex: -1 });
      } else if ((eEnd - eStart) * (aEnd - aStart) <= 4096 || eEnd - eStart === 1 || aEnd - aStart === 1) {
        smallAlignment(expected, actual, eStart, eEnd, aStart, aEnd, editCost, output);
      } else {
        const midpoint = eStart + Math.floor((eEnd - eStart) / 2);
        const left = alignmentScores(expected, actual, eStart, midpoint, aStart, aEnd, false, editCost);
        const right = alignmentScores(expected, actual, midpoint, eEnd, aStart, aEnd, true, editCost);
        const width = aEnd - aStart;
        let split = 0;
        let bestScore = Infinity;
        for (let index = 0; index <= width; index += 1) {
          const score = left[index] + right[width - index];
          if (score < bestScore) {
            bestScore = score;
            split = index;
          }
        }
        align(eStart, midpoint, aStart, aStart + split);
        align(midpoint, eEnd, aStart + split, aEnd);
      }
      for (let offset = 0; offset < suffixLength; offset += 1) {
        output.push({ state: 'correct', expectedIndex: eEnd + offset, actualIndex: aEnd + offset });
      }
    }

    align(0, expected.length, 0, actual.length);
    return output;
  }

  function compareWords(expected, actual) {
    const expectedWords = String(expected ?? '').match(/\S+/g) ?? [];
    const actualPieces = String(actual ?? '').match(/\s+|\S+/g) ?? [];
    const actualWords = [];
    const actualWordStarts = [];
    let actualOffset = 0;
    let actualWordEnd = 0;
    for (const piece of actualPieces) {
      if (!/^\s+$/.test(piece)) {
        actualWords.push(piece);
        actualWordStarts.push(actualOffset);
        actualWordEnd = actualOffset + piece.length;
      }
      actualOffset += piece.length;
    }
    const alignment = alignWords(expectedWords, actualWords);
    const wordStates = [];
    const missing = [];
    let correct = 0;
    let errorCount = 0;
    let nextActualIndex = 0;

    for (const item of alignment) {
      if (item.state === 'missing') {
        // Keep the boundary in the original UTF-16 input so a renderer can
        // place omissions inline without changing the draft or its whitespace.
        // Consecutive omissions share a boundary and retain alignment order.
        missing.push({
          text: expectedWords[item.expectedIndex],
          expectedIndex: item.expectedIndex,
          actualOffset: actualWordStarts[nextActualIndex] ?? actualWordEnd,
        });
      } else {
        wordStates[item.actualIndex] = {
          state: item.state,
          expected: item.expectedIndex < 0 ? null : expectedWords[item.expectedIndex],
          actualIndex: item.actualIndex,
        };
        nextActualIndex = item.actualIndex + 1;
      }
      if (item.state === 'correct') correct += 1;
      else errorCount += 1;
    }

    let actualIndex = 0;
    const tokens = actualPieces.map(text => {
      if (/^\s+$/.test(text)) return { text, state: 'correct', expected: text, actualIndex: -1 };
      return { text, ...wordStates[actualIndex++] };
    });
    return { tokens, missing, correct, errorCount, completed: expectedWords.length > 0 && errorCount === 0 };
  }

  return { splitSentences, sentenceRanges, groupSentences, compareWords };
});
