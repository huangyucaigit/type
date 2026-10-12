(() => {
  "use strict";

  const { normalizeSource, normalizeInput, compare, formatDuration, PracticeClock } = window.TypingCore;
  const $ = (id) => document.getElementById(id);
  const input = $("typingInput");
  const display = $("textDisplay");
  const dialog = $("importDialog");
  const editor = $("sourceEditor");
  const clock = new PracticeClock();
  const sample = "Learning a language is a journey that rewards patience and regular practice. Although progress may seem slow at first, small efforts made every day can lead to lasting improvements. Writing, in particular, helps learners organise their thoughts and express ideas with greater confidence.\n\nRather than aiming for perfection, students should focus on building a consistent routine. Reading a well-written article, noticing how its sentences connect, and typing it carefully can all be valuable steps. Over time, familiar words and useful expressions become easier to recall. The most important thing is to keep going, one sentence at a time.";

  let source = normalizeSource(sample);
  let articleTitle = "The value of everyday practice";
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
  const sentencePractice = window.SentencePractice?.create({ source, title: articleTitle, kind: "示例范文",
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
    getReferenceText: () => source,
    getAdditionalSources: () => activeMode === "sentence" ? sentencePractice?.getLearningSources() || [] : [],
    isPrimaryActive: () => activeMode === "realtime",
    isActive: () => !dialog.open,
  });
  const referenceSelection = window.ReferenceSelection?.create({
    input,
    display,
    area: $("typingArea"),
    isActive: () => activeMode === "realtime" && !dialog.open,
    onResumeInput: () => selectionTranslation?.prepareForInput(),
  });

  function words(text) {
    return text.trim() ? text.trim().split(/\s+/u).length : 0;
  }

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
    if (rect.top < margin || rect.bottom > visibleHeight - margin) {
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
    const value = formatDuration(clock.elapsed());
    if (value !== lastTimer) {
      $("timerValue").textContent = value;
      $("timerDisplay").setAttribute("aria-label", `全文模式秒表 ${value}`);
      lastTimer = value;
    }
    const running = clock.state === "running";
    $("timerStart").disabled = running;
    $("timerStart").textContent = clock.state === "stopped" ? "继续" : "开始";
    $("timerPause").disabled = !running;
    const state = running ? "计时中" : clock.state === "stopped" ? "已暂停" : "未开始";
    if ($("timerState").textContent !== state) $("timerState").textContent = state;
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
  }

  function resetPractice(focus = true) {
    selectionTranslation?.reset();
    referenceSelection?.clear();
    input.value = "";
    input.readOnly = false;
    composing = false;
    clock.reset();
    lastTimer = "";
    result = compare(source, "");
    nodes = [];
    rendered = [];
    display.replaceChildren();
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

  function selectMode(mode) {
    selectionTranslation?.close();
    referenceSelection?.clear();
    activeMode = mode;
    sentencePractice?.setActive(mode === "sentence");
    $("realtimePanel").hidden = mode !== "realtime";
    $("sentencePanel").hidden = mode !== "sentence";
    $("realtimeModeButton").setAttribute("aria-pressed", String(mode === "realtime"));
    $("sentenceModeButton").setAttribute("aria-pressed", String(mode === "sentence"));
  }

  $("realtimeModeButton").addEventListener("click", () => selectMode("realtime"));
  $("sentenceModeButton").disabled = !sentencePractice;
  $("sentenceModeButton").addEventListener("click", () => {
    if (sentencePractice) selectMode("sentence");
  });

  $("importButton").addEventListener("click", () => {
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
  });
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
    if (loadingFile) return;
    const text = normalizeSource(editor.value);
    if (!text) {
      importError("请先粘贴文字或选择一个 TXT 文件。");
      editor.setAttribute("aria-invalid", "true");
      editor.focus();
      return;
    }
    source = text;
    articleTitle = fileTitle || "我的英文范文";
    $("articleKind").textContent = "我的范文";
    dialog.close();
    resetPractice(activeMode === "realtime");
    sentencePractice?.setSource(source, articleTitle, "我的范文");
  });
  $("restartButton").addEventListener("click", () => {
    if (activeMode === "sentence") sentencePractice.reset(true);
    else resetPractice();
  });
  $("showTimer").addEventListener("change", (event) => {
    $("timerDisplay").hidden = !event.target.checked;
    sentencePractice?.setTimerVisible(event.target.checked);
    updateTimer();
  });
  $("timerStart").addEventListener("click", () => { clock.start(); updateTimer(); });
  $("timerPause").addEventListener("click", () => { clock.pause(); updateTimer(); });
  $("timerClear").addEventListener("click", () => { clock.reset(); updateTimer(); });
  input.addEventListener("input", reconcile);
  input.addEventListener("compositionstart", () => { composing = true; selectionTranslation?.prepareForInput(); referenceSelection?.clear(); });
  input.addEventListener("compositionend", () => { composing = false; reconcile(); });
  ["keyup", "click", "select", "focus", "pointerup"].forEach((name) => input.addEventListener(name, scheduleCaret));
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === input) scheduleCaret();
  });
  window.addEventListener("resize", scheduleCaret);
  document.addEventListener("visibilitychange", updateTimer);
  setInterval(() => { updateTimer(); sentencePractice?.refreshTimer(); }, 200);
  selectMode("realtime");
  resetPractice(false);
})();
