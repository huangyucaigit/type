(() => {
  'use strict';
  let article = null, visible = false, client = null, loading = null;
  const pending = [];
  let retainedIds = [];
  const history = window.AssistantHistory.create({ allowed: id => id === 'sample' || retainedIds.includes(id) });
  const owner = () => window.ZijianAuth?.getState()?.user?.id ? `account:${window.ZijianAuth.getState().user.id}` : 'guest';
  const state = () => ({ article, visible, owner: owner(), retainedIds });
  function update() {
    const button = document.getElementById('assistantToggle');
    button?.setAttribute('aria-expanded', String(visible));
    client?.update(state());
  }
  function setVisible(value) { visible = value; update(); if (value) void load(); }
  async function load() {
    if (client || loading) return loading;
    loading = (async () => {
      const button = document.getElementById('assistantToggle');
      button?.setAttribute('aria-busy', 'true');
      try {
        await window.ZijianAuth?.ready;
        let css = document.getElementById('assistantStyles');
        const stylesReady = css?.sheet ? Promise.resolve() : new Promise((resolve, reject) => {
          const isNew = !css;
          css ||= document.createElement('link'); css.id = 'assistantStyles'; css.rel = 'stylesheet'; css.href = '/learning-assistant.css';
          css.addEventListener('load', resolve, { once: true });
          css.addEventListener('error', () => { css.remove(); reject(new Error('Styles unavailable')); }, { once: true });
          if (isNew) document.head.append(css);
        });
        const [module] = await Promise.all([import('/learning-assistant.js'), stylesReady]);
        client = module.mountAssistant(document.getElementById('learningAssistantRoot'), { getState: state, setVisible, history });
        update();
        for (const operation of pending.splice(0)) {
          if (operation.owner === owner() && operation.articleId === article?.id) client.dispatch(operation);
        }
      } catch {
        pending.length = 0;
        const root = document.getElementById('learningAssistantRoot');
        root.replaceChildren();
        const notice = document.createElement('div'); notice.className = 'assistant-load-error'; notice.setAttribute('role', 'alert');
        notice.textContent = '助手加载失败，请重试。';
        const retry = document.createElement('button'); retry.className = 'button button-secondary'; retry.textContent = '重试';
        retry.onclick = () => { notice.remove(); loading = null; void load(); };
        const close = document.createElement('button'); close.className = 'button button-secondary'; close.textContent = '关闭';
        close.onclick = () => { notice.remove(); setVisible(false); };
        notice.append(retry, close); root.append(notice);
      } finally { button?.removeAttribute('aria-busy'); loading = null; }
    })();
    return loading;
  }
  function selection(selected) {
    if (!article || !selected?.text?.trim()) return;
    const operation = { type: 'selection', selection: { text: selected.text.trim(),
      sentence: selected.context?.sentence || '', paragraph: selected.context?.paragraph || '',
      id: `selection-${selected.start ?? 'x'}-${selected.end ?? 'x'}-${hash(selected.text + JSON.stringify(selected.context || {}))}` },
      owner: owner(), articleId: article.id };
    if (client) client.dispatch(operation); else pending.push(operation);
    setVisible(true);
  }
  function hash(text) { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return (h >>> 0).toString(16); }
  function refreshRetained() {
    retainedIds = window.ArticleHistory?.create({ getStorage: () => window.localStorage,
      normalizeText: value => String(value || '').trim() }).read().articles.map(item => item.id) || [];
    history.prune(retainedIds);
    if (article) article = { ...article, persistable: article.id === 'sample' || retainedIds.includes(article.id) };
    update();
  }
  window.LearningAssistant = Object.freeze({
    configureArticle(value) { article = { ...value }; refreshRetained(); },
    addSelection: selected => selection(selected),
    toggle: () => setVisible(!visible),
    hasHistory: id => history.has(owner(), id),
    getState: state,
  });
  window.addEventListener('authchange', update);
  window.addEventListener('articlehistorychange', refreshRetained);
  window.addEventListener('storage', event => { if (event.key === window.ArticleHistory?.STORAGE_KEY) refreshRetained(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && visible && !document.querySelector('dialog[open]')) {
      event.preventDefault(); setVisible(false); return;
    }
    if (event.isComposing || event.repeat || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'i'
      || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    const selected = window.LearningAssistantSelection?.();
    if (selected) selection(selected); else setVisible(!visible);
  });
  document.getElementById('assistantToggle')?.addEventListener('click', () => setVisible(!visible));
})();
