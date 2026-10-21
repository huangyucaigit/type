import test from 'node:test';
import assert from 'node:assert/strict';
import { requestMessages } from '../src/conversation.mjs';
const message = (id, role, text) => ({ id, role, parts: [{ type: 'text', text }], ...(role === 'user' ? { metadata: { references: [{ id: 'r', text: 'practice' }] } } : {}) });
test('failed/stopped partial turns are excluded while the current question and its references remain', () => {
  const input = [message('u1', 'user', 'old'), message('a1', 'assistant', 'partial'), message('u2', 'user', 'new')];
  for (const status of ['failed', 'stopped', 'interrupted']) {
    const sent = requestMessages(input, { u1: { status }, u2: { status: 'submitted' } });
    assert.deepEqual(sent.map(m => m.id), ['u2']); assert.equal(sent[0].metadata.references[0].text, 'practice');
  }
});
test('the context retains recent complete turns and clips older long answers without mutating display history', () => {
  const input = [];
  for (let i = 0; i < 10; i++) input.push(message(`u${i}`, 'user', 'question'), message(`a${i}`, 'assistant', 'x'.repeat(12000)));
  input.push(message('last', 'user', 'follow up'));
  const sent = requestMessages(input, {});
  assert.ok(sent.length <= 13); assert.equal(sent.at(-1).id, 'last'); assert.equal(sent[0].role, 'user');
  assert.equal(input[1].parts[0].text.length, 12000);
  assert.ok(sent.filter(m => m.role === 'assistant').every(m => m.parts[0].text.length === 8000));
});
