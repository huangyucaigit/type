'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// This executes the production controller. The harness models DOM ranges and
// UTF-16 offsets, but does not pretend to test Chromium's trusted-key defaults.
function page({ text = 'A😀 beta gamma.', value = 'A😀 beta', noSelectionAPI = false } = {}) {
  let active = true;
  let resumed = 0;
  let valueWrites = 0;
  let storedValue = value;
  const target = () => ({
    listeners: new Map(),
    addEventListener(name, handler) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(handler);
    },
    removeEventListener(name, handler) {
      this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== handler));
    },
    emit(name, properties = {}) {
      const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
      (this.listeners.get(name) || []).forEach(handler => handler(event));
      return event;
    },
  });
  const doc = target();
  const element = (children = []) => {
    const node = {
      ...target(), nodeType: 1, children, ownerDocument: doc,
      focus() { doc.activeElement = this; },
      contains(other) {
        for (let current = other; current; current = current.parentNode) if (current === this) return true;
        return false;
      },
    };
    children.forEach(child => { child.parentNode = node; });
    Object.defineProperty(node, 'textContent', { get: () => children.map(child => child.textContent).join('') });
    return node;
  };
  const textNode = text => ({ nodeType: 3, textContent: text });
  const spans = Array.from(text).map(character => element([textNode(character)]));
  // Layout-only elements must contribute zero text to selection offsets.
  spans.splice(2, 0, element(), element());
  const display = element(spans);
  const outside = element([textNode('Outside')]);
  const classes = new Set();
  const area = { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } };
  const input = {
    ...element(), selectionStart: value.length, selectionEnd: value.length, selectionDirection: 'forward',
    rangeCalls: [],
    setSelectionRange(start, end, direction) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
      this.rangeCalls.push({ start, end, direction });
    },
  };
  Object.defineProperty(input, 'value', { get: () => storedValue, set(next) { valueWrites++; storedValue = next; } });
  input.setRangeText = () => { throw new Error('Native undo must not be bypassed'); };
  doc.activeElement = input;

  function localOffset(root, node, offset) {
    if (root === node) return node.nodeType === 3 ? offset : node.children.slice(0, offset).reduce((total, child) => total + child.textContent.length, 0);
    let preceding = 0;
    for (const child of root.children || []) {
      if (child === node || child.contains?.(node)) return preceding + localOffset(child, node, offset);
      preceding += child.textContent.length;
    }
    throw new Error('Endpoint outside range root');
  }
  class Range {
    constructor(root = display) {
      this.root = root;
      this.startContainer = root;
      this.startOffset = 0;
      this.endContainer = root;
      this.endOffset = 0;
      this.rects = [{ left: 20, right: 120, top: 30, bottom: 55, width: 100, height: 25 }];
    }
    selectNodeContents(node) {
      this.root = node;
      this.startContainer = node;
      this.startOffset = 0;
      this.endContainer = node;
      this.endOffset = node.children.length;
    }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
    toString() {
      return this.root.textContent.slice(localOffset(this.root, this.startContainer, this.startOffset), localOffset(this.root, this.endContainer, this.endOffset));
    }
    getClientRects() { return this.rects; }
  }
  const selection = {
    ranges: [], anchorNode: null, anchorOffset: 0,
    get rangeCount() { return this.ranges.length; },
    getRangeAt(index) { return this.ranges[index]; },
    removeAllRanges() { this.ranges = []; },
    addRange(range) {
      this.ranges = [range];
      this.anchorNode = range.startContainer;
      this.anchorOffset = range.startOffset;
    },
  };
  doc.createRange = () => new Range();
  const view = noSelectionAPI ? {} : { getSelection: () => selection };
  doc.defaultView = view;
  const context = vm.createContext({ document: doc, window: view });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'reference-selection.js'), 'utf8'), context);
  const controller = view.ReferenceSelection.create({ input, display, area, isActive: () => active, onResumeInput: () => { resumed++; } });

  function endpoint(offset) {
    let remaining = offset;
    for (const span of spans) {
      if (!span.children.length) continue;
      const node = span.children[0];
      if (remaining <= node.textContent.length) return [node, remaining];
      remaining -= node.textContent.length;
    }
    return [display, spans.length];
  }
  function select(start, end = start, backward = false) {
    const range = new Range();
    [range.startContainer, range.startOffset] = endpoint(start);
    [range.endContainer, range.endOffset] = endpoint(end);
    selection.addRange(range);
    if (backward) {
      selection.anchorNode = range.endContainer;
      selection.anchorOffset = range.endOffset;
    }
    doc.emit('selectionchange');
    return range;
  }
  return {
    input, display, outside, doc, selection, classes, controller, select,
    pointerDown: properties => display.emit('pointerdown', { button: 0, clientX: 300, clientY: 200, ...properties }),
    pointerMove: properties => doc.emit('pointermove', { target: display, ...properties }),
    pointerUp: properties => doc.emit('pointerup', { button: 0, target: display, ...properties }),
    pointerCancel: properties => doc.emit('pointercancel', { target: display, ...properties }),
    contextMenu: () => display.emit('contextmenu'),
    key: (key, properties) => display.emit('keydown', { key, ...properties }),
    setActive(value) { active = value; },
    get resumed() { return resumed; },
    get valueWrites() { return valueWrites; },
  };
}

test('a collapsed source click maps UTF-16 offsets past emoji and empty layout elements', () => {
  const p = page();
  p.pointerDown();
  p.select(4);
  p.pointerUp();
  assert.equal(p.input.selectionStart, 4);
  assert.equal(p.input.selectionEnd, 4);
  assert.equal(p.doc.activeElement, p.input);
  assert.equal(p.selection.rangeCount, 0);
  assert.equal(p.resumed, 1);
});

test('clicking pending text resumes at the end of the actual draft', () => {
  const p = page();
  p.pointerDown();
  p.select(12);
  p.pointerUp();
  assert.equal(p.input.selectionStart, p.input.value.length);
  assert.equal(p.input.selectionEnd, p.input.value.length);
});

test('a typed-prefix drag preserves native source highlight and prepares backward replacement', () => {
  const p = page();
  p.pointerDown();
  p.select(1, 7, true);
  p.pointerUp();
  assert.equal(p.doc.activeElement, p.display);
  assert.equal(p.selection.rangeCount, 1);
  assert.equal(p.input.selectionStart, 1);
  assert.equal(p.input.selectionEnd, 7);
  assert.equal(p.input.selectionDirection, 'backward');
  assert.ok(p.classes.has('is-source-selecting'));
  assert.equal(p.resumed, 0);
});

test('a range including pending source cannot replace an unrelated native draft range', () => {
  const p = page();
  p.input.setSelectionRange(2, 3, 'backward');
  p.pointerDown();
  p.select(5, 13);
  p.pointerUp();
  assert.equal(p.input.selectionStart, 2);
  assert.equal(p.input.selectionEnd, 3);
  p.key('q');
  assert.equal(p.doc.activeElement, p.input);
  assert.equal(p.input.selectionStart, 2);
  assert.equal(p.input.selectionEnd, 3);
});

test('successive clicks inside selected text keep native word and paragraph selection available', () => {
  const p = page();
  const range = p.select(4, 13);
  for (let count = 0; count < 3; count++) {
    const event = p.pointerDown({ clientX: 50, clientY: 40 });
    assert.equal(event.defaultPrevented, false);
    p.pointerUp();
    assert.equal(p.selection.getRangeAt(0), range);
    assert.equal(range.toString(), 'beta gamm');
  }
  assert.equal(p.resumed, 0);
});

test('clicks outside the selected rectangles and right clicks retain browser defaults', () => {
  const p = page();
  p.select(4, 13);
  assert.equal(p.pointerDown({ clientX: 200, clientY: 40 }).defaultPrevented, false);
  assert.equal(p.pointerDown({ button: 2, clientX: 50, clientY: 40 }).defaultPrevented, false);
  assert.equal(p.pointerDown({ target: p.outside, clientX: 50, clientY: 40 }).defaultPrevented, false);
});

test('touch and pen selection handles retain browser defaults and never replace the native range', () => {
  for (const pointerType of ['touch', 'pen']) {
    const p = page();
    p.input.setSelectionRange(1, 2, 'forward');
    const range = p.select(4, 7);
    p.doc.activeElement = p.outside;
    const rangeCalls = p.input.rangeCalls.length;
    const event = p.pointerDown({ pointerType, pointerId: 3, clientX: 50, clientY: 40, timeStamp: 0 });
    assert.equal(event.defaultPrevented, false, pointerType);
    p.pointerUp({ pointerId: 3, timeStamp: 100 });
    assert.equal(p.selection.getRangeAt(0), range, pointerType);
    assert.equal(p.doc.activeElement, p.outside, pointerType);
    assert.equal(p.input.rangeCalls.length, rangeCalls, pointerType);
    assert.ok(p.classes.has('is-source-selecting'), pointerType);
    assert.equal(p.resumed, 0, pointerType);
    // A hardware keyboard still routes an intentional edit to the right range.
    p.key('r');
    assert.equal(p.input.selectionStart, 4, pointerType);
    assert.equal(p.input.selectionEnd, 7, pointerType);
    assert.equal(p.resumed, 1, pointerType);
  }
});

test('a touch long press leaves focus untouched when its range arrives after pointerup', () => {
  const p = page();
  p.doc.activeElement = p.outside;
  p.pointerDown({ pointerType: 'touch', pointerId: 1, timeStamp: 100 });
  p.pointerUp({ pointerId: 1, timeStamp: 650 });
  assert.equal(p.resumed, 0);
  assert.equal(p.doc.activeElement, p.outside);
  const range = p.select(4, 13);
  assert.equal(p.selection.getRangeAt(0), range);
  assert.ok(p.classes.has('is-source-selecting'));
  assert.equal(p.doc.activeElement, p.outside);
});

test('a short touch or pen tap still enters typing at the selected draft caret', () => {
  for (const pointerType of ['touch', 'pen']) {
    const p = page();
    p.doc.activeElement = p.outside;
    p.pointerDown({ pointerType, pointerId: 1, timeStamp: 100 });
    p.select(4);
    p.pointerUp({ pointerId: 1, timeStamp: 220 });
    assert.equal(p.doc.activeElement, p.input, pointerType);
    assert.equal(p.input.selectionStart, 4, pointerType);
    assert.equal(p.input.selectionEnd, 4, pointerType);
    assert.equal(p.selection.rangeCount, 0, pointerType);
    assert.equal(p.resumed, 1, pointerType);
  }
});

test('touch scrolling and native context menus never turn into an input tap', () => {
  const scroll = page();
  scroll.doc.activeElement = scroll.outside;
  scroll.pointerDown({ pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100, timeStamp: 100 });
  scroll.pointerMove({ pointerId: 1, clientX: 100, clientY: 120 });
  scroll.pointerMove({ pointerId: 1, clientX: 100, clientY: 100 });
  scroll.pointerUp({ pointerId: 1, timeStamp: 220 });
  assert.equal(scroll.resumed, 0);
  assert.equal(scroll.doc.activeElement, scroll.outside);
  const menu = page();
  menu.doc.activeElement = menu.outside;
  menu.pointerDown({ pointerType: 'touch', pointerId: 1, timeStamp: 100 });
  assert.equal(menu.contextMenu().defaultPrevented, false);
  menu.pointerUp({ pointerId: 1, timeStamp: 220 });
  assert.equal(menu.resumed, 0);
  assert.equal(menu.doc.activeElement, menu.outside);
});

test('pointer cancellation prevents a delayed release from stealing focus', () => {
  const p = page();
  p.doc.activeElement = p.outside;
  p.pointerDown({ pointerType: 'touch', pointerId: 1, timeStamp: 100 });
  const range = p.select(4, 13);
  p.pointerCancel({ pointerId: 1 });
  p.pointerUp({ pointerId: 1, timeStamp: 220 });
  assert.equal(p.resumed, 0);
  assert.equal(p.doc.activeElement, p.outside);
  assert.equal(p.selection.getRangeAt(0), range);
});

test('another pointer cannot cancel or finish a primary tap', () => {
  const p = page();
  p.pointerDown({ pointerType: 'touch', pointerId: 1, timeStamp: 100 });
  p.pointerDown({ pointerType: 'touch', pointerId: 2, isPrimary: false, timeStamp: 120 });
  p.pointerCancel({ pointerId: 2 });
  p.pointerUp({ pointerId: 2, timeStamp: 150 });
  assert.equal(p.resumed, 0);
  p.select(4);
  p.pointerUp({ pointerId: 1, timeStamp: 220 });
  assert.equal(p.resumed, 1);
  assert.equal(p.input.selectionStart, 4);
});

test('mouse clicks keep their existing caret behavior regardless of press duration', () => {
  const p = page();
  p.pointerDown({ pointerType: 'mouse', pointerId: 1, timeStamp: 100 });
  p.select(4);
  p.pointerUp({ pointerId: 1, timeStamp: 650 });
  assert.equal(p.resumed, 1);
  assert.equal(p.input.selectionStart, 4);
});

test('selection changes hide the painted caret without translating or focusing the input', () => {
  const p = page();
  p.select(4, 13);
  assert.ok(p.classes.has('is-source-selecting'));
  assert.equal(p.resumed, 0);
  p.select(4);
  assert.equal(p.classes.has('is-source-selecting'), false);
});

test('source selection outside the typing text is not captured as an edit', () => {
  const p = page();
  p.pointerDown();
  const range = p.select(4, 7);
  range.endContainer = p.outside.children[0];
  range.endOffset = 4;
  p.doc.activeElement = p.display;
  p.pointerUp();
  assert.equal(p.doc.activeElement, p.display);
  assert.equal(p.resumed, 0);
  assert.equal(p.classes.has('is-source-selecting'), false);
});

test('printable, paste, undo, caret and composing keys route to native input without text synthesis', () => {
  for (const [key, modifiers] of [
    ['r', {}], ['Enter', {}], ['Backspace', {}], ['ArrowLeft', { shiftKey: true }],
    ['v', { ctrlKey: true }], ['z', { metaKey: true }], ['z', { ctrlKey: true, shiftKey: true }],
    ['Process', {}], ['Unidentified', { keyCode: 229 }], ['Dead', {}],
  ]) {
    const p = page();
    p.pointerDown();
    p.select(4, 7);
    p.pointerUp();
    const before = p.input.value;
    const event = p.key(key, modifiers);
    assert.equal(event.defaultPrevented, false, key);
    assert.equal(p.doc.activeElement, p.input, key);
    assert.equal(p.input.selectionStart, 4, key);
    assert.equal(p.input.selectionEnd, 7, key);
    assert.equal(p.input.value, before, key);
    assert.equal(p.valueWrites, 0, key);
    assert.equal(p.selection.rangeCount, 0, key);
    assert.equal(p.resumed, 1, key);
  }
});

test('copy, Tab and browser shortcuts leave the source selection and native defaults intact', () => {
  for (const [key, modifiers] of [
    ['c', { ctrlKey: true }], ['c', { metaKey: true }], ['Tab', {}], ['Escape', {}],
    ['l', { ctrlKey: true }], ['f', { ctrlKey: true }], ['t', { metaKey: true }],
    ['ArrowLeft', { altKey: true }], ['ArrowRight', { altKey: true }],
  ]) {
    const p = page();
    p.pointerDown();
    const range = p.select(4, 13);
    p.pointerUp();
    const event = p.key(key, modifiers);
    assert.equal(event.defaultPrevented, false, key);
    assert.equal(p.doc.activeElement, p.display, key);
    assert.equal(p.selection.getRangeAt(0), range, key);
    assert.equal(p.resumed, 0, key);
  }
});

test('select all is scoped to the source and a subsequent key resumes the old native caret', () => {
  const p = page();
  p.input.setSelectionRange(2, 2, 'forward');
  p.doc.activeElement = p.display;
  const event = p.key('a', { ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(p.selection.getRangeAt(0).toString(), p.display.textContent);
  assert.ok(p.classes.has('is-source-selecting'));
  p.key('r');
  assert.equal(p.input.selectionStart, 2);
  assert.equal(p.input.selectionEnd, 2);
});

test('cut routes only a selection wholly within typed input', () => {
  const pending = page();
  pending.pointerDown();
  pending.select(4, 13);
  pending.pointerUp();
  pending.key('x', { ctrlKey: true });
  assert.equal(pending.doc.activeElement, pending.display);
  assert.equal(pending.resumed, 0);
  const typed = page();
  typed.pointerDown();
  typed.select(4, 7);
  typed.pointerUp();
  typed.key('x', { ctrlKey: true });
  assert.equal(typed.doc.activeElement, typed.input);
  assert.equal(typed.input.selectionStart, 4);
  assert.equal(typed.input.selectionEnd, 7);
  assert.equal(typed.valueWrites, 0);
});

test('clear removes only source-owned ranges and cancels an unfinished pointer gesture', () => {
  const p = page();
  p.pointerDown();
  p.select(4, 13);
  p.controller.clear();
  assert.equal(p.selection.rangeCount, 0);
  assert.equal(p.classes.has('is-source-selecting'), false);
  p.pointerUp();
  assert.equal(p.resumed, 0);
  const range = p.select(0, 1);
  range.startContainer = p.outside.children[0];
  range.endContainer = p.outside.children[0];
  p.controller.clear();
  assert.equal(p.selection.getRangeAt(0), range);
});

test('inactive mode and destroyed controllers never hijack selections or editing', () => {
  const p = page();
  p.setActive(false);
  p.pointerDown();
  p.select(4, 13);
  p.pointerUp();
  p.key('r');
  assert.equal(p.resumed, 0);
  assert.equal(p.classes.has('is-source-selecting'), false);
  p.setActive(true);
  p.controller.destroy();
  p.pointerDown();
  p.select(4, 13);
  p.pointerUp();
  p.key('r');
  assert.equal(p.resumed, 0);
  assert.equal(p.classes.has('is-source-selecting'), false);
});

test('missing optional selection APIs gracefully keep the input usable', () => {
  const p = page({ noSelectionAPI: true });
  assert.doesNotThrow(() => {
    p.pointerDown();
    p.pointerUp();
    p.key('a', { ctrlKey: true });
    p.controller.clear();
  });
  assert.equal(p.doc.activeElement, p.input);
});
