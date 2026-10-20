'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function analysisResponse(translation, type = 'phrase', extras = {}) {
  return { analysis: { type, translation, brief: [{ label: '语境意思', text: '结合当前语境理解。' }],
    details: [{ label: '仿写任务', text: '换一个话题，使用这个表达造句。' }], ...extras } };
}

function createPage({ protocol = 'http:', fetcher, source = '', optionalUI = true,
  touchPoints = 0, coarsePointer = false, touchUI = true, viewport } = {}) {
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(callback);
    }
    emit(name, properties = {}) {
      const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...properties };
      return Promise.all((this.listeners.get(name) || []).map(callback => callback(event)));
    }
  }
  class Element extends Target {
    constructor() {
      super();
      this.childNodes = [];
      this._text = '';
      this.value = '';
      this.hidden = false;
      this.style = {};
      this.attributes = new Map();
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.rect = { left: 220, right: 480, top: 160, bottom: 200, width: 260, height: 40 };
    }
    set textContent(value) { this._text = String(value); this.childNodes = []; }
    get textContent() { return this.childNodes.length ? this.childNodes.map(child => child.textContent).join('') : this._text; }
    append(...children) { children.forEach(child => { this.childNodes.push(child); child.parentElement = this; child.parentNode = this; }); }
    contains(child) { return child === this || this.childNodes.some(node => node === child || node.contains?.(child)) || child?.parentElement === this; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return this.rect; }
  }
  const document = new Target();
  document.activeElement = null;
  document.documentElement = { clientWidth: 900, clientHeight: 700 };
  document.createElement = () => new Element();
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
  const window = new Target();
  window.window = window;
  window.document = document;
  window.innerWidth = 900;
  window.innerHeight = 700;
  window.location = { protocol };
  window.navigator = { maxTouchPoints: touchPoints };
  window.matchMedia = query => ({ matches: query === '(any-pointer: coarse)' && coarsePointer });
  if (viewport) window.visualViewport = Object.assign(new Target(), viewport);
  let nativeSelection = null;
  window.getSelection = () => nativeSelection;
  const requests = [];
  window.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, ...options, ...body });
    return fetcher ? fetcher(body.text, body.context) : { ok: true, json: async () => analysisResponse(`中文：${body.text}`) };
  };
  const names = ['input', 'display', 'area', 'popup', 'sourceLabel', 'translationLabel', 'statusLabel', 'retryButton', 'closeButton',
    ...(optionalUI ? ['typeLabel', 'briefContainer', 'detailsContainer', 'expandButton'] : []),
    ...(touchUI ? ['learnAction', 'learnButton'] : [])];
  const elements = Object.fromEntries(names.map(name => [name, new Element()]));
  elements.input.parentElement = elements.area;
  elements.display.parentElement = elements.area;
  elements.retryButton.parentElement = elements.popup;
  elements.closeButton.parentElement = elements.popup;
  elements.sourceLabel.parentElement = elements.popup;
  elements.translationLabel.parentElement = elements.popup;
  elements.statusLabel.parentElement = elements.popup;
  for (const name of ['typeLabel', 'briefContainer', 'detailsContainer', 'expandButton']) {
    if (elements[name]) elements[name].parentElement = elements.popup;
  }
  if (elements.detailsContainer) elements.detailsContainer.id = 'analysis-details';
  elements.popup.rect = { width: 330, height: 190 };
  if (elements.learnAction) {
    elements.learnAction.hidden = true;
    elements.learnAction.append(elements.learnButton);
  }
  let active = true;
  let primaryActive = true;
  const additionalSources = [];
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'selection-translation.js'), 'utf8'), vm.createContext(window));
  const controller = window.SelectionTranslation.create({ ...elements, isActive: () => active, getReferenceText: () => source,
    isPrimaryActive: () => primaryActive, getAdditionalSources: () => additionalSources });
  return {
    ...elements, document, window, controller, requests,
    active(value) { active = value; },
    primaryActive(value) { primaryActive = value; },
    reference(value) { source = value; },
    addSource(text, { article = text, offset = 0, mapRange, id } = {}) {
      const display = new Element();
      const area = new Element();
      display.id = id || `additional-${additionalSources.length}`;
      display.append({ nodeType: 3, textContent: text });
      area.append(display);
      const source = { display, area, getReferenceText: () => text,
        mapRange: mapRange || ((start, end) => ({ source: article, start: start + offset, end: end + offset })) };
      additionalSources.push(source);
      return source;
    },
    removeSource(source) { additionalSources.splice(additionalSources.indexOf(source), 1); },
    selectAdditional(source, start = 0, end = source.display.textContent.length,
      { rect = { left: 80, right: 230, top: 210, bottom: 235, width: 150, height: 25 }, rects, rawText } = {}) {
      const node = source.display.childNodes[0];
      const range = { startContainer: node, startOffset: start, endContainer: node, endOffset: end,
        getBoundingClientRect: () => rect, getClientRects: () => rects || [rect] };
      range.cloneRange = () => range;
      document.activeElement = source.display;
      nativeSelection = { isCollapsed: false, rangeCount: 1, anchorNode: node, focusNode: node,
        toString: () => rawText ?? source.display.textContent.slice(start, end), getRangeAt: () => range };
      return document.emit('selectionchange');
    },
    selectAcrossBoundary(source, { edge = 'end', reverse = false, outsideText = '\n\n' } = {}) {
      const node = source.display.childNodes[0];
      const outside = new Element();
      outside.tagName = 'LABEL';
      const rect = { left: 80, right: 320, top: 210, bottom: 235, width: 240, height: 25 };
      function makeRange(startContainer, startOffset, endContainer, endOffset) {
        return {
          startContainer, startOffset, endContainer, endOffset,
          setStart(value, offset) { this.startContainer = value; this.startOffset = offset; },
          setEnd(value, offset) { this.endContainer = value; this.endOffset = offset; },
          cloneRange() { return makeRange(this.startContainer, this.startOffset, this.endContainer, this.endOffset); },
          getBoundingClientRect: () => rect,
          getClientRects: () => [rect],
          toString() {
            const from = offsetWithin(source.display, this.startContainer, this.startOffset);
            const to = offsetWithin(source.display, this.endContainer, this.endOffset);
            return `${from === null ? outsideText : ''}${source.display.textContent.slice(from ?? 0, to ?? source.display.textContent.length)}${to === null ? outsideText : ''}`;
          },
        };
      }
      const range = edge === 'end' ? makeRange(node, 0, outside, 0)
        : makeRange(outside, 0, node, node.textContent.length);
      nativeSelection = { isCollapsed: false, rangeCount: 1,
        anchorNode: reverse ? range.endContainer : range.startContainer,
        focusNode: reverse ? range.startContainer : range.endContainer,
        toString: () => range.toString(), getRangeAt: () => range };
      document.activeElement = source.display;
      return document.emit('selectionchange');
    },
    crossSourceSelection(first, second, text = 'Cross source English.') {
      nativeSelection = { isCollapsed: false, rangeCount: 1,
        anchorNode: first.display.childNodes[0], focusNode: second.display.childNodes[0], toString: () => text };
      return document.emit('selectionchange');
    },
    doubleClickAdditional(source, target = source.display) {
      return document.emit('dblclick', { target });
    },
    selectDisplay(text, rect = { left: 220, right: 400, top: 160, bottom: 185, width: 180, height: 25 }) {
      const node = { parentElement: elements.display };
      document.activeElement = elements.display;
      nativeSelection = { isCollapsed: false, rangeCount: 1, anchorNode: node, focusNode: node,
        toString: () => text, getRangeAt: () => ({ cloneRange: () => ({ getBoundingClientRect: () => rect }) }) };
      return document.emit('selectionchange');
    },
    selectRange(start, end, actual = source) {
      elements.display.textContent = '';
      const spans = Array.from(actual).map(character => {
        const span = new Element();
        span.className = 'character';
        span.append({ nodeType: 3, textContent: character });
        elements.display.append(span);
        return span;
      });
      const anchor = new Element();
      anchor.className = 'caret-anchor';
      elements.display.childNodes.splice(1, 0, anchor);
      anchor.parentElement = elements.display;
      anchor.parentNode = elements.display;
      function endpoint(position) {
        let units = 0;
        for (const span of spans) {
          if (position <= units + span.textContent.length) return { node: span.childNodes[0], offset: position - units };
          units += span.textContent.length;
        }
        return { node: elements.display, offset: elements.display.childNodes.length };
      }
      const from = endpoint(start), to = endpoint(end);
      const text = actual.slice(start, end);
      const rect = { left: 20, top: 100, bottom: 125, width: 150, height: 25 };
      const range = { startContainer: from.node, startOffset: from.offset, endContainer: to.node, endOffset: to.offset,
        getBoundingClientRect: () => rect };
      document.activeElement = elements.display;
      nativeSelection = { isCollapsed: false, rangeCount: 1, anchorNode: from.node, focusNode: to.node,
        toString: () => text, getRangeAt: () => ({ cloneRange: () => range }) };
      return document.emit('selectionchange');
    },
    selectInput(text, start = 0, end = text.length) {
      nativeSelection = null;
      elements.input.value = text;
      elements.input.selectionStart = start;
      elements.input.selectionEnd = end;
      document.activeElement = elements.input;
      return elements.input.emit('select');
    },
    clearSelection() {
      nativeSelection = null;
      elements.input.selectionEnd = elements.input.selectionStart;
      return document.emit('selectionchange');
    },
    outsideSelection(text) {
      nativeSelection = { isCollapsed: false, rangeCount: 1, anchorNode: {}, focusNode: {}, toString: () => text };
      document.activeElement = null;
      return document.emit('selectionchange');
    },
    selectPopup(text) {
      const node = { parentElement: elements.popup };
      document.activeElement = elements.popup;
      nativeSelection = { isCollapsed: false, rangeCount: 1, anchorNode: node, focusNode: node, toString: () => text };
      return document.emit('selectionchange');
    },
    doubleClick: () => elements.display.emit('dblclick'),
    learnSelection() {
      const before = requests.length;
      elements.display.emit('dblclick');
      assert.equal(requests.length, before, 'double-click only exposes the action');
      return elements.learnButton.emit('click');
    },
    learnInput() {
      const before = requests.length;
      elements.input.emit('dblclick');
      assert.equal(requests.length, before, 'textarea double-click must not request AI');
      return elements.learnButton.emit('click');
    },
    learnAdditional(source) {
      const before = requests.length;
      document.emit('dblclick', { target: source.display });
      assert.equal(requests.length, before, 'reference double-click must not request AI');
      return elements.learnButton.emit('click');
    },
    async pressLearnButton({ collapse = true } = {}) {
      await elements.learnButton.emit('pointerdown', { pointerType: 'touch', button: 0 });
      await document.emit('pointerdown', { target: elements.learnButton, pointerType: 'touch', button: 0 });
      if (collapse) {
        document.activeElement = elements.learnButton;
        nativeSelection = null;
        elements.input.selectionEnd = elements.input.selectionStart;
        await document.emit('selectionchange');
      }
      return elements.learnButton.emit('click');
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve: text => resolve({ ok: true, json: async () => analysisResponse(text) }) };
}

test('selecting or releasing a phrase alone never opens the popup or requests translation', async () => {
  const page = createPage();
  await page.document.emit('pointerdown', { target: page.display });
  await page.selectDisplay('An entire phrase.');
  await page.document.emit('pointerup', { target: page.display });
  await page.document.emit('keyup', { target: page.display, key: 'Shift' });
  assert.equal(page.popup.hidden, true);
  assert.equal(page.requests.length, 0);
});

test('clicking the desktop learning action translates the complete trimmed phrase', async () => {
  const page = createPage();
  await page.selectDisplay('  An entire phrase.  ');
  await page.learnSelection();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, '/api/analyze');
  assert.equal(page.requests[0].method, 'POST');
  assert.equal(page.requests[0].text, 'An entire phrase.');
  assert.equal(page.sourceLabel.textContent, 'An entire phrase.');
  assert.equal(page.translationLabel.textContent, '中文：An entire phrase.');
  assert.equal(page.popup.hidden, false);
  assert.equal(page.popup.attributes.get('aria-busy'), 'false');
});

test('desktop word selection and native double-click reveal an action without requesting AI', async () => {
  const page = createPage();
  let prevented = false;
  await page.document.emit('pointerdown', { target: page.display, pointerType: 'mouse', button: 0,
    detail: 2, clientX: 250, clientY: 170, preventDefault() { prevented = true; } });
  await page.selectDisplay('practice');
  await page.doubleClick();
  assert.equal(prevented, false, 'native word selection is not prevented');
  assert.equal(page.learnAction.hidden, true, 'selection is not obstructed before pointer release');
  assert.equal(page.popup.hidden, true);
  assert.equal(page.requests.length, 0);
  await page.document.emit('pointerup', { target: page.display, pointerType: 'mouse', button: 0,
    detail: 2, clientX: 250, clientY: 170 });
  await page.doubleClick();
  assert.equal(page.learnAction.hidden, false);
  assert.equal(page.learnAction.getAttribute('data-layout'), 'floating');
  assert.equal(page.requests.length, 0);
  await page.learnButton.emit('click');
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].text, 'practice');
});

test('a third native click can extend a selected word to its paragraph before an explicit request', async () => {
  const page = createPage();
  const paragraph = 'Daily practice matters. Small efforts lead to lasting progress.';
  await page.selectDisplay('practice');
  await page.doubleClick();
  assert.equal(page.learnAction.hidden, false);
  let prevented = false;
  await page.document.emit('pointerdown', { target: page.display, pointerType: 'mouse', button: 0, detail: 3,
    clientX: 280, clientY: 170, preventDefault() { prevented = true; } });
  await page.selectDisplay(paragraph);
  assert.equal(prevented, false, 'native paragraph selection is not prevented');
  assert.equal(page.learnAction.hidden, true);
  assert.equal(page.requests.length, 0);
  await page.document.emit('pointerup', { target: page.display, pointerType: 'mouse', button: 0, detail: 3,
    clientX: 280, clientY: 170 });
  assert.equal(page.learnAction.hidden, false);
  assert.equal(page.popup.hidden, true);
  await page.learnButton.emit('click');
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].text, paragraph, 'the finalized paragraph replaces the earlier word');
});

test('desktop dragging waits until release and submits only the latest completed selection', async () => {
  const page = createPage();
  await page.document.emit('pointerdown', { target: page.display, pointerType: 'mouse', button: 0 });
  for (const text of ['Small', 'Small efforts', 'Small efforts lead to progress.']) {
    await page.selectDisplay(text);
    assert.equal(page.learnAction.hidden, true);
    assert.equal(page.requests.length, 0);
  }
  await page.document.emit('pointerup', { target: page.display, pointerType: 'mouse', button: 0 });
  assert.equal(page.learnAction.hidden, false);
  await page.learnButton.emit('click');
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].text, 'Small efforts lead to progress.');
});

test('Escape and outside clicks dismiss a desktop action until a new source gesture', async () => {
  for (const dismiss of [page => page.document.emit('keydown', { key: 'Escape' }),
    page => page.document.emit('pointerdown', { target: {}, pointerType: 'mouse', button: 0 })]) {
    const page = createPage();
    await page.selectDisplay('A selected phrase.');
    assert.equal(page.learnAction.hidden, false);
    await dismiss(page);
    assert.equal(page.learnAction.hidden, true);
    await page.document.emit('selectionchange');
    await page.doubleClick();
    await page.learnButton.emit('click');
    assert.equal(page.learnAction.hidden, true);
    assert.equal(page.popup.hidden, true);
    assert.equal(page.requests.length, 0);
    await page.document.emit('pointerdown', { target: page.display, pointerType: 'mouse', button: 0 });
    await page.selectDisplay('A selected phrase.');
    await page.document.emit('pointerup', { target: page.display, pointerType: 'mouse', button: 0 });
    assert.equal(page.learnAction.hidden, false);
    await page.learnButton.emit('click');
    assert.equal(page.requests.length, 1);
  }
});

test('the desktop action follows the release point and stays inside viewport edges', async () => {
  const page = createPage();
  const source = page.addSource('A wide selected sentence in the reference.');
  page.learnAction.rect = { left: 0, top: 0, right: 130, bottom: 42, width: 130, height: 42 };
  const rect = { left: 80, right: 700, top: 200, bottom: 225, width: 620, height: 25 };
  await page.document.emit('pointerdown', { target: source.display, pointerType: 'mouse', button: 0,
    clientX: 100, clientY: 215 });
  await page.selectAdditional(source, 0, source.display.textContent.length, { rect });
  await page.document.emit('pointerup', { target: source.display, pointerType: 'mouse', button: 0,
    clientX: 580, clientY: 215 });
  assert.equal(page.learnAction.hidden, false);
  assert.equal(page.learnAction.style.left, '580px', 'the action appears next to the release location');
  assert.equal(page.learnAction.style.top, '235px', 'the action leaves a gap below the selected line');
  await page.document.emit('pointerdown', { target: source.display, pointerType: 'mouse', button: 0,
    clientX: 890, clientY: 675 });
  Object.assign(rect, { left: 600, right: 890, top: 660, bottom: 690, width: 290, height: 30 });
  await page.selectAdditional(source, 0, source.display.textContent.length, { rect });
  await page.document.emit('pointerup', { target: source.display, pointerType: 'mouse', button: 0,
    clientX: 890, clientY: 675 });
  assert.equal(page.learnAction.style.left, '758px', 'the action cannot overflow the right edge');
  assert.equal(page.learnAction.style.top, '608px', 'the action moves above the selection near the bottom');
  Object.assign(rect, { top: 750, bottom: 780 });
  await page.window.emit('scroll');
  assert.equal(page.learnAction.hidden, true, 'an offscreen selection leaves no stray floating button');
  Object.assign(rect, { top: 660, bottom: 690 });
  await page.window.emit('resize');
  assert.equal(page.learnAction.hidden, false);
  assert.equal(page.requests.length, 0);
});

test('a mouse action near the first line of a selected paragraph avoids all selected lines within the viewport', async () => {
  for (const scenario of [
    { width: 900, height: 700, firstTop: 200, expectedTop: 148 },
    { width: 900, height: 700, firstTop: 20, expectedTop: 115 },
    { width: 320, height: 320, firstTop: 200, expectedTop: 148 },
  ]) {
    const page = createPage();
    page.window.innerWidth = scenario.width;
    page.window.innerHeight = scenario.height;
    page.learnAction.rect = { left: 0, right: 130, top: 0, bottom: 42, width: 130, height: 42 };
    const source = page.addSource('Selecting a whole paragraph must leave its selected text readable.');
    const rects = [0, 30, 60].map(offset => ({ left: 80, right: 300, top: scenario.firstTop + offset,
      bottom: scenario.firstTop + offset + 25, width: 220, height: 25 }));
    const rect = { ...rects[0], bottom: rects[2].bottom, height: rects[2].bottom - rects[0].top };
    await page.document.emit('pointerdown', { target: source.display, pointerType: 'mouse', button: 0, detail: 3,
      clientX: 100, clientY: scenario.firstTop + 10 });
    await page.selectAdditional(source, 0, source.display.textContent.length, { rect, rects });
    await page.document.emit('pointerup', { target: source.display, pointerType: 'mouse', button: 0, detail: 3,
      clientX: 100, clientY: scenario.firstTop + 10 });
    assert.equal(page.learnAction.hidden, false);
    const left = Number.parseFloat(page.learnAction.style.left);
    const top = Number.parseFloat(page.learnAction.style.top);
    assert.equal(top, scenario.expectedTop);
    for (const line of rects) {
      const overlaps = left < line.right && left + 130 > line.left && top < line.bottom && top + 42 > line.top;
      assert.equal(overlaps, false, 'the floating action cannot cover any selected paragraph line');
    }
    assert.ok(left >= 12 && left + 130 <= scenario.width - 12);
    assert.ok(top >= 12 && top + 42 <= scenario.height - 12);
    assert.equal(page.requests.length, 0);
  }
});

test('inspecting an already open desktop result preserves expanded learning without another request', async () => {
  const page = createPage();
  await page.selectDisplay('A phrase to study.');
  await page.learnSelection();
  await page.expandButton.emit('click');
  assert.equal(page.detailsContainer.hidden, false);
  await page.document.emit('selectionchange');
  await page.doubleClick();
  assert.equal(page.detailsContainer.hidden, false);
  assert.equal(page.popup.hidden, false);
  assert.equal(page.learnAction.hidden, true);
  assert.equal(page.requests.length, 1);
});

test('a desktop textarea action anchors to the released mouse position and follows its input while scrolling', async () => {
  const page = createPage();
  page.input.rect = { left: 100, right: 700, top: 80, bottom: 500, width: 600, height: 420 };
  page.learnAction.rect = { left: 0, right: 130, top: 0, bottom: 42, width: 130, height: 42 };
  await page.document.emit('pointerdown', { target: page.input, pointerType: 'mouse', button: 0,
    clientX: 250, clientY: 180 });
  await page.selectInput('First line. Selected phrase. Last line.', 12, 28);
  assert.equal(page.learnAction.hidden, true);
  await page.document.emit('pointerup', { target: page.input, pointerType: 'mouse', button: 0,
    clientX: 560, clientY: 300 });
  assert.equal(page.learnAction.hidden, false);
  assert.equal(page.learnAction.style.left, '560px');
  assert.equal(page.learnAction.style.top, '310px', 'the action is near the selected text rather than the bottom of the input');
  Object.assign(page.input.rect, { top: 40, bottom: 460 });
  await page.window.emit('scroll');
  assert.equal(page.learnAction.style.left, '560px');
  assert.equal(page.learnAction.style.top, '270px', 'scrolling preserves the anchor inside the input');
  assert.equal(page.requests.length, 0);
  let prevented = false;
  await page.learnButton.emit('pointerdown', { pointerType: 'mouse', button: 0,
    preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'clicking the action preserves the native input range');
  await page.learnButton.emit('click');
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].text, 'Selected phrase.');
  assert.equal(page.input.selectionStart, 12);
  assert.equal(page.input.selectionEnd, 28);
});

test('native textarea selection is translated only after clicking the action and retains focus', async () => {
  const page = createPage();
  await page.selectInput('first selected phrase last', 6, 21);
  assert.equal(page.requests.length, 0);
  await page.learnInput();
  assert.equal(page.requests[0].text, 'selected phrase');
  assert.equal(page.document.activeElement, page.input);
  assert.equal(page.input.selectionStart, 6);
  assert.equal(page.input.selectionEnd, 21);
});

test('visible display selection wins over an old selected textarea that retains focus', async () => {
  const page = createPage();
  await page.selectInput('Old textarea words.');
  await page.selectDisplay('Visible article phrase.');
  page.document.activeElement = page.input;
  await page.learnSelection();
  assert.equal(page.requests[0].text, 'Visible article phrase.');
});

test('non-English, empty and selections outside the practice text make no request', async () => {
  const page = createPage();
  for (const text of [' ', '123!?', '中文']) {
    await page.selectDisplay(text);
    await page.doubleClick();
  }
  await page.outsideSelection('Outside the article.');
  await page.doubleClick();
  assert.equal(page.requests.length, 0);
  assert.equal(page.popup.hidden, true);
});

test('in-flight identical requests and completed translations are reused', async () => {
  const waiting = deferred();
  const page = createPage({ fetcher: () => waiting.promise });
  await page.selectDisplay('Reuse this phrase.');
  const first = page.learnSelection();
  await page.selectDisplay('A different selection.');
  await page.selectDisplay('Reuse this phrase.');
  const second = page.learnSelection();
  assert.equal(page.requests.length, 1);
  waiting.resolve('重复使用译文。');
  await Promise.all([first, second]);
  page.controller.close();
  await page.document.emit('pointerdown', { target: page.display, pointerType: 'mouse', button: 0 });
  await page.selectDisplay('Reuse this phrase.');
  await page.document.emit('pointerup', { target: page.display, pointerType: 'mouse', button: 0 });
  assert.equal(page.learnAction.hidden, false);
  await page.learnSelection();
  assert.equal(page.requests.length, 1);
  assert.equal(page.popup.hidden, false);
  assert.equal(page.translationLabel.textContent, '重复使用译文。');
});

test('changing selection hides stale results and only a new explicit action can fetch', async () => {
  const waiting = deferred();
  const page = createPage({ fetcher: text => text === 'Old phrase.' ? waiting.promise
    : { ok: true, json: async () => analysisResponse('新译文。') } });
  await page.selectDisplay('Old phrase.');
  const pending = page.learnSelection();
  await page.selectDisplay('New phrase.');
  assert.equal(page.popup.hidden, true);
  assert.equal(page.requests.length, 1);
  await page.learnSelection();
  waiting.resolve('过期译文。');
  await pending;
  assert.equal(page.translationLabel.textContent, '新译文。');
  assert.equal(page.sourceLabel.textContent, 'New phrase.');
});

test('typing, reset, outside click, Escape and inactive mode invalidate pending results', async () => {
  const actions = [
    page => page.input.emit('input'),
    page => page.controller.reset(),
    page => page.document.emit('pointerdown', { target: {} }),
    page => page.document.emit('keydown', { key: 'Escape' }),
    page => { page.active(false); page.controller.close(); },
    page => page.controller.prepareForInput(),
  ];
  for (const action of actions) {
    const waiting = deferred();
    const page = createPage({ fetcher: () => waiting.promise });
    await page.selectDisplay('Pending phrase.');
    const pending = page.learnSelection();
    await action(page);
    waiting.resolve('不得显示。');
    await pending;
    assert.equal(page.popup.hidden, true);
    assert.equal(page.translationLabel.textContent, '');
  }
});

test('oversized selections and file pages explain the next step without fetching', async () => {
  const page = createPage();
  await page.selectDisplay('x'.repeat(2001));
  await page.learnSelection();
  assert.match(page.statusLabel.textContent, /2000/);
  assert.equal(page.requests.length, 0);
  const local = createPage({ protocol: 'file:' });
  await local.selectDisplay('Example phrase.');
  await local.learnSelection();
  assert.match(local.statusLabel.textContent, /启动翻译\.cmd/);
  assert.match(local.statusLabel.textContent, /127\.0\.0\.1:4173/);
  assert.equal(local.requests.length, 0);
});

test('HTTP failure shows a safe message and retry keeps the selected phrase', async () => {
  let calls = 0;
  const page = createPage({ fetcher: () => ++calls === 1
    ? { ok: false, status: 503, json: async () => ({ error: 'secret upstream details'.repeat(30) }) }
    : { ok: true, json: async () => analysisResponse('成功。') } });
  await page.selectDisplay('Try again.');
  await page.learnSelection();
  assert.equal(page.retryButton.hidden, false);
  assert.match(page.statusLabel.textContent, /尚未配置/);
  assert.doesNotMatch(page.statusLabel.textContent, /secret/);
  let prevented = false;
  await page.retryButton.emit('pointerdown', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  await page.selectPopup('Try again.');
  await page.retryButton.emit('click');
  assert.equal(page.requests.length, 2);
  assert.equal(page.translationLabel.textContent, '成功。');
  assert.equal(page.retryButton.hidden, true);
});

test('short server explanations distinguish insufficient balance from configuration errors', async () => {
  const page = createPage({ fetcher: () => ({ ok: false, status: 503,
    json: async () => ({ error: '翻译账户余额不足，请充值后重试。' }) }) });
  await page.selectDisplay('Translate this.');
  await page.learnSelection();
  assert.equal(page.statusLabel.textContent, '翻译账户余额不足，请充值后重试。');
  assert.equal(page.retryButton.hidden, false);
});

test('selecting and copying Chinese inside the popup leaves the translation visible', async () => {
  const page = createPage();
  await page.selectDisplay('Copy the Chinese translation.');
  await page.learnSelection();
  const text = page.translationLabel.textContent;
  await page.document.emit('pointerdown', { target: page.translationLabel, detail: 1 });
  await page.selectPopup(text);
  await page.document.emit('keydown', { target: page.translationLabel, key: 'c', ctrlKey: true });
  assert.equal(page.popup.hidden, false);
  assert.equal(page.translationLabel.textContent, text);
  assert.equal(page.requests.length, 1);
});

test('selecting popup source while translation is loading does not discard its response', async () => {
  const waiting = deferred();
  const page = createPage({ fetcher: () => waiting.promise });
  await page.selectDisplay('Wait for this translation.');
  const pending = page.learnSelection();
  await page.selectPopup('Wait for this translation.');
  waiting.resolve('等待这段译文。');
  await pending;
  assert.equal(page.popup.hidden, false);
  assert.equal(page.translationLabel.textContent, '等待这段译文。');
  assert.equal(page.requests.length, 1);
});

test('returned markup is assigned as plain text and malformed responses remain retryable', async () => {
  const safe = createPage({ fetcher: () => ({ ok: true, json: async () => analysisResponse('<img src=x onerror=alert(1)>') }) });
  await safe.selectDisplay('Markup.');
  await safe.learnSelection();
  assert.equal(safe.translationLabel.textContent, '<img src=x onerror=alert(1)>');
  const invalid = createPage({ fetcher: () => ({ ok: true, json: async () => ({ translation: 42 }) }) });
  await invalid.selectDisplay('Invalid.');
  await invalid.learnSelection();
  assert.equal(invalid.retryButton.hidden, false);
  assert.match(invalid.statusLabel.textContent, /有效学习分析/);
});

test('desktop popover fits the viewport and repositions on resize and nested scrolling', async () => {
  const page = createPage();
  page.window.innerWidth = 700;
  page.window.innerHeight = 400;
  await page.selectDisplay('Near the edge.', { left: 690, top: 350, bottom: 375, width: 20, height: 25 });
  await page.learnSelection();
  assert.equal(page.popup.style.left, '358px');
  assert.equal(page.popup.style.top, '150px');
  page.window.innerHeight = 700;
  await page.window.emit('resize');
  assert.equal(page.popup.style.top, '385px');
  await page.window.emit('scroll');
  assert.equal(page.popup.style.left, '358px');
});

test('cached entries are bounded and oldest entries are re-requested after 100 distinct phrases', async () => {
  const page = createPage();
  for (let i = 0; i < 101; i += 1) {
    await page.selectDisplay(`Phrase ${i}.`);
    await page.learnSelection();
  }
  await page.selectDisplay('Phrase 0.');
  await page.learnSelection();
  assert.equal(page.requests.length, 102);
});

test('public selection snapshots can preserve a phrase and inactive mode blocks new requests', async () => {
  const page = createPage();
  await page.controller.translateSelection({ text: '  Preserved phrase.  ', rect: { left: 20, top: 50, bottom: 75, width: 100, height: 25 } });
  assert.equal(page.requests[0].text, 'Preserved phrase.');
  assert.equal(page.translationLabel.textContent, '中文：Preserved phrase.');
  assert.equal(page.popup.style.left, '20px');
  page.active(false);
  page.controller.reset();
  await page.controller.translateSelection({ text: 'No request.' });
  assert.equal(page.requests.length, 1);
  assert.equal(page.popup.hidden, true);
});

test('word, sentence and passage analyses render brief rows and collapsed learning details', async () => {
  for (const [type, label, text] of [
    ['word', '单词', 'progress'], ['sentence', '句子', 'Small efforts lead to progress.'],
    ['passage', '多句或段落', 'Small efforts matter. Regular practice helps.'],
  ]) {
    const page = createPage({ fetcher: () => ({ ok: true, json: async () => analysisResponse('中文说明。', type) }) });
    await page.selectDisplay(text);
    await page.learnSelection();
    assert.equal(page.typeLabel.textContent, label);
    assert.equal(page.briefContainer.childNodes.length, 1);
    assert.equal(page.briefContainer.childNodes[0].className, 'selection-analysis-row');
    assert.equal(page.briefContainer.childNodes[0].childNodes[0].className, 'selection-analysis-label');
    assert.equal(page.briefContainer.childNodes[0].childNodes[1].className, 'selection-analysis-value');
    assert.equal(page.detailsContainer.hidden, true);
    assert.equal(page.expandButton.hidden, false);
    assert.equal(page.expandButton.textContent, '展开学习');
    assert.equal(page.expandButton.attributes.get('aria-expanded'), 'false');
    assert.equal(page.expandButton.attributes.get('aria-controls'), 'analysis-details');
  }
});

test('older cached usage and warning rows move into collapsed learning without changing the response', async () => {
  const payload = analysisResponse('进步。', 'word', {
    brief: [
      { label: '语境意思', text: '这里表示学习上的进步。' },
      { label: '**核心用法：**', text: 'progress 作不可数名词。' },
      { label: '`易错提醒:`', text: '说 make progress，不加 a。' },
    ],
  });
  const before = structuredClone(payload);
  const page = createPage({ fetcher: () => ({ ok: true, json: async () => payload }) });
  const labels = container => Array.from(container.childNodes, row => row.childNodes[0].textContent);
  await page.selectDisplay('progress');
  await page.learnSelection();
  assert.deepEqual(labels(page.briefContainer), ['语境意思']);
  assert.deepEqual(labels(page.detailsContainer), ['**核心用法：**', '`易错提醒:`', '仿写任务']);
  assert.equal(page.detailsContainer.hidden, true);
  await page.expandButton.emit('click');
  assert.equal(page.detailsContainer.hidden, false);
  assert.equal(page.requests.length, 1);
  await page.closeButton.emit('click');
  await page.document.emit('pointerdown', { target: page.display, pointerType: 'mouse', button: 0 });
  await page.selectDisplay('progress');
  await page.document.emit('pointerup', { target: page.display, pointerType: 'mouse', button: 0 });
  assert.equal(page.learnAction.hidden, false);
  await page.learnSelection();
  assert.equal(page.popup.hidden, false);
  assert.equal(page.detailsContainer.hidden, true);
  assert.equal(page.detailsContainer.childNodes.length, 3);
  assert.equal(page.requests.length, 1);
  assert.deepEqual(payload, before);
});

test('a brief made entirely of usage and warning rows leaves only the translation above the expand button', async () => {
  const page = createPage({ fetcher: () => ({ ok: true, json: async () => analysisResponse('进步。', 'word', {
    brief: [{ label: '核心用法', text: '不可数名词。' }, { label: '易错提醒', text: '不要加 a。' }],
  }) }) });
  await page.selectDisplay('progress');
  await page.learnSelection();
  assert.equal(page.translationLabel.textContent, '进步。');
  assert.equal(page.briefContainer.childNodes.length, 0);
  assert.equal(page.detailsContainer.childNodes.length, 3);
  assert.equal(page.detailsContainer.hidden, true);
  assert.equal(page.expandButton.hidden, false);
  await page.expandButton.emit('click');
  assert.equal(page.detailsContainer.hidden, false);
  assert.equal(page.requests.length, 1);
});

test('expanding and collapsing learning details makes no extra request and new selections reset expansion', async () => {
  const page = createPage();
  await page.selectDisplay('First learning phrase.');
  await page.learnSelection();
  await page.expandButton.emit('click');
  assert.equal(page.detailsContainer.hidden, false);
  assert.equal(page.expandButton.textContent, '收起学习');
  assert.equal(page.expandButton.attributes.get('aria-expanded'), 'true');
  await page.expandButton.emit('click');
  assert.equal(page.detailsContainer.hidden, true);
  assert.equal(page.requests.length, 1);
  await page.expandButton.emit('click');
  await page.selectDisplay('A different learning phrase.');
  await page.learnSelection();
  assert.equal(page.detailsContainer.hidden, true);
  assert.equal(page.expandButton.attributes.get('aria-expanded'), 'false');
  assert.equal(page.requests.length, 2);
});

test('rendered markup in brief and detail entries remains ordinary text', async () => {
  const marker = '<script>alert(1)</script>';
  const page = createPage({ fetcher: () => ({ ok: true, json: async () => analysisResponse(marker, 'word', {
    brief: [{ label: marker, text: marker }], details: [{ label: marker, text: marker }],
  }) }) });
  await page.selectDisplay('word');
  await page.learnSelection();
  assert.equal(page.briefContainer.childNodes[0].childNodes[0].textContent, marker);
  assert.equal(page.detailsContainer.childNodes[0].childNodes[1].textContent, marker);
  assert.equal(page.briefContainer.childNodes[0].childNodes[0].childNodes.length, 0);
});

test('duplicate words in different locations receive their own sentence and paragraph context', async () => {
  const source = 'Students make progress through practice.\n\nTechnology can accelerate progress in medicine.';
  const page = createPage({ source });
  const first = source.indexOf('progress');
  const second = source.lastIndexOf('progress');
  await page.selectRange(first, first + 8);
  await page.learnSelection();
  assert.equal(page.requests[0].context.sentence, 'Students make progress through practice.');
  assert.equal(page.requests[0].context.paragraph, 'Students make progress through practice.');
  await page.selectRange(second, second + 8);
  assert.equal(page.popup.hidden, true);
  await page.learnSelection();
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[1].context.sentence, 'Technology can accelerate progress in medicine.');
  assert.equal(page.requests[1].context.paragraph, 'Technology can accelerate progress in medicine.');
  await page.selectRange(first, first + 8);
  await page.learnSelection();
  assert.equal(page.requests.length, 2);
});

test('sentence and multi-sentence selections include enclosing context without locating by text search', async () => {
  const source = 'Practice matters. Small efforts bring progress. Keep going.\n\nA final paragraph.';
  const page = createPage({ source });
  const start = source.indexOf('Small');
  const end = source.indexOf('\n');
  await page.selectRange(start, end);
  await page.learnSelection();
  assert.equal(page.requests[0].text, 'Small efforts bring progress. Keep going.');
  assert.equal(page.requests[0].context.sentence, 'Small efforts bring progress. Keep going.');
  assert.equal(page.requests[0].context.paragraph, 'Practice matters. Small efforts bring progress. Keep going.');
});

test('native textarea positions attach the correct occurrence and preserve internal whitespace', async () => {
  const source = 'First progress.\n\nSecond progress with  two spaces.';
  const page = createPage({ source });
  const start = source.lastIndexOf('progress');
  await page.selectInput(source, start, source.length);
  await page.learnInput();
  assert.equal(page.requests[0].text, 'progress with  two spaces.');
  assert.equal(page.requests[0].context.sentence, 'Second progress with  two spaces.');
});

test('character spans map Unicode offsets despite an earlier typo with a different length', async () => {
  const source = 'A😀 word.\n\nAnother word.';
  const actual = 'A? word.\n\nAnother word.';
  const page = createPage({ source });
  const start = actual.indexOf('word');
  await page.selectRange(start, start + 4, actual);
  await page.learnSelection();
  assert.equal(page.requests[0].context.sentence, 'A😀 word.');
  const second = actual.lastIndexOf('word');
  await page.selectRange(second, second + 4, actual);
  await page.learnSelection();
  assert.equal(page.requests[1].context.sentence, 'Another word.');
});

test('unknown or mismatching selection positions safely send empty context', async () => {
  const page = createPage({ source: 'The reference is correct.' });
  await page.selectDisplay('unknown phrase');
  await page.learnSelection();
  assert.deepEqual(page.requests[0].context, { sentence: '', paragraph: '' });
  await page.selectRange(4, 13, 'The different is correct.');
  await page.learnSelection();
  assert.deepEqual(page.requests[1].context, { sentence: '', paragraph: '' });
});

test('long contexts are bounded and explicitly marked as truncated', async () => {
  const source = `${'earlier '.repeat(500)}target${' later'.repeat(500)}`;
  const page = createPage({ source });
  const start = source.indexOf('target');
  await page.selectRange(start, start + 6);
  await page.learnSelection();
  assert.ok(page.requests[0].context.sentence.length <= 1200);
  assert.ok(page.requests[0].context.paragraph.length <= 3000);
  assert.match(page.requests[0].context.sentence, /前文已截断/);
  assert.match(page.requests[0].context.paragraph, /后文已截断/);
  assert.match(page.requests[0].context.paragraph, /target/);
});

test('whitespace and outside document selections suppress an old focused English textarea selection', async () => {
  const page = createPage();
  await page.selectInput('Old selected English.');
  for (const text of ['  \n\t ', '中文', '123!?']) {
    await page.selectDisplay(text);
    page.document.activeElement = page.input;
    await page.doubleClick();
  }
  await page.outsideSelection('Outside English.');
  page.document.activeElement = page.input;
  await page.doubleClick();
  assert.equal(page.requests.length, 0);
  assert.equal(page.popup.hidden, true);
});

test('invalid analysis type or empty rows are retryable and failed results are not cached', async () => {
  for (const extras of [{ type: 'unknown' }, { brief: [] }, { details: [] }, { brief: [{ label: '', text: 'text' }] },
    { details: [{ label: 'label', text: 42 }] }, { translation: '' }]) {
    let calls = 0;
    const page = createPage({ fetcher: () => ({ ok: true, json: async () => ++calls === 1
      ? analysisResponse('译文。', 'word', extras) : analysisResponse('恢复成功。', 'word') }) });
    await page.selectDisplay('word');
    await page.learnSelection();
    assert.equal(page.retryButton.hidden, false);
    assert.equal(page.expandButton.hidden, true);
    await page.retryButton.emit('click');
    assert.equal(page.translationLabel.textContent, '恢复成功。');
    assert.equal(page.requests.length, 2);
  }
});

test('analysis remains usable without optional learning-panel elements', async () => {
  const page = createPage({ optionalUI: false });
  await page.selectDisplay('Compatible phrase.');
  await page.learnSelection();
  assert.equal(page.translationLabel.textContent, '中文：Compatible phrase.');
  assert.equal(page.retryButton.hidden, true);
});

test('keyboard focus inside the popup keeps a pending native-input analysis and permits expansion', async () => {
  const waiting = deferred();
  const page = createPage({ fetcher: () => waiting.promise });
  await page.selectInput('Native selected phrase.');
  const pending = page.learnInput();
  page.document.activeElement = page.closeButton;
  await page.clearSelection();
  assert.equal(page.popup.hidden, false);
  waiting.resolve('键盘可以操作浮窗。');
  await pending;
  assert.equal(page.translationLabel.textContent, '键盘可以操作浮窗。');
  page.document.activeElement = page.expandButton;
  await page.document.emit('selectionchange');
  await page.expandButton.emit('click');
  assert.equal(page.popup.hidden, false);
  assert.equal(page.detailsContainer.hidden, false);
  assert.equal(page.requests.length, 1);
});

test('retry from popup keyboard focus retains the selected text and moves focus before hiding the button', async () => {
  let calls = 0;
  const page = createPage({ fetcher: () => ++calls === 1 ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, json: async () => analysisResponse('重试成功。') } });
  await page.selectInput('Retry native selection.');
  await page.learnInput();
  page.document.activeElement = page.retryButton;
  await page.clearSelection();
  assert.equal(page.popup.hidden, false);
  await page.retryButton.emit('click');
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[1].text, 'Retry native selection.');
  assert.equal(page.translationLabel.textContent, '重试成功。');
  assert.equal(page.document.activeElement, page.closeButton);
});

test('a temporarily collapsed selection while starting to copy popup text keeps the pending analysis', async () => {
  const waiting = deferred();
  const page = createPage({ fetcher: () => waiting.promise });
  await page.selectDisplay('Copy after waiting.');
  const pending = page.learnSelection();
  await page.document.emit('pointerdown', { target: page.sourceLabel });
  await page.clearSelection();
  assert.equal(page.popup.hidden, false);
  waiting.resolve('选择浮窗文字前不收起。');
  await pending;
  assert.equal(page.translationLabel.textContent, '选择浮窗文字前不收起。');
  await page.selectPopup(page.translationLabel.textContent);
  assert.equal(page.popup.hidden, false);
  await page.outsideSelection('A different external selection.');
  assert.equal(page.popup.hidden, true);
});

test('a new whitespace source selection still dismisses a previously engaged popup without any request', async () => {
  const page = createPage();
  await page.selectDisplay('First phrase.');
  await page.learnSelection();
  await page.document.emit('pointerdown', { target: page.translationLabel });
  await page.clearSelection();
  assert.equal(page.popup.hidden, false);
  await page.selectDisplay('   ');
  assert.equal(page.popup.hidden, true);
  await page.learnSelection();
  assert.equal(page.requests.length, 1);
});

test('additional sentence references analyse only after the learning action and include their full-article context', async () => {
  const article = 'Practice brings progress.\n\nTechnology accelerates progress in medicine.';
  const page = createPage({ source: article });
  page.primaryActive(false);
  const first = page.addSource('Practice brings progress.', { article });
  const secondText = 'Technology accelerates progress in medicine.';
  const second = page.addSource(secondText, { article, offset: article.indexOf(secondText) });
  await page.selectAdditional(first, 16, 24);
  assert.equal(page.requests.length, 0);
  await page.learnAdditional(first);
  assert.equal(page.requests[0].text, 'progress');
  assert.equal(page.requests[0].context.sentence, 'Practice brings progress.');
  await page.selectAdditional(second, 23, 31);
  assert.equal(page.popup.hidden, true);
  await page.learnAdditional(second);
  assert.equal(page.requests[1].text, 'progress');
  assert.equal(page.requests[1].context.paragraph, secondText);
  assert.equal(page.requests.length, 2);
  await page.selectAdditional(first, 16, 24);
  await page.learnAdditional(first);
  assert.equal(page.requests.length, 2);
});

test('group-local selections map to original article offsets across normalised sentence whitespace', async () => {
  const article = 'Introduction.\n\nFirst sentence.   \nSecond sentence.\n\nConclusion.';
  const text = 'First sentence. Second sentence.';
  const page = createPage();
  const calls = [];
  const firstStart = article.indexOf('First');
  const secondStart = article.indexOf('Second');
  const source = page.addSource(text, { mapRange: (start, end) => {
    calls.push([start, end]);
    return { source: article, start: firstStart + start,
      end: secondStart + end - text.indexOf('Second') };
  } });
  await page.selectAdditional(source, 0, text.length, { rawText: text });
  await page.learnAdditional(source);
  assert.deepEqual(calls[0], [0, text.length]);
  assert.equal(page.requests[0].text, text);
  assert.equal(page.requests[0].context.paragraph, 'First sentence.   \nSecond sentence.');
  assert.equal(page.requests[0].context.sentence, 'First sentence.   \nSecond sentence.');
});

test('additional selection mapping trims only selection edges and preserves local internal whitespace', async () => {
  const page = createPage();
  const text = '  Words with  two spaces.  ';
  const calls = [];
  const source = page.addSource(text, { mapRange: (start, end) => {
    calls.push([start, end]);
    return { source: text, start, end };
  } });
  await page.selectAdditional(source);
  await page.learnAdditional(source);
  assert.deepEqual(calls[0], [2, text.length - 2]);
  assert.equal(page.requests[0].text, 'Words with  two spaces.');
});

test('cross-reference, hidden-reference and non-reference double-clicks make no request', async () => {
  const page = createPage();
  const first = page.addSource('First reference.');
  const second = page.addSource('Second reference.');
  await page.crossSourceSelection(first, second);
  await page.doubleClickAdditional(first);
  await page.selectAdditional(first);
  await page.document.emit('dblclick', { target: {} });
  await page.document.emit('dblclick', { target: first.area });
  first.display.hidden = true;
  await page.doubleClickAdditional(first);
  first.display.hidden = false;
  first.area.hidden = true;
  await page.doubleClickAdditional(first);
  first.area.hidden = false;
  page.removeSource(first);
  await page.doubleClickAdditional(first);
  assert.equal(page.requests.length, 0);
});

test('native paragraph selection can include a neighboring block boundary containing only rendered newlines', async () => {
  const article = 'Earlier context.\n\nLearning a language rewards patience and regular practice.\n\nLater context.';
  const text = 'Learning a language rewards patience and regular practice.';
  for (const gesture of [{ edge: 'end' }, { edge: 'start', reverse: true }]) {
    const page = createPage({ source: article });
    page.primaryActive(false);
    const source = page.addSource(text, { article, offset: article.indexOf(text) });
    await page.document.emit('pointerdown', { target: source.display, pointerType: 'mouse', button: 0, detail: 3 });
    await page.selectAcrossBoundary(source, gesture);
    assert.equal(page.learnAction.hidden, true, 'the native paragraph gesture completes before showing the action');
    await page.document.emit('pointerup', { target: source.display, pointerType: 'mouse', button: 0, detail: 3 });
    assert.equal(page.learnAction.hidden, false, 'rendered block whitespace does not suppress a valid paragraph');
    assert.equal(page.requests.length, 0);
    assert.equal(page.popup.hidden, true);
    assert.equal(page.window.getSelection().toString(), gesture.edge === 'end' ? `${text}\n\n` : `\n\n${text}`,
      'cropping analysis boundaries must not mutate the learner\'s native selection');
    await page.learnButton.emit('click');
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].text, text);
    assert.equal(page.requests[0].context.sentence, text);
    assert.equal(page.requests[0].context.paragraph, text);
  }
});

test('paragraph boundary normalization never crops meaningful outside text into a valid reference selection', async () => {
  for (const gesture of [{ edge: 'end', outsideText: '\n\nYour input' },
    { edge: 'start', reverse: true, outsideText: 'Outside heading\n\n' }]) {
    const page = createPage();
    await page.selectInput('An older selected textarea phrase.');
    const source = page.addSource('Learning a language rewards regular practice.');
    await page.selectAcrossBoundary(source, gesture);
    page.document.activeElement = page.input;
    await page.document.emit('selectionchange');
    await page.doubleClickAdditional(source);
    assert.equal(page.learnAction.hidden, true);
    assert.equal(page.requests.length, 0);
    await page.learnButton.emit('click');
    assert.equal(page.requests.length, 0, 'neither cropped reference text nor stale textarea text can be submitted');
    assert.equal(page.popup.hidden, true);
  }
});

test('extra references filter whitespace, Chinese, numbers and symbols before requesting', async () => {
  for (const text of ['   \n\t ', '纯中文', '12345', '!?…']) {
    const page = createPage();
    const source = page.addSource(text);
    await page.selectAdditional(source);
    await page.learnAdditional(source);
    assert.equal(page.requests.length, 0);
    assert.equal(page.popup.hidden, true);
  }
});

test('native reference pointer actions remain unblocked before explicitly learning a selected phrase', async () => {
  const page = createPage();
  const source = page.addSource('An entire sentence for learning.');
  await page.selectAdditional(source);
  let prevented = false;
  await page.document.emit('pointerdown', { target: source.display.childNodes[0], button: 0,
    clientX: 100, clientY: 220, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  await page.selectAdditional(source);
  assert.equal(page.document.activeElement, source.display);
  assert.equal(page.requests.length, 0);
  assert.equal(page.learnAction.hidden, true, 'dragging cannot expose a button in the selection path');
  await page.document.emit('pointerup', { target: source.display, button: 0, clientX: 220, clientY: 220 });
  assert.equal(page.learnAction.hidden, false);
  await page.learnAdditional(source);
  assert.equal(page.requests[0].text, 'An entire sentence for learning.');
  assert.equal(page.document.activeElement, source.display);
});

test('pointer actions outside an extra selection or using a secondary button retain their normal behavior', async () => {
  const page = createPage();
  const source = page.addSource('Selected sentence.');
  await page.selectAdditional(source);
  for (const properties of [{ button: 0, clientX: 20, clientY: 220 }, { button: 2, clientX: 100, clientY: 220 }]) {
    let prevented = false;
    await page.document.emit('pointerdown', { target: source.display, ...properties,
      preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
  }
  assert.equal(page.requests.length, 0);
});

test('inactive primary typing selections cannot request or override active sentence references', async () => {
  const page = createPage();
  await page.selectInput('Old realtime selection.');
  page.primaryActive(false);
  await page.learnInput();
  await page.learnSelection();
  assert.equal(page.requests.length, 0);
  const source = page.addSource('Current sentence reference.');
  await page.selectAdditional(source);
  page.document.activeElement = page.input;
  await page.learnAdditional(source);
  assert.equal(page.requests[0].text, 'Current sentence reference.');
  await page.learnSelection();
  assert.equal(page.requests.length, 1);
});

test('additional popup positioning uses the selected reference area when Range geometry is empty', async () => {
  const page = createPage();
  const first = page.addSource('First position.');
  const second = page.addSource('Second position.');
  first.area.rect = { left: 70, top: 100, bottom: 140, width: 200, height: 40 };
  second.area.rect = { left: 450, top: 300, bottom: 340, width: 200, height: 40 };
  const rect = { left: 0, top: 0, bottom: 0, width: 0, height: 0 };
  await page.selectAdditional(first, 0, first.display.textContent.length, { rect });
  await page.learnAdditional(first);
  assert.equal(page.popup.style.left, '70px');
  assert.equal(page.popup.style.top, '150px');
  await page.selectAdditional(second, 0, second.display.textContent.length, { rect });
  await page.learnAdditional(second);
  assert.equal(page.popup.style.left, '450px');
  assert.equal(page.popup.style.top, '350px');
});

test('hidden, removed or reset additional sources cannot display pending responses even while the popup is engaged', async () => {
  for (const deactivate of [source => { source.display.hidden = true; },
    (source, page) => page.removeSource(source), (source, page) => page.controller.reset()]) {
    const waiting = deferred();
    const page = createPage({ fetcher: () => waiting.promise });
    const source = page.addSource('Pending extra reference.');
    await page.selectAdditional(source);
    const pending = page.learnAdditional(source);
    await page.document.emit('pointerdown', { target: page.sourceLabel });
    await page.selectPopup('Pending extra reference.');
    deactivate(source, page);
    await page.document.emit('selectionchange');
    waiting.resolve('不得显示过期结果。');
    await pending;
    assert.equal(page.popup.hidden, true);
    assert.equal(page.translationLabel.textContent, '');
  }
});

test('unreliable local ranges and invalid article mappings safely omit context', async () => {
  const page = createPage();
  let mappingCalls = 0;
  const source = page.addSource('Correct source phrase.', { mapRange: () => {
    mappingCalls += 1;
    return { source: 'Original article.', start: -1, end: 100 };
  } });
  await page.selectAdditional(source, 0, 7, { rawText: 'Changed' });
  await page.learnAdditional(source);
  assert.equal(mappingCalls, 0);
  assert.deepEqual(page.requests[0].context, { sentence: '', paragraph: '' });
  await page.selectAdditional(source);
  await page.learnAdditional(source);
  assert.ok(mappingCalls > 0);
  assert.deepEqual(page.requests[1].context, { sentence: '', paragraph: '' });
});

test('extra-source popup details expand and copy without another request', async () => {
  const page = createPage();
  const source = page.addSource('Learn from this sentence.');
  await page.selectAdditional(source);
  await page.learnAdditional(source);
  await page.expandButton.emit('click');
  assert.equal(page.detailsContainer.hidden, false);
  await page.selectPopup('结合当前语境理解。');
  await page.document.emit('keydown', { target: page.popup, key: 'c', ctrlKey: true });
  assert.equal(page.popup.hidden, false);
  assert.equal(page.requests.length, 1);
});

test('touch-capable and coarse-pointer devices expose learning only after selecting English', async () => {
  for (const capability of [{ touchPoints: 5 }, { coarsePointer: true }]) {
    const page = createPage(capability);
    assert.equal(page.learnAction.hidden, true);
    await page.selectDisplay('Choose this English phrase.');
    assert.equal(page.learnAction.hidden, false);
    assert.equal(page.popup.hidden, true);
    assert.equal(page.requests.length, 0);
    await page.clearSelection();
    assert.equal(page.learnAction.hidden, true);
  }
});

test('touch, pen and mouse interactions require the same explicit learning action', async () => {
  for (const pointerType of ['touch', 'pen']) {
    const page = createPage();
    await page.document.emit('pointerdown', { target: page.display, pointerType });
    await page.selectDisplay('Touch selected English.');
    assert.equal(page.learnAction.hidden, false);
    assert.equal(page.requests.length, 0);
    await page.document.emit('pointerdown', { target: page.display, pointerType: 'mouse' });
    await page.document.emit('selectionchange');
    assert.equal(page.learnAction.hidden, true, 'the action waits for the mouse selection gesture to finish');
    await page.document.emit('pointerup', { target: page.display, pointerType: 'mouse' });
    assert.equal(page.learnAction.hidden, false);
    await page.doubleClick();
    assert.equal(page.requests.length, 0);
    await page.learnButton.emit('click');
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].text, 'Touch selected English.');
  }
});

test('touch learning keeps a selected word and its imported sentence when tapping collapses the native range', async () => {
  const article = 'Practice brings progress. Technology accelerates progress in medicine.';
  const page = createPage({ source: article, touchPoints: 5 });
  const start = article.lastIndexOf('progress');
  await page.selectRange(start, start + 'progress'.length);
  assert.equal(page.learnAction.hidden, false);
  await page.pressLearnButton();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].text, 'progress');
  assert.equal(page.requests[0].context.sentence, 'Technology accelerates progress in medicine.');
  assert.equal(page.requests[0].context.paragraph, article);
  assert.equal(page.translationLabel.textContent, '中文：progress');
  assert.equal(page.popup.hidden, false);
  assert.equal(page.learnAction.hidden, true);
});

test('adjusting touch selection never requests analysis and the action uses the latest selected range', async () => {
  const article = 'Small steps lead to lasting progress.';
  const page = createPage({ source: article, touchPoints: 1 });
  await page.selectRange(0, 5);
  await page.selectRange(0, 11);
  await page.selectRange(0, article.length);
  assert.equal(page.requests.length, 0);
  assert.equal(page.popup.hidden, true);
  await page.pressLearnButton();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].text, article);
  assert.equal(page.requests[0].context.sentence, article);
});

test('touch learning rejects blank, non-English, outside and cross-reference selections', async () => {
  const page = createPage({ touchPoints: 1 });
  for (const text of [' \n\t ', '纯中文', '12345', '!?…']) {
    await page.selectDisplay(text);
    assert.equal(page.learnAction.hidden, true);
    await page.learnButton.emit('click');
  }
  const first = page.addSource('First English reference.');
  const second = page.addSource('Second English reference.');
  await page.selectAdditional(first);
  assert.equal(page.learnAction.hidden, false);
  await page.crossSourceSelection(first, second);
  assert.equal(page.learnAction.hidden, true);
  await page.learnButton.emit('click');
  await page.outsideSelection('English outside the practice source.');
  assert.equal(page.learnAction.hidden, true);
  await page.learnButton.emit('click');
  assert.equal(page.requests.length, 0);
});

test('sentence-group touch learning maps the chosen word into the original article context', async () => {
  const article = 'Practice brings progress.\n\nTechnology accelerates progress in medicine.';
  const page = createPage({ source: article, touchPoints: 5 });
  page.primaryActive(false);
  const secondText = 'Technology accelerates progress in medicine.';
  const second = page.addSource(secondText, { article, offset: article.indexOf(secondText) });
  const start = secondText.indexOf('progress');
  await page.selectAdditional(second, start, start + 'progress'.length);
  assert.equal(page.learnAction.hidden, false);
  await page.pressLearnButton();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].text, 'progress');
  assert.equal(page.requests[0].context.sentence, secondText);
  assert.equal(page.requests[0].context.paragraph, secondText);
  assert.equal(page.popup.hidden, false);
});

test('touch and pen selection handles retain their native pointer behavior inside sentence references', async () => {
  for (const pointerType of ['touch', 'pen']) {
    const page = createPage();
    const source = page.addSource('An entire sentence for learning.');
    await page.selectAdditional(source);
    let prevented = false;
    await page.document.emit('pointerdown', { target: source.display.childNodes[0], pointerType, button: 0,
      clientX: 100, clientY: 220, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(page.document.activeElement, source.display);
    assert.equal(page.requests.length, 0);
  }
});

test('input, resets, mode changes and outside actions invalidate the visible touch action', async () => {
  const actions = [
    page => page.input.emit('beforeinput'),
    page => page.input.emit('input'),
    page => page.input.emit('compositionstart'),
    page => page.controller.reset(),
    page => page.controller.prepareForInput(),
    page => { page.active(false); return page.document.emit('selectionchange'); },
    page => { page.primaryActive(false); return page.document.emit('selectionchange'); },
    page => page.document.emit('pointerdown', { target: {}, pointerType: 'touch' }),
    page => page.document.emit('keydown', { key: 'Escape' }),
    page => page.clearSelection(),
  ];
  for (const action of actions) {
    const page = createPage({ touchPoints: 1 });
    await page.selectDisplay('A selected practice phrase.');
    assert.equal(page.learnAction.hidden, false);
    await action(page);
    assert.equal(page.learnAction.hidden, true);
    await page.learnButton.emit('click');
    assert.equal(page.requests.length, 0);
  }
});

test('hidden, removed and replaced sentence references cannot submit a saved touch selection', async () => {
  const deactivate = [
    (source) => { source.display.hidden = true; },
    (source) => { source.area.hidden = true; },
    (source, page) => page.removeSource(source),
    (source) => { source.getReferenceText = () => 'A replacement reference.'; },
  ];
  for (const change of deactivate) {
    const page = createPage({ touchPoints: 1 });
    const source = page.addSource('The original English reference.');
    await page.selectAdditional(source);
    await page.learnButton.emit('pointerdown', { pointerType: 'touch' });
    change(source, page);
    await page.learnButton.emit('click');
    assert.equal(page.requests.length, 0);
    assert.equal(page.popup.hidden, true);
    assert.equal(page.learnAction.hidden, true);
  }
});

test('changing the article or hiding its display invalidates a saved primary touch selection', async () => {
  for (const change of [page => page.reference('A newly imported article.'),
    page => { page.display.hidden = true; }, page => { page.area.hidden = true; }]) {
    const page = createPage({ source: 'An original article.', touchPoints: 1 });
    await page.selectRange(0, 11);
    await page.learnButton.emit('pointerdown', { pointerType: 'touch' });
    change(page);
    await page.learnButton.emit('click');
    assert.equal(page.requests.length, 0);
    assert.equal(page.popup.hidden, true);
    assert.equal(page.learnAction.hidden, true);
  }
});

test('new touch selections and resets discard pending learning responses', async () => {
  for (const invalidate of [page => page.selectDisplay('A new selection.'), page => page.controller.reset()]) {
    const waiting = deferred();
    const page = createPage({ touchPoints: 1, fetcher: () => waiting.promise });
    await page.selectDisplay('An old pending selection.');
    const pending = page.pressLearnButton();
    // The action's native pointer/selection sequence completes before its fetch.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.requests.length, 1);
    await invalidate(page);
    waiting.resolve('不得显示过期结果。');
    await pending;
    assert.equal(page.popup.hidden, true);
    assert.equal(page.translationLabel.textContent, '');
  }
});

test('missing action markup never falls back to charging AI on double-click', async () => {
  const page = createPage({ touchUI: false });
  await page.selectDisplay('Compatible older page.');
  await page.doubleClick();
  assert.equal(page.requests.length, 0);
  assert.equal(page.popup.hidden, true);
});

test('phone learning action and bottom panel follow the visible viewport when the keyboard changes its bounds', async () => {
  const page = createPage({ touchPoints: 1,
    viewport: { width: 390, height: 400, offsetLeft: 7, offsetTop: 30 } });
  page.window.innerWidth = 900;
  page.window.innerHeight = 900;
  await page.selectDisplay('Read on a phone.');
  assert.equal(page.learnAction.style.left, '32px');
  assert.equal(page.learnAction.style.top, '378px');
  assert.equal(page.learnAction.style.width, '340px');
  await page.pressLearnButton();
  assert.equal(page.popup.style.left, '19px');
  assert.equal(page.popup.style.top, '228px');
  assert.equal(page.popup.style.width, '366px');
  assert.equal(page.popup.style.maxHeight, '260px');
  page.window.visualViewport.height = 240;
  page.window.visualViewport.offsetTop = 70;
  await page.window.visualViewport.emit('resize');
  assert.equal(page.popup.style.top, '142px');
  assert.equal(page.popup.style.maxHeight, '156px');
  page.window.visualViewport.offsetLeft = 17;
  page.window.visualViewport.offsetTop = 90;
  await page.window.visualViewport.emit('scroll');
  assert.equal(page.popup.style.left, '29px');
  assert.equal(page.popup.style.top, '162px');
  assert.equal(page.requests.length, 1);
});

test('tablet learning floats near the selection and respects the visible viewport edges', async () => {
  const page = createPage({ touchPoints: 5,
    viewport: { width: 800, height: 600, offsetLeft: 20, offsetTop: 40 } });
  await page.selectDisplay('Read on a tablet.', { left: 700, top: 500, bottom: 525, width: 100, height: 25 });
  await page.pressLearnButton();
  assert.equal(page.popup.style.left, '478px');
  assert.equal(page.popup.style.top, '300px');
  assert.equal(page.popup.style.width, '420px');
  page.window.visualViewport.height = 900;
  await page.window.visualViewport.emit('resize');
  assert.equal(page.popup.style.top, '535px');
  assert.equal(page.requests.length, 1);
});

test('native touch cancellation during a long press preserves a valid selection without translating', async () => {
  const page = createPage({ touchPoints: 1 });
  await page.selectDisplay('Long press selected English.');
  await page.document.emit('pointercancel', { pointerType: 'touch' });
  assert.equal(page.learnAction.hidden, false);
  assert.equal(page.popup.hidden, true);
  assert.equal(page.requests.length, 0);
  await page.clearSelection();
  assert.equal(page.learnAction.hidden, true);
});

test('changing a noncollapsed native selection after pressing the action cannot translate the old snapshot', async () => {
  const page = createPage({ touchPoints: 1 });
  await page.selectDisplay('The original selection.');
  await page.learnButton.emit('pointerdown', { pointerType: 'touch' });
  await page.selectDisplay('A different selection.');
  await page.learnButton.emit('click');
  assert.equal(page.requests.length, 0);
  assert.equal(page.popup.hidden, true);
  assert.equal(page.learnAction.hidden, true);
});

test('a tablet mouse can activate an action displayed by touch after native selection collapses', async () => {
  const page = createPage({ touchPoints: 5 });
  await page.selectDisplay('Use a tablet mouse.');
  assert.equal(page.learnAction.hidden, false);
  await page.learnButton.emit('pointerdown', { pointerType: 'mouse', button: 0 });
  await page.document.emit('pointerdown', { target: page.learnButton, pointerType: 'mouse', button: 0 });
  page.document.activeElement = page.learnButton;
  await page.clearSelection();
  await page.learnButton.emit('click');
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].text, 'Use a tablet mouse.');
  assert.equal(page.popup.hidden, false);
});

test('touch-generated double-clicks do not bypass the explicit learning action in either mode', async () => {
  const page = createPage({ touchPoints: 1 });
  await page.selectDisplay('Double tap on a phone.');
  await page.doubleClick();
  assert.equal(page.requests.length, 0);
  assert.equal(page.popup.hidden, true);
  assert.equal(page.learnAction.hidden, false);
  page.primaryActive(false);
  const source = page.addSource('Double tap on a sentence reference.');
  await page.selectAdditional(source);
  await page.doubleClickAdditional(source);
  assert.equal(page.requests.length, 0);
  assert.equal(page.learnAction.hidden, false);
  await page.pressLearnButton();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].text, 'Double tap on a sentence reference.');
});

test('releasing a pressed learning action outside its bounds discards its snapshot even with button pointer capture', async () => {
  for (const captured of [false, true]) {
    const page = createPage({ touchPoints: 1 });
    await page.selectDisplay('A cancelled action tap.');
    await page.learnButton.emit('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 250, clientY: 180 });
    page.document.activeElement = page.learnButton;
    await page.clearSelection();
    assert.equal(page.learnAction.hidden, false);
    await page.document.emit('pointerup', { target: captured ? page.learnButton : {}, pointerType: 'touch', pointerId: 7,
      clientX: 10, clientY: 5 });
    assert.equal(page.learnAction.hidden, true);
    await page.learnButton.emit('click');
    assert.equal(page.requests.length, 0);
    assert.equal(page.popup.hidden, true);
  }
});
