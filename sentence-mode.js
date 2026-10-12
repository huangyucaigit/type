(function () {
  "use strict";

  function create({ source, title, kind = "我的范文", onLearningReset = () => {} }) {
    const { groupSentences, splitSentences, compareWords } = window.SentenceCore;
    const { PracticeClock, formatDuration } = window.TypingCore;
    const $ = (id) => document.getElementById(id);
    const clock = new PracticeClock();
    const normalize = text => String(text ?? "").replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
    let sourceText = normalize(source);
    let articleTitle = title;
    let articleKind = kind;
    let groupSize = 1;
    let items = [];
    let lastTime = "";
    let active = true;
    // Translations belong to the exact English text, independently of practice drafts.
    const translations = new Map();

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function button(text, className, action) {
      const node = element("button", className, text);
      node.type = "button";
      node.addEventListener("click", action);
      return node;
    }

    function showReference(item, visible) {
      if (!visible && !item.reference.hidden && items.includes(item)) onLearningReset();
      item.reference.hidden = !visible;
      item.placeholder.hidden = visible;
      item.toggle.textContent = visible ? "隐藏范文" : "显示范文";
      item.toggle.setAttribute("aria-expanded", String(visible));
    }

    function translationError(status) {
      if (status === 401 || status === 403) return "翻译密钥未通过验证，请检查本地 .env 配置后重试。";
      if (status === 402) return "翻译账户余额不足，请检查账户后重试。";
      if (status === 413) return "这一组内容过长，请减少每组句数后重试。";
      if (status === 429) return "翻译请求较多，请稍后重试。";
      if (status === 503) return "翻译服务尚未配置好，请检查本地 .env 配置后重试。";
      return "翻译暂时不可用，请确认本地翻译服务已启动，再点击重试。";
    }

    function requestTranslation(text) {
      const cached = translations.get(text);
      if (cached) return cached;
      const promise = (async () => {
        let response;
        try {
          response = await window.fetch("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
        } catch {
          throw new Error(translationError());
        }
        if (!response.ok) {
          let errorData;
          try { errorData = await response.json(); } catch { /* Use the status fallback. */ }
          throw new Error(typeof errorData?.error === "string" && errorData.error.length < 400
            ? errorData.error : translationError(response.status));
        }
        let data;
        try { data = await response.json(); } catch { throw new Error("翻译结果格式异常，请重试。"); }
        if (typeof data?.translation !== "string" || !data.translation.trim()) {
          throw new Error("没有收到有效译文，请重试。");
        }
        return data.translation.trim();
      })();
      translations.set(text, promise);
      // A failed request is retryable; successful results and in-flight requests are reused.
      promise.catch(() => { if (translations.get(text) === promise) translations.delete(text); });
      return promise;
    }

    async function loadTranslation(item) {
      if (item.translationLoading || item.translationText) return;
      if (window.location?.protocol === "file:") {
        item.translationStatus.textContent = "请先双击“启动翻译.cmd”，再打开下方翻译版网页使用中文翻译。";
        item.translationLink.hidden = false;
        return;
      }
      item.translationLoading = true;
      item.translationStatus.textContent = "正在翻译…";
      item.translationStatus.className = "translation-status";
      item.translationPanel.setAttribute("aria-busy", "true");
      item.translationRetry.hidden = true;
      try {
        const text = await requestTranslation(item.text);
        if (!items.includes(item)) return;
        item.translationText = text;
        item.translationContent.textContent = text;
        item.translationStatus.textContent = "";
      } catch (error) {
        if (!items.includes(item)) return;
        item.translationStatus.textContent = error.message;
        item.translationStatus.className = "translation-status has-errors";
        item.translationRetry.hidden = false;
      } finally {
        item.translationLoading = false;
        item.translationPanel.setAttribute("aria-busy", "false");
      }
    }

    function showTranslation(item, visible) {
      item.translationPanel.hidden = !visible;
      item.translationToggle.textContent = visible ? "隐藏中文" : "显示中文";
      item.translationToggle.setAttribute("aria-expanded", String(visible));
      if (visible) return loadTranslation(item);
    }

    function refreshTimer() {
      const value = formatDuration(clock.elapsed());
      const running = clock.state === "running";
      const paused = clock.state === "stopped";
      const state = running ? "计时中" : paused ? "已暂停" : "未开始";
      if (value !== lastTime) {
        $("sentenceTimerValue").textContent = value;
        lastTime = value;
      }
      const label = `分句模式秒表 ${value}，${state}`;
      if ($("sentenceTimerDisplay").getAttribute("aria-label") !== label) $("sentenceTimerDisplay").setAttribute("aria-label", label);
      if ($("sentenceTimerState").textContent !== state) $("sentenceTimerState").textContent = state;
      $("sentenceTimerStart").textContent = paused ? "继续" : "开始";
      $("sentenceTimerStart").disabled = running;
      $("sentenceTimerPause").disabled = !running;
    }

    function refreshSummary() {
      const checked = items.filter((item) => item.analysis).length;
      const correct = items.filter((item) => item.analysis?.completed).length;
      const allCorrect = items.length > 0 && correct === items.length;
      $("sentenceProgress").textContent = `正确完成 ${correct} / ${items.length} 组`;
      $("sentenceSessionStatus").textContent = allCorrect
        ? "已完成"
        : checked > 0
          ? `已检查 ${checked} / ${items.length} 组`
          : items.some((item) => item.draft.length)
            ? "练习中"
            : "准备开始";
      refreshTimer();
    }

    function edit(item, focus = true) {
      onLearningReset();
      cancelReview(item);
      item.analysis = null;
      item.answer.hidden = false;
      item.checkedAnswer.hidden = true;
      item.editButton.hidden = true;
      item.feedback.textContent = "";
      item.feedback.className = "group-feedback";
      item.missing.hidden = true;
      item.reviewPanel.hidden = true;
      item.reviewPanel.replaceChildren();
      item.reviewLink.hidden = true;
      item.state.textContent = item.draft ? "待检查" : "待输入";
      item.card.classList.remove("is-checked", "is-correct");
      item.inputLabel.textContent = "你的输入";
      refreshSummary();
      if (focus) item.answer.focus({ preventScroll: true });
    }

    function cancelReview(item) {
      item.reviewVersion = (item.reviewVersion || 0) + 1;
      item.reviewController?.abort();
      item.reviewController = null;
      item.reviewPending = false;
      if (item.checkButton) {
        item.checkButton.disabled = false;
        item.checkButton.textContent = "对照检查";
      }
      item.card?.setAttribute("aria-busy", "false");
    }

    function validateReview(value, answer) {
      const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 24000;
      if (!value || !["correct", "needs_correction", "uncertain"].includes(value.languageStatus)
        || !["consistent", "changed", "uncertain"].includes(value.meaningStatus)
        || !text(value.summary) || !text(value.correctedAnswer)
        || !Array.isArray(value.errors) || value.errors.length > 40
        || !Array.isArray(value.differences) || value.differences.length > 20
        || !Array.isArray(value.meaningNotes) || value.meaningNotes.length > 20
        || value.meaningNotes.some(note => !text(note))
        || value.errors.some(error => !error || !text(error.original) || !text(error.correction)
          || !text(error.reason) || !["spelling", "grammar", "word_choice", "punctuation"].includes(error.category)
          || !answer.includes(error.original))
        || value.differences.some(difference => !difference || !text(difference.aspect)
          || !text(difference.answer) || !text(difference.reference) || !text(difference.explanation))
        || (value.languageStatus === "correct" && (value.errors.length > 0 || value.correctedAnswer !== answer))
        || (value.languageStatus === "needs_correction" && (!value.errors.length || value.correctedAnswer === answer))
        || (value.meaningStatus !== "consistent" && !value.meaningNotes.length)) {
        throw new Error("评析结果格式异常，请重新检查。");
      }
      return value;
    }

    function reviewSection(panel, heading) {
      const section = element("section", "review-section");
      section.append(element("h4", "review-heading", heading));
      panel.append(section);
      return section;
    }

    function renderReview(item, result) {
      item.reviewPanel.replaceChildren();
      reviewSection(item.reviewPanel, "总体评析").append(element("p", "review-summary", result.summary));
      if (result.errors.length) {
        const section = reviewSection(item.reviewPanel, "逐项批改");
        const wrap = element("div", "review-table-wrap");
        wrap.tabIndex = 0;
        wrap.setAttribute("role", "region");
        wrap.setAttribute("aria-label", "逐项批改表，可左右滚动");
        const table = element("table", "review-table");
        const head = element("thead");
        const headings = element("tr");
        ["你的表达", "正确表达", "原因"].forEach(label => {
          const cell = element("th", "", label);
          cell.setAttribute("scope", "col");
          headings.append(cell);
        });
        head.append(headings);
        const body = element("tbody");
        result.errors.forEach(error => {
          const row = element("tr");
          const original = element("td", "review-original", error.original);
          const correction = element("td", "review-replacement", error.correction);
          original.lang = correction.lang = "en";
          row.append(original, correction, element("td", "review-reason", error.reason));
          body.append(row);
        });
        table.append(head, body);
        wrap.append(table);
        section.append(wrap);
      }
      if (result.correctedAnswer !== item.draft.trim()) {
        const corrected = element("p", "review-correction", result.correctedAnswer);
        corrected.lang = "en";
        reviewSection(item.reviewPanel, "保留你的表达 · 修正后").append(corrected);
      }
      if (result.differences.length) {
        const section = reviewSection(item.reviewPanel, "与范文的表达对比");
        const list = element("div", "review-comparison-list");
        result.differences.forEach(difference => {
          const comparison = element("div", "review-comparison");
          comparison.append(element("h5", "", difference.aspect));
          for (const [label, expression] of [[result.correctedAnswer === item.draft.trim() ? "你的表达" : "修正后的表达", difference.answer], ["范文表达", difference.reference]]) {
            const line = element("p");
            line.append(element("span", "review-expression-label", `${label}：`));
            const english = element("span", "review-expression", expression);
            english.lang = "en";
            line.append(english);
            comparison.append(line);
          }
          comparison.append(element("p", "review-explanation", difference.explanation));
          list.append(comparison);
        });
        section.append(list);
      }
      if (result.meaningNotes.length) {
        const note = element("p", `review-semantic-note${result.meaningStatus !== "consistent" ? " has-difference" : ""}`, result.meaningNotes.join("\n"));
        reviewSection(item.reviewPanel, result.meaningStatus === "changed" ? "与范文的原意差异" : "原意核对").append(note);
      }
      item.reviewPanel.hidden = false;
    }

    async function review(item) {
      if (!active || item.reviewPending || !items.includes(item)) return;
      edit(item, false);
      showReference(item, true);
      const answer = item.draft.trim();
      const reference = item.text.trim();
      if (!answer || !/[A-Za-z]/u.test(answer)) {
        item.feedback.textContent = "请先输入英文，再进行对照检查。";
        item.feedback.className = "group-feedback has-errors";
        item.answer.focus({ preventScroll: true });
        return;
      }
      if (window.location?.protocol === "file:") {
        item.feedback.textContent = "当前为离线页面，可点击“逐词核对”；启动本地服务后可使用表达评析。";
        item.reviewLink.hidden = false;
        return;
      }
      if (!/[A-Za-z]/u.test(reference) || answer.length > 12000 || reference.length > 12000) {
        item.feedback.textContent = "范文和输入均须包含英文，且各不超过 12000 个字符；可减少每组句数后重试。";
        item.feedback.className = "group-feedback has-errors";
        return;
      }
      const revision = item.reviewVersion;
      const snapshot = item.draft;
      const controller = new window.AbortController();
      item.reviewController = controller;
      item.reviewPending = true;
      item.checkButton.disabled = true;
      item.checkButton.textContent = "评析中…";
      item.card.setAttribute("aria-busy", "true");
      item.state.textContent = "评析中";
      item.feedback.textContent = "正在评析英文表达…";
      item.feedback.className = "group-feedback is-reviewing";
      let timedOut = false;
      const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 65000);
      const isCurrent = () => active && items.includes(item) && item.reviewVersion === revision && item.draft === snapshot;
      try {
        let response;
        try {
          response = await window.fetch("/api/review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reference, answer }),
            signal: controller.signal,
          });
        } catch {
          throw new Error(timedOut ? "评析等待超时，请点击“对照检查”重试。" : "暂时无法连接评析服务，请重试，或使用“逐词核对”。");
        }
        let data;
        try { data = await response.json(); } catch { throw new Error("评析结果格式异常，请重新检查。"); }
        if (!response.ok) {
          throw new Error(typeof data?.error === "string" && data.error.length < 400
            ? data.error : response.status === 429 ? "评析请求较多，请稍后重试。" : "表达评析暂时不可用，请重试，或使用“逐词核对”。");
        }
        if (!isCurrent()) return;
        const result = validateReview(data?.review, answer);
        const completed = result.languageStatus === "correct" && result.meaningStatus === "consistent";
        item.analysis = { completed, review: result };
        // Different but valid wording is never compared with the strict word diff.
        // Without exact error ranges, corrections are highlighted only in the table.
        item.checkedAnswer.replaceChildren(element("span", "review-answer", snapshot));
        item.answer.hidden = true;
        item.checkedAnswer.hidden = false;
        item.editButton.hidden = false;
        item.inputLabel.textContent = "你的输入 · 表达评析";
        renderReview(item, result);
        item.feedback.textContent = result.languageStatus === "needs_correction"
          ? `有 ${result.errors.length} 处语言问题需要修正。`
          : result.languageStatus === "uncertain" ? "部分表达需要结合语境进一步判断。"
            : result.meaningStatus === "changed" ? "语言表达正确，但与范文原意不同。"
              : result.meaningStatus === "uncertain" ? "语言表达正确，原意是否一致尚需确认。"
                : "表达正确，保留了范文原意。";
        item.feedback.className = `group-feedback ${completed ? "is-correct" : result.languageStatus === "needs_correction" ? "has-errors" : "is-warning"}`;
        item.state.textContent = completed ? "表达正确" : result.languageStatus === "needs_correction" ? "待修正" : "待确认";
        item.card.classList.add("is-checked");
        item.card.classList.toggle("is-correct", completed);
        refreshSummary();
      } catch (error) {
        if (!isCurrent()) return;
        item.feedback.textContent = `${error.message} 输入已保留。`;
        item.feedback.className = "group-feedback has-errors";
        item.state.textContent = "待重试";
      } finally {
        window.clearTimeout(timeout);
        if (isCurrent()) {
          item.reviewPending = false;
          item.reviewController = null;
          item.checkButton.disabled = false;
          item.checkButton.textContent = "对照检查";
          item.card.setAttribute("aria-busy", "false");
        }
      }
    }

    function checkWords(item) {
      onLearningReset();
      cancelReview(item);
      item.reviewPanel.hidden = true;
      item.reviewPanel.replaceChildren();
      item.reviewLink.hidden = true;
      const analysis = compareWords(item.text, item.draft);
      item.analysis = analysis;
      showReference(item, true);
      item.checkedAnswer.replaceChildren();
      if (!item.draft.trim()) {
        item.checkedAnswer.append(element("span", "answer-empty", "本组尚未输入内容。"));
      } else {
        analysis.tokens.forEach((token) => {
          const span = element("span", token.state === "incorrect" ? "word-error" : token.state === "extra" ? "word-extra" : "word-correct", token.text);
          if (token.state === "incorrect") span.title = `应为：${token.expected}`;
          if (token.state === "extra") span.title = "多输入的单词";
          item.checkedAnswer.append(span);
        });
      }
      item.answer.hidden = true;
      item.checkedAnswer.hidden = false;
      item.editButton.hidden = false;
      item.inputLabel.textContent = "你的输入 · 检查结果";
      item.missing.replaceChildren();
      item.missing.hidden = analysis.missing.length === 0;
      if (analysis.missing.length) {
        item.missing.append(element("span", "missing-label", `漏写 ${analysis.missing.length} 词：`));
        analysis.missing.forEach((missing) => {
          const span = element("span", "missing-word", missing.text);
          span.title = `原文第 ${missing.expectedIndex + 1} 个词`;
          item.missing.append(span);
        });
      }
      const incorrect = analysis.tokens.filter((token) => token.state === "incorrect").length;
      const extra = analysis.tokens.filter((token) => token.state === "extra").length;
      item.feedback.textContent = analysis.completed
        ? "本组全部正确。"
        : `有 ${analysis.errorCount} 处需要修改：错词 ${incorrect} · 多词 ${extra} · 漏词 ${analysis.missing.length}。`;
      item.feedback.className = `group-feedback ${analysis.completed ? "is-correct" : "has-errors"}`;
      item.state.textContent = analysis.completed ? "全部正确" : "待修正";
      item.card.classList.add("is-checked");
      item.card.classList.toggle("is-correct", analysis.completed);
      refreshSummary();
    }

    function buildGroup(group, index, fragments) {
      const item = { text: group.text, fragments, draft: "", analysis: null, reviewVersion: 0, reviewPending: false };
      const number = index + 1;
      const card = element("article", "sentence-group");
      card.setAttribute("aria-labelledby", `sentenceHeading-${number}`);
      item.card = card;
      const header = element("div", "sentence-group-header");
      header.append(element("span", "group-number", String(number).padStart(2, "0")));
      const heading = element("h3", "", `第 ${number} 组 · ${group.sentences.length} 句`);
      heading.id = `sentenceHeading-${number}`;
      header.append(heading);
      item.state = element("span", "group-state", "待输入");
      header.append(item.state);
      item.toggle = button("显示范文", "button button-secondary reference-toggle", () => showReference(item, item.reference.hidden));
      item.toggle.setAttribute("aria-controls", `sentenceReference-${number}`);
      item.toggle.setAttribute("aria-label", `第 ${number} 组显示或隐藏范文`);
      item.translationToggle = button("显示中文", "button button-secondary translation-toggle", () => showTranslation(item, item.translationPanel.hidden));
      item.translationToggle.setAttribute("aria-controls", `sentenceTranslation-${number}`);
      item.translationToggle.setAttribute("aria-expanded", "false");
      item.translationToggle.setAttribute("aria-label", `第 ${number} 组显示或隐藏中文翻译`);
      card.append(header);
      item.reference = element("p", "sentence-reference", item.text);
      item.reference.id = `sentenceReference-${number}`;
      item.reference.lang = "en";
      item.reference.tabIndex = 0;
      item.reference.setAttribute("aria-label", `第 ${number} 组英文范文，可选中后双击查看翻译与雅思用法`);
      item.reference.setAttribute("aria-describedby", "sentenceHelp");
      item.placeholder = element("p", "reference-placeholder", "范文已隐藏");
      card.append(item.reference, item.placeholder);
      item.translationPanel = element("section", "sentence-translation");
      item.translationPanel.id = `sentenceTranslation-${number}`;
      item.translationPanel.hidden = true;
      item.translationPanel.setAttribute("aria-label", `第 ${number} 组中文翻译`);
      item.translationPanel.setAttribute("aria-busy", "false");
      item.translationPanel.append(element("span", "translation-label", "中文参考"));
      item.translationContent = element("p", "translation-content");
      item.translationContent.lang = "zh-CN";
      item.translationStatus = element("p", "translation-status");
      item.translationStatus.setAttribute("role", "status");
      item.translationStatus.setAttribute("aria-live", "polite");
      item.translationRetry = button("重试翻译", "button button-secondary translation-retry", () => loadTranslation(item));
      item.translationRetry.hidden = true;
      item.translationLink = element("a", "translation-service-link", "打开翻译版网页");
      item.translationLink.href = "http://127.0.0.1:4173";
      item.translationLink.target = "_blank";
      item.translationLink.rel = "noopener";
      item.translationLink.hidden = true;
      item.translationPanel.append(item.translationContent, item.translationStatus, item.translationRetry, item.translationLink);
      card.append(item.translationPanel);
      item.inputLabel = element("label", "group-input-label", "你的输入");
      item.inputLabel.htmlFor = `sentenceAnswer-${number}`;
      item.answer = element("textarea", "sentence-answer");
      item.answer.id = `sentenceAnswer-${number}`;
      item.answer.setAttribute("aria-label", `第 ${number} 组输入`);
      item.answer.setAttribute("aria-describedby", `sentenceHelp sentenceFeedback-${number}`);
      item.answer.lang = "en";
      item.answer.spellcheck = false;
      item.answer.setAttribute("autocapitalize", "off");
      item.answer.setAttribute("autocomplete", "off");
      item.answer.setAttribute("autocorrect", "off");
      item.answer.placeholder = "在这里输入你记住的句子…";
      item.answer.rows = Math.min(9, Math.max(3, group.sentences.length + 1));
      for (const event of ["focus", "beforeinput", "compositionstart"]) {
        item.answer.addEventListener(event, () => onLearningReset());
      }
      item.answer.addEventListener("input", () => {
        onLearningReset();
        item.draft = item.answer.value;
        if (item.analysis || item.reviewPending || item.feedback.textContent) edit(item, false);
        item.state.textContent = item.draft.length ? "待检查" : "待输入";
        refreshSummary();
      });
      item.checkedAnswer = element("div", "checked-answer");
      item.checkedAnswer.setAttribute("role", "region");
      item.checkedAnswer.setAttribute("aria-label", `第 ${number} 组输入检查结果`);
      item.checkedAnswer.lang = "en";
      item.checkedAnswer.hidden = true;
      card.append(item.inputLabel, item.answer, item.checkedAnswer);
      item.feedback = element("p", "group-feedback");
      item.feedback.id = `sentenceFeedback-${number}`;
      item.feedback.setAttribute("role", "status");
      item.feedback.setAttribute("aria-live", "polite");
      item.missing = element("div", "missing-words");
      item.missing.hidden = true;
      const actions = element("div", "sentence-group-actions");
      actions.setAttribute("role", "group");
      actions.setAttribute("aria-label", `第 ${number} 组练习操作`);
      item.editButton = button("修改输入", "button button-secondary group-edit", () => edit(item));
      item.editButton.hidden = true;
      item.checkButton = button("对照检查", "button button-primary group-check", () => review(item));
      item.checkButton.setAttribute("aria-label", `第 ${number} 组对照检查，评析英文表达`);
      const strictButton = button("逐词核对", "button button-secondary group-word-check", () => checkWords(item));
      strictButton.setAttribute("aria-label", `第 ${number} 组逐词核对，与范文严格比对`);
      actions.append(item.checkButton, strictButton, item.toggle, item.translationToggle, item.editButton);
      item.reviewLink = element("a", "review-service-link", "打开在线练习页");
      item.reviewLink.href = "http://127.0.0.1:4173";
      item.reviewLink.target = "_blank";
      item.reviewLink.rel = "noopener";
      item.reviewLink.hidden = true;
      item.reviewPanel = element("section", "sentence-review");
      item.reviewPanel.setAttribute("aria-label", `第 ${number} 组表达评析`);
      item.reviewPanel.hidden = true;
      card.append(actions, item.feedback, item.missing, item.reviewLink, item.reviewPanel);
      showReference(item, true);
      return item;
    }

    function reset(focus = false) {
      onLearningReset();
      items.forEach(cancelReview);
      clock.reset();
      lastTime = "";
      $("groupingError").hidden = true;
      $("sentencesPerGroup").removeAttribute("aria-invalid");
      $("sentencesPerGroup").value = String(groupSize);
      $("sentenceArticleTitle").textContent = articleTitle;
      $("sentenceArticleKind").textContent = `${articleKind} · 分句模式`;
      const groups = groupSentences(sourceText, groupSize);
      // Groups join sentences with one space. Keep a separate map back to the
      // original whitespace and paragraphs, including repeated sentences.
      let sourceCursor = 0;
      items = groups.map((group, index) => {
        let localCursor = 0;
        const fragments = group.sentences.map(sentence => {
          const start = sourceText.indexOf(sentence, sourceCursor);
          const fragment = { localStart: localCursor, localEnd: localCursor + sentence.length, sourceStart: start };
          localCursor += sentence.length + 1;
          if (start >= 0) sourceCursor = start + sentence.length;
          return fragment;
        });
        return buildGroup(group, index, fragments);
      });
      $("sentenceGroups").replaceChildren(...items.map((item) => item.card));
      $("sentenceMeta").textContent = `${splitSentences(sourceText).length} 句 · ${items.length} 组 · 每组最多 ${groupSize} 句`;
      refreshSummary();
      if (focus) items[0]?.answer.focus({ preventScroll: true });
    }

    $("applyGrouping").addEventListener("click", () => {
      const value = $("sentencesPerGroup").value.trim();
      const count = Number(value);
      if (!value || !Number.isSafeInteger(count) || count < 1) {
        $("groupingError").textContent = "请输入大于或等于 1 的有效整数。";
        $("groupingError").hidden = false;
        $("sentencesPerGroup").setAttribute("aria-invalid", "true");
        $("sentencesPerGroup").focus();
        return;
      }
      $("groupingError").hidden = true;
      $("sentencesPerGroup").removeAttribute("aria-invalid");
      if (count === groupSize) return;
      groupSize = count;
      reset();
    });
    $("showAllReferences").addEventListener("click", () => items.forEach((item) => showReference(item, true)));
    $("hideAllReferences").addEventListener("click", () => items.forEach((item) => showReference(item, false)));
    $("sentenceTimerStart").addEventListener("click", () => { clock.start(); refreshTimer(); });
    $("sentenceTimerPause").addEventListener("click", () => { clock.pause(); refreshTimer(); });
    $("sentenceTimerClear").addEventListener("click", () => { clock.reset(); refreshTimer(); });
    reset();
    return {
      reset,
      refreshTimer,
      setActive(value) {
        active = Boolean(value);
        if (!active) items.filter(item => item.reviewPending).forEach(item => edit(item, false));
      },
      getLearningSources() {
        return items.filter(item => !item.reference.hidden).map(item => ({
          display: item.reference,
          area: item.reference,
          getReferenceText: () => item.text,
          mapRange(start, end) {
            if (!items.includes(item) || item.reference.hidden || !Number.isInteger(start)
              || !Number.isInteger(end) || start < 0 || end <= start || end > item.text.length) return null;
            const mapOffset = offset => {
              const fragment = item.fragments.find(part => offset >= part.localStart && offset <= part.localEnd);
              return fragment && fragment.sourceStart >= 0 ? fragment.sourceStart + offset - fragment.localStart : null;
            };
            const from = mapOffset(start);
            const to = mapOffset(end);
            return from !== null && to !== null && to > from ? { source: sourceText, start: from, end: to } : null;
          },
        }));
      },
      setTimerVisible(visible) { $("sentenceTimerDisplay").hidden = !visible; refreshTimer(); },
      setSource(text, nextTitle, nextKind) {
        sourceText = normalize(text);
        articleTitle = nextTitle;
        articleKind = nextKind;
        reset();
      },
    };
  }

  window.SentencePractice = { create };
})();
