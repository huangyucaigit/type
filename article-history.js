(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ArticleHistory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const STORAGE_KEY = "mars-ielts-typing:article:v1";
  const LIMIT = 10;
  const MAX_PROGRESS_TEXT = 1000000;
  const MAX_PROGRESS_GROUPS = 10000;
  const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const boundedInteger = (value, fallback, maximum) => Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, Math.floor(value))) : fallback;

  function copyProgress(progress) {
    return { ...progress,
      ...(progress.realtime ? { realtime: { ...progress.realtime } } : {}),
      ...(progress.sentence ? { sentence: { ...progress.sentence,
        groups: progress.sentence.groups.map(group => ({ ...group })) } } : {}) };
  }

  // Accept only the fields needed to resume practice. Saved data may be edited,
  // left by an old version, or shared with another tab; never trust its shape.
  function normalizeProgress(value) {
    if (!record(value) || value.version !== 1 || !["realtime", "sentence"].includes(value.mode)) return null;
    let remaining = MAX_PROGRESS_TEXT;
    const selection = (state, text) => {
      const start = boundedInteger(state.selectionStart, text.length, text.length);
      const end = Math.max(start, boundedInteger(state.selectionEnd, start, text.length));
      return { selectionStart: start, selectionEnd: end,
        selectionDirection: ["forward", "backward", "none"].includes(state.selectionDirection)
          ? state.selectionDirection : "none" };
    };
    const draft = text => {
      if (typeof text !== "string" || text.length > remaining) return false;
      remaining -= text.length;
      return true;
    };
    const result = { version: 1, mode: value.mode };
    if (value.realtime !== undefined) {
      if (!record(value.realtime) || !draft(value.realtime.value)) return null;
      result.realtime = { value: value.realtime.value, ...selection(value.realtime, value.realtime.value),
        scrollY: boundedInteger(value.realtime.scrollY, 0, 100000000) };
    }
    if (value.sentence !== undefined) {
      const sentence = value.sentence;
      if (!record(sentence) || !Number.isSafeInteger(sentence.groupSize) || sentence.groupSize < 1
        || !Array.isArray(sentence.groups) || sentence.groups.length > MAX_PROGRESS_GROUPS) return null;
      const groups = [];
      for (const group of sentence.groups) {
        if (!record(group) || !draft(group.draft)) return null;
        groups.push({ draft: group.draft, ...selection(group, group.draft),
          referenceVisible: group.referenceVisible !== false,
          scrollTop: boundedInteger(group.scrollTop, 0, 100000000),
          ...(typeof group.checked === "boolean" ? { checked: group.checked } : {}),
          ...(typeof group.collapsed === "boolean" ? { collapsed: group.collapsed } : {}),
          ...(typeof group.reviewCompleted === "boolean" ? { reviewCompleted: group.reviewCompleted } : {}) });
      }
      result.sentence = { groupSize: sentence.groupSize, groups,
        activeGroup: boundedInteger(sentence.activeGroup, 0, Math.max(0, groups.length - 1)),
        scrollY: boundedInteger(sentence.scrollY, 0, 100000000) };
    }
    if (!result[value.mode]) return null;
    result.scrollY = boundedInteger(value.scrollY, 0, 100000000);
    return result;
  }

  function create({ getStorage, normalizeText, now = Date.now,
    makeId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` }) {
    let memory = { articles: [], currentId: null };
    const copyArticle = article => ({ ...article,
      ...(article.progress ? { progress: copyProgress(article.progress) } : {}) });
    const copy = state => ({ ...state, articles: state.articles.map(copyArticle),
      ...(state.sampleProgress ? { sampleProgress: copyProgress(state.sampleProgress) } : {}) });
    const validText = value => typeof value === "string" && Boolean(normalizeText(value));

    function read() {
      try {
        const raw = getStorage().getItem(STORAGE_KEY);
        if (raw === null) { memory = { articles: [], currentId: null }; return copy(memory); }
        const saved = JSON.parse(raw);
        if (!saved || Array.isArray(saved) || saved.version !== 1) return copy(memory);
        if (Array.isArray(saved.articles)) {
          const articles = [];
          for (const article of saved.articles) {
            if (!article || typeof article.id !== "string" || !article.id
              || !validText(article.text) || typeof article.title !== "string" || !article.title.trim()) continue;
            const text = article.text.trim();
            if (articles.some(item => item.id === article.id || item.text === text)) continue;
            const timestamp = value => Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? value : null;
            const progress = normalizeProgress(article.progress);
            articles.push({ id: article.id, text, title: article.title.trim(),
              titleSource: ["ai", "manual", "legacy"].includes(article.titleSource) ? article.titleSource : "fallback",
              importedAt: timestamp(article.importedAt), lastUsedAt: timestamp(article.lastUsedAt),
              ...(progress ? { progress } : {}) });
          }
          const retained = articles.slice(-LIMIT);
          memory = { articles: retained, currentId: retained.some(item => item.id === saved.currentId)
            ? saved.currentId : retained.at(-1)?.id || null };
        } else if (validText(saved.text) && typeof saved.title === "string" && saved.title.trim()) {
          // Migrate the previous single article on the next user action, without writing at startup.
          memory = { articles: [{ id: "legacy-article", text: normalizeText(saved.text), title: saved.title.trim(),
            titleSource: "legacy", importedAt: null, lastUsedAt: null }], currentId: "legacy-article" };
        }
        const sampleProgress = normalizeProgress(saved.sampleProgress);
        if (sampleProgress) memory.sampleProgress = sampleProgress;
      } catch { /* Storage may be disabled; practice remains usable. */ }
      return copy(memory);
    }

    function write(state) {
      const current = state.articles.find(item => item.id === state.currentId);
      // Current article and history share one atomic localStorage write.
      getStorage().setItem(STORAGE_KEY, JSON.stringify({ version: 1,
        text: current ? normalizeText(current.text) : "", title: current?.title || "",
        articles: state.articles, currentId: state.currentId,
        ...(state.sampleProgress ? { sampleProgress: state.sampleProgress } : {}) }));
      memory = copy(state);
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("articlehistorychange"));
      }
      return copy(state);
    }

    return {
      read,
      saveProgress(id, snapshot) {
        const state = read();
        const article = id === null ? null : state.articles.find(item => item.id === id);
        // A delayed save from a stale tab must not recreate a deleted article.
        if (id !== null && !article) return null;
        const progress = snapshot === null ? null : normalizeProgress(snapshot);
        if (snapshot !== null && !progress) throw new TypeError("练习进度格式无效或内容过大。");
        const target = id === null ? state : article;
        const key = id === null ? "sampleProgress" : "progress";
        if (progress) target[key] = progress;
        else delete target[key];
        return write(state);
      },
      importArticle(raw, title) {
        const text = raw.trim();
        if (!validText(text)) throw new Error("文章不能为空。");
        const state = read();
        const existing = state.articles.find(item => item.text === text);
        const article = existing || { id: makeId(), text, title: title.trim() || "我的英文范文", titleSource: "fallback" };
        article.importedAt = now();
        article.lastUsedAt = Math.max(article.importedAt, ...state.articles.map(item => (item.lastUsedAt || 0) + 1));
        state.articles = [...state.articles.filter(item => item.id !== article.id), article].slice(-LIMIT);
        state.currentId = article.id;
        write(state);
        return { ...copyArticle(article), shouldGenerateTitle: !existing };
      },
      select(id) {
        const state = read();
        const article = state.articles.find(item => item.id === id);
        if (!article) return null;
        article.lastUsedAt = Math.max(now(), ...state.articles.map(item => (item.lastUsedAt || 0) + 1));
        state.currentId = id;
        write(state);
        return copyArticle(article);
      },
      remove(id) {
        const state = read();
        state.articles = state.articles.filter(item => item.id !== id);
        if (state.currentId === id) {
          state.currentId = [...state.articles].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))[0]?.id || null;
        }
        return write(state);
      },
      rename(id, title, { generated = false, expectedTitle } = {}) {
        title = title.trim();
        if (!title || Array.from(title).length > 80) throw new Error("标题需为 1–80 个字符。");
        const state = read();
        const article = state.articles.find(item => item.id === id);
        // A late AI response must not revive a deleted article or overwrite a manual name.
        if (!article || (generated && (article.titleSource !== "fallback" || article.title !== expectedTitle))) return null;
        article.title = title;
        article.titleSource = generated ? "ai" : "manual";
        write(state);
        return copyArticle(article);
      },
    };
  }
  return { create, STORAGE_KEY, LIMIT };
});
