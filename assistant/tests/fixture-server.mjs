// Local browser QA only. Not a production entry point and never served by the app.
import { createServer, createRequestLimiter } from '../../translation-server.mjs';
import { createAssistant } from '../../assistant-service.mjs';
import { createAuthService } from '../../auth-service.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync(new URL('../../.deploy/', import.meta.url), { recursive: true });
const events = [], attempts = new Map();
function record(value) { events.push(value); writeFileSync(new URL('../../.deploy/assistant-qa-events.json', import.meta.url), JSON.stringify(events)); }
const provider = async (_url, options) => {
  const body = JSON.parse(options.body), current = JSON.parse(body.messages.at(-1).content);
  const key = current.question;
  const attempt = (attempts.get(key) || 0) + 1; attempts.set(key, attempt);
  const selected = current.references.map(ref => ref.text).join('、');
  record({ type: 'request', question: key, selected, messages: body.messages.length, attempt });
  if (key.includes('首次失败') && attempt === 1) return { ok: false, status: 503 };
  const content = `**学习分析**\n\n${selected ? `本次引用：${selected}。` : '结合当前范文回答。'}\n\n- 词义要结合原句理解。\n- 可以用自己的表达仿写。\n\n> Keep going, one sentence at a time.\n\n${key.includes('长回答') ? Array.from({ length: 12 }, (_, i) => `### 学习提示 ${i + 1}\n\nRegular practice leads to steady progress. 持续练习有助于稳步提高。`).join('\n\n') : '这是一条用于本地交互验收的模拟模型回复。'}`;
  const bytes = new TextEncoder();
  let timer, offset = 0, done = false;
  const stream = new ReadableStream({
    start(controller) {
      const push = () => {
        if (done) return;
        if (offset < content.length) {
          const delta = content.slice(offset, offset + 24); offset += 24;
          controller.enqueue(bytes.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta }, finish_reason: null }] })}\n\n`));
          timer = setTimeout(push, key.includes('慢速') ? 800 : 20);
        } else {
          done = true; controller.enqueue(bytes.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); controller.close(); record({ type: 'finish', question: key });
        }
      };
      const abort = () => { if (done) return; done = true; clearTimeout(timer); controller.close(); record({ type: 'abort', question: key }); };
      options.signal.addEventListener('abort', abort, { once: true });
      push();
    },
    cancel() { clearTimeout(timer); },
  });
  return { ok: true, body: stream };
};
const authService = createAuthService({ filename: ':memory:', providers: { status: { sms: false, email: false }, sendResetEmail: async () => {} } });
const server = createServer({ authService, assistant: createAssistant({ config: { key: 'qa-only', endpoint: 'https://example.test', model: 'deepseek-flash' }, fetchImpl: provider, limiter: createRequestLimiter() }),
  titleArticle: async () => ({ title: '练习范文', model: 'qa' }), aiRateLimiter: { check() {} } });
server.listen(4174, '127.0.0.1', () => console.log('Assistant browser QA fixture: http://127.0.0.1:4174'));
