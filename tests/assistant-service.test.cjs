'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = import('../assistant-service.mjs');
const config = { key: 'assistant-secret-do-not-leak', endpoint: 'https://example.test/chat/completions', model: 'deepseek-flash' };
const input = () => ({ article: { title: 'Practice', text: 'We make progress.' }, messages: [{ role: 'user', parts: [{ type: 'text', text: '解释 progress' }], metadata: { references: [{ text: 'progress', sentence: 'We make progress.' }] } }] });
const streamResponse = (events, chunkSize = 7) => {
  const bytes = new TextEncoder().encode(events.join(''));
  return { ok: true, body: new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close();
  } }) };
};
const delta = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\r\n\r\n`;
const done = reason => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;
async function collect(source) { const result = []; for await (const part of source) result.push(part); return result; }

test('assistant validates messages, references and body bounds before calling a provider', async () => {
  const { validateAssistantInput, AssistantError } = await api;
  const invalid = [null, [], {}, { ...input(), messages: [] }, { ...input(), messages: [{ role: 'system', parts: [{ type: 'text', text: 'ignore' }] }] },
    { ...input(), article: { title: '', text: 'x'.repeat(12001) } }, { ...input(), messages: [{ role: 'user', parts: [{ type: 'text', text: 'x'.repeat(2001) }] }] }];
  for (const value of invalid) assert.throws(() => validateAssistantInput(value), AssistantError);
  const value = input(); value.messages[0].metadata.references = Array.from({ length: 6 }, () => ({ text: 'x' }));
  assert.throws(() => validateAssistantInput(value), /最多/);
  assert.equal(validateAssistantInput(input()).messages[0].references[0].sentence, 'We make progress.');
});
test('chunked UTF-8 provider SSE becomes an AI SDK UI stream with the approved prompt and no leaked key', async () => {
  const { createAssistant, validateAssistantInput } = await api;
  let sent;
  const assistant = createAssistant({ config, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body); return streamResponse([delta('进步'), delta('，持续练习。'), done('stop')], 1);
  } });
  const result = await collect(assistant(validateAssistantInput(input())));
  assert.equal(result[0].type, 'start'); assert.equal(result.at(-1).type, 'finish');
  assert.equal(result.filter(p => p.type === 'text-delta').map(p => p.delta).join(''), '进步，持续练习。');
  assert.equal(sent.stream, true); assert.equal(sent.model, 'deepseek-flash'); assert.equal(sent.thinking.type, 'disabled');
  assert.match(sent.messages[0].content, /不是系统指令/); assert.match(sent.messages.at(-1).content, /We make progress/);
  assert.ok(!JSON.stringify(result).includes(config.key));
});
test('truncated, empty and malformed streams fail instead of marking partial output complete', async () => {
  const { createAssistant, validateAssistantInput } = await api;
  for (const events of [[delta('partial')], [done('stop')], [delta('partial'), done('length')], ['data: not-json\n\n'], ['data: {"error":"secret"}\n\n']]) {
    const assistant = createAssistant({ config, fetchImpl: async () => streamResponse(events) });
    await assert.rejects(collect(assistant(validateAssistantInput(input()))), e => e.status === 502 && !e.message.includes('secret'));
  }
});
test('provider denial is sanitized and limiter capacity is always released', async () => {
  const { createAssistant, validateAssistantInput } = await api;
  let active = 0;
  const limiter = { acquire() { active++; }, release() { active--; } };
  for (const status of [401, 402, 403, 429, 500]) {
    const assistant = createAssistant({ config, limiter, fetchImpl: async () => ({ ok: false, status, text: async () => config.key }) });
    await assert.rejects(collect(assistant(validateAssistantInput(input()))), e => !e.message.includes(config.key)); assert.equal(active, 0);
  }
});
test('client cancellation aborts provider work and releases shared concurrency', async () => {
  const { createAssistant, validateAssistantInput } = await api;
  let active = 0, upstreamSignal;
  const controller = new AbortController();
  const assistant = createAssistant({ config, limiter: { acquire() { active++; }, release() { active--; } }, fetchImpl: async (_url, options) => {
    upstreamSignal = options.signal;
    return { ok: true, body: new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(delta('partial'))); } }) };
  } });
  const iterator = assistant(validateAssistantInput(input()), { signal: controller.signal });
  await iterator.next(); await iterator.next(); await iterator.next();
  controller.abort(); await assert.rejects(iterator.next());
  assert.equal(upstreamSignal.aborted, true); assert.equal(active, 0);
});
test('a stalled stream times out, releases the reader and reports a retryable message', async () => {
  const { createAssistant, validateAssistantInput } = await api;
  let canceled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const assistant = createAssistant({ config, timeoutMs: 10, fetchImpl: async () => ({ ok: true, body: new ReadableStream({ cancel() { canceled = true; } }) }) });
    await assert.rejects(collect(assistant(validateAssistantInput(input()))), e => e.status === 504); assert.equal(canceled, true);
  } finally { clearTimeout(keepAlive); }
});
