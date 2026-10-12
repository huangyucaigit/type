'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextDecoder, TextEncoder } = require('node:util');

// Run the actual browser scripts against a small event/element harness. Layout,
// native text selection and file pickers are verified separately in a browser.
function createPage({ fetch } = {}) {
  const elements = new Map();
  const intervals = [];
  const frames = new Map();
  let now = 0;
  let nextFrame = 0;
  let document;

  class Element {
    constructor(id = '') {
      this.id = id;
      this.value = '';
      this.textContent = '';
      this.className = '';
      this.children = [];
      this.parentElement = null;
      this.listeners = new Map();
      this.attributes = new Map();
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.open = false;
      this.checked = false;
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.selectionDirection = 'none';
      this.lastChild = { textContent: '' };
      this.classList = {
        toggle: (name, force) => {
          const classes = new Set(this.className.split(/\s+/).filter(Boolean));
          const shouldAdd = force === undefined ? !classes.has(name) : force;
          if (shouldAdd) classes.add(name); else classes.delete(name);
          this.className = [...classes].join(' ');
          return shouldAdd;
        },
        contains: (name) => this.className.split(/\s+/).includes(name),
      };
    }
    addEventListener(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(listener);
    }
    emit(name, properties = {}) {
      const event = { target: this, preventDefault() {}, ...properties };
      return Promise.all((this.listeners.get(name) || []).map(listener => listener(event)));
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
    replaceChildren() {
      this.children.forEach(child => { child.parentElement = null; });
      this.children = [];
    }
    get nextSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      return siblings[siblings.indexOf(this) + 1] || null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    getBoundingClientRect() { return { top: 150, bottom: 175, left: 0, right: 600 }; }
  }

  document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    createElement: () => new Element(),
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    TextDecoder,
    fetch,
    performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setInterval(callback) { intervals.push(callback); },
  });
  context.window = context;
  context.innerHeight = 900;
  context.addEventListener = () => {};
  context.scrollBy = () => {};
  for (const name of ['typing-core.js', 'reference-selection.js', 'selection-translation.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context, { filename: name });
  }
  const $ = id => document.getElementById(id);
  $('showTimer').checked = true;

  return {
    $,
    fire: (id, name, properties) => $(id).emit(name, properties),
    open: () => $('importButton').emit('click'),
    draft(text) { $('sourceEditor').value = text; return $('sourceEditor').emit('input'); },
    choose(file) {
      $('fileInput').files = [file];
      $('fileInput').value = file.name;
      return $('fileInput').emit('change');
    },
    type(text) {
      $('typingInput').value = text;
      $('typingInput').setSelectionRange(text.length, text.length);
      return $('typingInput').emit('input');
    },
    tick(milliseconds) {
      now += milliseconds;
      intervals.forEach(callback => callback());
      const pendingFrames = [...frames.values()];
      frames.clear();
      pendingFrames.forEach(callback => callback());
    },
  };
}

const bytes = text => new TextEncoder().encode(text).buffer;
const file = (name, text) => ({ name, arrayBuffer: async () => bytes(text) });
function delayedFile(name) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { file: { name, arrayBuffer: () => promise }, resolve: text => resolve(bytes(text)), reject };
}

test('the real app sends imported context on double-click and learning leaves the draft and stopwatch intact', async () => {
  const requests = [];
  const page = createPage({ fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ analysis: {
      type: 'word', translation: '进步',
      brief: [{ label: '核心用法', text: '不可数名词，make progress 表示取得进步。' }],
      details: [{ label: '仿写任务', text: '写一句关于坚持练习的话。' }],
    } }) };
  } });
  const article = 'We make progress. Regular practice helps.';
  await page.open();
  await page.draft(article);
  await page.fire('importForm', 'submit');
  await page.type('We make progress.');
  await page.fire('timerStart', 'click');
  page.tick(4000);
  await page.fire('timerPause', 'click');
  page.$('typingInput').setSelectionRange(8, 16);
  await page.fire('typingInput', 'select');
  assert.equal(requests.length, 0);
  await page.fire('typingInput', 'dblclick');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/analyze');
  assert.equal(requests[0].body.text, 'progress');
  assert.equal(requests[0].body.context.sentence, 'We make progress.');
  assert.equal(requests[0].body.context.paragraph, article);
  assert.equal(page.$('selectionAnalysisType').textContent, '单词');
  assert.equal(page.$('selectionTranslationText').textContent, '进步');
  assert.equal(page.$('selectionAnalysisDetails').hidden, true);
  await page.fire('selectionAnalysisExpand', 'click');
  assert.equal(page.$('selectionAnalysisDetails').hidden, false);
  assert.equal(requests.length, 1);
  assert.equal(page.$('typingInput').value, 'We make progress.');
  assert.equal(page.$('timerValue').textContent, '00:04');
  assert.equal(page.$('timerState').textContent, '已暂停');
  await page.type('We make progress. R');
  assert.equal(page.$('selectionTranslationPopup').hidden, true);
  assert.equal(page.$('timerValue').textContent, '00:04');
});

test('editing a draft cancels a pending file without overwriting the newer text', async () => {
  const page = createPage();
  await page.open();
  const reading = delayedFile('older.txt');
  const pending = page.choose(reading.file);
  assert.equal(page.$('applySource').disabled, true);
  await page.draft('My newer draft.');
  assert.equal(page.$('applySource').disabled, false);
  reading.resolve('Older file contents.');
  await pending;
  assert.equal(page.$('sourceEditor').value, 'My newer draft.');
  assert.equal(page.$('sourcePreview').textContent, 'My newer draft.');
  assert.equal(page.$('fileName').textContent, '尚未选择文件');
});

test('an invalid second file cancels pending work and restores the start button', async () => {
  const page = createPage();
  await page.open();
  await page.draft('Keep this draft.');
  const reading = delayedFile('older.txt');
  const pending = page.choose(reading.file);
  await page.choose({ name: 'wrong.csv' });
  reading.resolve('Stale contents.');
  await pending;
  assert.equal(page.$('applySource').disabled, false);
  assert.equal(page.$('fileName').textContent, '尚未选择文件');
  assert.match(page.$('importError').textContent, /\.txt/);
  assert.equal(page.$('sourceEditor').value, 'Keep this draft.');
});

test('only the latest file may update the draft or clear the active file selection', async () => {
  const page = createPage();
  await page.open();
  const first = delayedFile('first.txt');
  const second = delayedFile('second.txt');
  const pendingFirst = page.choose(first.file);
  const pendingSecond = page.choose(second.file);
  first.resolve('First contents.');
  await pendingFirst;
  assert.equal(page.$('fileInput').value, 'second.txt');
  assert.equal(page.$('applySource').disabled, true);
  second.resolve('Second contents.');
  await pendingSecond;
  assert.equal(page.$('sourceEditor').value, 'Second contents.');
  assert.equal(page.$('fileName').textContent, 'second.txt');
  assert.equal(page.$('applySource').disabled, false);
});

test('closing and reopening import isolates the new draft from an older read', async () => {
  const page = createPage();
  await page.open();
  const reading = delayedFile('old.txt');
  const pending = page.choose(reading.file);
  await page.fire('cancelImport', 'click');
  await page.open();
  await page.draft('New session draft.');
  reading.resolve('Old session contents.');
  await pending;
  assert.equal(page.$('importDialog').open, true);
  assert.equal(page.$('sourceEditor').value, 'New session draft.');
  assert.equal(page.$('applySource').disabled, false);
  assert.equal(page.$('importError').hidden, true);
});

test('empty, invalid UTF-8 and unreadable files preserve the draft and active practice', async () => {
  const cases = [
    [{ name: 'empty.txt', arrayBuffer: async () => bytes(' \t\r\n ') }, /没有可练习/],
    [{ name: 'encoding.txt', arrayBuffer: async () => Uint8Array.from([0xff, 0xfe, 0x41]).buffer }, /文件编码不支持/],
    [{ name: 'unreadable.txt', arrayBuffer: async () => { throw new Error('Read failed'); } }, /文件读取失败/],
  ];
  for (const [invalidFile, expectedMessage] of cases) {
    const page = createPage();
    const sourceBefore = page.$('sourceReadable').textContent;
    await page.fire('timerStart', 'click');
    await page.type('Learning');
    page.tick(2200);
    await page.open();
    await page.draft('Keep my draft.');
    await page.choose(invalidFile);
    assert.equal(page.$('sourceEditor').value, 'Keep my draft.');
    assert.equal(page.$('sourceReadable').textContent, sourceBefore);
    assert.equal(page.$('typingInput').value, 'Learning');
    assert.equal(page.$('statusLabel').textContent, '练习中');
    assert.equal(page.$('timerValue').textContent, '00:02');
    assert.equal(page.$('applySource').disabled, false);
    assert.match(page.$('importError').textContent, expectedMessage);
  }
});

test('UTF-8 file preview exactly matches the normalized source applied for practice', async () => {
  const page = createPage();
  await page.open();
  await page.choose(file('My essay.TXT', '\uFEFF \tOne\tparagraph.\r\n\r\nTwo  spaces. \r\n'));
  const preview = page.$('sourcePreview').textContent;
  assert.equal(preview, 'One paragraph.\n\nTwo  spaces.');
  await page.fire('importForm', 'submit');
  assert.equal(page.$('sourceReadable').textContent, preview);
  assert.equal(page.$('articleTitle').textContent, 'My essay');
  assert.equal(page.$('importDialog').open, false);
});

test('submission while a file is loading leaves the active practice unchanged', async () => {
  const page = createPage();
  const sourceBefore = page.$('sourceReadable').textContent;
  await page.open();
  await page.draft('Draft before loading.');
  const reading = delayedFile('new.txt');
  const pending = page.choose(reading.file);
  await page.fire('importForm', 'submit');
  assert.equal(page.$('sourceReadable').textContent, sourceBefore);
  assert.equal(page.$('importDialog').open, true);
  reading.resolve('New article.');
  await pending;
  await page.fire('importForm', 'submit');
  assert.equal(page.$('sourceReadable').textContent, 'New article.');
});

test('completion preserves manual timing, and applying a new article resets input and stopwatch', async () => {
  const page = createPage();
  await page.open();
  await page.draft('Hello.');
  await page.fire('importForm', 'submit');
  await page.fire('timerStart', 'click');
  await page.type('H');
  page.tick(3400);
  await page.type('Hello.');
  assert.equal(page.$('statusLabel').textContent, '已完成');
  assert.equal(page.$('typingInput').readOnly, true);
  assert.equal(page.$('timerValue').textContent, '00:03');
  page.tick(5000);
  assert.equal(page.$('timerValue').textContent, '00:08');
  await page.fire('timerPause', 'click');
  page.tick(5000);
  assert.equal(page.$('timerValue').textContent, '00:08');
  await page.open();
  await page.draft('Next article.');
  await page.fire('importForm', 'submit');
  assert.equal(page.$('sourceReadable').textContent, 'Next article.');
  assert.equal(page.$('typingInput').value, '');
  assert.equal(page.$('typingInput').readOnly, false);
  assert.equal(page.$('statusLabel').textContent, '准备开始');
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(page.$('timerState').textContent, '未开始');
  assert.equal(page.$('progressFill').style.width, '0%');
});

test('hiding the timer preserves elapsed time and restarting resets only the practice', async () => {
  const page = createPage();
  const sourceBefore = page.$('sourceReadable').textContent;
  page.tick(5000);
  assert.equal(page.$('timerValue').textContent, '00:00');
  await page.fire('timerStart', 'click');
  await page.type('L');
  page.tick(1200);
  page.$('showTimer').checked = false;
  await page.fire('showTimer', 'change');
  assert.equal(page.$('timerDisplay').hidden, true);
  page.tick(4200);
  page.$('showTimer').checked = true;
  await page.fire('showTimer', 'change');
  assert.equal(page.$('timerDisplay').hidden, false);
  assert.equal(page.$('timerValue').textContent, '00:05');
  await page.fire('restartButton', 'click');
  assert.equal(page.$('sourceReadable').textContent, sourceBefore);
  assert.equal(page.$('typingInput').value, '');
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(page.$('statusLabel').textContent, '准备开始');
});

test('typing never starts or resumes a stopwatch and practice status is independent of timing', async () => {
  const page = createPage();
  await page.type('L');
  page.tick(2000);
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(page.$('timerState').textContent, '未开始');
  assert.equal(page.$('statusLabel').textContent, '练习中');
  assert.equal(page.$('timerStart').disabled, false);
  assert.equal(page.$('timerPause').disabled, true);
  await page.fire('timerStart', 'click');
  page.tick(2200);
  assert.equal(page.$('timerStart').disabled, true);
  assert.equal(page.$('timerPause').disabled, false);
  await page.fire('timerPause', 'click');
  await page.type('Learning');
  page.tick(10000);
  assert.equal(page.$('timerValue').textContent, '00:02');
  assert.equal(page.$('timerState').textContent, '已暂停');
  assert.equal(page.$('timerStart').textContent, '继续');
  await page.fire('timerStart', 'click');
  page.tick(1900);
  assert.equal(page.$('timerValue').textContent, '00:04');
  assert.equal(page.$('typingInput').value, 'Learning');
});

test('clear stops and zeros either a running or paused stopwatch without losing typing errors', async () => {
  for (const pauseFirst of [false, true]) {
    const page = createPage();
    await page.type('Wrong');
    const errorHint = page.$('errorHint').textContent;
    await page.fire('timerStart', 'click');
    page.tick(2200);
    if (pauseFirst) await page.fire('timerPause', 'click');
    await page.fire('timerClear', 'click');
    assert.equal(page.$('typingInput').value, 'Wrong');
    assert.equal(page.$('errorHint').textContent, errorHint);
    assert.equal(page.$('timerValue').textContent, '00:00');
    assert.equal(page.$('timerState').textContent, '未开始');
    assert.equal(page.$('timerStart').textContent, '开始');
    assert.equal(page.$('timerStart').disabled, false);
    assert.equal(page.$('timerPause').disabled, true);
    page.tick(5000);
    assert.equal(page.$('timerValue').textContent, '00:00');
    await page.type('L');
    page.tick(2000);
    assert.equal(page.$('timerValue').textContent, '00:00');
  }
});

test('clear preserves completed text and its lock while the stopwatch can be started again', async () => {
  const page = createPage();
  const source = page.$('sourceReadable').textContent;
  await page.type(source);
  assert.equal(page.$('typingInput').readOnly, true);
  await page.fire('timerStart', 'click');
  page.tick(1500);
  await page.fire('timerClear', 'click');
  assert.equal(page.$('typingInput').value, source);
  assert.equal(page.$('typingInput').readOnly, true);
  assert.equal(page.$('statusLabel').textContent, '已完成');
  assert.equal(page.$('timerValue').textContent, '00:00');
  await page.fire('timerStart', 'click');
  page.tick(2200);
  assert.equal(page.$('timerValue').textContent, '00:02');
});
