(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const form = $("feedbackForm");
  const nickname = $("feedbackNickname");
  const message = $("feedbackMessage");
  const consent = $("feedbackConsent");
  const submit = $("feedbackSubmit");
  const quota = $("feedbackQuota");
  const formStatus = $("feedbackFormStatus");
  const list = $("feedbackMessages");
  const listStatus = $("feedbackListStatus");
  const refresh = $("feedbackRefresh");
  const more = $("feedbackMore");
  const localFile = location.protocol === "file:";
  const dateFormat = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const dayFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const state = {
    csrfToken: "", fingerprint: "", canSubmit: null, day: "", resetAt: "",
    busy: false, checking: false, listLoading: false, nextCursor: null,
    consentVersion: 0, quotaVersion: 0, listVersion: 0, messagesRevision: 0,
  };
  let resetTimer;
  let initialLoad = Promise.resolve();
  const renderedIds = new Set();
  const count = (text) => Array.from(text.trim()).length;

  function setStatus(node, text, error = false) {
    node.textContent = text;
    node.classList.toggle("has-error", error);
  }

  function validFields() {
    return count(nickname.value) <= 20 && count(message.value) >= 5 && count(message.value) <= 1000;
  }

  function updateUi() {
    const locked = state.canSubmit === false;
    submit.disabled = localFile || state.busy || state.checking || locked || !consent.checked ||
      !state.csrfToken || !state.fingerprint || !validFields();
    submit.textContent = state.busy ? "正在提交…" : locked ? "今天已提交" : "提交留言";
    nickname.disabled = state.busy || locked;
    message.disabled = state.busy || locked;
    consent.disabled = state.busy || localFile;
    refresh.disabled = state.listLoading || state.busy || localFile;
    more.disabled = state.listLoading;
    more.hidden = !state.nextCursor;
    if (locked) quota.textContent = "今天已提交，明天 00:00 后可再次留言（北京时间）。";
    else if (state.checking) quota.textContent = "正在确认今日额度…";
    else if (consent.checked && state.canSubmit === true) quota.textContent = "今日还可提交 1 次。";
    else quota.textContent = "";
  }

  function updateValidation(showErrors = false) {
    const nicknameLength = count(nickname.value);
    const messageLength = count(message.value);
    const nicknameError = nicknameLength > 20 ? "昵称最多 20 字。" : "";
    const messageError = messageLength > 1000 ? "留言最多 1000 字。" :
      showErrors && messageLength < 5 ? "请填写至少 5 字的留言。" : "";
    $("messageCount").textContent = `${messageLength} / 1000`;
    $("messageCount").classList.toggle("has-error", messageLength > 1000);
    $("nicknameError").textContent = nicknameError;
    $("messageError").textContent = messageError;
    nickname.setAttribute("aria-invalid", String(Boolean(nicknameError)));
    message.setAttribute("aria-invalid", String(Boolean(messageError)));
    updateUi();
  }

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { ...options, credentials: "same-origin", signal: controller.signal });
      let body;
      try { body = await response.json(); }
      catch { throw new Error("留言服务暂时不可用，请稍后重试。"); }
      if (!response.ok) {
        const error = new Error(typeof body.error === "string" ? body.error : "请求失败，请稍后重试。");
        error.status = response.status;
        error.code = body.code;
        error.resetAt = body.resetAt;
        error.retryAfter = body.retryAfter;
        throw error;
      }
      return body;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超时，请稍后重试。");
      if (error instanceof TypeError) throw new Error("无法连接留言服务，请检查网络后重试。");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function applyQuota(data) {
    if (typeof data.csrfToken === "string") state.csrfToken = data.csrfToken;
    if (typeof data.canSubmit === "boolean") state.canSubmit = data.canSubmit;
    if (typeof data.day === "string") state.day = data.day;
    if (typeof data.resetAt === "string" || typeof data.resetAt === "number") state.resetAt = data.resetAt;
    scheduleDayReset();
  }

  function scheduleDayReset() {
    clearTimeout(resetTimer);
    const timestamp = typeof state.resetAt === "number" ? state.resetAt : Date.parse(state.resetAt);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return;
    resetTimer = setTimeout(async () => {
      state.canSubmit = null;
      state.csrfToken = "";
      updateUi();
      if (state.busy || state.checking || !consent.checked) return;
      try { await checkQuota(); }
      catch (error) { setStatus(formStatus, error.message, true); }
    }, Math.min(timestamp - Date.now() + 250, 2147483647));
  }

  async function browserFingerprint() {
    if (!globalThis.crypto?.subtle) {
      throw new Error("当前网址无法生成浏览器特征摘要，请使用 HTTPS 正式网址或本机 localhost 地址。");
    }
    let timezone = "";
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch {}
    const features = {
      version: 1,
      userAgent: navigator.userAgent || "",
      languages: Array.from(navigator.languages || []),
      platform: navigator.platform || "",
      timezone,
      screen: [screen.availWidth, screen.availHeight, screen.colorDepth],
      hardwareConcurrency: navigator.hardwareConcurrency || 0,
    };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(features)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function checkQuota() {
    const version = ++state.quotaVersion;
    const consentVersion = state.consentVersion;
    state.checking = true;
    updateUi();
    try {
      // Finish the first cookie-setting request before requesting a personal quota.
      await initialLoad.catch(() => {});
      if (!consent.checked || consentVersion !== state.consentVersion) return false;
      const fingerprint = state.fingerprint || await browserFingerprint();
      if (!consent.checked || consentVersion !== state.consentVersion) return false;
      const data = await request("/api/feedback", { headers: { "X-Browser-Fingerprint": fingerprint } });
      if (!consent.checked || consentVersion !== state.consentVersion || version !== state.quotaVersion) return false;
      state.fingerprint = fingerprint;
      applyQuota(data);
      return true;
    } finally {
      if (version === state.quotaVersion) {
        state.checking = false;
        updateUi();
      }
    }
  }

  function appendMessages(messages, prepend = false) {
    if (!Array.isArray(messages)) return;
    for (const item of messages) {
      if (!item || typeof item.id !== "string" || typeof item.message !== "string" || renderedIds.has(item.id)) continue;
      renderedIds.add(item.id);
      const li = document.createElement("li");
      li.className = "feedback-message";
      const article = document.createElement("article");
      const header = document.createElement("header");
      header.className = "feedback-message-header";
      const name = document.createElement("h3");
      name.className = "feedback-message-name";
      name.textContent = item.nickname || "匿名访客";
      const time = document.createElement("time");
      time.className = "feedback-message-time";
      const date = new Date(item.createdAt);
      if (Number.isFinite(date.getTime())) {
        time.dateTime = date.toISOString();
        time.textContent = `${dateFormat.format(date)}（北京时间）`;
      }
      const text = document.createElement("p");
      text.className = "feedback-message-text";
      text.textContent = item.message;
      header.append(name, time);
      article.append(header, text);
      li.append(article);
      if (prepend) list.prepend(li);
      else list.append(li);
    }
    if (renderedIds.size) setStatus(listStatus, "");
  }

  async function loadMessages(append = false) {
    if (localFile || state.listLoading) return;
    const version = ++state.listVersion;
    const messagesRevision = state.messagesRevision;
    state.listLoading = true;
    updateUi();
    setStatus(listStatus, append ? "正在加载更多…" : "正在加载留言…");
    try {
      const query = append && state.nextCursor ? `?cursor=${encodeURIComponent(state.nextCursor)}` : "";
      const data = await request(`/api/feedback${query}`);
      if (version !== state.listVersion) return;
      if (messagesRevision !== state.messagesRevision) return;
      // Public list requests never override a quota result obtained with consent.
      if (!state.csrfToken && typeof data.csrfToken === "string") state.csrfToken = data.csrfToken;
      if (!append && !state.fingerprint && !state.checking) applyQuota(data);
      if (!append) { list.replaceChildren(); renderedIds.clear(); }
      appendMessages(data.messages);
      state.nextCursor = typeof data.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
      setStatus(listStatus, renderedIds.size ? "" : "还没有留言，欢迎反馈使用体验。");
    } catch (error) { setStatus(listStatus, error.message, true); }
    finally {
      if (version === state.listVersion) { state.listLoading = false; updateUi(); }
    }
  }

  consent.addEventListener("change", async () => {
    if (localFile) return;
    state.consentVersion += 1;
    const version = state.consentVersion;
    state.fingerprint = "";
    setStatus(formStatus, "");
    if (!consent.checked) {
      state.quotaVersion += 1;
      state.checking = false;
      updateUi();
      return;
    }
    try { await checkQuota(); }
    catch (error) {
      if (consent.checked && version === state.consentVersion) setStatus(formStatus, error.message, true);
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (localFile || state.busy || state.checking) return;
    updateValidation(true);
    if (!validFields()) {
      (count(nickname.value) > 20 ? nickname : message).focus();
      return;
    }
    if (!consent.checked) {
      setStatus(formStatus, "请先同意使用浏览器特征摘要限制重复留言。", true);
      consent.focus();
      return;
    }
    state.busy = true;
    setStatus(formStatus, "");
    updateUi();
    try {
      // Refresh both the day and the request token before committing a message.
      if (!await checkQuota()) return;
      if (state.canSubmit === false) return;
      const data = await request("/api/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csrfToken: state.csrfToken, fingerprint: state.fingerprint,
          nickname: nickname.value.trim(), message: message.value.trim(), website: $("feedbackWebsite").value,
        }),
      });
      state.canSubmit = false;
      if (data.day) state.day = data.day;
      if (data.resetAt) state.resetAt = data.resetAt;
      scheduleDayReset();
      state.messagesRevision += 1;
      appendMessages([data.message], true);
      setStatus(formStatus, "留言已公开，感谢你的反馈。");
    } catch (error) {
      if (error.status === 429 && error.code === "DAILY_LIMIT") {
        state.canSubmit = false;
        if (error.resetAt) state.resetAt = error.resetAt;
        scheduleDayReset();
      }
      setStatus(formStatus, error.message, true);
    } finally { state.busy = false; updateUi(); }
  });

  nickname.addEventListener("input", () => updateValidation());
  message.addEventListener("input", () => updateValidation());
  refresh.addEventListener("click", () => loadMessages());
  more.addEventListener("click", () => loadMessages(true));
  window.addEventListener("focus", async () => {
    if (localFile || state.busy || state.checking || !consent.checked) return;
    const parts = Object.fromEntries(dayFormat.formatToParts(new Date()).map((part) => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    if (state.day && state.day === today) return;
    try { await checkQuota(); }
    catch (error) { setStatus(formStatus, error.message, true); }
  });

  updateValidation();
  if (localFile) {
    const notice = "留言板需要本地服务。请运行“启动翻译.cmd”，再通过 http://127.0.0.1:4173/feedback.html 打开。";
    setStatus(formStatus, notice, true);
    setStatus(listStatus, "通过本地服务或正式网站打开后，可查看公开留言。", true);
  } else initialLoad = loadMessages();
})();
