(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.TypingCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeSource(text) {
    return String(text ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, ' ')
      .trim();
  }

  function normalizeInput(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n');
  }

  function compare(source, input) {
    const expectedCharacters = Array.from(String(source ?? ''));
    const actualCharacters = Array.from(String(input ?? ''));
    const characters = [];
    let correct = 0;
    let errorCount = 0;
    let firstError = null;

    for (let index = 0; index < Math.max(expectedCharacters.length, actualCharacters.length); index += 1) {
      const expected = expectedCharacters[index] ?? null;
      const actual = actualCharacters[index] ?? null;
      let state;

      if (expected === null) {
        state = 'extra';
      } else if (actual === null) {
        state = 'pending';
      } else if (expected === actual) {
        state = 'correct';
        correct += 1;
      } else {
        state = 'incorrect';
      }

      if (state === 'incorrect' || state === 'extra') {
        errorCount += 1;
        if (firstError === null) firstError = index;
      }

      characters.push({ index, expected, actual, state });
    }

    const total = expectedCharacters.length;
    const typed = actualCharacters.length;
    return {
      characters,
      total,
      typed,
      correct,
      errorCount,
      firstError,
      completed: total > 0 && typed === total && correct === total,
    };
  }

  function formatDuration(ms) {
    const numericMilliseconds = Number(ms);
    const totalSeconds = Number.isFinite(numericMilliseconds)
      ? Math.floor(Math.max(0, numericMilliseconds) / 1000)
      : 0;
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = String(totalMinutes % 60).padStart(2, '0');
    const hours = Math.floor(totalMinutes / 60);
    return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
  }

  function defaultNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  class PracticeClock {
    constructor(now = defaultNow) {
      if (typeof now !== 'function') throw new TypeError('now must be a function');
      this._now = now;
      this.reset();
    }

    start() {
      if (this.state !== 'running') {
        this._startedAt = this._now();
        this.state = 'running';
      }
      return this;
    }

    stop() {
      if (this.state === 'running') {
        this._elapsedMilliseconds = this.elapsed();
        this.state = 'stopped';
      }
      return this;
    }

    pause() {
      return this.stop();
    }

    reset() {
      this.state = 'idle';
      this._startedAt = null;
      this._elapsedMilliseconds = 0;
      return this;
    }

    elapsed() {
      return this.state === 'running'
        ? this._elapsedMilliseconds + Math.max(0, this._now() - this._startedAt)
        : this._elapsedMilliseconds;
    }
  }

  return { normalizeSource, normalizeInput, compare, formatDuration, PracticeClock };
});
