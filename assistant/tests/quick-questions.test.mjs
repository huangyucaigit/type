import test from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_QUESTIONS, referenceKind, recommendedQuestions, questionTarget } from '../src/quick-questions.mjs';
const ref = (id, text) => ({ id, text, sentence: 'We make progress through regular practice.', paragraph: '' });
const user = references => ({ role: 'user', metadata: { references } });

test('word, phrase, sentence and paragraph receive relevant lightweight recommendations', () => {
  for (const text of ['progress', 'progress.', 'make progress', 'well-written', "people’s lives"]) {
    assert.equal(referenceKind({ text }), 'expression', text);
    assert.deepEqual(recommendedQuestions({ text }).map(item => item.id), ['collocations', 'alternatives']);
  }
  for (const text of ['Regular practice helps us improve.', 'Although practice takes time, it helps us improve', 'Why does practice help us improve?']) {
    assert.equal(referenceKind({ text }), 'sentence', text);
    assert.deepEqual(recommendedQuestions({ text }).map(item => item.id), ['structure', 'imitation', 'rewrite']);
  }
  for (const text of ['We practice daily. It makes a difference.', 'We practice daily.\n\nOur confidence grows.']) {
    assert.equal(referenceKind({ text }), 'passage');
    assert.deepEqual(recommendedQuestions({ text }).map(item => item.id), ['collocations', 'writing', 'imitation']);
  }
});

test('six distinct prompts scope the chosen reference, bound teaching detail and keep practice answers hidden', () => {
  assert.equal(QUICK_QUESTIONS.length, 6);
  assert.equal(new Set(QUICK_QUESTIONS.map(item => item.id)).size, 6);
  for (const item of QUICK_QUESTIONS) {
    assert.ok(item.prompt.length < 2000);
    assert.match(item.prompt, /这一条英语引用/);
    assert.match(item.prompt, /简洁中文/);
    assert.match(item.prompt, /最多1个英文例句/);
  }
  assert.match(QUICK_QUESTIONS.find(item => item.id === 'imitation').prompt, /不给答案或示例.*等我作答后/);
  assert.match(QUICK_QUESTIONS.find(item => item.id === 'rewrite').prompt, /不强行改写/);
  assert.match(QUICK_QUESTIONS.find(item => item.id === 'writing').prompt, /不打分/);
});

test('new content is the default target; sending it preserves the target even with older pending quotes', () => {
  const old = ref('old', 'practice'), newest = ref('new', 'progress');
  assert.equal(questionTarget([old, newest], []).reference, newest);
  const target = questionTarget([old], [user([newest])], 'new');
  assert.equal(target.reference, newest);
  assert.equal(target.label, '继续学习上次引用');
  assert.equal(questionTarget([old], [user([newest])], 'old').reference, old);
  assert.equal(questionTarget([], [user([newest])]).reference, newest);
  assert.equal(questionTarget([], [], 'gone'), null);
});

test('removing an unsent target falls back to a real remaining reference and old data remains compatible', () => {
  const remaining = ref('remaining', 'practice');
  assert.equal(questionTarget([remaining], [], 'removed').reference, remaining);
  assert.equal(questionTarget([], [{ role: 'assistant', parts: [] }, { role: 'user' }]), null);
});
