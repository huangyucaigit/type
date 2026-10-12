"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "..", "feedback.js"), "utf8");
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
};
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const tomorrow = new Date(Date.now() + 86400000).toISOString();
const quota = (overrides = {}) => ({ csrfToken: "token-1", canSubmit: true, day: "2026-10-11", resetAt: tomorrow, messages: [], nextCursor: null, ...overrides });

function createPage({ protocol = "http:", fetcher } = {}) {
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    async emit(type) {
      await Promise.all((this.listeners.get(type) || []).map((handler) => handler({ preventDefault() {} })));
    }
  }
  class Element extends Target {
    constructor() {
      super();
      this.children = [];
      this.attributes = new Map();
      this.classes = new Set();
      this.classList = { toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
      this.value = "";
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this._text = "";
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text; }
    append(...children) { this.children.push(...children); }
    prepend(...children) { this.children.unshift(...children); }
    replaceChildren(...children) { this.children = children; this._text = ""; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    focus() { this.focused = true; }
  }
  const ids = ["feedbackForm", "feedbackNickname", "feedbackMessage", "feedbackConsent", "feedbackSubmit", "feedbackQuota", "feedbackFormStatus", "feedbackMessages", "feedbackListStatus", "feedbackRefresh", "feedbackMore", "messageCount", "nicknameError", "messageError", "feedbackWebsite"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const document = { getElementById: (id) => elements[id], createElement: () => new Element() };
  const window = new Target();
  const requests = [];
  const timerCallbacks = new Map();
  let timerId = 0;
  let fingerprintReads = 0;
  let digestCalls = 0;
  const navigator = {};
  for (const [key, value] of Object.entries({ userAgent: "Example Browser 1", languages: ["zh-CN", "en"], platform: "Example Platform", hardwareConcurrency: 8 })) {
    Object.defineProperty(navigator, key, { get() { fingerprintReads += 1; return value; } });
  }
  const crypto = { subtle: { digest: async (...args) => { digestCalls += 1; return webcrypto.subtle.digest(...args); } } };
  const context = vm.createContext({
    window, document, location: { protocol }, navigator, crypto, screen: { availWidth: 1400, availHeight: 900, colorDepth: 24 },
    TextEncoder, Uint8Array, Intl, Date, AbortController,
    setTimeout: (callback) => { const id = ++timerId; timerCallbacks.set(id, callback); return id; },
    clearTimeout: (id) => timerCallbacks.delete(id),
    fetch: async (url, options) => {
      const request = { url, ...options };
      requests.push(request);
      return fetcher ? fetcher(request, requests.length) : reply(quota({ canSubmit: options.headers ? true : null }));
    },
  });
  vm.runInContext(source, context);
  return {
    elements, window, requests, timerCallbacks,
    fingerprintReads: () => fingerprintReads,
    digestCalls: () => digestCalls,
    async consent() { elements.feedbackConsent.checked = true; await elements.feedbackConsent.emit("change"); },
    async draft(text = "希望增加快捷键操作。", name = "") {
      elements.feedbackNickname.value = name;
      elements.feedbackMessage.value = text;
      await elements.feedbackNickname.emit("input");
      await elements.feedbackMessage.emit("input");
    },
    async submit() { await elements.feedbackForm.emit("submit"); },
  };
}

test("public browsing never reads fingerprint features before consent and renders text safely", async () => {
  const page = createPage({ fetcher: () => reply(quota({ canSubmit: null, messages: [{ id: "a", nickname: "<b>访客</b>", message: "<script>alert(1)</script>", createdAt: "2026-10-11T01:00:00.000Z" }] })) });
  await settle();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].headers, undefined);
  assert.equal(page.fingerprintReads(), 0);
  assert.equal(page.digestCalls(), 0);
  assert.match(page.elements.feedbackMessages.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(page.elements.feedbackMessages.textContent, /09:00（北京时间）/);
  assert.equal(page.elements.feedbackSubmit.disabled, true);
});

test("consent computes only a digest and reuses it when checking before submit", async () => {
  const page = createPage({ fetcher: (request) => request.method === "POST" ? reply({ message: { id: "new", nickname: "", message: "希望增加快捷键操作。", createdAt: new Date().toISOString() }, day: "2026-10-11", resetAt: tomorrow }, 201) : reply(quota({ canSubmit: request.headers ? true : null })) });
  await settle();
  await page.consent();
  await page.draft();
  assert.equal(page.elements.feedbackSubmit.disabled, false);
  const fingerprint = page.requests[1].headers["X-Browser-Fingerprint"];
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(page.requests), /Example Browser|Example Platform/);
  await page.submit();
  assert.equal(page.digestCalls(), 1);
  assert.equal(page.requests.at(-1).method, "POST");
  assert.equal(JSON.parse(page.requests.at(-1).body).fingerprint, fingerprint);
  assert.equal(page.elements.feedbackMessages.children.length, 1);
  assert.match(page.elements.feedbackFormStatus.textContent, /留言已公开/);
  assert.equal(page.elements.feedbackSubmit.disabled, true);
  assert.equal(page.elements.feedbackMessage.disabled, true);
});

test("initial cookie-setting list request completes before consent quota request", async () => {
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const page = createPage({ fetcher: (_, number) => number === 1 ? first : reply(quota()) });
  const consenting = page.consent();
  await settle();
  assert.equal(page.requests.length, 1);
  assert.equal(page.digestCalls(), 0);
  release(reply(quota({ canSubmit: null, csrfToken: "first-cookie-token" })));
  await consenting;
  assert.equal(page.requests.length, 2);
  assert.match(page.requests[1].headers["X-Browser-Fingerprint"], /^[a-f0-9]{64}$/);
});

test("a failed initial list request still allows a consented quota retry", async () => {
  const page = createPage({ fetcher: (_, number) => number === 1 ? Promise.reject(new TypeError("offline")) : reply(quota()) });
  await settle();
  await page.consent();
  await page.draft();
  assert.equal(page.requests.length, 2);
  assert.equal(page.elements.feedbackSubmit.disabled, false);
});

test("short-term rate limit preserves the draft and keeps today available", async () => {
  const page = createPage({ fetcher: (request) => request.method === "POST" ? reply({ error: "操作过于频繁，请稍后重试。", code: "RATE_LIMIT", retryAfter: 30 }, 429) : reply(quota({ canSubmit: request.headers ? true : null })) });
  await settle();
  await page.consent();
  await page.draft();
  await page.submit();
  assert.equal(page.elements.feedbackMessage.value, "希望增加快捷键操作。");
  assert.equal(page.elements.feedbackMessage.disabled, false);
  assert.equal(page.elements.feedbackSubmit.disabled, false);
  assert.match(page.elements.feedbackFormStatus.textContent, /过于频繁/);
});

test("daily limit locks only today's submission and preserves the draft", async () => {
  const page = createPage({ fetcher: (request) => request.method === "POST" ? reply({ error: "今天已经留言。", code: "DAILY_LIMIT", resetAt: tomorrow }, 429) : reply(quota({ canSubmit: request.headers ? true : null })) });
  await settle();
  await page.consent();
  await page.draft();
  await page.submit();
  assert.equal(page.elements.feedbackMessage.value, "希望增加快捷键操作。");
  assert.equal(page.elements.feedbackMessage.disabled, true);
  assert.equal(page.elements.feedbackSubmit.textContent, "今天已提交");
  assert.match(page.elements.feedbackQuota.textContent, /北京时间/);
});

test("a failed submission preserves text and allows retry", async () => {
  const page = createPage({ fetcher: (request) => request.method === "POST" ? reply({ error: "暂时无法保存留言。" }, 503) : reply(quota({ canSubmit: request.headers ? true : null })) });
  await settle();
  await page.consent();
  await page.draft("输入的反馈需要保留。", "访客");
  await page.submit();
  assert.equal(page.elements.feedbackMessage.value, "输入的反馈需要保留。");
  assert.equal(page.elements.feedbackNickname.value, "访客");
  assert.equal(page.elements.feedbackSubmit.disabled, false);
  assert.match(page.elements.feedbackFormStatus.textContent, /无法保存/);
});

test("Unicode characters are counted consistently for message and nickname limits", async () => {
  const page = createPage();
  await settle();
  await page.consent();
  await page.draft("😀".repeat(1000), "😀".repeat(20));
  assert.equal(page.elements.messageCount.textContent, "1000 / 1000");
  assert.equal(page.elements.feedbackSubmit.disabled, false);
  await page.draft("😀".repeat(1001), "😀".repeat(21));
  assert.equal(page.elements.feedbackSubmit.disabled, true);
  assert.match(page.elements.messageError.textContent, /1000/);
  assert.match(page.elements.nicknameError.textContent, /20/);
});

test("local file mode makes no network or fingerprint requests", async () => {
  const page = createPage({ protocol: "file:" });
  await settle();
  await page.consent();
  await page.draft();
  await page.submit();
  assert.equal(page.requests.length, 0);
  assert.equal(page.fingerprintReads(), 0);
  assert.match(page.elements.feedbackFormStatus.textContent, /启动翻译\.cmd/);
});

test("pagination cannot overwrite an authenticated daily quota", async () => {
  const page = createPage({ fetcher: (request) => reply(quota({
    canSubmit: request.url.includes("cursor=") ? true : request.headers ? false : null,
    nextCursor: request.url.includes("cursor=") ? null : "next-page",
    messages: [{ id: request.url.includes("cursor=") ? "older" : "newer", message: "公开留言内容", nickname: "", createdAt: new Date().toISOString() }],
  })) });
  await settle();
  await page.consent();
  assert.equal(page.elements.feedbackSubmit.textContent, "今天已提交");
  await page.elements.feedbackMore.emit("click");
  assert.equal(page.elements.feedbackSubmit.textContent, "今天已提交");
  assert.equal(page.elements.feedbackMessages.children.length, 2);
});
