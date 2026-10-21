'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, normalize, PREFIX } = require('../assistant-history.js');
const memory = () => {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i], getItem: k => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
};
const user = (id, text = '问题') => ({ id, role: 'user', parts: [{ type: 'text', text }], metadata: { references: [{ id: 'r1', text: 'progress', sentence: 'We make progress.' }] } });
const answer = id => ({ id, role: 'assistant', parts: [{ type: 'text', text: '中文回答。' }] });

test('assistant browser history isolates visitors, accounts and articles and retains references/drafts', () => {
  const storage = memory(), store = create({ storage: () => storage });
  const value = { messages: [user('u1'), answer('a1')], turns: { u1: { status: 'complete' } }, draft: '继续提问', references: [{ id: 'r2', text: 'practice' }] };
  assert.equal(store.write('guest', 'one', value).saved, true);
  store.write('account:2', 'one', { draft: '私有记录' });
  assert.equal(store.read('guest', 'one').draft, '继续提问');
  assert.equal(store.read('account:2', 'one').draft, '私有记录');
  assert.equal(store.read('account:3', 'one').messages.length, 0);
  assert.equal(store.read('guest', 'two').messages.length, 0);
  assert.equal(store.read('guest', 'one').messages[0].metadata.references[0].text, 'progress');
  assert.equal(store.read('guest', 'one').references[0].text, 'practice');
});
test('in-flight turns restore as interrupted rather than falsely complete; partial output remains', () => {
  const storage = memory(), store = create({ storage: () => storage });
  store.write('guest', 'sample', { messages: [user('u'), answer('a')], turns: { u: { status: 'submitted' } } });
  assert.equal(store.read('guest', 'sample').turns.u.status, 'interrupted');
  assert.equal(store.read('guest', 'sample').messages.length, 2);
});
test('FIFO/deletion pruning removes histories for all owners without touching other browser storage', () => {
  const storage = memory(), store = create({ storage: () => storage });
  storage.setItem('practice', 'keep');
  for (const owner of ['guest', 'account:1']) for (const id of ['sample', 'old', 'retained']) store.write(owner, id, { draft: id });
  assert.equal(store.prune(['retained']), true);
  assert.equal(storage.length, 5);
  assert.equal(store.has('guest', 'old'), false);
  assert.equal(store.read('account:1', 'retained').draft, 'retained');
  assert.equal(storage.getItem('practice'), 'keep');
});
test('a late generation cannot resurrect a removed article; disabled storage degrades safely', () => {
  let retained = true;
  const store = create({ storage: () => memory(), allowed: () => retained });
  retained = false;
  assert.deepEqual(store.write('guest', 'deleted', { messages: [user('u')] }), { saved: false, deleted: true });
  const blocked = create({ storage: () => { throw new Error('disabled'); } });
  assert.equal(blocked.read('guest', 'sample').messages.length, 0);
  assert.equal(blocked.write('guest', 'sample', {}).saved, false);
});
test('corrupt browser data is normalized and old complete pairs are bounded', () => {
  assert.equal(normalize({ messages: [null, { role: 'system', id: 'system', parts: [] }] }).messages.length, 0);
  const messages = [];
  for (let i = 0; i < 100; i++) messages.push(user(`u${i}`), answer(`a${i}`));
  const value = normalize({ messages, references: [{ id: 'same', text: 'a' }, { id: 'same', text: 'b' }] });
  assert.equal(value.messages.length, 120);
  assert.equal(value.messages[0].role, 'user');
  assert.equal(value.references.length, 1);
  assert.equal(value.trimmed, true);
});
test('clear affects just the selected account/article', () => {
  const storage = memory(), store = create({ storage: () => storage });
  store.write('guest', 'one', { draft: 'one' }); store.write('guest', 'two', { draft: 'two' });
  store.remove('guest', 'one'); assert.equal(store.read('guest', 'one').draft, ''); assert.equal(store.read('guest', 'two').draft, 'two');
  assert.ok(PREFIX.includes('assistant'));
});

test('quick-learning target survives refresh alongside unused references and drafts, and invalid targets are discarded', () => {
  const storage = memory(), store = create({ storage: () => storage });
  store.write('guest', 'sample', { messages: [user('u1'), answer('a1')], draft: '不要清空草稿',
    references: [{ id: 'unused', text: 'routine' }], quickTargetId: 'r1' });
  const saved = store.read('guest', 'sample');
  assert.equal(saved.quickTargetId, 'r1');
  assert.equal(saved.references[0].id, 'unused');
  assert.equal(saved.draft, '不要清空草稿');
  assert.equal(normalize({ quickTargetId: 'removed' }).quickTargetId, '');
  assert.equal(normalize({ quickTargetId: {}, messages: [user('u')] }).quickTargetId, '');
});
