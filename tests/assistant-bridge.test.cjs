'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const data = new Map(), listeners = new Map();
  const storage = { get length() { return data.size; }, getItem: k => data.get(k) ?? null, key: i => [...data.keys()][i], setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  const element = { setAttribute() {}, removeAttribute() {}, addEventListener() {} };
  const context = vm.createContext({ localStorage: storage, CustomEvent: class { constructor(type) { this.type = type; } },
    document: { getElementById: () => element, addEventListener() {} },
    addEventListener(type, fn) { const previous = listeners.get(type) || []; listeners.set(type, [...previous, fn]); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
  });
  context.window = context;
  for (const file of ['article-history.js', 'assistant-history.js', 'assistant-bridge.js']) vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context);
  const articles = context.ArticleHistory.create({ getStorage: () => storage, normalizeText: t => t.trim(), makeId: (() => { let i = 0; return () => `article-${++i}`; })() });
  return { context, storage, articles, assistant: context.LearningAssistant, history: context.AssistantHistory.create({ storage: () => storage }) };
}
test('bridge reads real article storage with the required callbacks so imported conversation can persist', () => {
  const { articles, assistant, history, storage } = fixture();
  const article = articles.importArticle('A complete imported passage.', 'Imported');
  assistant.configureArticle({ id: article.id, title: article.title, text: article.text });
  const state = assistant.getState();
  assert.equal(state.retainedIds.length, 1); assert.equal(state.retainedIds[0], article.id); assert.equal(state.article.persistable, true);
  history.write('guest', article.id, { draft: '保留的学习草稿' });
  articles.rename(article.id, 'Renamed');
  assert.equal(history.read('guest', article.id).draft, '保留的学习草稿');
  assert.ok(storage.length > 1);
});
test('article deletion and FIFO clear corresponding histories for every owner', () => {
  const { articles, assistant, history } = fixture();
  const oldest = articles.importArticle('Oldest passage.', 'Oldest');
  assistant.configureArticle({ id: oldest.id, title: oldest.title, text: oldest.text });
  history.write('guest', oldest.id, { draft: 'guest' }); history.write('account:1', oldest.id, { draft: 'account' });
  for (let i = 0; i < 10; i++) articles.importArticle(`New passage ${i}.`, `New ${i}`);
  assert.equal(history.has('guest', oldest.id), false); assert.equal(history.has('account:1', oldest.id), false);
  assert.equal(assistant.getState().article.persistable, false);
  const current = articles.read().articles.at(-1);
  history.write('guest', current.id, { draft: 'delete' }); articles.remove(current.id);
  assert.equal(history.has('guest', current.id), false);
});
