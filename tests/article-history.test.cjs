const test = require('node:test');
const assert = require('node:assert/strict');
const { create, STORAGE_KEY } = require('../article-history.js');
const { normalizeSource } = require('../typing-core.js');

function fixture(initial) {
  let value = initial || null;
  let time = 1000;
  let sequence = 0;
  const storage = { getItem: () => value, setItem: (key, data) => { value = data; } };
  const makeStore = () => create({ getStorage: () => storage, normalizeText: normalizeSource,
    now: () => ++time, makeId: () => `article-${++sequence}` });
  return { store: makeStore(), makeStore, storage, value: () => value };
}

test('the eleventh import evicts the earliest import even if it was recently loaded', () => {
  const f = fixture();
  const first = f.store.importArticle('Article 1.', 'One');
  for (let i = 2; i <= 10; i++) f.store.importArticle(`Article ${i}.`, `Title ${i}`);
  f.store.select(first.id);
  const before = f.store.read();
  assert.equal(before.articles[0].id, first.id);
  f.store.importArticle('Article 11.', 'Eleven');
  const after = f.makeStore().read();
  assert.equal(after.articles.length, 10);
  assert.equal(after.articles[0].text, 'Article 2.');
  assert.equal(after.articles.at(-1).text, 'Article 11.');
  assert.equal(after.articles.some(item => item.id === first.id), false);
});

test('trim-only deduplication reuses the title and id, refreshes FIFO order, and preserves inner whitespace', () => {
  const f = fixture();
  const first = f.store.importArticle('  Same  text.\n', 'First');
  f.store.rename(first.id, '我的标题');
  f.store.importArticle('Other text.', 'Other');
  const duplicate = f.store.importArticle('\nSame  text.  ', 'New file name');
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.title, '我的标题');
  assert.equal(duplicate.titleSource, 'manual');
  assert.ok(duplicate.importedAt > first.importedAt);
  assert.equal(f.store.read().articles.length, 2);
  assert.equal(f.store.read().articles.at(-1).id, first.id);
  f.store.importArticle('Same text.', 'Different whitespace');
  f.store.importArticle('Same\ttext.', 'Different tab');
  assert.equal(f.store.read().articles.length, 4);
});

test('legacy article migrates without startup writes, persists with a new article, and empty history stays empty', () => {
  const original = JSON.stringify({ version: 1, text: '  Saved\tarticle. ', title: ' Old title ' });
  const f = fixture(original);
  assert.equal(f.store.read().articles[0].title, 'Old title');
  assert.equal(f.value(), original);
  f.store.importArticle('New article.', 'New');
  const reloaded = f.makeStore();
  assert.equal(reloaded.read().articles.length, 2);
  for (const item of reloaded.read().articles) reloaded.remove(item.id);
  assert.deepEqual(f.makeStore().read(), { articles: [], currentId: null });
  assert.equal(JSON.parse(f.value()).text, '');
});

test('loading changes restore selection without reordering; deletion restores the last used retained article', () => {
  const f = fixture();
  const first = f.store.importArticle('One.', 'One');
  const second = f.store.importArticle('Two.', 'Two');
  const third = f.store.importArticle('Three.', 'Three');
  f.store.select(first.id);
  f.store.select(third.id);
  assert.equal(f.makeStore().read().currentId, third.id);
  assert.deepEqual(f.store.read().articles.map(item => item.id), [first.id, second.id, third.id]);
  f.store.remove(third.id);
  assert.equal(f.makeStore().read().currentId, first.id);
});

test('manual titles and deleted or evicted articles cannot be overwritten by delayed AI responses', () => {
  const f = fixture();
  const first = f.store.importArticle('One.', 'Placeholder');
  f.store.rename(first.id, '用户改名');
  assert.equal(f.store.rename(first.id, 'AI title', { generated: true, expectedTitle: first.title }), null);
  f.store.remove(first.id);
  assert.equal(f.store.rename(first.id, 'Late AI', { generated: true, expectedTitle: first.title }), null);
  assert.equal(f.store.read().articles.length, 0);
  const second = f.store.importArticle('Two.', 'Temporary');
  const updated = f.store.rename(second.id, 'AI 主题', { generated: true, expectedTitle: second.title });
  assert.equal(updated.titleSource, 'ai');
  assert.equal(f.store.importArticle('Two.', 'Different name').title, 'AI 主题');
});

test('failed writes preserve all stored records and never apply a partial delete or rename', () => {
  const f = fixture();
  const first = f.store.importArticle('One.', 'One');
  const before = f.value();
  f.storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => f.store.importArticle('Two.', 'Two'));
  assert.throws(() => f.store.rename(first.id, 'Renamed'));
  assert.throws(() => f.store.remove(first.id));
  assert.equal(f.value(), before);
  assert.equal(f.store.read().articles[0].title, 'One');
  assert.equal(f.store.read().articles.length, 1);
});

test('each mutation rereads storage so separate tabs keep other tabs imports and manual names', () => {
  const f = fixture();
  const other = f.makeStore();
  const first = f.store.importArticle('One.', 'One');
  other.importArticle('Two.', 'Two');
  other.rename(first.id, 'Another tab');
  assert.equal(f.store.rename(first.id, 'Late AI', { generated: true, expectedTitle: 'One' }), null);
  f.store.importArticle('Three.', 'Three');
  assert.equal(other.read().articles.length, 3);
  assert.equal(other.read().articles[0].title, 'Another tab');
});

test('invalid storage falls back safely and invalid titles do not mutate records', () => {
  for (const data of ['{broken', 'null', '42', '[]', JSON.stringify({ version: 2, articles: [] })]) {
    assert.deepEqual(fixture(data).store.read(), { articles: [], currentId: null });
  }
  const f = fixture();
  const first = f.store.importArticle('One.', 'One');
  for (const title of ['', ' \n ', '长'.repeat(81)]) assert.throws(() => f.store.rename(first.id, title));
  assert.equal(f.store.read().articles[0].title, 'One');
});

function progress(overrides = {}) {
  return { version: 1, mode: 'realtime',
    realtime: { value: 'Half typed', selectionStart: 5, selectionEnd: 5, selectionDirection: 'none', scrollY: 210 },
    sentence: { groupSize: 2, activeGroup: 1, scrollY: 450, groups: [
      { draft: 'First group.', selectionStart: 12, selectionEnd: 12, selectionDirection: 'none', referenceVisible: false, checked: true, scrollTop: 30 },
      { draft: 'Second', selectionStart: 2, selectionEnd: 6, selectionDirection: 'backward', referenceVisible: true, scrollTop: 5 },
    ] }, scrollY: 210, ...overrides };
}

test('practice progress survives reload independently per article and never changes import or last-used order', () => {
  const f = fixture();
  const first = f.store.importArticle('One.', 'One');
  const second = f.store.importArticle('Two.', 'Two');
  const before = f.store.read();
  const firstProgress = progress();
  const secondProgress = progress({ mode: 'sentence', scrollY: 450 });
  f.store.saveProgress(first.id, firstProgress);
  f.store.saveProgress(second.id, secondProgress);
  const reloaded = f.makeStore().read();
  assert.equal(reloaded.currentId, second.id);
  assert.deepEqual(reloaded.articles.map(({ progress, ...article }) => article), before.articles);
  assert.deepEqual(reloaded.articles[0].progress, firstProgress);
  assert.deepEqual(reloaded.articles[1].progress, secondProgress);
  f.store.select(first.id);
  f.store.rename(first.id, 'Renamed');
  assert.deepEqual(f.makeStore().read().articles[0].progress, firstProgress);
});

test('sample progress is optional and stores alongside imported articles without changing the selected article', () => {
  const f = fixture();
  assert.deepEqual(f.store.read(), { articles: [], currentId: null });
  assert.equal(f.value(), null);
  f.store.saveProgress(null, progress());
  assert.deepEqual(f.makeStore().read(), { articles: [], currentId: null, sampleProgress: progress() });
  const imported = f.store.importArticle('Imported text.', 'Imported');
  assert.equal(f.makeStore().read().currentId, imported.id);
  assert.deepEqual(f.makeStore().read().sampleProgress, progress());
  f.store.saveProgress(null, null);
  assert.equal('sampleProgress' in f.makeStore().read(), false);
  assert.equal(f.makeStore().read().currentId, imported.id);
});

test('progress normalizes cursor and scroll bounds, strips unknown properties, and preserves a full ordinary draft', () => {
  const f = fixture();
  const article = f.store.importArticle('Tiny article.', 'Tiny');
  const draft = 'Longer draft than the reference. '.repeat(2000);
  const saved = progress({ mode: 'sentence', scrollY: -4.5,
    realtime: { value: draft, selectionStart: -20, selectionEnd: Infinity, selectionDirection: 'bad', scrollY: 23.9, secret: 'drop' },
    sentence: { groupSize: Number.MAX_SAFE_INTEGER, activeGroup: 100.5, scrollY: 1e20, groups: [
      { draft: 'abc', selectionStart: 50, selectionEnd: -5, selectionDirection: 'backward', referenceVisible: false, checked: false, scrollTop: -50, extra: 'drop' },
    ], unknown: true }, unexpected: 'drop' });
  f.store.saveProgress(article.id, saved);
  const result = f.makeStore().read().articles[0].progress;
  assert.equal(result.realtime.value, draft);
  assert.deepEqual(result.realtime, { value: draft, selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollY: 23 });
  assert.deepEqual(result.sentence, { groupSize: Number.MAX_SAFE_INTEGER, activeGroup: 0, scrollY: 100000000, groups: [
    { draft: 'abc', selectionStart: 3, selectionEnd: 3, selectionDirection: 'backward', referenceVisible: false, checked: false, scrollTop: 0 },
  ] });
  assert.equal(result.scrollY, 0);
  assert.equal('unexpected' in result, false);
});

test('all returned and submitted progress snapshots are independent copies, including nested groups', () => {
  const f = fixture();
  const article = f.store.importArticle('One.', 'One');
  const submitted = progress();
  const written = f.store.saveProgress(article.id, submitted);
  f.store.saveProgress(null, progress());
  submitted.realtime.value = 'mutated input';
  submitted.sentence.groups[0].draft = 'mutated input group';
  written.articles[0].progress.sentence.groups[0].draft = 'mutated result';
  const read = f.store.read();
  read.articles[0].progress.realtime.value = 'mutated read';
  read.sampleProgress.sentence.groups[0].draft = 'mutated sample';
  f.store.select(article.id).progress.sentence.groups[0].draft = 'mutated selection';
  f.store.rename(article.id, 'New title').progress.realtime.value = 'mutated rename';
  const imported = f.store.importArticle('One.', 'One again');
  imported.progress.sentence.groups[0].draft = 'mutated duplicate';
  assert.deepEqual(f.makeStore().read().articles[0].progress, progress());
  assert.deepEqual(f.makeStore().read().sampleProgress, progress());
});

test('duplicate imports preserve progress while article deletion and FIFO eviction discard it permanently', () => {
  const f = fixture();
  const first = f.store.importArticle('One.', 'One');
  f.store.saveProgress(first.id, progress());
  f.store.importArticle('  One. ', 'Duplicate');
  assert.deepEqual(f.store.read().articles[0].progress, progress());
  f.store.remove(first.id);
  const afterDelete = f.value();
  assert.equal(f.store.saveProgress(first.id, progress()), null);
  assert.equal(f.value(), afterDelete);
  const reimported = f.store.importArticle('One.', 'One');
  assert.notEqual(reimported.id, first.id);
  assert.equal('progress' in reimported, false);
  f.store.saveProgress(reimported.id, progress());
  for (let i = 2; i <= 11; i++) f.store.importArticle(`Article ${i}.`, `Title ${i}`);
  const afterEviction = f.value();
  assert.equal(f.store.saveProgress(reimported.id, progress()), null);
  assert.equal(f.value(), afterEviction);
  assert.equal(f.makeStore().read().articles.some(item => item.id === reimported.id), false);
});

test('malformed and oversized progress is ignored on read without writes and rejected on save without modifying drafts', () => {
  const invalid = [null, [], {}, { ...progress(), version: 2 }, { ...progress(), mode: 'invalid' },
    { version: 1, mode: 'realtime' }, { ...progress(), realtime: { value: 25 } },
    { ...progress(), sentence: { groupSize: 0, groups: [] } },
    { ...progress(), sentence: { groupSize: 1.1, groups: [] } },
    { ...progress(), sentence: { groupSize: 1, groups: [null] } },
    { ...progress(), sentence: { groupSize: 1, groups: Array.from({ length: 10001 }, () => ({ draft: '' })) } },
    { ...progress(), realtime: { value: 'x'.repeat(1000001) } },
  ];
  for (const value of invalid) {
    const original = JSON.stringify({ version: 1, articles: [{ id: 'one', text: 'One.', title: 'One', progress: value }], currentId: 'one', sampleProgress: value });
    const f = fixture(original);
    const read = f.store.read();
    assert.equal(read.articles.length, 1);
    assert.equal('progress' in read.articles[0], false);
    assert.equal('sampleProgress' in read, false);
    assert.equal(f.value(), original);
    // null is the explicit clearing operation rather than an invalid save.
    if (value !== null) assert.throws(() => f.store.saveProgress('one', value), /练习进度/);
    assert.equal(f.value(), original);
  }
});

test('progress save and clear are atomic on storage failures and reread other tabs changes', () => {
  const f = fixture();
  const first = f.store.importArticle('One.', 'One');
  const other = f.makeStore();
  other.importArticle('Two.', 'Two');
  other.rename(first.id, 'Other tab title');
  f.store.saveProgress(first.id, progress());
  assert.equal(f.store.read().articles.length, 2);
  assert.equal(f.store.read().articles[0].title, 'Other tab title');
  const before = f.value();
  f.storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => f.store.saveProgress(first.id, progress({ scrollY: 500 })), /quota/);
  assert.throws(() => f.store.saveProgress(first.id, null), /quota/);
  assert.throws(() => f.store.saveProgress(null, progress()), /quota/);
  assert.equal(f.value(), before);
  assert.deepEqual(f.makeStore().read().articles[0].progress, progress());
});
