(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ArticleHistory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const STORAGE_KEY = "mars-ielts-typing:article:v1";
  const LIMIT = 10;

  function create({ getStorage, normalizeText, now = Date.now,
    makeId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` }) {
    let memory = { articles: [], currentId: null };
    const copy = state => ({ ...state, articles: state.articles.map(article => ({ ...article })) });
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
            articles.push({ id: article.id, text, title: article.title.trim(),
              titleSource: ["ai", "manual", "legacy"].includes(article.titleSource) ? article.titleSource : "fallback",
              importedAt: timestamp(article.importedAt), lastUsedAt: timestamp(article.lastUsedAt) });
          }
          const retained = articles.slice(-LIMIT);
          memory = { articles: retained, currentId: retained.some(item => item.id === saved.currentId)
            ? saved.currentId : retained.at(-1)?.id || null };
        } else if (validText(saved.text) && typeof saved.title === "string" && saved.title.trim()) {
          // Migrate the previous single article on the next user action, without writing at startup.
          memory = { articles: [{ id: "legacy-article", text: normalizeText(saved.text), title: saved.title.trim(),
            titleSource: "legacy", importedAt: null, lastUsedAt: null }], currentId: "legacy-article" };
        }
      } catch { /* Storage may be disabled; practice remains usable. */ }
      return copy(memory);
    }

    function write(state) {
      const current = state.articles.find(item => item.id === state.currentId);
      // Current article and history share one atomic localStorage write.
      getStorage().setItem(STORAGE_KEY, JSON.stringify({ version: 1,
        text: current ? normalizeText(current.text) : "", title: current?.title || "",
        articles: state.articles, currentId: state.currentId }));
      memory = copy(state);
      return copy(state);
    }

    return {
      read,
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
        return { ...article, shouldGenerateTitle: !existing };
      },
      select(id) {
        const state = read();
        const article = state.articles.find(item => item.id === id);
        if (!article) return null;
        article.lastUsedAt = Math.max(now(), ...state.articles.map(item => (item.lastUsedAt || 0) + 1));
        state.currentId = id;
        write(state);
        return { ...article };
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
        return { ...article };
      },
    };
  }
  return { create, STORAGE_KEY, LIMIT };
});
