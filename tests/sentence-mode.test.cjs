'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextDecoder } = require('node:util');

// This harness runs the actual browser controllers and comparison modules.
// Layout and trusted mouse defaults still require browser validation. Native
// ranges below exercise the real controllers' selection and context mapping.
function createPage({ source = 'First sentence. Second sentence! Third sentence?', integrated = false, fetch, protocol = 'http:', onLearningReset } = {}) {
  const roots = new Map();
  const intervals = [];
  const frames = new Map();
  let now = 0;
  let nextFrame = 0;
  let document;
  let nativeSelection = null;

  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(callback);
    }
    removeEventListener(name, callback) {
      this.listeners.set(name, (this.listeners.get(name) || []).filter(listener => listener !== callback));
    }
    emit(name, properties = {}) {
      const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...properties };
      return Promise.all((this.listeners.get(name) || []).map(callback => callback(event)));
    }
  }

  class Element extends Target {
    constructor(tagName = 'div', id = '') {
      super();
      this.tagName = tagName.toUpperCase();
      this.nodeType = 1;
      this.id = id;
      this.value = '';
      this._textContent = '';
      this.className = '';
      this.children = [];
      this.parentElement = null;
      this.listeners = new Map();
      this.attributes = new Map();
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.open = false;
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.selectionDirection = 'none';
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: (...names) => names.forEach(name => this.classList.toggle(name, true)),
        remove: (...names) => names.forEach(name => this.classList.toggle(name, false)),
        toggle: (name, force) => {
          const classes = new Set(this.className.split(/\s+/).filter(Boolean));
          const add = force === undefined ? !classes.has(name) : force;
          if (add) classes.add(name); else classes.delete(name);
          this.className = [...classes].join(' ');
          return add;
        },
      };
    }
    get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._textContent = String(value); }
    get childNodes() {
      if (!this._textContent) return this.children;
      if (!this._textNode || this._textNode.textContent !== this._textContent) {
        this._textNode = { nodeType: 3, textContent: this._textContent, parentElement: this, parentNode: this };
      }
      return [this._textNode, ...this.children];
    }
    get firstChild() { return this.childNodes[0] || null; }
    get parentNode() { return this.parentElement; }
    get lastChild() { return this.children.at(-1) || { textContent: '' }; }
    get nextSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      return siblings[siblings.indexOf(this) + 1] || null;
    }
    emit(name, properties = {}) {
      const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...properties };
      const results = [];
      for (let node = this; node; node = node.parentElement) {
        results.push(...(node.listeners.get(name) || []).map(callback => callback(event)));
      }
      results.push(...(document.listeners.get(name) || []).map(callback => callback(event)));
      return Promise.all(results);
    }
    append(...children) { children.forEach(child => this.insertBefore(child, null)); }
    insertBefore(child, next) {
      child.remove();
      const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index, 0, child);
      child.parentElement = this;
    }
    remove() {
      if (!this.parentElement) return;
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
    replaceChildren(...children) {
      this.children.forEach(child => { child.parentElement = null; });
      this.children = [];
      this._textContent = '';
      this._textNode = null;
      this.append(...children);
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    contains(node) { return node === this || this.childNodes.some(child => child === node || child.contains?.(node)); }
    getBoundingClientRect() { return { top: 150, bottom: 175, left: 0, right: 600, width: 600, height: 25 }; }
  }

  function descendants(node) {
    return [node, ...node.children.flatMap(descendants)];
  }
  document = new Target();
  Object.assign(document, {
    activeElement: null,
    documentElement: { clientWidth: 900, clientHeight: 900 },
    getElementById(id) {
      for (const root of roots.values()) {
        const found = descendants(root).find(node => node.id === id);
        if (found) return found;
      }
      const element = new Element('div', id);
      roots.set(id, element);
      return element;
    },
    createElement: tag => new Element(tag),
  });
  function offsetWithin(root, node, offset) {
    if (root === node) return node.nodeType === 3 ? offset
      : root.childNodes.slice(0, offset).map(child => child.textContent).join('').length;
    let preceding = 0;
    for (const child of root.childNodes || []) {
      const nested = offsetWithin(child, node, offset);
      if (nested !== null) return preceding + nested;
      preceding += child.textContent.length;
    }
    return null;
  }
  document.createRange = () => {
    let root, node, offset;
    return { selectNodeContents(value) { root = value; }, setEnd(value, position) { node = value; offset = position; },
      toString() {
        const length = offsetWithin(root, node, offset);
        if (length === null) throw new Error('Range endpoint missing');
        return root.textContent.slice(0, length);
      } };
  };
  const context = vm.createContext({
    document,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch,
    location: { protocol },
    performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setInterval(callback) { intervals.push(callback); return intervals.length; },
  });
  context.window = context;
  context.innerHeight = 900;
  context.innerWidth = 900;
  context.addEventListener = () => {};
  context.getSelection = () => nativeSelection;
  context.scrollBy = () => {};
  const $ = id => document.getElementById(id);
  $('showTimer').checked = true;
  if (integrated) {
    $('selectionTranslationPopup').append(...[
      'selectionTranslationSource', 'selectionTranslationText', 'selectionAnalysisType',
      'selectionAnalysisBrief', 'selectionAnalysisDetails', 'selectionAnalysisExpand',
      'selectionTranslationStatus', 'selectionTranslationRetry', 'selectionTranslationClose',
    ].map($));
  }
  const scripts = ['typing-core.js', 'sentence-core.js', 'sentence-mode.js'];
  if (integrated) scripts.push('reference-selection.js', 'selection-translation.js', 'app.js');
  scripts.forEach(name => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context, { filename: name }));
  const controller = integrated ? null : context.SentencePractice.create({ source, title: 'My essay', kind: '我的范文', onLearningReset });
  const groups = () => $('sentenceGroups').children;
  const find = (node, className) => descendants(node).filter(child => child.classList.contains(className));
  const group = index => {
    const card = groups()[index];
    const one = className => find(card, className)[0];
    return {
      card,
      reference: one('sentence-reference'),
      placeholder: one('reference-placeholder'),
      toggle: one('reference-toggle'),
      translationToggle: one('translation-toggle'),
      translation: one('sentence-translation'),
      translationContent: one('translation-content'),
      translationStatus: one('translation-status'),
      translationRetry: one('translation-retry'),
      translationLink: one('translation-service-link'),
      answer: one('sentence-answer'),
      checked: one('checked-answer'),
      feedback: one('group-feedback'),
      missing: one('missing-words'),
      state: one('group-state'),
      edit: one('group-edit'),
      // Existing strict-comparison coverage continues to exercise the local option.
      check: one('group-word-check'),
      review: one('group-check'),
      reviewPanel: one('sentence-review'),
      reviewLink: one('review-service-link'),
    };
  };
  return {
    $, controller, groups, group, find, document,
    fire: (id, name, properties) => $(id).emit(name, properties),
    click: node => node.emit('click'),
    doubleClick: node => node.emit('dblclick'),
    async select(node, start = 0, end = node.textContent.length) {
      function endpoint(position) {
        const leaves = [];
        function visit(current) {
          if (current.nodeType === 3) leaves.push(current);
          else (current.childNodes || []).forEach(visit);
        }
        visit(node);
        let units = 0;
        for (const leaf of leaves) {
          if (position <= units + leaf.textContent.length) return { node: leaf, offset: position - units };
          units += leaf.textContent.length;
        }
        return { node, offset: node.childNodes.length };
      }
      const from = endpoint(start), to = endpoint(end);
      const range = {
        startContainer: from.node, startOffset: from.offset, endContainer: to.node, endOffset: to.offset,
        getBoundingClientRect: () => node.getBoundingClientRect(),
      };
      range.cloneRange = () => range;
      range.getClientRects = () => [range.getBoundingClientRect()];
      nativeSelection = { isCollapsed: start === end, rangeCount: 1, anchorNode: from.node, focusNode: to.node,
        toString: () => node.textContent.slice(start, end), getRangeAt: () => range,
        removeAllRanges() { nativeSelection = null; } };
      document.activeElement = node;
      await document.emit('selectionchange');
    },
    async selectAcross(first, second) {
      const range = { startContainer: first.firstChild, startOffset: 0,
        endContainer: second.firstChild, endOffset: second.textContent.length,
        getBoundingClientRect: () => first.getBoundingClientRect() };
      range.cloneRange = () => range;
      nativeSelection = { isCollapsed: false, rangeCount: 1, anchorNode: first.firstChild, focusNode: second.firstChild,
        toString: () => first.textContent + '\n' + second.textContent, getRangeAt: () => range };
      await document.emit('selectionchange');
    },
    async type(index, text) { const answer = group(index).answer; answer.value = text; await answer.emit('input'); },
    async realType(text) {
      $('typingInput').value = text;
      $('typingInput').setSelectionRange(text.length, text.length);
      await $('typingInput').emit('input');
    },
    async size(value) { $('sentencesPerGroup').value = String(value); await $('applyGrouping').emit('click'); },
    async import(text) {
      await $('importButton').emit('click');
      $('sourceEditor').value = text;
      await $('sourceEditor').emit('input');
      await $('importForm').emit('submit');
    },
    tick(milliseconds) {
      now += milliseconds;
      intervals.forEach(callback => callback());
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback());
      controller?.refreshTimer();
    },
  };
}

test('each group starts with a visible reference and a visible blank input', () => {
  const page = createPage();
  assert.equal(page.groups().length, 3);
  page.groups().forEach((card, index) => {
    const group = page.group(index);
    assert.equal(group.reference.hidden, false);
    assert.equal(group.placeholder.hidden, true);
    assert.equal(group.toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(group.answer.hidden, false);
    assert.equal(group.answer.value, '');
    assert.equal(group.checked.hidden, true);
    assert.equal(group.edit.hidden, true);
    assert.equal(group.missing.hidden, true);
    assert.equal(page.find(card, 'word-error').length, 0);
    assert.match(group.answer.getAttribute('aria-label'), new RegExp(String(index + 1)));
  });
  assert.match(page.$('sentenceSessionStatus').textContent, /准备开始/);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  assert.equal(page.$('sentenceTimerState').textContent, '未开始');
  assert.equal(page.$('sentenceTimerStart').disabled, false);
  assert.equal(page.$('sentenceTimerPause').disabled, true);
});

test('individual and global reference controls reveal and hide independently', async () => {
  const page = createPage();
  await page.fire('hideAllReferences', 'click');
  await page.click(page.group(1).toggle);
  assert.equal(page.group(0).reference.hidden, true);
  assert.equal(page.group(1).reference.hidden, false);
  assert.equal(page.group(1).placeholder.hidden, true);
  assert.equal(page.group(1).toggle.getAttribute('aria-expanded'), 'true');
  await page.click(page.group(1).toggle);
  assert.equal(page.group(1).reference.hidden, true);
  await page.fire('showAllReferences', 'click');
  page.groups().forEach((card, index) => assert.equal(page.group(index).reference.hidden, false));
  await page.fire('hideAllReferences', 'click');
  page.groups().forEach((card, index) => assert.equal(page.group(index).reference.hidden, true));
});

test('any positive safe integer groups in order, including a short final group', async () => {
  const source = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.';
  for (const size of [1, 2, 3, 5, 7, 100, Number.MAX_SAFE_INTEGER]) {
    const page = createPage({ source });
    await page.size(size);
    assert.equal(page.groups().length, Math.ceil(5 / size));
    assert.equal(page.groups().map((card, index) => page.group(index).reference.textContent).join(' '), source);
    assert.equal(page.$('groupingError').hidden, true);
    assert.equal(page.$('sentencesPerGroup').getAttribute('aria-invalid'), null);
    if (size === 2) assert.equal(page.group(2).reference.textContent, 'Fifth sentence.');
  }
});

test('invalid group sizes retain existing groups, drafts and checked results', async () => {
  for (const value of ['', '0', '-2', '1.5', 'abc', 'NaN', 'Infinity', '9007199254740992']) {
    const page = createPage();
    await page.type(0, 'First wrong.');
    await page.click(page.group(0).check);
    const original = page.group(0);
    await page.size(value);
    assert.equal(page.group(0).card, original.card, value);
    assert.equal(page.group(0).answer.value, 'First wrong.', value);
    assert.equal(page.group(0).checked.hidden, false, value);
    assert.equal(page.$('groupingError').hidden, false, value);
    assert.equal(page.$('sentencesPerGroup').getAttribute('aria-invalid'), 'true', value);
  }
});

test('applying the current size preserves drafts, results and reference visibility', async () => {
  const page = createPage();
  await page.fire('sentenceTimerStart', 'click');
  await page.type(0, 'First wrong.');
  await page.click(page.group(0).check);
  const card = page.group(0).card;
  page.tick(2300);
  await page.size(1);
  assert.equal(page.group(0).card, card);
  assert.equal(page.group(0).answer.value, 'First wrong.');
  assert.equal(page.group(0).checked.hidden, false);
  assert.equal(page.group(0).reference.hidden, false);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:02');
});

test('typing does not mark errors; checking reveals the source and marks only wrong words', async () => {
  const page = createPage({ source: 'We learn English every day.' });
  await page.click(page.group(0).toggle);
  await page.type(0, 'We learn French every day.');
  const group = page.group(0);
  assert.equal(group.reference.hidden, true);
  assert.equal(group.checked.hidden, true);
  assert.equal(page.find(group.card, 'word-error').length, 0);
  assert.equal(group.feedback.classList.contains('has-errors'), false);
  await page.click(group.check);
  assert.equal(group.reference.hidden, false);
  assert.equal(group.answer.hidden, true);
  assert.equal(group.checked.hidden, false);
  assert.equal(group.checked.textContent, 'We learn French every day.');
  const errors = page.find(group.checked, 'word-error');
  assert.deepEqual(errors.map(node => node.textContent), ['French']);
  assert.equal(errors[0].title, '应为：English');
  assert.equal(group.feedback.classList.contains('has-errors'), true);
});

test('case and punctuation mismatches are visible at word level after checking', async () => {
  const page = createPage({ source: 'English matters.' });
  await page.type(0, 'english matters!');
  await page.click(page.group(0).check);
  assert.deepEqual(page.find(page.group(0).checked, 'word-error').map(node => node.textContent), ['english', 'matters!']);
  assert.equal(page.group(0).card.classList.contains('is-correct'), false);
});

test('missing words are listed without making later correct words red', async () => {
  const page = createPage({ source: 'We learn English every day.' });
  await page.type(0, 'We English every day.');
  await page.click(page.group(0).check);
  const group = page.group(0);
  assert.equal(group.missing.hidden, false);
  assert.deepEqual(page.find(group.missing, 'missing-word').map(node => node.textContent), ['learn']);
  assert.equal(page.find(group.checked, 'word-error').length, 0);
  assert.equal(page.find(group.checked, 'word-extra').length, 0);
  assert.match(group.feedback.textContent, /漏词 1/);
});

test('extra words are red without making later correct words red', async () => {
  const page = createPage({ source: 'We learn English every day.' });
  await page.type(0, 'We really learn English every day.');
  await page.click(page.group(0).check);
  const group = page.group(0);
  assert.deepEqual(page.find(group.checked, 'word-extra').map(node => node.textContent), ['really']);
  assert.equal(page.find(group.checked, 'word-error').length, 0);
  assert.equal(group.missing.hidden, true);
  assert.match(group.feedback.textContent, /多词 1/);
});

test('checking an empty answer shows an explicit prompt and all omitted words', async () => {
  const page = createPage({ source: 'Keep learning.' });
  await page.click(page.group(0).check);
  const group = page.group(0);
  assert.match(group.checked.textContent, /尚未输入/);
  assert.deepEqual(page.find(group.missing, 'missing-word').map(node => node.textContent), ['Keep', 'learning.']);
  assert.equal(group.reference.hidden, false);
  assert.match(page.$('sentenceProgress').textContent, /0 \/ 1/);
  page.tick(5000);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
});

test('editing keeps the draft, removes stale visible feedback and supports rechecking', async () => {
  const page = createPage({ source: 'We learn English every day.' });
  await page.type(0, 'We English every night.');
  await page.click(page.group(0).check);
  const group = page.group(0);
  await page.click(group.edit);
  assert.equal(group.answer.hidden, false);
  assert.equal(group.answer.value, 'We English every night.');
  assert.equal(group.checked.hidden, true);
  assert.equal(group.missing.hidden, true);
  assert.equal(group.feedback.classList.contains('has-errors'), false);
  assert.equal(group.card.classList.contains('is-checked'), false);
  assert.equal(group.edit.hidden, true);
  await page.type(0, 'We learn English every day.');
  await page.click(group.check);
  assert.equal(group.card.classList.contains('is-correct'), true);
  assert.equal(page.find(group.checked, 'word-error').length, 0);
  assert.equal(group.missing.hidden, true);
});

test('checking and editing one group leaves other groups unchanged', async () => {
  const page = createPage();
  await page.click(page.group(1).toggle);
  await page.type(0, 'First sentence.');
  await page.type(1, 'Second typo!');
  await page.click(page.group(0).check);
  assert.equal(page.group(1).answer.value, 'Second typo!');
  assert.equal(page.group(1).checked.hidden, true);
  assert.equal(page.group(1).reference.hidden, true);
  await page.click(page.group(1).check);
  await page.click(page.group(0).edit);
  assert.equal(page.group(1).checked.hidden, false);
  assert.equal(page.group(1).feedback.classList.contains('has-errors'), true);
  assert.equal(page.group(1).reference.hidden, false);
  assert.equal(page.group(2).answer.value, '');
});

test('changing the group size starts a fresh sentence session', async () => {
  const page = createPage();
  await page.fire('sentenceTimerStart', 'click');
  await page.type(0, 'First sentence.');
  await page.click(page.group(0).check);
  page.tick(3000);
  await page.size(2);
  assert.equal(page.groups().length, 2);
  assert.equal(page.group(0).answer.value, '');
  assert.equal(page.group(0).checked.hidden, true);
  assert.equal(page.group(0).reference.hidden, false);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  assert.equal(page.$('sentenceTimerState').textContent, '未开始');
});

test('setting a new source resets drafts and timer while retaining the chosen group size', async () => {
  const page = createPage();
  await page.size(2);
  await page.fire('sentenceTimerStart', 'click');
  await page.type(0, 'Old draft');
  page.tick(3200);
  page.controller.setSource('A new idea. Another idea. The last idea.', 'New title', '导入范文');
  assert.equal(page.groups().length, 2);
  assert.equal(page.group(0).reference.textContent, 'A new idea. Another idea.');
  assert.equal(page.group(0).answer.value, '');
  assert.equal(page.$('sentenceArticleTitle').textContent, 'New title');
  assert.match(page.$('sentenceArticleKind').textContent, /导入范文/);
  assert.equal(page.$('sentencesPerGroup').value, '2');
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  assert.equal(page.$('sentenceTimerState').textContent, '未开始');
});

test('sentence stopwatch starts only on command and continues while its display is hidden', async () => {
  const page = createPage();
  page.tick(5000);
  await page.fire('showAllReferences', 'click');
  page.tick(2000);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  await page.type(0, 'First');
  await page.click(page.group(0).check);
  page.tick(2200);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  await page.fire('sentenceTimerStart', 'click');
  assert.equal(page.$('sentenceTimerState').textContent, '计时中');
  assert.equal(page.$('sentenceTimerStart').disabled, true);
  assert.equal(page.$('sentenceTimerPause').disabled, false);
  page.tick(2200);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:02');
  page.controller.setTimerVisible(false);
  assert.equal(page.$('sentenceTimerDisplay').hidden, true);
  page.tick(3400);
  page.controller.setTimerVisible(true);
  assert.equal(page.$('sentenceTimerDisplay').hidden, false);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:05');
});

test('pause and continue preserve elapsed time and typing or checking never resumes it', async () => {
  const page = createPage();
  await page.fire('sentenceTimerStart', 'click');
  page.tick(2200);
  await page.fire('sentenceTimerPause', 'click');
  assert.equal(page.$('sentenceTimerState').textContent, '已暂停');
  assert.equal(page.$('sentenceTimerStart').textContent, '继续');
  assert.equal(page.$('sentenceTimerStart').disabled, false);
  assert.equal(page.$('sentenceTimerPause').disabled, true);
  assert.match(page.$('sentenceTimerDisplay').getAttribute('aria-label'), /已暂停/);
  await page.type(0, 'First typo.');
  await page.click(page.group(0).check);
  await page.click(page.group(0).edit);
  page.tick(10000);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:02');
  assert.equal(page.$('sentenceTimerState').textContent, '已暂停');
  await page.fire('sentenceTimerStart', 'click');
  page.tick(1900);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:04');
  await page.fire('sentenceTimerPause', 'click');
  page.tick(10000);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:04');
});

test('completion and later edits leave the stopwatch entirely under manual control', async () => {
  const page = createPage({ source: 'First sentence. Second sentence.' });
  await page.fire('sentenceTimerStart', 'click');
  await page.type(0, 'First sentence.');
  page.tick(1200);
  await page.click(page.group(0).check);
  page.tick(2000);
  await page.type(1, 'Second sentence.');
  await page.click(page.group(1).check);
  assert.match(page.$('sentenceSessionStatus').textContent, /已完成/);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:03');
  page.tick(7000);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:10');
  assert.equal(page.$('sentenceTimerState').textContent, '计时中');
  await page.fire('sentenceTimerPause', 'click');
  await page.click(page.group(0).edit);
  assert.doesNotMatch(page.$('sentenceSessionStatus').textContent, /已完成/);
  await page.type(0, 'First wrong.');
  page.tick(2200);
  await page.click(page.group(0).check);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:10');
  assert.equal(page.group(0).card.classList.contains('is-correct'), false);
  await page.click(page.group(0).edit);
  await page.type(0, 'First sentence.');
  await page.click(page.group(0).check);
  assert.match(page.$('sentenceSessionStatus').textContent, /已完成/);
  page.tick(7000);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:10');
  await page.fire('sentenceTimerStart', 'click');
  page.tick(2000);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:12');
});

test('clearing the stopwatch keeps drafts, checked errors, references and translations intact', async () => {
  let calls = 0;
  const page = createPage({ fetch: async () => { calls++; return translated('第一句话。'); } });
  await page.fire('sentenceTimerStart', 'click');
  await page.type(0, 'First typo.');
  await page.click(page.group(0).check);
  await page.click(page.group(0).translationToggle);
  page.tick(2300);
  const group = page.group(0);
  const feedback = group.feedback.textContent;
  await page.fire('sentenceTimerClear', 'click');
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  assert.equal(page.$('sentenceTimerState').textContent, '未开始');
  assert.equal(page.$('sentenceTimerStart').textContent, '开始');
  assert.equal(page.$('sentenceTimerPause').disabled, true);
  assert.equal(group.answer.value, 'First typo.');
  assert.equal(group.checked.hidden, false);
  assert.equal(group.reference.hidden, false);
  assert.equal(group.feedback.textContent, feedback);
  assert.equal(page.find(group.checked, 'word-error').length, 1);
  assert.equal(group.translation.hidden, false);
  assert.equal(group.translationContent.textContent, '第一句话。');
  assert.equal(calls, 1);
  page.tick(4000);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  await page.fire('sentenceTimerStart', 'click');
  page.tick(1200);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:01');
});

test('reset clears results and timer while preserving source, group size and timer visibility', async () => {
  const page = createPage();
  await page.size(2);
  await page.fire('sentenceTimerStart', 'click');
  await page.type(0, 'Wrong');
  await page.click(page.group(0).check);
  page.controller.setTimerVisible(false);
  page.tick(2300);
  const reference = page.group(0).reference.textContent;
  page.controller.reset(true);
  assert.equal(page.group(0).reference.textContent, reference);
  assert.equal(page.group(0).reference.hidden, false);
  assert.equal(page.group(0).answer.value, '');
  assert.equal(page.group(0).checked.hidden, true);
  assert.equal(page.$('sentencesPerGroup').value, '2');
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  assert.equal(page.$('sentenceTimerDisplay').hidden, true);
});

test('the real app starts in realtime mode and retains both drafts through mode switches', async () => {
  const page = createPage({ integrated: true });
  assert.equal(page.$('realtimePanel').hidden, false);
  assert.equal(page.$('sentencePanel').hidden, true);
  assert.equal(page.$('realtimeModeButton').getAttribute('aria-pressed'), 'true');
  await page.realType('Learning');
  await page.fire('sentenceModeButton', 'click');
  assert.equal(page.$('realtimePanel').hidden, true);
  assert.equal(page.$('sentencePanel').hidden, false);
  assert.equal(page.$('sentenceModeButton').getAttribute('aria-pressed'), 'true');
  await page.type(0, 'My sentence draft');
  await page.click(page.group(0).check);
  await page.fire('realtimeModeButton', 'click');
  assert.equal(page.$('typingInput').value, 'Learning');
  await page.fire('sentenceModeButton', 'click');
  assert.equal(page.group(0).answer.value, 'My sentence draft');
  assert.equal(page.group(0).checked.hidden, false);
});

test('import updates and resets both modes while keeping the selected mode', async () => {
  const page = createPage({ integrated: true });
  await page.fire('timerStart', 'click');
  await page.realType('Learning');
  await page.fire('sentenceModeButton', 'click');
  await page.fire('sentenceTimerStart', 'click');
  await page.type(0, 'Previous draft');
  page.tick(2200);
  await page.import('New first sentence. New second sentence.');
  assert.equal(page.$('sentencePanel').hidden, false);
  assert.equal(page.$('sentenceModeButton').getAttribute('aria-pressed'), 'true');
  assert.equal(page.groups().length, 2);
  assert.equal(page.group(0).reference.textContent, 'New first sentence.');
  assert.equal(page.group(0).answer.value, '');
  assert.equal(page.$('sourceReadable').textContent, 'New first sentence. New second sentence.');
  assert.equal(page.$('typingInput').value, '');
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  assert.equal(page.$('sentenceTimerState').textContent, '未开始');
});

test('restarting sentence mode preserves the realtime draft and its elapsed time', async () => {
  const page = createPage({ integrated: true });
  await page.fire('timerStart', 'click');
  await page.realType('Learning');
  page.tick(2500);
  await page.fire('sentenceModeButton', 'click');
  await page.fire('sentenceTimerStart', 'click');
  await page.type(0, 'My sentence');
  page.tick(1500);
  await page.fire('restartButton', 'click');
  assert.equal(page.group(0).answer.value, '');
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  assert.equal(page.$('typingInput').value, 'Learning');
  assert.equal(page.$('timerValue').textContent, '00:04');
});

test('restarting realtime mode preserves sentence drafts, results and elapsed time', async () => {
  const page = createPage({ integrated: true });
  await page.fire('sentenceModeButton', 'click');
  await page.fire('sentenceTimerStart', 'click');
  await page.type(0, 'My sentence');
  await page.click(page.group(0).check);
  page.tick(2200);
  await page.fire('realtimeModeButton', 'click');
  await page.realType('Learning');
  page.tick(1300);
  await page.fire('restartButton', 'click');
  assert.equal(page.$('typingInput').value, '');
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(page.group(0).answer.value, 'My sentence');
  assert.equal(page.group(0).checked.hidden, false);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:03');
});

test('the shared timer switch controls both mode displays without resetting clocks', async () => {
  const page = createPage({ integrated: true });
  await page.fire('timerStart', 'click');
  await page.fire('sentenceTimerStart', 'click');
  await page.realType('Learning');
  await page.type(0, 'My sentence');
  page.tick(2200);
  page.$('showTimer').checked = false;
  await page.fire('showTimer', 'change');
  assert.equal(page.$('timerDisplay').hidden, true);
  assert.equal(page.$('sentenceTimerDisplay').hidden, true);
  page.tick(3300);
  page.$('showTimer').checked = true;
  await page.fire('showTimer', 'change');
  assert.equal(page.$('timerDisplay').hidden, false);
  assert.equal(page.$('sentenceTimerDisplay').hidden, false);
  assert.equal(page.$('timerValue').textContent, '00:05');
  assert.equal(page.$('sentenceTimerValue').textContent, '00:05');
});

function translated(text = '第一句话。') {
  return { ok: true, status: 200, json: async () => ({ translation: text, cached: false, model: 'deepseek-flash' }) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('Chinese translation is requested only on click, sending the source and safely rendering text', async () => {
  const requests = [];
  const page = createPage({ fetch: async (url, options) => { requests.push({ url, options }); return translated('<b>中文参考</b>'); } });
  await page.type(0, 'My private answer');
  assert.equal(requests.length, 0);
  const group = page.group(0);
  assert.equal(group.translation.hidden, true);
  await page.click(group.translationToggle);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/translate');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].options.body), { text: 'First sentence.' });
  assert.equal(group.translation.hidden, false);
  assert.equal(group.translationContent.textContent, '<b>中文参考</b>');
  assert.equal(group.translationContent.children.length, 0);
  assert.equal(group.translationToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(group.reference.hidden, false);
  assert.equal(group.answer.value, 'My private answer');
  assert.equal(group.checked.hidden, true);
  assert.equal(page.find(group.card, 'translation-note').length, 0);
  assert.equal(group.translationStatus.textContent, '');
});

test('Chinese visibility is independent of English and cached toggles do not affect practice or clocks', async () => {
  let calls = 0;
  const page = createPage({ fetch: async () => { calls++; return translated(); } });
  const group = page.group(0);
  await page.click(group.toggle);
  await page.click(group.translationToggle);
  page.tick(4000);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:00');
  await page.click(group.toggle);
  await page.click(group.translationToggle);
  assert.equal(group.reference.hidden, false);
  assert.equal(group.translation.hidden, true);
  await page.fire('sentenceTimerStart', 'click');
  await page.type(0, 'First sentence.');
  page.tick(2300);
  await page.click(group.check);
  await page.fire('hideAllReferences', 'click');
  await page.click(group.translationToggle);
  assert.equal(group.reference.hidden, true);
  assert.equal(group.translation.hidden, false);
  assert.equal(group.checked.hidden, false);
  assert.equal(group.answer.value, 'First sentence.');
  assert.equal(page.$('sentenceTimerValue').textContent, '00:02');
  assert.equal(calls, 1);
});

test('a pending translation can be hidden and shown without duplicate requests', async () => {
  const pending = deferred();
  let calls = 0;
  const page = createPage({ fetch: () => { calls++; return pending.promise; } });
  const group = page.group(0);
  const work = page.click(group.translationToggle);
  assert.match(group.translationStatus.textContent, /正在翻译/);
  assert.equal(group.translation.getAttribute('aria-busy'), 'true');
  await page.click(group.translationToggle);
  assert.equal(group.translation.hidden, true);
  await page.click(group.translationToggle);
  assert.equal(calls, 1);
  await page.click(group.translationToggle);
  pending.resolve(translated());
  await work;
  assert.equal(group.translation.hidden, true);
  assert.equal(group.translation.getAttribute('aria-busy'), 'false');
  await page.click(group.translationToggle);
  assert.equal(group.translationContent.textContent, '第一句话。');
  assert.equal(calls, 1);
});

test('identical group text shares pending and completed translations', async () => {
  const pending = deferred();
  let calls = 0;
  const page = createPage({ source: 'Same sentence. Same sentence.', fetch: () => { calls++; return pending.promise; } });
  const first = page.click(page.group(0).translationToggle);
  const second = page.click(page.group(1).translationToggle);
  assert.equal(calls, 1);
  pending.resolve(translated('相同句子。'));
  await Promise.all([first, second]);
  assert.equal(page.group(0).translationContent.textContent, '相同句子。');
  assert.equal(page.group(1).translationContent.textContent, '相同句子。');
  await page.click(page.group(0).translationToggle);
  assert.equal(page.group(1).translation.hidden, false);
  page.controller.reset();
  await page.click(page.group(0).translationToggle);
  assert.equal(calls, 1);
  assert.equal(page.group(0).translationContent.textContent, '相同句子。');
});

test('network errors retain the draft and can be retried successfully', async () => {
  let calls = 0;
  const page = createPage({ fetch: async () => { calls++; if (calls === 1) throw new Error('offline'); return translated(); } });
  await page.type(0, 'Keep my draft');
  const group = page.group(0);
  await page.click(group.translationToggle);
  assert.match(group.translationStatus.textContent, /本地翻译服务已启动/);
  assert.equal(group.translationRetry.hidden, false);
  assert.equal(group.translationStatus.classList.contains('has-errors'), true);
  assert.equal(group.answer.value, 'Keep my draft');
  await page.click(group.translationRetry);
  assert.equal(calls, 2);
  assert.equal(group.translationContent.textContent, '第一句话。');
  assert.equal(group.translationRetry.hidden, true);
  assert.equal(group.translationStatus.classList.contains('has-errors'), false);
});

test('safe server errors and malformed translation responses remain retryable', async () => {
  for (const response of [
    { ok: false, status: 402, json: async () => ({ error: '翻译账户余额不足。' }) },
    { ok: true, status: 200, json: async () => ({ translation: '   ' }) },
    { ok: true, status: 200, json: async () => { throw new Error('bad JSON'); } },
  ]) {
    let calls = 0;
    const page = createPage({ fetch: async () => ++calls === 1 ? response : translated() });
    const group = page.group(0);
    await page.click(group.translationToggle);
    assert.equal(group.translationRetry.hidden, false);
    assert.equal(group.translation.getAttribute('aria-busy'), 'false');
    await page.click(group.translationRetry);
    assert.equal(group.translationContent.textContent, '第一句话。');
    assert.equal(calls, 2);
  }
});

test('regrouping never applies an old response to new text and reuses exact cached text', async () => {
  const pending = deferred();
  let calls = 0;
  const page = createPage({ fetch: () => { calls++; return pending.promise; } });
  const old = page.group(0);
  const work = page.click(old.translationToggle);
  await page.size(2);
  const current = page.group(0);
  pending.resolve(translated('旧组译文。'));
  await work;
  assert.equal(current.translationContent.textContent, '');
  assert.equal(current.translation.hidden, true);
  assert.equal(current.reference.textContent, 'First sentence. Second sentence!');
  await page.size(1);
  await page.click(page.group(0).translationToggle);
  assert.equal(page.group(0).translationContent.textContent, '旧组译文。');
  assert.equal(calls, 1);
});

test('a new source ignores a stale failed request and can request its own translation', async () => {
  const pending = deferred();
  let calls = 0;
  const page = createPage({ fetch: () => ++calls === 1 ? pending.promise : Promise.resolve(translated('新文章。')) });
  const work = page.click(page.group(0).translationToggle);
  page.controller.setSource('New essay.', 'New', '我的范文');
  const current = page.group(0);
  pending.reject(new Error('offline'));
  await work;
  assert.equal(current.translationStatus.textContent, '');
  assert.equal(current.translationRetry.hidden, true);
  await page.click(current.translationToggle);
  assert.equal(current.translationContent.textContent, '新文章。');
  assert.equal(calls, 2);
});

test('direct-file mode explains how to open the local translation service without requesting it', async () => {
  let calls = 0;
  const page = createPage({ protocol: 'file:', fetch: async () => { calls++; return translated(); } });
  const group = page.group(0);
  await page.click(group.translationToggle);
  assert.equal(calls, 0);
  assert.match(group.translationStatus.textContent, /启动翻译.cmd/);
  assert.equal(group.translationLink.hidden, false);
  assert.equal(group.translationLink.href, 'http://127.0.0.1:4173');
  assert.equal(group.translationLink.rel, 'noopener');
  assert.equal(group.translationRetry.hidden, true);
  assert.equal(group.reference.hidden, false);
  assert.equal(group.answer.hidden, false);
});

test('learning sources include only visible references and reject hidden or replaced ranges', async () => {
  const page = createPage({ source: 'Same word. Same word.' });
  assert.equal(page.controller.getLearningSources().length, 2);
  await page.fire('hideAllReferences', 'click');
  assert.equal(page.controller.getLearningSources().length, 0);
  await page.click(page.group(1).toggle);
  const [entry] = page.controller.getLearningSources();
  assert.equal(entry.display, page.group(1).reference);
  assert.equal(entry.area, page.group(1).reference);
  assert.equal(entry.getReferenceText(), 'Same word.');
  assert.deepEqual(JSON.parse(JSON.stringify(entry.mapRange(5, 9))), {
    source: 'Same word. Same word.', start: 16, end: 20,
  });
  for (const [start, end] of [[-1, 3], [0, 0], [4, 2], [0, 20], [0.5, 4], [0, Infinity]]) {
    assert.equal(entry.mapRange(start, end), null);
  }
  await page.click(page.group(1).toggle);
  assert.equal(page.controller.getLearningSources().length, 0);
  assert.equal(entry.mapRange(5, 9), null);
  await page.click(page.group(1).toggle);
  const [old] = page.controller.getLearningSources();
  page.controller.reset();
  assert.equal(old.mapRange(5, 9), null);
});

test('learning range mapping preserves original whitespace, paragraph breaks and UTF-16 positions', async () => {
  const normalized = '😀 First idea.   Second idea!\n\nThird idea? Fourth idea.';
  const page = createPage({ source: '\uFEFF  ' + normalized.replace(/\n/g, '\r\n') + '  ' });
  await page.size(3);
  await page.fire('showAllReferences', 'click');
  const [entry, last] = page.controller.getLearningSources();
  const displayed = '😀 First idea. Second idea! Third idea?';
  assert.equal(entry.getReferenceText(), displayed);
  const second = displayed.indexOf('Second');
  assert.deepEqual(JSON.parse(JSON.stringify(entry.mapRange(second, second + 6))), {
    source: normalized, start: normalized.indexOf('Second'), end: normalized.indexOf('Second') + 6,
  });
  const from = displayed.indexOf('Second'), end = displayed.length;
  const mapped = entry.mapRange(from, end);
  assert.equal(mapped.source.slice(mapped.start, mapped.end), 'Second idea!\n\nThird idea?');
  const whole = entry.mapRange(0, displayed.length);
  assert.equal(whole.source.slice(whole.start, whole.end), '😀 First idea.   Second idea!\n\nThird idea?');
  const fourth = last.mapRange(0, 6);
  assert.equal(fourth.start, normalized.indexOf('Fourth'));
});

test('learning reset notifications cover source hiding, input, checking and session resets only', async () => {
  let resets = 0;
  const page = createPage({ onLearningReset: () => resets++ });
  assert.equal(resets, 1);
  await page.click(page.group(0).toggle);
  assert.equal(resets, 2);
  await page.click(page.group(0).toggle);
  assert.equal(resets, 2);
  for (const name of ['focus', 'beforeinput', 'compositionstart', 'input']) {
    const before = resets;
    await page.group(0).answer.emit(name);
    assert.equal(resets, before + 1, name);
  }
  for (const action of [
    () => page.click(page.group(0).check),
    () => page.click(page.group(0).edit),
    () => page.controller.reset(),
    () => page.size(2),
    () => page.controller.setSource('Replacement essay.', 'Replacement', '我的范文'),
  ]) {
    const before = resets;
    await action();
    assert.ok(resets > before);
  }
  const before = resets;
  await page.size(2);
  await page.size(0);
  await page.fire('sentenceTimerStart', 'click');
  await page.fire('sentenceTimerPause', 'click');
  await page.fire('sentenceTimerClear', 'click');
  page.controller.setTimerVisible(false);
  assert.equal(resets, before);
});

function analyzed(translation = '当前语境的中文意思。') {
  return { ok: true, status: 200, json: async () => ({ analysis: {
    type: 'word', translation,
    brief: [{ label: '核心用法', text: '结合当前句子理解。' }],
    details: [{ label: '仿写任务', text: '使用这个表达写一句话。' }],
  }, cached: false, model: 'deepseek-flash' }) };
}

async function learningPage(source, fetcher) {
  const requests = [];
  const page = createPage({ integrated: true, fetch: (url, options) => {
    const request = { url, options, ...JSON.parse(options.body) };
    requests.push(request);
    return fetcher ? fetcher(request) : Promise.resolve(url === '/api/translate' ? translated('中文参考。') : analyzed());
  } });
  await page.import(source);
  await page.fire('sentenceModeButton', 'click');
  return Object.assign(page, { requests });
}

test('sentence references share contextual IELTS analysis only after double-click without changing practice', async () => {
  const source = 'We make progress through practice. Daily effort helps learners.';
  const page = await learningPage(source);
  await page.type(0, 'Keep this private draft');
  await page.fire('sentenceTimerStart', 'click');
  page.tick(2300);
  const group = page.group(0);
  const start = group.reference.textContent.indexOf('progress');
  await page.document.emit('pointerdown', { target: group.reference });
  await page.select(group.reference, start, start + 8);
  await page.document.emit('pointerup', { target: group.reference });
  assert.equal(page.requests.length, 0);
  assert.equal(page.$('selectionTranslationPopup').hidden, true);
  await page.doubleClick(group.reference);
  assert.equal(page.requests.length, 1);
  const [request] = page.requests;
  assert.equal(request.url, '/api/analyze');
  assert.equal(request.text, 'progress');
  assert.deepEqual(request.context, { sentence: 'We make progress through practice.', paragraph: source });
  assert.equal(page.$('selectionTranslationPopup').hidden, false);
  assert.equal(page.$('selectionTranslationText').textContent, '当前语境的中文意思。');
  assert.equal(page.$('selectionAnalysisType').textContent, '单词');
  assert.equal(page.$('selectionAnalysisDetails').hidden, true);
  await page.fire('selectionAnalysisExpand', 'click');
  assert.equal(page.$('selectionAnalysisDetails').hidden, false);
  assert.match(page.$('selectionAnalysisDetails').textContent, /仿写任务/);
  await page.fire('selectionAnalysisExpand', 'click');
  await page.doubleClick(group.reference);
  assert.equal(page.requests.length, 1);
  assert.equal(group.answer.value, 'Keep this private draft');
  assert.equal(group.checked.hidden, true);
  assert.equal(page.$('typingInput').value, '');
  assert.equal(page.$('sentenceTimerValue').textContent, '00:02');
  assert.equal(page.$('sentenceTimerState').textContent, '计时中');
});

test('same selected word in different groups uses its actual sentence and independent context cache', async () => {
  const source = 'Practice creates progress.\n\nTechnology can accelerate progress.';
  const page = await learningPage(source);
  await page.fire('showAllReferences', 'click');
  for (let index = 0; index < 2; index++) {
    const display = page.group(index).reference;
    const start = display.textContent.indexOf('progress');
    await page.select(display, start, start + 8);
    await page.doubleClick(display);
  }
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[0].context.sentence, 'Practice creates progress.');
  assert.equal(page.requests[0].context.paragraph, 'Practice creates progress.');
  assert.equal(page.requests[1].context.sentence, 'Technology can accelerate progress.');
  assert.equal(page.requests[1].context.paragraph, 'Technology can accelerate progress.');
});

test('grouped selections map emoji, joined whitespace and cross-paragraph spans back to the original article', async () => {
  const source = '😀 First idea.   Second progress!\n\nThird progress? Fourth idea.';
  const page = await learningPage(source);
  await page.size(3);
  const display = page.group(0).reference;
  const start = display.textContent.indexOf('Second');
  await page.select(display, start, start + 'Second progress!'.length);
  await page.doubleClick(display);
  assert.equal(page.requests[0].context.sentence, 'Second progress!');
  assert.equal(page.requests[0].context.paragraph, '😀 First idea.   Second progress!');
  await page.select(display, start, display.textContent.length);
  await page.doubleClick(display);
  assert.equal(page.requests[1].text, 'Second progress! Third progress?');
  assert.equal(page.requests[1].context.paragraph, source);
  await page.select(display);
  await page.doubleClick(display);
  assert.equal(page.requests[2].text, '😀 First idea. Second progress! Third progress?');
  assert.equal(page.requests[2].context.paragraph, source);
});

test('answers, checked results, Chinese panels, cross-group and hidden references never start learning requests', async () => {
  const page = await learningPage('First English sentence. Second English sentence.');
  const first = page.group(0), second = page.group(1);
  await page.click(first.toggle);
  await page.select(first.reference);
  await page.doubleClick(first.reference);
  assert.equal(page.requests.length, 0);
  await page.type(0, 'My English answer');
  first.answer.setSelectionRange(0, first.answer.value.length);
  await page.doubleClick(first.answer);
  await page.click(first.check);
  await page.select(first.checked);
  await page.doubleClick(first.checked);
  first.translationContent.textContent = 'Chinese reference with English';
  first.translation.hidden = false;
  await page.select(first.translationContent);
  await page.doubleClick(first.translationContent);
  await page.fire('showAllReferences', 'click');
  await page.selectAcross(first.reference, second.reference);
  await page.doubleClick(first.reference);
  await page.select(first.reference);
  await page.click(first.toggle);
  await page.doubleClick(first.reference);
  assert.equal(page.requests.length, 0);
  assert.equal(page.$('selectionTranslationPopup').hidden, true);
});

test('non-English sentence selections are rejected locally and inactive realtime ranges cannot leak into analysis', async () => {
  const page = await learningPage('English 中文 123 !!! sentence.');
  const display = page.group(0).reference;
  for (const selected of [' ', '中文', '123', '!!!']) {
    const start = display.textContent.indexOf(selected);
    await page.select(display, start, start + selected.length);
    await page.doubleClick(display);
  }
  await page.select(page.$('textDisplay'), 0, 7);
  await page.doubleClick(page.$('textDisplay'));
  assert.equal(page.requests.length, 0);
  await page.select(display, 0, 7);
  await page.fire('realtimeModeButton', 'click');
  await page.doubleClick(display);
  assert.equal(page.requests.length, 0);
});

test('sentence lifecycle and answer events invalidate pending learning responses', async () => {
  const actions = [
    ['hide one', page => page.click(page.group(0).toggle)],
    ['hide all', page => page.fire('hideAllReferences', 'click')],
    ['regroup', page => page.size(2)],
    ['restart', page => page.fire('restartButton', 'click')],
    ['import', page => page.import('Replacement essay.')],
    ['mode switch', page => page.fire('realtimeModeButton', 'click')],
    ['answer focus', page => page.group(0).answer.emit('focus')],
    ['answer beforeinput', page => page.group(0).answer.emit('beforeinput')],
    ['answer composition', page => page.group(0).answer.emit('compositionstart')],
    ['answer input', page => page.type(0, 'Updated private answer')],
    ['check', page => page.click(page.group(0).check)],
  ];
  for (const [name, action] of actions) {
    const pending = deferred();
    const page = await learningPage('First English sentence. Second English sentence.', () => pending.promise);
    await page.select(page.group(0).reference, 0, 5);
    const work = page.doubleClick(page.group(0).reference);
    assert.equal(page.requests.length, 1, name);
    assert.equal(page.$('selectionTranslationPopup').hidden, false, name);
    await action(page);
    pending.resolve(analyzed('迟到结果不得重新打开浮窗。'));
    await work;
    assert.equal(page.$('selectionTranslationPopup').hidden, true, name);
    assert.equal(page.$('selectionTranslationText').textContent, '', name);
  }
});

test('editing a checked group dismisses pending learning and preserves the editable answer', async () => {
  const pending = deferred();
  const page = await learningPage('First English sentence.', () => pending.promise);
  await page.type(0, 'First draft.');
  const group = page.group(0);
  await page.click(group.check);
  await page.select(group.reference, 6, 13);
  const work = page.doubleClick(group.reference);
  assert.equal(page.requests[0].text, 'English');
  await page.click(group.edit);
  pending.resolve(analyzed('不得显示的旧分析。'));
  await work;
  assert.equal(page.$('selectionTranslationPopup').hidden, true);
  assert.equal(page.$('selectionTranslationText').textContent, '');
  assert.equal(group.answer.hidden, false);
  assert.equal(group.answer.value, 'First draft.');
  assert.equal(group.checked.hidden, true);
  assert.equal(group.reference.hidden, false);
});

function reviewed(answer, overrides = {}) {
  return { ok: true, status: 200, json: async () => ({ review: {
    languageStatus: 'correct', meaningStatus: 'consistent', summary: '你的表达正确，使用了另一种自然句式。',
    correctedAnswer: answer.trim(), errors: [],
    differences: [{ aspect: '句式', answer: answer.trim(), reference: 'We learn English every day.', explanation: '你的表达和范文使用不同句式，但保留了原意。' }],
    meaningNotes: [], ...overrides,
  }, model: 'deepseek-flash', cached: false }) };
}

test('AI check accepts a correct paraphrase without strict-diff error colors and sends only this group', async () => {
  const requests = [];
  const answer = 'English is something we study daily.';
  const page = createPage({ source: 'We learn English every day. Another group stays private.', fetch: async (url, options) => {
    requests.push({ url, ...JSON.parse(options.body) });
    return reviewed(answer);
  } });
  await page.type(0, '  ' + answer + '  ');
  await page.type(1, 'Other private draft');
  const group = page.group(0);
  await page.click(group.toggle);
  assert.equal(requests.length, 0);
  await page.click(group.review);
  assert.deepEqual(requests, [{ url: '/api/review', reference: 'We learn English every day.', answer }]);
  assert.equal(group.checked.textContent, '  ' + answer + '  ');
  assert.equal(group.answer.hidden, true);
  assert.equal(group.reference.hidden, false);
  assert.equal(group.reviewPanel.hidden, false);
  assert.equal(group.card.classList.contains('is-correct'), true);
  assert.equal(page.find(group.card, 'word-error').length, 0);
  assert.equal(page.find(group.card, 'word-extra').length, 0);
  assert.equal(page.find(group.card, 'review-original').length, 0);
  assert.match(group.feedback.textContent, /表达正确/);
  assert.match(page.$('sentenceProgress').textContent, /1 \/ 2/);
  assert.equal(page.group(1).answer.value, 'Other private draft');
});

test('AI language errors use a three-column table and preserve the learner wording in the correction', async () => {
  const answer = 'We studies English daily.';
  const page = createPage({ source: 'We learn English every day.', fetch: async () => reviewed(answer, {
    languageStatus: 'needs_correction', correctedAnswer: 'We study English daily.',
    summary: 'daily 的用法正确；主语和动词需要保持一致。',
    errors: [{ original: 'studies', correction: 'study', reason: '主语 We 为复数，使用动词原形。', category: 'grammar' }],
  }) });
  await page.type(0, answer);
  await page.click(page.group(0).review);
  const group = page.group(0);
  const table = page.find(group.reviewPanel, 'review-table')[0];
  assert.deepEqual(page.find(table, 'review-original').map(node => node.textContent), ['studies']);
  assert.deepEqual(page.find(table, 'review-replacement').map(node => node.textContent), ['study']);
  assert.deepEqual(table.children[0].children[0].children.map(node => node.textContent), ['你的表达', '正确表达', '原因']);
  assert.match(page.find(table, 'review-reason')[0].textContent, /主语 We/);
  assert.equal(page.find(group.reviewPanel, 'review-correction')[0].textContent, 'We study English daily.');
  assert.equal(group.checked.textContent, answer);
  assert.equal(page.find(group.checked, 'word-error').length, 0);
  assert.equal(group.card.classList.contains('is-correct'), false);
  assert.match(group.feedback.textContent, /1 处语言问题/);
});

test('grammatical sentences that change the meaning are distinguished from language errors', async () => {
  const answer = 'We never study English.';
  const page = createPage({ source: 'We learn English every day.', fetch: async () => reviewed(answer, {
    meaningStatus: 'changed', meaningNotes: ['never 表示从不，与原文的每天学习相反。'],
  }) });
  await page.type(0, answer);
  await page.click(page.group(0).review);
  const group = page.group(0);
  assert.match(group.feedback.textContent, /语言表达正确，但与范文原意不同/);
  assert.match(group.reviewPanel.textContent, /原意差异/);
  assert.equal(page.find(group.reviewPanel, 'review-original').length, 0);
  assert.equal(group.card.classList.contains('is-correct'), false);
  assert.match(page.$('sentenceProgress').textContent, /0 \/ 1/);
});

test('uncertain language or meaning is not silently accepted as a correct group', async () => {
  for (const overrides of [
    { languageStatus: 'uncertain', summary: '这处省略需要更多上下文判断。' },
    { meaningStatus: 'uncertain', meaningNotes: ['指代不明确，需要补充上下文。'] },
  ]) {
    const page = createPage({ source: 'We learn English every day.', fetch: async () => reviewed('We do so daily.', overrides) });
    await page.type(0, 'We do so daily.');
    await page.click(page.group(0).review);
    assert.equal(page.group(0).state.textContent, '待确认');
    assert.equal(page.group(0).card.classList.contains('is-correct'), false);
    assert.match(page.$('sentenceProgress').textContent, /0 \/ 1/);
  }
});

test('pending AI review keeps input editable, prevents duplicate requests and ignores revisions', async () => {
  const pending = deferred();
  let signal, calls = 0;
  const page = createPage({ fetch: (url, options) => { calls++; signal = options.signal; return pending.promise; } });
  await page.type(0, 'First valid answer.');
  const group = page.group(0);
  const work = page.click(group.review);
  assert.equal(group.answer.hidden, false);
  assert.equal(group.answer.disabled, false);
  assert.equal(group.review.disabled, true);
  assert.equal(group.card.getAttribute('aria-busy'), 'true');
  await page.click(group.review);
  assert.equal(calls, 1);
  await page.type(0, 'New draft stays editable.');
  assert.equal(signal.aborted, true);
  assert.equal(group.review.disabled, false);
  pending.resolve(reviewed('First valid answer.'));
  await work;
  assert.equal(group.reviewPanel.hidden, true);
  assert.equal(group.answer.value, 'New draft stays editable.');
  assert.equal(group.checked.hidden, true);
  assert.equal(group.feedback.textContent, '');
  assert.equal(group.state.textContent, '待检查');
});

test('late AI success or failure cannot override a newer completed review', async () => {
  for (const fail of [false, true]) {
    const pending = deferred();
    let calls = 0;
    const page = createPage({ fetch: async () => ++calls === 1 ? pending.promise : reviewed('Second answer.') });
    await page.type(0, 'First answer.');
    const group = page.group(0);
    const old = page.click(group.review);
    await page.type(0, 'Second answer.');
    await page.click(group.review);
    if (fail) pending.reject(new Error('late offline'));
    else pending.resolve(reviewed('First answer.'));
    await old;
    assert.equal(group.checked.textContent, 'Second answer.');
    assert.equal(group.reviewPanel.hidden, false);
    assert.equal(group.card.classList.contains('is-correct'), true);
    assert.equal(group.review.disabled, false);
  }
});

test('reset, import, regroup, local check and mode switches invalidate pending AI reviews', async () => {
  const actions = [
    ['reset', page => page.controller.reset()],
    ['source', page => page.controller.setSource('Replacement essay.', 'New', '我的范文')],
    ['regroup', page => page.size(2)],
    ['local check', page => page.click(page.group(0).check)],
    ['inactive mode', page => page.controller.setActive(false)],
  ];
  for (const [name, action] of actions) {
    const pending = deferred();
    let signal;
    const page = createPage({ fetch: (_, options) => { signal = options.signal; return pending.promise; } });
    await page.type(0, 'First sentence.');
    const old = page.group(0);
    const work = page.click(old.review);
    await action(page);
    assert.equal(signal.aborted, true, name);
    pending.resolve(reviewed('First sentence.'));
    await work;
    assert.equal(page.group(0).reviewPanel.hidden, true, name);
    if (name === 'local check') {
      assert.equal(page.group(0).checked.hidden, false);
      assert.equal(page.group(0).card.classList.contains('is-correct'), true);
    }
  }
  const pending = deferred();
  const page = createPage({ integrated: true, fetch: () => pending.promise });
  await page.fire('sentenceModeButton', 'click');
  await page.type(0, 'A correct draft.');
  const group = page.group(0);
  const work = page.click(group.review);
  await page.fire('realtimeModeButton', 'click');
  await page.fire('sentenceModeButton', 'click');
  pending.resolve(reviewed('A correct draft.'));
  await work;
  assert.equal(group.reviewPanel.hidden, true);
  assert.equal(group.answer.value, 'A correct draft.');
});

test('AI service errors preserve drafts and retry without changing the manual stopwatch', async () => {
  let calls = 0;
  const page = createPage({ fetch: async () => {
    if (++calls === 1) throw new Error('offline');
    return reviewed('First sentence.');
  } });
  await page.type(0, 'First sentence.');
  await page.fire('sentenceTimerStart', 'click');
  const group = page.group(0);
  await page.click(group.review);
  assert.match(group.feedback.textContent, /输入已保留/);
  assert.equal(group.answer.hidden, false);
  assert.equal(group.answer.value, 'First sentence.');
  assert.equal(group.review.disabled, false);
  page.tick(2200);
  await page.click(group.review);
  page.tick(2200);
  assert.equal(group.reviewPanel.hidden, false);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:04');
  assert.equal(page.$('sentenceTimerState').textContent, '计时中');
  assert.equal(calls, 2);
});

test('AI response validation rejects inconsistent or malformed results and allows retry', async () => {
  const invalid = [
    { ok: false, status: 429, json: async () => ({ error: '请求较多，请稍后重试。' }) },
    { ok: true, status: 200, json: async () => ({ translation: 'wrong endpoint' }) },
    { ok: true, status: 200, json: async () => { throw new Error('bad JSON'); } },
    reviewed('First sentence.', { errors: [{ original: 'First', correction: 'The first', reason: 'wrongly returned an error', category: 'grammar' }] }),
    reviewed('First sentence.', { languageStatus: 'needs_correction', correctedAnswer: 'A sentence.', errors: [{ original: 'Absent phrase', correction: 'A', reason: 'not present', category: 'grammar' }] }),
  ];
  for (const response of invalid) {
    let calls = 0;
    const page = createPage({ fetch: async () => ++calls === 1 ? response : reviewed('First sentence.') });
    await page.type(0, 'First sentence.');
    const group = page.group(0);
    await page.click(group.review);
    assert.equal(group.reviewPanel.hidden, true);
    assert.equal(group.answer.hidden, false);
    assert.equal(group.review.disabled, false);
    assert.match(group.feedback.textContent, /输入已保留/);
    await page.click(group.review);
    assert.equal(group.card.classList.contains('is-correct'), true);
  }
});

test('empty, non-English, overlong and file-mode answers do not send AI requests', async () => {
  let calls = 0;
  for (const answer of ['', '   ', '纯中文。', '12345 !!!', 'a'.repeat(12001)]) {
    const page = createPage({ fetch: async () => { calls++; return reviewed(answer); } });
    await page.type(0, answer);
    await page.click(page.group(0).review);
    assert.equal(page.group(0).answer.hidden, false);
    assert.equal(page.group(0).reviewPanel.hidden, true);
    assert.ok(page.group(0).feedback.textContent);
  }
  const page = createPage({ protocol: 'file:', source: 'First sentence.', fetch: async () => { calls++; return reviewed('First sentence.'); } });
  await page.type(0, 'First sentence.');
  await page.click(page.group(0).review);
  assert.match(page.group(0).feedback.textContent, /离线页面/);
  assert.equal(page.group(0).reviewLink.hidden, false);
  await page.click(page.group(0).check);
  assert.equal(page.group(0).card.classList.contains('is-correct'), true);
  assert.equal(page.group(0).reviewLink.hidden, true);
  assert.equal(calls, 0);
});

test('AI review text is rendered as plain text and editing removes stale evaluation', async () => {
  const answer = 'First sentence.';
  const marker = '<img src=x onerror=alert(1)>';
  const page = createPage({ fetch: async () => reviewed(answer, {
    summary: marker,
    differences: [{ aspect: marker, answer: marker, reference: marker, explanation: marker }],
    meaningNotes: [marker],
  }) });
  await page.type(0, answer);
  const group = page.group(0);
  await page.click(group.review);
  assert.match(group.reviewPanel.textContent, /<img/);
  assert.equal(page.find(group.reviewPanel, 'review-summary')[0].children.length, 0);
  await page.click(group.edit);
  assert.equal(group.reviewPanel.hidden, true);
  assert.equal(group.reviewPanel.textContent, '');
  assert.equal(group.checked.hidden, true);
  assert.equal(group.answer.hidden, false);
  assert.equal(group.answer.value, answer);
  assert.equal(group.feedback.textContent, '');
  assert.equal(group.card.classList.contains('is-correct'), false);
});

test('concurrent AI reviews are independent between groups', async () => {
  const first = deferred(), second = deferred();
  const page = createPage({ fetch: (_, options) => JSON.parse(options.body).answer === 'First sentence.' ? first.promise : second.promise });
  await page.type(0, 'First sentence.');
  await page.type(1, 'Second sentence!');
  const firstWork = page.click(page.group(0).review);
  const secondWork = page.click(page.group(1).review);
  second.resolve(reviewed('Second sentence!'));
  await secondWork;
  assert.equal(page.group(1).reviewPanel.hidden, false);
  assert.equal(page.group(0).review.disabled, true);
  first.resolve(reviewed('First sentence.'));
  await firstWork;
  assert.equal(page.group(0).reviewPanel.hidden, false);
  assert.match(page.$('sentenceProgress').textContent, /2 \/ 3/);
});

test('double-clicking a draft checks only that group locally and preserves its buttons', async () => {
  let requests = 0;
  const page = createPage({ fetch: async () => { requests++; throw new Error('local checking must not request a model'); } });
  await page.type(0, 'First typo.');
  await page.type(1, 'Keep the other draft!');
  await page.click(page.group(0).toggle);
  await page.click(page.group(1).toggle);
  const first = page.group(0), second = page.group(1);

  await page.doubleClick(first.answer);

  assert.equal(first.answer.hidden, true);
  assert.equal(first.checked.hidden, false);
  assert.equal(first.checked.textContent, 'First typo.');
  assert.equal(first.reference.hidden, false);
  assert.deepEqual(page.find(first.checked, 'word-error').map(node => node.textContent), ['typo.']);
  assert.equal(first.edit.hidden, false);
  assert.equal(first.check.hidden, false);
  assert.equal(first.review.hidden, false);
  assert.equal(first.reviewPanel.hidden, true);
  assert.equal(second.answer.value, 'Keep the other draft!');
  assert.equal(second.answer.hidden, false);
  assert.equal(second.checked.hidden, true);
  assert.equal(second.reference.hidden, true);
  assert.equal(second.feedback.textContent, '');
  assert.equal(requests, 0);
});

test('double-click skips empty drafts and waits until input-method composition finishes', async () => {
  const page = createPage({ source: 'Keep learning.' });
  const group = page.group(0);
  await page.click(group.toggle);
  for (const draft of ['', '  \t\n  ']) {
    await page.type(0, draft);
    await page.doubleClick(group.answer);
    assert.equal(group.answer.hidden, false);
    assert.equal(group.checked.hidden, true);
    assert.equal(group.reference.hidden, true);
    assert.equal(group.feedback.textContent, '');
  }

  await page.type(0, 'Keep learning.');
  await group.answer.emit('compositionstart');
  await page.doubleClick(group.answer);
  assert.equal(group.answer.hidden, false);
  assert.equal(group.checked.hidden, true);
  assert.equal(group.reference.hidden, true);
  await group.answer.emit('compositionend');
  await page.doubleClick(group.answer);
  assert.equal(group.checked.hidden, false);
  assert.equal(group.card.classList.contains('is-correct'), true);
});

test('double-clicking a checked word restores the complete draft and leaves the manual stopwatch running', async () => {
  const page = createPage({ source: 'We learn English every day. Another sentence.' });
  const draft = '  We learn French\n every day.  ';
  await page.type(0, draft);
  await page.type(1, 'Another sentence.');
  await page.click(page.group(1).check);
  await page.fire('sentenceTimerStart', 'click');
  page.tick(2300);
  const group = page.group(0), other = page.group(1);
  await page.doubleClick(group.answer);
  const wrongWord = page.find(group.checked, 'word-error')[0];
  assert.equal(wrongWord.textContent, 'French');

  await page.doubleClick(wrongWord);

  assert.equal(group.answer.hidden, false);
  assert.equal(group.answer.value, draft);
  assert.equal(page.document.activeElement, group.answer);
  assert.equal(group.checked.hidden, true);
  assert.equal(group.edit.hidden, true);
  assert.equal(group.feedback.textContent, '');
  assert.equal(group.missing.hidden, true);
  assert.equal(group.reviewPanel.hidden, true);
  assert.equal(group.card.classList.contains('is-checked'), false);
  assert.equal(other.checked.hidden, false);
  assert.equal(other.card.classList.contains('is-correct'), true);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:02');
  assert.equal(page.$('sentenceTimerState').textContent, '计时中');
  page.tick(1700);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:04');
  await page.type(0, 'We learn English every day.');
  await page.click(group.check);
  assert.equal(group.card.classList.contains('is-correct'), true);
});

test('double-clicking a correct checked word returns to editing without resuming a paused stopwatch', async () => {
  const page = createPage({ source: 'Keep learning.' });
  await page.fire('sentenceTimerStart', 'click');
  page.tick(2100);
  await page.fire('sentenceTimerPause', 'click');
  await page.type(0, 'Keep learning.');
  const group = page.group(0);
  await page.doubleClick(group.answer);
  assert.equal(group.card.classList.contains('is-correct'), true);
  await page.doubleClick(group.checked.children[0]);
  assert.equal(group.answer.value, 'Keep learning.');
  assert.equal(group.answer.hidden, false);
  assert.equal(group.card.classList.contains('is-correct'), false);
  assert.match(page.$('sentenceProgress').textContent, /0 \/ 1/);
  page.tick(5000);
  assert.equal(page.$('sentenceTimerValue').textContent, '00:02');
  assert.equal(page.$('sentenceTimerState').textContent, '已暂停');
});

test('double-clicking an AI checked answer clears the evaluation, retains the draft and makes no new request', async () => {
  let requests = 0;
  const answer = 'English is something we study daily.';
  const page = createPage({ source: 'We learn English every day.', fetch: async () => { requests++; return reviewed(answer); } });
  const draft = '  ' + answer + '\n';
  await page.type(0, draft);
  const group = page.group(0);
  await page.click(group.review);
  assert.equal(group.reviewPanel.hidden, false);
  assert.equal(group.card.classList.contains('is-correct'), true);
  await page.doubleClick(group.checked.children[0]);
  assert.equal(group.answer.hidden, false);
  assert.equal(group.answer.value, draft);
  assert.equal(page.document.activeElement, group.answer);
  assert.equal(group.checked.hidden, true);
  assert.equal(group.reviewPanel.hidden, true);
  assert.equal(group.reviewPanel.textContent, '');
  assert.equal(group.feedback.textContent, '');
  assert.equal(group.state.textContent, '待检查');
  assert.equal(group.card.classList.contains('is-correct'), false);
  assert.equal(requests, 1);
});

test('double-clicking a draft cancels pending AI review and late success or failure cannot replace local results', async () => {
  for (const failure of [false, true]) {
    const pending = deferred();
    let signal, requests = 0;
    const page = createPage({ source: 'First sentence.', fetch: (_, options) => {
      requests++;
      signal = options.signal;
      return pending.promise;
    } });
    await page.type(0, 'First typo.');
    const group = page.group(0);
    const work = page.click(group.review);
    assert.equal(group.card.getAttribute('aria-busy'), 'true');
    await page.doubleClick(group.answer);
    assert.equal(signal.aborted, true);
    assert.equal(group.checked.hidden, false);
    assert.equal(group.review.disabled, false);
    assert.equal(group.card.getAttribute('aria-busy'), 'false');
    const feedback = group.feedback.textContent;
    if (failure) pending.reject(new Error('late provider failure'));
    else pending.resolve(reviewed('First typo.'));
    await work;
    assert.equal(group.checked.textContent, 'First typo.');
    assert.equal(group.feedback.textContent, feedback);
    assert.equal(group.reviewPanel.hidden, true);
    assert.equal(group.card.classList.contains('is-correct'), false);
    assert.deepEqual(page.find(group.checked, 'word-error').map(node => node.textContent), ['typo.']);
    assert.equal(requests, 1);
  }
});

test('double-click ignores hidden controls, inactive mode and detached groups', async () => {
  const page = createPage();
  await page.type(0, 'First typo.');
  const original = page.group(0);
  await page.doubleClick(original.checked);
  assert.equal(original.answer.hidden, false);
  assert.equal(original.feedback.textContent, '');
  page.controller.setActive(false);
  await page.doubleClick(original.answer);
  assert.equal(original.checked.hidden, true);
  page.controller.setActive(true);
  await page.doubleClick(original.answer);
  const firstWord = original.checked.children[0];
  await page.doubleClick(original.answer);
  assert.equal(original.checked.children[0], firstWord);
  page.controller.setActive(false);
  await page.doubleClick(original.checked);
  assert.equal(original.checked.hidden, false);
  page.controller.setActive(true);
  page.controller.reset();
  const replacement = page.group(0);
  await page.doubleClick(original.checked);
  original.answer.value = 'Detached draft.';
  await page.doubleClick(original.answer);
  assert.equal(replacement.answer.value, '');
  assert.equal(replacement.checked.hidden, true);
  assert.notEqual(page.document.activeElement, original.answer);
});
