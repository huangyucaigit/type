(() => {
  "use strict";

  const { normalizeSource, normalizeInput, compare, formatDuration, PracticeClock } = window.TypingCore;
  const $ = (id) => document.getElementById(id);
  const input = $("typingInput");
  const requiresAuth = document.documentElement?.dataset?.authRequired === "true";
  const hasAccess = () => window.ZijianAuth ? window.ZijianAuth.hasAccess() : !requiresAuth;
  const canPractice = () => window.ZijianAuth ? window.ZijianAuth.canPractice() : !requiresAuth;
  const requireAccess = () => window.ZijianAuth ? window.ZijianAuth.requireAccess() : !requiresAuth;
  const withAccess = action => window.ZijianAuth ? window.ZijianAuth.runWithAccess(action) : !requiresAuth ? action() : undefined;
  const display = $("textDisplay");
  const dialog = $("importDialog");
  const editor = $("sourceEditor");
  const clock = new PracticeClock();
  let togglingTimer = false;
  const sample = "Learning a language is a journey that rewards patience and regular practice. Although progress may seem slow at first, small efforts made every day can lead to lasting improvements. Writing, in particular, helps learners organise their thoughts and express ideas with greater confidence.\n\nRather than aiming for perfection, students should focus on building a consistent routine. Reading a well-written article, noticing how its sentences connect, and typing it carefully can all be valuable steps. Over time, familiar words and useful expressions become easier to recall. The most important thing is to keep going, one sentence at a time.";

  const history = window.ArticleHistory.create({ getStorage: () => window.localStorage, normalizeText: normalizeSource });
  const initialHistory = history.read();
  const savedArticle = initialHistory.articles.find(item => item.id === initialHistory.currentId);
  const historyDialog = $("historyDialog");
  const titleRequests = new Map();
  const titleErrors = new Map();
  let editingArticleId = null;
  let currentArticleId = savedArticle?.id || null;
  let progressPersistable = true;
  let progressReady = false;
  let restoringProgress = false;
  let progressTimer = 0;
  let progressDirty = false;
  let viewportRevision = 0;
  let restoringViewport = false;
  let articleProgress = {};

  function progressNotice(message = "", warning = false) {
    const notice = $("practiceProgressNotice");
    notice.hidden = !message;
    notice.textContent = message;
    notice.classList.toggle("is-warning", warning);
  }

  const pageScroll = () => Math.max(0, Number(window.scrollY) || 0);

  function rememberMode() {
    if (activeMode === "realtime") {
      articleProgress.realtime = {
        value: input.value,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        selectionDirection: input.selectionDirection,
        scrollY: restoringViewport ? articleProgress.realtime?.scrollY || 0 : pageScroll(),
      };
    } else {
      const snapshot = sentencePractice?.getProgress();
      if (snapshot) articleProgress.sentence = { ...snapshot,
        scrollY: restoringViewport ? articleProgress.sentence?.scrollY || 0 : pageScroll() };
    }
  }

  function flushProgress() {
    clearTimeout(progressTimer);
    progressTimer = 0;
    if (!progressReady || restoringProgress || !progressDirty || !progressPersistable) return true;
    if (composing || sentencePractice?.isComposing?.()) return false;
    rememberMode();
    try {
      const saved = history.saveProgress(currentArticleId, {
        ...articleProgress, version: 1, mode: activeMode,
        scrollY: articleProgress[activeMode]?.scrollY || 0,
      });
      progressDirty = false;
      // A deleted article may remain visible in this tab; never recreate its record.
      if (!saved) progressPersistable = false;
      if ($("practiceProgressNotice").classList.contains("is-warning")) progressNotice();
      return true;
    } catch {
      progressNotice("练习进度暂未保存；本页输入仍保留。请检查浏览器存储空间或隐私设置。", true);
      return false;
    }
  }

  function scheduleProgress() {
    if (!progressReady || restoringProgress || composing || sentencePractice?.isComposing?.() || !progressPersistable) return;
    progressDirty = true;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(flushProgress, 350);
  }

  function restoreViewport() {
    const revision = ++viewportRevision;
    const scrollY = articleProgress[activeMode]?.scrollY || 0;
    restoringViewport = true;
    requestAnimationFrame(() => {
      if (revision !== viewportRevision) return;
      window.scrollTo({ top: scrollY, left: 0, behavior: "instant" });
      requestAnimationFrame(() => { if (revision === viewportRevision) restoringViewport = false; });
    });
  }

  function restoreArticleProgress(snapshot) {
    restoringProgress = true;
    progressDirty = false;
    clearTimeout(progressTimer);
    articleProgress = snapshot ? { ...snapshot } : {};
    const full = snapshot?.realtime;
    try {
      resetPractice(false);
      sentencePractice?.setSource(source, articleTitle, articleKind);
      if (full) {
        input.value = normalizeInput(full.value);
        input.setSelectionRange(full.selectionStart, full.selectionEnd, full.selectionDirection);
        result = compare(source, input.value);
        input.readOnly = !canPractice() || result.completed;
        drawCharacters();
        updateFeedback();
        scheduleCaret();
      }
      if (snapshot?.sentence && !sentencePractice?.restoreProgress(snapshot.sentence)) delete articleProgress.sentence;
      selectMode(snapshot?.mode || activeMode);
      // Both modes have their own drafts, even when only one has been used.
      articleProgress.realtime ||= { value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none", scrollY: 0 };
      articleProgress.sentence ||= { ...sentencePractice?.getProgress(), scrollY: 0 };
    } finally {
      restoringProgress = false;
      progressReady = true;
    }
    const hasDraft = full?.value || snapshot?.sentence?.groups?.some(group => group.draft || group.checked);
    progressNotice(hasDraft ? "已恢复上次练习" : "");
    // Startup restores the reading position without opening a mobile keyboard.
    if (snapshot) restoreViewport();
  }

  function storageNotice(message = "") {
    const notice = $("articleStorageNotice");
    notice.hidden = !message;
    notice.textContent = message;
  }

  function saveArticle(text, title) {
    try {
      const article = history.importArticle(text, title);
      storageNotice();
      return article;
    } catch {
      storageNotice("浏览器未能保存这篇文章；本次仍可练习，刷新后可能恢复旧文章。请检查存储空间或浏览器隐私设置。");
      return null;
    }
  }

  let source = savedArticle ? normalizeSource(savedArticle.text) : normalizeSource(sample);
  let articleTitle = savedArticle?.title || "The value of everyday practice";
  let articleKind = savedArticle ? "我的范文" : "示例范文";
  let result = compare(source, "");
  let nodes = [];
  let rendered = [];
  let fileTitle = "";
  let loadingFile = false;
  let importRevision = 0;
  let caretFrame = 0;
  let composing = false;
  let lastTimer = "";
  let activeMode = "realtime";
  let selectionTranslation = null;
  const sentencePractice = window.SentencePractice?.create({ source, title: articleTitle, kind: articleKind,
    onProgressChange: scheduleProgress,
    onLearningReset: () => selectionTranslation?.reset() });
  const caret = document.createElement("span");
  caret.className = "caret-anchor";
  const inputBoundary = document.createElement("wbr");
  selectionTranslation = window.SelectionTranslation?.create({
    input,
    display,
    area: $("typingArea"),
    popup: $("selectionTranslationPopup"),
    sourceLabel: $("selectionTranslationSource"),
    translationLabel: $("selectionTranslationText"),
    typeLabel: $("selectionAnalysisType"),
    briefContainer: $("selectionAnalysisBrief"),
    detailsContainer: $("selectionAnalysisDetails"),
    expandButton: $("selectionAnalysisExpand"),
    statusLabel: $("selectionTranslationStatus"),
    retryButton: $("selectionTranslationRetry"),
    closeButton: $("selectionTranslationClose"),
    learnAction: $("selectionLearnAction"),
    learnButton: $("selectionLearnButton"),
    sentenceButton: $("selectionSentenceButton"),
    getReferenceText: () => source,
    getAdditionalSources: () => activeMode === "sentence" ? sentencePractice?.getLearningSources() || [] : [],
    isPrimaryActive: () => activeMode === "realtime",
    isActive: () => canPractice() && !dialog.open && !historyDialog.open && !window.ZijianAuth?.isDialogOpen(),
  });
  const referenceSelection = window.ReferenceSelection?.create({
    input,
    display,
    area: $("typingArea"),
    isActive: () => activeMode === "realtime" && !dialog.open && !historyDialog.open && !window.ZijianAuth?.isDialogOpen(),
    onResumeInput: () => selectionTranslation?.prepareForInput(),
  });

  function words(text) {
    return text.trim() ? text.trim().split(/\s+/u).length : 0;
  }

  function updateArticleTitle(article) {
    if (!article || article.id !== currentArticleId) return;
    articleTitle = article.title;
    $("articleTitle").textContent = articleTitle;
    $("articleTitle").title = articleTitle;
    sentencePractice?.setTitle?.(articleTitle);
  }

  function button(label, handler, className = "button button-secondary") {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.addEventListener("click", handler);
    return element;
  }

  function renderHistory() {
    const state = history.read();
    $("historyCount").textContent = `${state.articles.length} / 10 篇`;
    $("historyEmpty").hidden = state.articles.length > 0;
    $("historyList").replaceChildren();
    for (const article of [...state.articles].reverse()) {
      const card = document.createElement("li");
      card.className = "history-card";
      const load = button(article.title, () => withAccess(() => {
        if (!flushProgress()) { error.textContent = "当前练习进度暂未保存，请检查浏览器存储设置后重试；当前输入仍保留。"; return; }
        let selected = article;
        try { selected = history.select(article.id); storageNotice(); }
        catch {
          // The flush above may have saved newer input than the open history card.
          selected = history.read().articles.find(item => item.id === article.id);
          storageNotice("浏览器未能保存这次切换；本次仍可练习，刷新后可能恢复旧文章。");
        }
        if (!selected) { renderHistory(); return; }
        currentArticleId = article.id;
        progressPersistable = true;
        source = normalizeSource(selected.text);
        articleTitle = selected.title;
        articleKind = "我的范文";
        historyDialog.close();
        restoreArticleProgress(selected.progress);
        if (!selected.progress) restoreViewport();
        scheduleProgress();
      }), "history-load");
      load.setAttribute("aria-label", `载入范文：${article.title}`);
      const excerpt = document.createElement("p");
      excerpt.className = "history-excerpt";
      excerpt.textContent = article.text.replace(/\s+/gu, " ").slice(0, 140);
      const meta = document.createElement("p");
      meta.className = "history-meta";
      meta.textContent = `${words(article.text)} 词 · ${article.importedAt
        ? new Date(article.importedAt).toLocaleString("zh-CN", { hour12: false }) + " 导入" : "此前保存的范文"}${article.id === currentArticleId ? " · 当前练习" : ""}`;
      const actions = document.createElement("div");
      actions.className = "history-actions";
      const editForm = document.createElement("form");
      editForm.className = "history-edit";
      editForm.hidden = true;
      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.maxLength = 80;
      titleInput.value = article.title;
      titleInput.setAttribute("aria-label", "范文标题");
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "button button-primary";
      save.textContent = "保存标题";
      const error = document.createElement("p");
      error.className = "history-error";
      error.setAttribute("role", "status");
      error.textContent = titleErrors.get(article.id) || "";
      editForm.append(titleInput, save, button("取消", () => { editingArticleId = null; renderHistory(); $("closeHistory").focus(); }));
      editForm.addEventListener("submit", event => {
        event.preventDefault();
        if (!titleInput.value.trim()) { error.textContent = "请填写标题。"; titleInput.focus(); return; }
        try {
          updateArticleTitle(history.rename(article.id, titleInput.value));
          titleErrors.delete(article.id);
          editingArticleId = null;
          storageNotice();
          renderHistory();
          $("closeHistory").focus();
        } catch { error.textContent = "标题未能保存，请检查标题长度、存储空间或浏览器隐私设置。"; }
      });
      const rename = button("改名", () => { editingArticleId = article.id; editForm.hidden = false; titleInput.focus(); });
      rename.setAttribute("aria-label", `修改标题：${article.title}`);
      const remove = button("删除", () => {
        try {
          history.remove(article.id);
          if (article.id === currentArticleId) { progressPersistable = false; progressDirty = false; progressNotice(); }
          titleErrors.delete(article.id);
          storageNotice();
          renderHistory();
          $("closeHistory").focus();
        } catch { error.textContent = "未能删除，请检查浏览器存储设置后重试。"; }
      });
      remove.classList.toggle("history-delete", true);
      remove.setAttribute("aria-label", `删除范文：${article.title}`);
      actions.append(rename, remove);
      if (article.titleSource === "fallback") {
        const pending = titleRequests.has(article.id);
        const retry = button(pending ? "AI 起名中…" : "重试 AI 起名", () => void generateTitle(article));
        retry.disabled = pending;
        actions.append(retry);
      }
      card.append(load, excerpt, meta, actions, editForm, error);
      $("historyList").append(card);
    }
  }

  async function generateTitle(article) {
    if (!article || article.titleSource !== "fallback" || titleRequests.has(article.id)) return;
    if (window.ZijianAuth && !hasAccess() && !await window.ZijianAuth.ensureAccess()) return;
    if (!window.ZijianAuth && !requireAccess()) return;
    if (window.location?.protocol === "file:") {
      titleErrors.set(article.id, "本地文件模式无法 AI 起名，可直接改名或通过网站访问。");
      if (historyDialog.open && !editingArticleId) renderHistory();
      return;
    }
    const token = {};
    titleRequests.set(article.id, token);
    titleErrors.delete(article.id);
    if (historyDialog.open && !editingArticleId) renderHistory();
    try {
      const response = await fetch("/api/article-title", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: article.text.slice(0, 12000) }),
        signal: AbortSignal.timeout(35000) });
      if (!response.ok) throw new Error("AI title unavailable");
      const result = await response.json();
      if (typeof result.title !== "string" || !result.title.trim()) throw new Error("Invalid title");
      updateArticleTitle(history.rename(article.id, result.title, { generated: true, expectedTitle: article.title }));
    } catch {
      titleErrors.set(article.id, "AI 标题暂未生成，可重试或手动改名。");
    } finally {
      if (titleRequests.get(article.id) === token) titleRequests.delete(article.id);
      if (historyDialog.open && !editingArticleId) renderHistory();
    }
  }

  $("historyButton").addEventListener("click", () => {
    selectionTranslation?.close();
    referenceSelection?.clear();
    editingArticleId = null;
    renderHistory();
    historyDialog.showModal();
  });
  $("closeHistory").addEventListener("click", () => historyDialog.close());
  historyDialog.addEventListener("click", event => {
    if (event.target !== historyDialog) return;
    const rect = historyDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) historyDialog.close();
  });

  function describe(character) {
    if (character === null) return "文章结尾";
    if (character === " ") return "空格";
    if (character === "\n") return "回车换行";
    if (character === "\t") return "制表符";
    return `“${character}”`;
  }

  function createCharacter() {
    const span = document.createElement("span");
    nodes.push(span);
    display.append(span);
    return span;
  }

  function drawCharacters() {
    while (nodes.length > result.characters.length) nodes.pop().remove();
    rendered.length = result.characters.length;
    result.characters.forEach((character, index) => {
      const value = character.actual ?? character.expected;
      const cacheKey = `${character.state}\u0000${value}\u0000${character.expected}`;
      if (rendered[index] === cacheKey) return;
      const node = nodes[index] || createCharacter();
      let kind = "";
      if (value === " ") kind = " space";
      if (value === "\n") kind = " newline";
      if (value === "\t") kind = " tab";
      node.className = `character ${character.state}${kind}`;
      node.textContent = value;
      node.title = character.state === "incorrect" || character.state === "extra"
        ? `应输入：${describe(character.expected)}；实际输入：${describe(character.actual)}`
        : "";
      rendered[index] = cacheKey;
    });
    // The untyped suffix must not push a partially typed word onto a new line.
    // This keeps the rendered input prefix aligned with the native textarea.
    display.insertBefore(inputBoundary, nodes[result.typed] || null);
    updateCaret(false);
  }

  function caretIndex() {
    const offset = input.selectionDirection === "backward" ? input.selectionStart : input.selectionEnd;
    return Array.from(input.value.slice(0, offset)).length;
  }

  function updateCaret(shouldScroll = true) {
    const index = Math.min(caretIndex(), nodes.length);
    const next = index === result.typed ? inputBoundary : nodes[index] || null;
    if (caret.nextSibling !== next || caret.parentElement !== display) display.insertBefore(caret, next);
    $("typingArea").classList.toggle("is-selecting", input.selectionStart !== input.selectionEnd);
    if (!shouldScroll || document.activeElement !== input || dialog.open) return;
    const rect = caret.getBoundingClientRect();
    const margin = 90;
    const visibleHeight = window.visualViewport?.height || window.innerHeight;
    const timerRect = $("floatingTimer")?.getBoundingClientRect();
    const overlapsTimer = timerRect?.width > 0 && rect.right >= timerRect.left && rect.left <= timerRect.right;
    const lowerEdge = overlapsTimer ? Math.min(visibleHeight - margin, timerRect.top - 16) : visibleHeight - margin;
    if (rect.top < margin || rect.bottom > lowerEdge) {
      window.scrollBy({ top: rect.top - visibleHeight * .45, behavior: "instant" });
    }
    // The overlay owns the page height; native textarea scrolling must not offset its selection.
    input.scrollTop = 0;
    input.scrollLeft = 0;
  }

  function scheduleCaret() {
    cancelAnimationFrame(caretFrame);
    caretFrame = requestAnimationFrame(() => updateCaret());
  }

  function keepSentenceInputVisible(event) {
    if (activeMode !== "sentence" || !event.target.matches?.(".sentence-answer")) return;
    const timerRect = $("floatingTimer")?.getBoundingClientRect();
    if (!timerRect || timerRect.width <= 0) return;
    const rect = event.target.getBoundingClientRect();
    const overlaps = rect.right > timerRect.left && rect.left < timerRect.right;
    if (overlaps && timerRect.top > rect.height + 32 && rect.bottom > timerRect.top - 16) {
      window.scrollBy({ top: rect.bottom - timerRect.top + 16, behavior: "instant" });
    }
  }

  function updateFeedback() {
    const hasError = result.errorCount > 0;
    const complete = result.completed && !composing;
    $("errorHint").classList.toggle("has-error", hasError);
    $("errorCount").hidden = !hasError;
    $("errorCount").textContent = `${result.errorCount} 处待修正`;
    if (hasError) {
      const error = result.characters[result.firstError];
      $("errorHint").textContent = `第 ${error.index + 1} 个字符：应输入${describe(error.expected)}，实际输入${describe(error.actual)}。`;
    } else if (complete) {
      $("errorHint").textContent = "全文核对正确。";
    } else if (result.typed > 0) {
      const next = result.characters[result.typed]?.expected;
      $("errorHint").textContent = next === "\n" ? "下一处是换行。" : "";
    } else {
      $("errorHint").textContent = "";
    }
    $("feedbackRow").hidden = !$("errorHint").textContent;
    $("characterProgress").textContent = `正确 ${result.correct} / ${result.total} 字符`;
    $("progressFill").style.width = `${result.total ? result.correct / result.total * 100 : 0}%`;
    $("practiceCard").classList.toggle("is-complete", complete);
    const status = $("sessionStatus");
    status.className = `session-status${complete ? " complete" : result.typed > 0 ? " running" : ""}`;
    $("statusLabel").textContent = complete ? "已完成" : result.typed > 0 ? "练习中" : "准备开始";
  }

  function updateTimer() {
    const elapsed = clock.elapsed();
    const value = formatDuration(elapsed);
    const timer = $("timerDisplay");
    timer.setAttribute("data-long-time", String(value.length > 5));
    if (value !== lastTimer) {
      $("timerValue").textContent = value;
      $("timerDisplay").setAttribute("aria-label", `全文模式秒表 ${value}`);
      lastTimer = value;
    }
    const running = clock.state === "running";
    const action = running ? "暂停" : clock.state === "stopped" ? "继续" : "开始";
    $("timerStart").disabled = togglingTimer;
    $("timerStart").textContent = action;
    $("timerStart").setAttribute("aria-label", `${action}全文模式秒表`);
    $("timerStart").setAttribute("aria-pressed", String(running));
    $("timerClear").disabled = togglingTimer;
    const state = running ? "计时中" : clock.state === "stopped" ? "已暂停" : "未开始";
    if ($("timerState").textContent !== state) $("timerState").textContent = state;
    window.ZijianTimer?.update({ mode: "realtime", value, running, started: clock.state !== "idle" });
  }

  function reconcile() {
    selectionTranslation?.prepareForInput();
    referenceSelection?.clear();
    const normalized = normalizeInput(input.value);
    if (input.value !== normalized) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value = normalized;
      input.setSelectionRange(Math.min(start, normalized.length), Math.min(end, normalized.length));
    }
    result = compare(source, input.value);
    if (result.completed && !composing) {
      input.readOnly = true;
    }
    drawCharacters();
    updateFeedback();
    updateTimer();
    scheduleCaret();
    scheduleProgress();
  }

  function resetPractice(focus = true) {
    selectionTranslation?.reset();
    referenceSelection?.clear();
    input.value = "";
    input.readOnly = !canPractice();
    composing = false;
    clock.reset();
    lastTimer = "";
    result = compare(source, "");
    nodes = [];
    rendered = [];
    display.replaceChildren();
    $("articleKind").textContent = articleKind;
    $("articleTitle").textContent = articleTitle;
    $("articleTitle").title = articleTitle;
    const paragraphs = source.split(/\n\s*\n/u).length;
    $("articleMeta").textContent = `${words(source)} 词 · ${paragraphs} 段 · 严格逐字符核对`;
    $("sourceReadable").textContent = source;
    drawCharacters();
    updateFeedback();
    updateTimer();
    if (focus) {
      input.focus({ preventScroll: true });
      scheduleCaret();
    }
  }

  function clearImportError() {
    $("importError").hidden = true;
    $("importError").textContent = "";
    editor.removeAttribute("aria-invalid");
  }

  function importError(message) {
    $("importError").textContent = message;
    $("importError").hidden = false;
  }

  function updatePreview() {
    const text = normalizeSource(editor.value);
    $("sourcePreview").textContent = text || "暂无内容";
    $("sourcePreview").classList.toggle("preview-empty", !text);
    $("previewMeta").textContent = `${words(text)} 词 · ${Array.from(text).length} 字符`;
  }

  function cancelFileRead() {
    ++importRevision;
    loadingFile = false;
    $("applySource").disabled = false;
    $("fileName").textContent = fileTitle ? `${fileTitle}.txt` : "尚未选择文件";
  }

  function selectMode(mode, moveFocus = false) {
    const changed = activeMode !== mode;
    if (changed && progressReady && !restoringProgress) rememberMode();
    selectionTranslation?.close();
    referenceSelection?.clear();
    activeMode = mode;
    sentencePractice?.setActive(mode === "sentence");
    $("realtimePanel").hidden = mode !== "realtime";
    $("sentencePanel").hidden = mode !== "sentence";
    $("timerDisplay").hidden = mode !== "realtime";
    $("sentenceTimerDisplay").hidden = mode !== "sentence";
    window.ZijianTimer?.setMode(mode);
    ["realtimeModeButton", "sentenceFullModeButton"].forEach(id => $(id)?.setAttribute("aria-pressed", String(mode === "realtime")));
    ["sentenceModeButton", "sentenceSplitModeButton"].forEach(id => $(id)?.setAttribute("aria-pressed", String(mode === "sentence")));
    if (moveFocus) $(mode === "realtime" ? "realtimeModeButton" : "sentenceSplitModeButton")?.focus({ preventScroll: true });
    if (changed && progressReady && !restoringProgress) { restoreViewport(); scheduleProgress(); }
  }

  ["realtimeModeButton", "sentenceFullModeButton"].forEach(id => $(id)?.addEventListener("click", () => selectMode("realtime", true)));
  ["sentenceModeButton", "sentenceSplitModeButton"].forEach(id => {
    const button = $(id);
    if (!button) return;
    button.disabled = !sentencePractice;
    button.addEventListener("click", () => { if (sentencePractice) selectMode("sentence", true); });
  });

  $("importButton").addEventListener("click", () => withAccess(() => {
    selectionTranslation?.close();
    referenceSelection?.clear();
    cancelFileRead();
    editor.value = "";
    fileTitle = "";
    $("fileInput").value = "";
    $("fileName").textContent = "尚未选择文件";
    $("applySource").disabled = false;
    clearImportError();
    updatePreview();
    dialog.showModal();
    editor.focus();
  }));
  $("closeImport").addEventListener("click", () => dialog.close());
  $("cancelImport").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", cancelFileRead);
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  editor.addEventListener("input", () => {
    if (loadingFile) cancelFileRead();
    clearImportError();
    updatePreview();
  });

  $("fileInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const revision = ++importRevision;
    if (!/\.txt$/iu.test(file.name)) {
      cancelFileRead();
      importError("请选择扩展名为 .txt 的纯文本文件。");
      event.target.value = "";
      return;
    }
    loadingFile = true;
    $("applySource").disabled = true;
    $("fileName").textContent = "正在读取…";
    clearImportError();
    try {
      const bytes = await file.arrayBuffer();
      if (revision !== importRevision) return;
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("文件编码不支持。请将文件另存为通用文字编码（UTF-8），或直接粘贴正文。");
      }
      if (!normalizeSource(text)) throw new Error("这个文件没有可练习的文字，请选择其他文件。");
      editor.value = text;
      fileTitle = file.name.replace(/\.txt$/iu, "");
      $("fileName").textContent = file.name;
      $("fileName").title = file.name;
      updatePreview();
    } catch (error) {
      if (revision !== importRevision) return;
      importError(error instanceof Error && /文件编码|没有可练习/u.test(error.message) ? error.message : "文件读取失败，请重新选择，或直接粘贴文章。");
      $("fileName").textContent = fileTitle ? `${fileTitle}.txt` : "尚未选择文件";
    } finally {
      if (revision === importRevision) {
        loadingFile = false;
        $("applySource").disabled = false;
        event.target.value = "";
      }
    }
  });

  $("importForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void withAccess(() => {
      if (loadingFile) return;
      const text = normalizeSource(editor.value);
      if (!text) {
        importError("请先粘贴文字或选择一个 TXT 文件。");
        editor.setAttribute("aria-invalid", "true");
        editor.focus();
        return;
      }
      if (!flushProgress()) { importError("当前练习进度暂未保存，请检查浏览器存储设置后重试；当前输入仍保留。"); return; }
      source = text;
      const summary = Array.from(source.replace(/\s+/gu, " "));
      articleTitle = fileTitle.trim() || summary.slice(0, 48).join("") + (summary.length > 48 ? "…" : "");
      articleKind = "我的范文";
      const article = saveArticle(editor.value, articleTitle);
      currentArticleId = article?.id || null;
      progressPersistable = !!article;
      if (article) articleTitle = article.title;
      dialog.close();
      restoreArticleProgress(article?.progress);
      if (!article?.progress) restoreViewport();
      if (activeMode === "realtime") input.focus({ preventScroll: true });
      scheduleProgress();
      if (article?.shouldGenerateTitle) void generateTitle(article);
    });
  });
  $("restartButton").addEventListener("click", () => withAccess(() => {
    if (activeMode === "sentence") sentencePractice.reset(true);
    else resetPractice();
    progressNotice();
    scheduleProgress();
    flushProgress();
  }));
  $("timerStart").addEventListener("click", async () => {
    if (togglingTimer) return;
    if (clock.state === "running") { clock.pause(); updateTimer(); return; }
    togglingTimer = true;
    updateTimer();
    try { await withAccess(() => { clock.start(); updateTimer(); }); }
    finally { togglingTimer = false; updateTimer(); }
  });
  $("timerClear").addEventListener("click", () => { clock.reset(); updateTimer(); });
  input.addEventListener("input", reconcile);
  input.addEventListener("compositionstart", () => { composing = true; selectionTranslation?.prepareForInput(); referenceSelection?.clear(); });
  input.addEventListener("compositionend", () => { composing = false; reconcile(); });
  ["keyup", "click", "select", "focus", "pointerup"].forEach((name) => input.addEventListener(name, () => {
    scheduleCaret();
    scheduleProgress();
  }));
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === input) { scheduleCaret(); scheduleProgress(); }
  });
  document.addEventListener("focusin", keepSentenceInputVisible);
  document.addEventListener("input", keepSentenceInputVisible);
  window.addEventListener("resize", scheduleCaret);
  window.addEventListener("scroll", () => { if (!restoringViewport) scheduleProgress(); }, { passive: true });
  window.addEventListener("pagehide", flushProgress);
  document.addEventListener("visibilitychange", () => {
    updateTimer();
    if (document.visibilityState === "hidden") flushProgress();
  });
  window.addEventListener("authchange", () => {
    const allowed = canPractice();
    input.readOnly = !allowed || result.completed;
    if (!allowed) { clock.pause(); updateTimer(); }
    sentencePractice?.refreshAccess?.();
  });
  setInterval(() => { updateTimer(); sentencePractice?.refreshTimer(); }, 200);
  if (window.history && "scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
  restoreArticleProgress(savedArticle?.progress || (!savedArticle ? initialHistory.sampleProgress : null));
})();
