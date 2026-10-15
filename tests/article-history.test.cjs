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
