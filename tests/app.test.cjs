'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextDecoder, TextEncoder } = require('node:util');
const { groupSentences } = require('../sentence-core.js');

const ARTICLE_STORAGE_KEY = 'mars-ielts-typing:article:v1';
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    writes,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); writes.push({ key, value: String(value) }); },
    removeItem(key) { values.delete(key); },
  };
}

// Run the actual browser scripts against a small event/element harness. Layout,
// native text selection and file pickers are verified separately in a browser.
function createPage({ fetch, titleFetch, protocol = 'http:', storage = memoryStorage(), storageGetter, auth, assistant } = {}) {
  const elements = new Map();
  const intervals = [];
  const frames = new Map();
  const timers = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  let now = 0;
  let nextFrame = 0;
  let nextTimer = 0;
  let document;
  const listen = (listeners, name, listener) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(listener);
  };
  const emit = (listeners, target, name, properties = {}) => Promise.all(
    (listeners.get(name) || []).map(listener => listener({ target, preventDefault() {}, ...properties })));

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
      this.scrollTop = 0;
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
    replaceChildren(...children) {
      this.children.forEach(child => { child.parentElement = null; });
      this.children = [];
      this.append(...children);
    }
    get nextSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      return siblings[siblings.indexOf(this) + 1] || null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    getBoundingClientRect() { return { top: 150, bottom: 175, left: 0, right: 600 }; }
  }

  document = {
    activeElement: null,
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    createElement: () => new Element(),
    addEventListener: (name, listener) => listen(documentListeners, name, listener),
  };
  const context = vm.createContext({
    document,
    TextDecoder,
    fetch: (url, options) => url === '/api/article-title'
      ? (titleFetch ? titleFetch(url, options) : Promise.resolve({ ok: false }))
      : fetch(url, options),
    AbortSignal,
    performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setInterval(callback) { intervals.push(callback); },
    setTimeout(callback, delay = 0) { timers.set(++nextTimer, { due: now + delay, callback }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  context.window = context;
  if (auth) context.ZijianAuth = auth;
  if (assistant) context.LearningAssistant = assistant;
  context.location = { protocol };
  Object.defineProperty(context, 'localStorage', { get: storageGetter || (() => storage) });
  context.innerHeight = 900;
  context.scrollY = 0;
  context.addEventListener = (name, listener) => listen(windowListeners, name, listener);
  context.scrollTo = ({ top }) => { context.scrollY = top; };
  context.scrollBy = () => {};
  const copy = value => JSON.parse(JSON.stringify(value));
  const sentence = { created: [], sources: [], titles: [], active: [], resets: [], restored: [], refreshes: 0 };
  context.SentencePractice = { create(options) {
    sentence.created.push({ source: options.source, title: options.title, kind: options.kind });
    let source = options.source;
    const blank = () => ({ groupSize: sentence.progress?.groupSize || 1, activeGroup: 0,
      groups: groupSentences(source, sentence.progress?.groupSize || 1).map(() => ({
        draft: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollTop: 0,
        referenceVisible: true, checked: false,
      })) });
    sentence.progress = blank();
    sentence.change = snapshot => {
      sentence.progress = copy(snapshot);
      options.onProgressChange?.(copy(sentence.progress));
    };
    return {
      setSource(nextSource, title, kind) {
        source = nextSource;
        sentence.sources.push({ source, title, kind });
        sentence.progress = blank();
        options.onProgressChange?.(copy(sentence.progress));
      },
      setTitle(title) { sentence.titles.push(title); },
      setActive(active) { sentence.active.push(active); },
      reset(focus) { sentence.resets.push(focus); sentence.progress = blank(); options.onProgressChange?.(copy(sentence.progress)); },
      getProgress() { return copy(sentence.progress); },
      restoreProgress(snapshot) {
        if (groupSentences(source, snapshot.groupSize).length !== snapshot.groups.length) return false;
        sentence.progress = copy(snapshot);
        sentence.restored.push(copy(snapshot));
        return true;
      },
      getResumeTarget() { return document.getElementById(`sentence-group-${sentence.progress.activeGroup}`); },
      refreshTimer() { sentence.refreshes += 1; },
      getLearningSources() { return []; },
    };
  } };
  for (const name of ['typing-core.js', 'article-history.js', 'floating-timer.js', 'reference-selection.js', 'selection-translation.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context, { filename: name });
  }
  const $ = id => document.getElementById(id);

  return {
    $,
    storage,
    sentence,
    document,
    window: context,
    windowEvent: (name, properties) => emit(windowListeners, context, name, properties),
    documentEvent: (name, properties) => emit(documentListeners, document, name, properties),
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
      for (const [id, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
        if (!timers.has(id) || timer.due > now) continue;
        timers.delete(id);
        timer.callback();
      }
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

test('the real app sends imported context only after the learning action and leaves the draft and stopwatch intact', async () => {
  const requests = [];
  const added = [];
  const page = createPage({ assistant: { configureArticle() {}, addSelection: value => added.push(value) }, fetch: async (url, options) => {
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
  await page.fire('timerStart', 'click');
  page.$('typingInput').setSelectionRange(8, 16);
  await page.fire('typingInput', 'select');
  assert.equal(requests.length, 0);
  await page.fire('typingInput', 'dblclick');
  assert.equal(requests.length, 0);
  assert.equal(page.$('selectionLearnAction').hidden, false);
  await page.fire('selectionLearnButton', 'click');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/analyze');
  assert.equal(added.length, 0, 'independent learning must not add content to the assistant');
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
  await page.fire('timerStart', 'click');
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

test('switching modes changes the visible stopwatch, preserves elapsed time and restarting resets only the practice', async () => {
  const page = createPage();
  const sourceBefore = page.$('sourceReadable').textContent;
  page.tick(5000);
  assert.equal(page.$('timerValue').textContent, '00:00');
  await page.fire('timerStart', 'click');
  await page.type('L');
  page.tick(1200);
  await page.fire('sentenceModeButton', 'click');
  assert.equal(page.$('timerDisplay').hidden, true);
  assert.equal(page.$('sentenceTimerDisplay').hidden, false);
  page.tick(4200);
  await page.fire('sentenceFullModeButton', 'click');
  assert.equal(page.$('timerDisplay').hidden, false);
  assert.equal(page.$('sentenceTimerDisplay').hidden, true);
  assert.equal(page.$('timerValue').textContent, '00:05');
  await page.fire('restartButton', 'click');
  assert.equal(page.$('sourceReadable').textContent, sourceBefore);
  assert.equal(page.$('typingInput').value, '');
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(page.$('statusLabel').textContent, '准备开始');
});

test('one stopwatch button starts, pauses and continues while typing never changes its state', async () => {
  const page = createPage();
  await page.type('L');
  page.tick(2000);
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(page.$('timerState').textContent, '未开始');
  assert.equal(page.$('statusLabel').textContent, '练习中');
  assert.equal(page.$('timerStart').disabled, false);
  assert.equal(page.$('timerStart').textContent, '开始');
  assert.equal(page.$('timerStart').getAttribute('aria-label'), '开始全文模式秒表');
  await page.fire('timerStart', 'click');
  page.tick(2200);
  assert.equal(page.$('timerStart').disabled, false);
  assert.equal(page.$('timerStart').textContent, '暂停');
  assert.equal(page.$('timerStart').getAttribute('aria-label'), '暂停全文模式秒表');
  await page.fire('timerStart', 'click');
  await page.type('Learning');
  page.tick(10000);
  assert.equal(page.$('timerValue').textContent, '00:02');
  assert.equal(page.$('timerState').textContent, '已暂停');
  assert.equal(page.$('timerStart').textContent, '继续');
  assert.equal(page.$('timerStart').disabled, false);
  assert.equal(page.$('timerStart').getAttribute('aria-label'), '继续全文模式秒表');
  await page.fire('timerStart', 'click');
  page.tick(1900);
  assert.equal(page.$('timerValue').textContent, '00:04');
  assert.equal(page.$('typingInput').value, 'Learning');
  assert.equal(page.$('timerStart').textContent, '暂停');
  assert.equal(page.$('timerStart').getAttribute('aria-label'), '暂停全文模式秒表');
});

test('folding the full stopwatch preserves the draft and running time while the edge label keeps updating', async () => {
  const storage = memoryStorage();
  const page = createPage({ storage });
  assert.equal(page.$('floatingTimer').getAttribute('data-collapsed'), 'true');
  assert.equal(page.$('timerExpand').hidden, false);
  assert.equal(page.$('floatingTimer').getAttribute('data-collapsed'), 'true');
  assert.equal(page.$('timerExpanded').hidden, true);
  assert.equal(page.$('timerExpand').hidden, false);
  assert.equal(page.$('timerCompactIcon').hidden, false);
  page.tick(1500);
  assert.equal(page.$('timerState').textContent, '未开始');
  await page.fire('timerExpand', 'click');
  await page.type('Learning');
  await page.fire('timerStart', 'click');
  page.tick(2200);
  await page.fire('timerCollapse', 'click');
  assert.equal(page.$('timerState').textContent, '计时中');
  assert.equal(page.$('timerCompactValue').textContent, '00:02');
  assert.equal(page.$('timerCompactIcon').hidden, true);
  page.tick(3100);
  assert.equal(page.$('timerCompactValue').textContent, '00:05');
  assert.equal(page.$('timerState').textContent, '计时中');
  assert.equal(page.$('typingInput').value, 'Learning');
  await page.fire('timerExpand', 'click');
  assert.equal(page.$('timerExpanded').hidden, false);
  assert.equal(page.$('timerValue').textContent, '00:05');
  assert.equal(page.$('timerState').textContent, '计时中');
  await page.fire('timerStart', 'click');
  await page.fire('timerCollapse', 'click');
  page.tick(5000);
  assert.equal(page.$('timerCompactValue').textContent, '00:05');
  assert.equal(page.$('timerState').textContent, '已暂停');
  assert.equal(storage.getItem('mars-ielts-typing:timer-collapsed:v1'), '1');
  const restored = createPage({ storage });
  assert.equal(restored.$('floatingTimer').getAttribute('data-collapsed'), 'true');
  assert.equal(restored.$('timerState').textContent, '未开始');
  assert.equal(restored.$('timerCompactIcon').hidden, false);
});

test('repeated stopwatch clicks during authorization start once, and pausing needs no new authorization', async () => {
  let authorize;
  let requests = 0;
  let grants = 0;
  const pending = new Promise(resolve => { authorize = resolve; });
  const page = createPage({ auth: {
    hasAccess: () => true,
    canPractice: () => true,
    requireAccess: () => true,
    isDialogOpen: () => false,
    async runWithAccess(action) {
      requests++;
      await pending;
      grants++;
      return action();
    },
  } });
  const first = page.fire('timerStart', 'click');
  assert.equal(page.$('timerStart').disabled, true);
  const duplicate = page.fire('timerStart', 'click');
  page.tick(2000);
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(requests, 1);
  authorize();
  await Promise.all([first, duplicate]);
  assert.equal(grants, 1);
  assert.equal(page.$('timerStart').disabled, false);
  assert.equal(page.$('timerStart').textContent, '暂停');
  page.tick(2200);
  await page.fire('timerStart', 'click');
  assert.equal(page.$('timerState').textContent, '已暂停');
  assert.equal(page.$('timerStart').textContent, '继续');
  assert.equal(requests, 1);
  page.tick(3000);
  assert.equal(page.$('timerValue').textContent, '00:02');
});

test('the digital stopwatch crosses a minute, pauses, resets and supports hour readings', async () => {
  const page = createPage();
  await page.fire('timerStart', 'click');
  page.tick(59000);
  assert.equal(page.$('timerValue').textContent, '00:59');
  page.tick(2000);
  assert.equal(page.$('timerValue').textContent, '01:01');
  assert.equal(page.$('timerState').textContent, '计时中');
  await page.fire('timerStart', 'click');
  page.tick(5000);
  assert.equal(page.$('timerValue').textContent, '01:01');
  assert.equal(page.$('timerState').textContent, '已暂停');
  await page.fire('timerClear', 'click');
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(page.$('timerState').textContent, '未开始');
  assert.equal(page.$('timerDisplay').getAttribute('data-long-time'), 'false');
  await page.fire('timerStart', 'click');
  page.tick(3599000);
  assert.equal(page.$('timerValue').textContent, '59:59');
  assert.equal(page.$('timerDisplay').getAttribute('data-long-time'), 'false');
  page.tick(1000);
  assert.equal(page.$('timerValue').textContent, '1:00:00');
  assert.equal(page.$('timerDisplay').getAttribute('data-long-time'), 'true');
  await page.fire('timerClear', 'click');
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(page.$('timerDisplay').getAttribute('data-long-time'), 'false');
});

test('clear stops and zeros either a running or paused stopwatch without losing typing errors', async () => {
  for (const pauseFirst of [false, true]) {
    const page = createPage();
    await page.type('Wrong');
    const errorHint = page.$('errorHint').textContent;
    await page.fire('timerStart', 'click');
    page.tick(2200);
    if (pauseFirst) await page.fire('timerStart', 'click');
    await page.fire('timerClear', 'click');
    assert.equal(page.$('typingInput').value, 'Wrong');
    assert.equal(page.$('errorHint').textContent, errorHint);
    assert.equal(page.$('timerValue').textContent, '00:00');
    assert.equal(page.$('timerState').textContent, '未开始');
    assert.equal(page.$('timerStart').textContent, '开始');
    assert.equal(page.$('timerStart').disabled, false);
    assert.equal(page.$('timerStart').getAttribute('aria-label'), '开始全文模式秒表');
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

test('a successfully pasted article resumes its draft on a new page while manual timing starts empty', async () => {
  const storage = memoryStorage();
  const page = createPage({ storage });
  assert.equal(storage.writes.length, 0, 'opening the sample must not save it as an import');
  await page.open();
  await page.draft(' \tFirst\tparagraph.\r\n\r\nSecond  paragraph. \r\n');
  await page.fire('importForm', 'submit');
  const text = 'First paragraph.\n\nSecond  paragraph.';
  const title = 'First paragraph. Second paragraph.';
  const saved = JSON.parse(storage.getItem(ARTICLE_STORAGE_KEY));
  assert.equal(saved.version, 1);
  assert.equal(saved.text, text);
  assert.equal(saved.title, title);
  assert.equal(saved.articles.length, 1);
  assert.equal(page.$('articleStorageNotice').hidden, true);
  assert.deepEqual(page.sentence.sources.at(-1), { source: text, title, kind: '我的范文' });
  await page.type('First');
  await page.fire('timerStart', 'click');
  page.tick(4200);
  const restored = createPage({ storage });
  assert.equal(restored.$('sourceReadable').textContent, text);
  assert.equal(restored.$('articleTitle').textContent, title);
  assert.equal(restored.$('articleKind').textContent, '我的范文');
  assert.deepEqual(restored.sentence.created, [{ source: text, title, kind: '我的范文' }]);
  assert.equal(restored.$('typingInput').value, 'First');
  assert.equal(restored.$('typingInput').readOnly, false);
  assert.equal(restored.$('statusLabel').textContent, '练习中');
  assert.equal(restored.$('timerValue').textContent, '00:00');
  assert.equal(restored.$('timerState').textContent, '未开始');
  assert.notEqual(restored.$('progressFill').style.width, '0%');
  assert.equal(storage.writes.length, 2);
});

test('a TXT import saves the applied preview and filename title only after confirmation', async () => {
  const storage = memoryStorage();
  const page = createPage({ storage });
  await page.open();
  await page.choose(file('My IELTS essay.TXT', '\uFEFF  First\tpart.\r\n\r\nTwo  spaces.  '));
  assert.equal(storage.getItem(ARTICLE_STORAGE_KEY), null, 'reading a file is only a preview');
  const preview = page.$('sourcePreview').textContent;
  await page.fire('importForm', 'submit');
  const restored = createPage({ storage });
  assert.equal(restored.$('sourceReadable').textContent, preview);
  assert.equal(restored.$('articleTitle').textContent, 'My IELTS essay');
  assert.deepEqual(restored.sentence.created, [{ source: preview, title: 'My IELTS essay', kind: '我的范文' }]);
});

test('TXT filenames produce a trimmed nonempty title that remains restorable', async () => {
  for (const [filename, title] of [['  My essay  .txt', 'My essay'], ['  .txt', 'The imported article must survive.']]) {
    const storage = memoryStorage();
    const page = createPage({ storage });
    await page.open();
    await page.choose(file(filename, 'The imported article must survive.'));
    await page.fire('importForm', 'submit');
    assert.equal(page.$('articleTitle').textContent, title);
    assert.equal(JSON.parse(storage.getItem(ARTICLE_STORAGE_KEY)).title, title);
    const restored = createPage({ storage });
    assert.equal(restored.$('articleTitle').textContent, title);
    assert.equal(restored.$('sourceReadable').textContent, 'The imported article must survive.');
  }
});

test('another confirmed article becomes current while practice changes save independently of manual timing', async () => {
  const storage = memoryStorage();
  const page = createPage({ storage });
  await page.open();
  await page.choose(file('First.txt', 'The first essay.'));
  await page.fire('importForm', 'submit');
  const savedArticle = JSON.parse(storage.getItem(ARTICLE_STORAGE_KEY)).articles[0];
  await page.type('The');
  await page.fire('timerStart', 'click');
  page.tick(2300);
  await page.fire('timerStart', 'click');
  const afterTyping = storage.getItem(ARTICLE_STORAGE_KEY);
  await page.fire('timerClear', 'click');
  assert.equal(storage.getItem(ARTICLE_STORAGE_KEY), afterTyping, 'clearing manual time does not erase the saved draft');
  await page.fire('restartButton', 'click');
  await page.fire('sentenceModeButton', 'click');
  await page.fire('restartButton', 'click');
  await page.fire('realtimeModeButton', 'click');
  page.tick(350);
  const practiced = JSON.parse(storage.getItem(ARTICLE_STORAGE_KEY)).articles[0];
  assert.deepEqual({ ...practiced, progress: undefined }, { ...savedArticle, progress: undefined });
  assert.equal(practiced.progress.realtime.value, '');
  await page.open();
  await page.draft('The second essay.');
  await page.fire('importForm', 'submit');
  assert.equal(JSON.parse(storage.getItem(ARTICLE_STORAGE_KEY)).articles.length, 2);
  const restored = createPage({ storage });
  assert.equal(restored.$('sourceReadable').textContent, 'The second essay.');
  assert.equal(restored.$('articleTitle').textContent, 'The second essay.');
});

test('cancelled drafts, empty submissions, file previews and pending reads preserve the saved article', async () => {
  const saved = JSON.stringify({ version: 1, text: 'The saved article.', title: 'Saved title' });
  const storage = memoryStorage({ [ARTICLE_STORAGE_KEY]: saved });
  const page = createPage({ storage });
  await page.open();
  await page.draft('An abandoned draft.');
  await page.fire('cancelImport', 'click');
  await page.open();
  await page.draft(' \t\r\n ');
  await page.fire('importForm', 'submit');
  assert.equal(page.$('importDialog').open, true);
  await page.choose(file('Preview.txt', 'Only previewed.'));
  await page.fire('cancelImport', 'click');
  await page.open();
  await page.draft('Draft before reading.');
  const reading = delayedFile('Pending.txt');
  const pending = page.choose(reading.file);
  await page.fire('importForm', 'submit');
  assert.equal(page.$('sourceReadable').textContent, 'The saved article.');
  await page.fire('cancelImport', 'click');
  reading.resolve('A stale file result.');
  await pending;
  assert.equal(storage.getItem(ARTICLE_STORAGE_KEY), saved);
  assert.equal(storage.writes.length, 0);
  assert.equal(createPage({ storage }).$('sourceReadable').textContent, 'The saved article.');
});

test('invalid, empty, unreadable and incorrectly encoded TXT files never overwrite a saved article', async () => {
  const saved = JSON.stringify({ version: 1, text: 'Keep the last import.', title: 'My original title' });
  const invalidFiles = [
    { name: 'wrong.csv' },
    file('empty.txt', ' \r\n\t '),
    { name: 'broken.txt', arrayBuffer: async () => { throw new Error('Read failed'); } },
    { name: 'encoding.txt', arrayBuffer: async () => Uint8Array.from([0xff, 0xfe]).buffer },
  ];
  for (const invalidFile of invalidFiles) {
    const storage = memoryStorage({ [ARTICLE_STORAGE_KEY]: saved });
    const page = createPage({ storage });
    await page.open();
    await page.choose(invalidFile);
    assert.equal(page.$('importError').hidden, false);
    await page.fire('importForm', 'submit');
    assert.equal(storage.getItem(ARTICLE_STORAGE_KEY), saved);
    assert.equal(storage.writes.length, 0);
    assert.equal(page.$('sourceReadable').textContent, 'Keep the last import.');
  }
});

test('malformed or unsupported saved records fall back consistently to the sample in both modes', () => {
  const sample = createPage().$('sourceReadable').textContent;
  const invalidRecords = [
    '{broken', 'null', '[]', '"a string"', '42',
    JSON.stringify({ version: 2, text: 'Wrong version.', title: 'Title' }),
    JSON.stringify({ version: 1, text: ' \r\n\t ', title: 'Title' }),
    JSON.stringify({ version: 1, text: 123, title: 'Title' }),
    JSON.stringify({ version: 1, text: {}, title: 'Title' }),
    JSON.stringify({ version: 1, text: 'Article.', title: null }),
    JSON.stringify({ version: 1, text: 'Article.', title: ' \t\r\n ' }),
    JSON.stringify({ text: 'Article.', title: 'Title' }),
  ];
  for (const invalidRecord of invalidRecords) {
    const storage = memoryStorage({ [ARTICLE_STORAGE_KEY]: invalidRecord });
    const page = createPage({ storage });
    assert.equal(page.$('sourceReadable').textContent, sample);
    assert.equal(page.$('articleTitle').textContent, 'The value of everyday practice');
    assert.equal(page.$('articleKind').textContent, '示例范文');
    assert.deepEqual(page.sentence.created, [{ source: sample, title: 'The value of everyday practice', kind: '示例范文' }]);
    assert.equal(storage.writes.length, 0, 'a fallback must not replace the last stored value');
  }
});

test('restoring a valid record normalizes its source and title without persisting an initial practice', () => {
  const storage = memoryStorage({ [ARTICLE_STORAGE_KEY]: JSON.stringify({
    version: 1, text: '\uFEFF  One\tline.\r\n\r\nSecond  paragraph.  ', title: '  My saved title  ',
  }) });
  const page = createPage({ storage });
  assert.equal(page.$('sourceReadable').textContent, 'One line.\n\nSecond  paragraph.');
  assert.equal(page.$('articleTitle').textContent, 'My saved title');
  assert.deepEqual(page.sentence.created, [{ source: 'One line.\n\nSecond  paragraph.', title: 'My saved title', kind: '我的范文' }]);
  assert.equal(storage.writes.length, 0);
});

test('unavailable storage and a throwing storage getter cannot prevent opening or importing an article', async () => {
  const cases = [
    { storage: null },
    { storageGetter: () => { throw new Error('Browser storage disabled'); } },
  ];
  for (const options of cases) {
    const page = createPage(options);
    assert.match(page.$('sourceReadable').textContent, /^Learning a language/);
    await page.open();
    await page.draft('Practice still works.');
    await page.fire('importForm', 'submit');
    assert.equal(page.$('sourceReadable').textContent, 'Practice still works.');
    assert.equal(page.$('importDialog').open, false);
    assert.equal(page.$('articleStorageNotice').hidden, false);
    assert.match(page.$('articleStorageNotice').textContent, /保存|保留/);
    assert.match(page.$('articleStorageNotice').textContent, /无法|未能|不能|失败|不会|未保存|未.*保存/);
    await page.type('Practice');
    assert.equal(page.$('statusLabel').textContent, '练习中');
    assert.deepEqual(page.sentence.sources.at(-1), { source: 'Practice still works.', title: 'Practice still works.', kind: '我的范文' });
  }
});

test('a storage read failure falls back to the sample and does not prevent a later successful save', async () => {
  const storage = memoryStorage();
  storage.getItem = () => { throw new Error('Cannot read storage'); };
  const page = createPage({ storage });
  assert.match(page.$('sourceReadable').textContent, /^Learning a language/);
  await page.open();
  await page.draft('A new article can be saved.');
  await page.fire('importForm', 'submit');
  assert.equal(page.$('sourceReadable').textContent, 'A new article can be saved.');
  assert.equal(storage.writes.length, 1);
  const record = JSON.parse(storage.writes[0].value);
  assert.equal(record.text, 'A new article can be saved.');
  assert.equal(record.title, 'A new article can be saved.');
  assert.equal(record.articles.length, 1);
  assert.equal(page.$('articleStorageNotice').hidden, true);
});

test('a failed write preserves the stored article and the new practice, and the next successful save clears its notice', async () => {
  const saved = JSON.stringify({ version: 1, text: 'The earlier saved article.', title: 'Earlier' });
  const storage = memoryStorage({ [ARTICLE_STORAGE_KEY]: saved });
  const originalSetItem = storage.setItem;
  storage.setItem = () => { throw new Error('Storage quota exhausted'); };
  const page = createPage({ storage });
  await page.open();
  await page.draft('This article is usable without persistence.');
  await page.fire('importForm', 'submit');
  assert.equal(page.$('sourceReadable').textContent, 'This article is usable without persistence.');
  assert.equal(storage.getItem(ARTICLE_STORAGE_KEY), saved);
  assert.equal(page.$('articleStorageNotice').hidden, false);
  assert.match(page.$('articleStorageNotice').textContent, /保存|保留/);
  assert.match(page.$('articleStorageNotice').textContent, /无法|未能|不能|失败|不会|未保存|未.*保存/);
  assert.equal(createPage({ storage }).$('sourceReadable').textContent, 'The earlier saved article.');
  storage.setItem = originalSetItem;
  await page.open();
  await page.draft('This one is saved successfully.');
  await page.fire('importForm', 'submit');
  assert.equal(page.$('articleStorageNotice').hidden, true);
  assert.equal(createPage({ storage }).$('sourceReadable').textContent, 'This one is saved successfully.');
});

test('separate browser storage starts independently while explicitly shared storage restores an import', async () => {
  const first = createPage();
  await first.open();
  await first.draft('Only saved in the first browser.');
  await first.fire('importForm', 'submit');
  assert.match(createPage().$('sourceReadable').textContent, /^Learning a language/);
  assert.equal(createPage({ storage: first.storage }).$('sourceReadable').textContent, 'Only saved in the first browser.');
});

const settleTitles = () => new Promise(resolve => setImmediate(resolve));
async function importArticle(page, text) {
  await page.open();
  await page.draft(text);
  await page.fire('importForm', 'submit');
}

test('recent articles load into both modes, reset practice, and rename/delete without disturbing active practice', async () => {
  const page = createPage();
  await importArticle(page, 'First essay.');
  await importArticle(page, 'Second essay.');
  await settleTitles();
  await page.type('Second');
  await page.fire('timerStart', 'click');
  page.tick(2000);
  await page.fire('historyButton', 'click');
  assert.equal(page.$('historyCount').textContent, '2 / 10 篇');
  let firstCard = page.$('historyList').children[1];
  await firstCard.children[0].emit('click');
  assert.equal(page.$('historyDialog').open, false);
  assert.equal(page.$('sourceReadable').textContent, 'First essay.');
  assert.equal(page.$('typingInput').value, '');
  assert.equal(page.$('timerValue').textContent, '00:00');
  assert.equal(page.sentence.sources.at(-1).source, 'First essay.');
  assert.equal(createPage({ storage: page.storage }).$('sourceReadable').textContent, 'First essay.');
  await page.type('First');
  await page.fire('historyButton', 'click');
  firstCard = page.$('historyList').children[1];
  await firstCard.children[3].children[0].emit('click');
  const editForm = firstCard.children[4];
  editForm.children[0].value = '  ';
  await editForm.emit('submit');
  assert.match(firstCard.children[5].textContent, /填写标题/);
  editForm.children[0].value = '我的第一篇';
  await editForm.emit('submit');
  assert.equal(page.$('articleTitle').textContent, '我的第一篇');
  assert.equal(page.sentence.titles.at(-1), '我的第一篇');
  assert.equal(page.$('typingInput').value, 'First');
  firstCard = page.$('historyList').children[1];
  await firstCard.children[3].children[1].emit('click');
  assert.equal(page.$('historyCount').textContent, '1 / 10 篇');
  assert.equal(page.$('sourceReadable').textContent, 'First essay.');
  assert.equal(page.$('typingInput').value, 'First');
  assert.equal(createPage({ storage: page.storage }).$('sourceReadable').textContent, 'Second essay.');
});

test('background AI naming never blocks practice or resets typed text and is reused after reimport', async () => {
  let resolveTitle, calls = 0;
  const pending = new Promise(resolve => { resolveTitle = resolve; });
  const page = createPage({ titleFetch: () => { calls++; return pending; } });
  await importArticle(page, 'Daily practice improves language skills.');
  assert.equal(page.$('importDialog').open, false);
  await page.type('Daily');
  await page.fire('timerStart', 'click');
  page.tick(3000);
  resolveTitle({ ok: true, json: async () => ({ title: '每天练习的价值' }) });
  await settleTitles();
  assert.equal(page.$('articleTitle').textContent, '每天练习的价值');
  assert.equal(page.$('typingInput').value, 'Daily');
  assert.equal(page.$('timerValue').textContent, '00:03');
  assert.equal(page.sentence.sources.length, 2, 'renaming must not reset sentence practice');
  assert.equal(page.sentence.titles.at(-1), '每天练习的价值');
  await importArticle(page, '  Daily practice improves language skills.  ');
  assert.equal(calls, 1);
  assert.equal(page.$('articleTitle').textContent, '每天练习的价值');
  assert.equal(JSON.parse(page.storage.getItem(ARTICLE_STORAGE_KEY)).articles.length, 1);
});

test('manual rename drafts survive an AI response, manual saves win, and deleted articles stay deleted', async () => {
  for (const action of ['rename', 'delete']) {
    let resolveTitle;
    const page = createPage({ titleFetch: () => new Promise(resolve => { resolveTitle = resolve; }) });
    await importArticle(page, 'An essay awaiting a title.');
    await page.fire('historyButton', 'click');
    const card = page.$('historyList').children[0];
    if (action === 'rename') {
      await card.children[3].children[0].emit('click');
      card.children[4].children[0].value = '尚未提交的手动标题';
      resolveTitle({ ok: true, json: async () => ({ title: 'AI 自动标题' }) });
      await settleTitles();
      assert.equal(card.children[4].children[0].value, '尚未提交的手动标题');
      assert.equal(page.$('historyList').children[0], card, 'AI must not rebuild an active rename editor');
      await card.children[4].emit('submit');
      assert.equal(page.$('articleTitle').textContent, '尚未提交的手动标题');
    } else {
      await card.children[3].children[1].emit('click');
      resolveTitle({ ok: true, json: async () => ({ title: '迟到标题' }) });
      await settleTitles();
      assert.equal(page.$('historyEmpty').hidden, false);
      assert.equal(JSON.parse(page.storage.getItem(ARTICLE_STORAGE_KEY)).articles.length, 0);
    }
  }
});

test('failed AI names offer a retry, and file mode keeps history usable without making an AI call', async () => {
  let calls = 0;
  const page = createPage({ titleFetch: async () => (++calls === 1
    ? { ok: false } : { ok: true, json: async () => ({ title: '重试成功的标题' }) }) });
  await importArticle(page, 'A retryable article.');
  await settleTitles();
  await page.fire('historyButton', 'click');
  const card = page.$('historyList').children[0];
  assert.match(card.children[5].textContent, /可重试/);
  await card.children[3].children[2].emit('click');
  await settleTitles();
  assert.equal(page.$('articleTitle').textContent, '重试成功的标题');
  assert.equal(calls, 2);
  const local = createPage({ protocol: 'file:', titleFetch: () => { throw new Error('must not call'); } });
  await importArticle(local, 'A local article.');
  await local.fire('historyButton', 'click');
  assert.match(local.$('historyList').children[0].children[5].textContent, /本地文件/);
  assert.equal(local.$('historyCount').textContent, '1 / 10 篇');
});

const savedState = page => JSON.parse(page.storage.getItem(ARTICLE_STORAGE_KEY));
const savedProgress = page => {
  const state = savedState(page);
  return state.currentId ? state.articles.find(article => article.id === state.currentId).progress : state.sampleProgress;
};
const frameRestore = page => { page.tick(0); page.tick(0); };
async function loadRecent(page, prefix) {
  await page.fire('historyButton', 'click');
  const card = page.$('historyList').children.find(card => card.children[0].textContent.startsWith(prefix));
  assert.ok(card, `recent article ${prefix} exists`);
  await card.children[0].emit('click');
  frameRestore(page);
}

test('automatic saves debounce typing and restore full text, cursor direction, scrolling and errors without startup writes', async () => {
  const page = createPage();
  await importArticle(page, 'We practise every day. Another sentence.');
  const baseline = page.storage.writes.length;
  await page.type('We');
  page.tick(200);
  await page.type('We practixe');
  page.tick(349);
  assert.equal(page.storage.writes.length, baseline);
  page.$('typingInput').setSelectionRange(3, 8, 'backward');
  await page.fire('typingInput', 'select');
  page.window.scrollY = 630;
  await page.windowEvent('scroll');
  page.tick(350);
  assert.equal(page.storage.writes.length, baseline + 1);
  const progress = savedProgress(page);
  assert.equal(progress.realtime.value, 'We practixe');
  assert.equal(progress.realtime.selectionStart, 3);
  assert.equal(progress.realtime.selectionEnd, 8);
  assert.equal(progress.realtime.selectionDirection, 'backward');
  assert.equal(progress.realtime.scrollY, 630);
  const error = page.$('errorHint').textContent;
  const writes = page.storage.writes.length;
  const restored = createPage({ storage: page.storage });
  frameRestore(restored);
  assert.equal(restored.$('typingInput').value, 'We practixe');
  assert.equal(restored.$('typingInput').selectionStart, 3);
  assert.equal(restored.$('typingInput').selectionEnd, 8);
  assert.equal(restored.$('typingInput').selectionDirection, 'backward');
  assert.equal(restored.window.scrollY, 630);
  assert.equal(restored.$('errorHint').textContent, error);
  assert.equal(restored.$('practiceProgressNotice').textContent, '已恢复上次练习');
  assert.equal(restored.document.activeElement, null, 'restoring does not open a mobile keyboard');
  assert.equal(page.storage.writes.length, writes, 'restoring never overwrites the saved scene');
});

test('pagehide and hidden visibility flush recent input immediately and composition waits for committed text', async () => {
  const page = createPage();
  await importArticle(page, 'A complete sentence.');
  await page.type('A');
  await page.windowEvent('pagehide');
  assert.equal(savedProgress(page).realtime.value, 'A');
  const before = page.storage.writes.length;
  await page.fire('typingInput', 'compositionstart');
  await page.type('A 临');
  page.tick(1000);
  await page.windowEvent('pagehide');
  assert.equal(page.storage.writes.length, before, 'unfinished IME text never replaces a committed draft');
  page.$('typingInput').value = 'A complete';
  page.$('typingInput').setSelectionRange(10, 10);
  await page.fire('typingInput', 'compositionend');
  page.document.visibilityState = 'hidden';
  await page.documentEvent('visibilitychange');
  assert.equal(savedProgress(page).realtime.value, 'A complete');
  page.tick(1000);
  assert.equal(page.storage.writes.length, before + 1, 'an immediate flush cancels the queued debounce');
});

test('sample practice resumes locally without appearing in imported history', async () => {
  const page = createPage();
  assert.equal(page.storage.getItem(ARTICLE_STORAGE_KEY), null);
  await page.type('Learning a language');
  await page.windowEvent('pagehide');
  const state = savedState(page);
  assert.deepEqual(state.articles, []);
  assert.equal(state.currentId, null);
  assert.equal(state.sampleProgress.realtime.value, 'Learning a language');
  const restored = createPage({ storage: page.storage });
  assert.equal(restored.$('articleKind').textContent, '示例范文');
  assert.equal(restored.$('typingInput').value, 'Learning a language');
  await restored.fire('historyButton', 'click');
  assert.equal(restored.$('historyCount').textContent, '0 / 10 篇');
});

test('mode changes preserve separate drafts, group settings, active group, selection and per-mode scrolling', async () => {
  const page = createPage();
  await importArticle(page, 'First sentence. Second sentence. Third sentence. Fourth sentence.');
  frameRestore(page);
  await page.type('First sent');
  page.$('typingInput').setSelectionRange(4, 4);
  page.window.scrollY = 250;
  await page.windowEvent('scroll');
  await page.fire('sentenceModeButton', 'click');
  frameRestore(page);
  const sentence = { groupSize: 2, activeGroup: 1, groups: [
    { draft: 'First group draft.', selectionStart: 3, selectionEnd: 5, selectionDirection: 'forward', referenceVisible: false, checked: true, scrollTop: 20 },
    { draft: 'Third sent', selectionStart: 6, selectionEnd: 6, selectionDirection: 'none', referenceVisible: true, checked: false, scrollTop: 8 },
  ] };
  page.sentence.change(sentence);
  page.window.scrollY = 910;
  await page.windowEvent('scroll');
  await page.windowEvent('pagehide');
  const state = savedProgress(page);
  assert.equal(state.mode, 'sentence');
  assert.equal(state.realtime.value, 'First sent');
  assert.equal(state.realtime.scrollY, 250);
  assert.equal(state.sentence.scrollY, 910);
  const restored = createPage({ storage: page.storage });
  frameRestore(restored);
  assert.equal(restored.$('sentencePanel').hidden, false);
  assert.equal(restored.$('realtimePanel').hidden, true);
  assert.equal(restored.window.scrollY, 910);
  assert.equal(restored.sentence.progress.groupSize, 2);
  assert.equal(restored.sentence.progress.activeGroup, 1);
  assert.deepEqual(restored.sentence.progress.groups, sentence.groups);
  await restored.fire('sentenceFullModeButton', 'click');
  frameRestore(restored);
  assert.equal(restored.$('typingInput').value, 'First sent');
  assert.equal(restored.$('typingInput').selectionStart, 4);
  assert.equal(restored.window.scrollY, 250);
  await restored.windowEvent('pagehide');
  assert.equal(savedProgress(restored).mode, 'realtime', 'switching a restored scene persists the newly selected mode');
  await restored.fire('sentenceModeButton', 'click');
  frameRestore(restored);
  assert.equal(restored.window.scrollY, 910);
  assert.deepEqual(restored.sentence.progress.groups, sentence.groups);
  await restored.windowEvent('pagehide');
  assert.equal(savedProgress(restored).mode, 'sentence');
});

test('switching articles flushes pending edits and restores each article while duplicate imports retain progress', async () => {
  const page = createPage();
  await importArticle(page, 'First article.');
  await page.type('First');
  await importArticle(page, 'Second article.');
  await page.type('Second ar');
  await loadRecent(page, 'First article.');
  assert.equal(page.$('typingInput').value, 'First');
  await page.type('First arti');
  await loadRecent(page, 'Second article.');
  assert.equal(page.$('typingInput').value, 'Second ar');
  await importArticle(page, '\n First article.  ');
  assert.equal(page.$('typingInput').value, 'First arti');
  assert.equal(savedState(page).articles.length, 2);
  const restored = createPage({ storage: page.storage });
  assert.equal(restored.$('typingInput').value, 'First arti');
});

test('restarting clears only the active mode while keeping the other draft and grouping choice', async () => {
  const page = createPage();
  await importArticle(page, 'One sentence. Two sentence. Three sentence. Four sentence.');
  await page.type('One sent');
  await page.fire('sentenceModeButton', 'click');
  frameRestore(page);
  page.sentence.change({ groupSize: 2, activeGroup: 1, groups: [
    { draft: 'One group.', selectionStart: 10, selectionEnd: 10, selectionDirection: 'none', referenceVisible: true, checked: true, scrollTop: 0 },
    { draft: 'Three', selectionStart: 5, selectionEnd: 5, selectionDirection: 'none', referenceVisible: true, checked: false, scrollTop: 0 },
  ] });
  await page.windowEvent('pagehide');
  await page.fire('restartButton', 'click');
  page.tick(350);
  let progress = savedProgress(page);
  assert.equal(progress.realtime.value, 'One sent');
  assert.equal(progress.sentence.groupSize, 2);
  assert.deepEqual(progress.sentence.groups.map(group => group.draft), ['', '']);
  page.sentence.change({ ...page.sentence.progress, groups: page.sentence.progress.groups.map((group, index) => ({ ...group, draft: index ? '' : 'New group' })) });
  await page.fire('sentenceFullModeButton', 'click');
  frameRestore(page);
  assert.equal(page.$('typingInput').value, 'One sent');
  await page.fire('restartButton', 'click');
  page.tick(350);
  progress = savedProgress(page);
  assert.equal(progress.realtime.value, '');
  assert.equal(progress.sentence.groups[0].draft, 'New group');
});

test('deleting a visible article discards its progress and pending edits cannot recreate it', async () => {
  const page = createPage();
  await importArticle(page, 'An article to remove.');
  await page.type('An article');
  await page.fire('historyButton', 'click');
  const card = page.$('historyList').children[0];
  await card.children[3].children[1].emit('click');
  page.tick(1000);
  await page.windowEvent('pagehide');
  assert.deepEqual(savedState(page).articles, []);
  assert.equal(page.$('typingInput').value, 'An article', 'deletion need not discard visible unsaved text');
  await page.type('Still visible');
  page.tick(1000);
  assert.deepEqual(savedState(page).articles, []);
  assert.equal('sampleProgress' in savedState(page), false, 'deleted imported drafts never become sample progress');
});

test('quota failure warns without losing the current draft or previously saved progress and a later save recovers', async () => {
  const page = createPage();
  await importArticle(page, 'An article that remains usable.');
  await page.type('An');
  await page.windowEvent('pagehide');
  const before = page.storage.getItem(ARTICLE_STORAGE_KEY);
  const write = page.storage.setItem;
  page.storage.setItem = () => { throw new Error('quota'); };
  await page.type('An article');
  page.tick(350);
  assert.equal(page.$('typingInput').value, 'An article');
  assert.equal(page.storage.getItem(ARTICLE_STORAGE_KEY), before);
  assert.equal(page.$('practiceProgressNotice').hidden, false);
  assert.match(page.$('practiceProgressNotice').textContent, /暂未保存/);
  assert.equal(page.$('practiceProgressNotice').classList.contains('is-warning'), true);
  page.storage.setItem = write;
  await page.windowEvent('pagehide');
  assert.equal(savedProgress(page).realtime.value, 'An article');
  assert.equal(page.$('practiceProgressNotice').hidden, true);
});

test('failed pending-progress saves prevent article replacement so switching or importing cannot lose the current draft', async () => {
  for (const action of ['import', 'history']) {
    const page = createPage();
    await importArticle(page, 'First saved article.');
    await importArticle(page, 'Second current article.');
    await page.windowEvent('pagehide');
    const before = page.storage.getItem(ARTICLE_STORAGE_KEY);
    await page.type('Second unsaved typing');
    const write = page.storage.setItem;
    page.storage.setItem = () => { throw new Error('quota'); };
    if (action === 'import') {
      await page.open();
      await page.draft('A replacement article.');
      await page.fire('importForm', 'submit');
      assert.equal(page.$('importDialog').open, true);
      assert.equal(page.$('sourceEditor').value, 'A replacement article.');
    } else {
      await page.fire('historyButton', 'click');
      const first = page.$('historyList').children.find(card => card.children[0].textContent === 'First saved article.');
      await first.children[0].emit('click');
      assert.equal(page.$('historyDialog').open, true);
    }
    assert.equal(page.$('sourceReadable').textContent, 'Second current article.');
    assert.equal(page.$('typingInput').value, 'Second unsaved typing');
    assert.equal(page.storage.getItem(ARTICLE_STORAGE_KEY), before);
    assert.match(page.$('practiceProgressNotice').textContent, /暂未保存/);
    page.storage.setItem = write;
    await page.windowEvent('pagehide');
    assert.equal(savedProgress(page).realtime.value, 'Second unsaved typing');
  }
});

test('a failed history-selection write still restores the freshly flushed draft instead of a stale history card', async () => {
  const page = createPage();
  await importArticle(page, 'A saved article with a newer draft.');
  await page.type('A saved');
  await page.windowEvent('pagehide');
  await page.fire('historyButton', 'click');
  const current = page.$('historyList').children[0].children[0];
  await page.type('A saved article with');
  const write = page.storage.setItem;
  let attempts = 0;
  page.storage.setItem = (key, value) => {
    if (++attempts === 2) throw new Error('selection write quota');
    write(key, value);
  };
  await current.emit('click');
  assert.equal(page.$('typingInput').value, 'A saved article with');
  assert.equal(savedProgress(page).realtime.value, 'A saved article with');
  assert.match(page.$('articleStorageNotice').textContent, /未能保存这次切换/);
});
