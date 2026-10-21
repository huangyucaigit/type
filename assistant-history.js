(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AssistantHistory = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const PREFIX = 'mars-ielts-typing:assistant:v1:';
  const clean = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const id = value => clean(value, 160).replace(/[^a-zA-Z0-9:_-]/g, '');
  function references(value) {
    if (!Array.isArray(value)) return [];
    const result = [];
    for (const item of value.slice(0, 5)) {
      if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
      const ref = { id: id(item.id) || `ref-${result.length}`, text: clean(item.text.trim(), 2000),
        sentence: clean(item.sentence, 1200), paragraph: clean(item.paragraph, 3000) };
      if (!result.some(previous => previous.id === ref.id)) result.push(ref);
    }
    while (result.length && JSON.stringify(result).length > 16000) result.pop();
    return result;
  }
  function normalize(value = {}) {
    const messages = [];
    for (const item of Array.isArray(value.messages) ? value.messages : []) {
      if (!item || !['user', 'assistant'].includes(item.role) || !id(item.id)) continue;
      const content = clean(item.parts?.filter(p => p?.type === 'text').map(p => p.text).join(''), item.role === 'user' ? 2000 : 32000);
      if (!content.trim()) continue;
      messages.push({ id: id(item.id), role: item.role, parts: [{ type: 'text', text: content }],
        ...(item.role === 'user' ? { metadata: { references: references(item.metadata?.references) } } : {}) });
    }
    // Retain complete turns when trimming. Limits bound browser storage, not the model context window.
    let trimmed = false;
    while (messages.length > 120 || JSON.stringify(messages).length > 250000) {
      messages.shift();
      while (messages.length && messages[0].role !== 'user') messages.shift();
      trimmed = true;
    }
    const turns = {};
    for (const message of messages.filter(m => m.role === 'user')) {
      const saved = value.turns?.[message.id];
      if (!saved) continue;
      const status = ['submitted', 'streaming'].includes(saved.status) ? 'interrupted'
        : ['complete', 'failed', 'stopped', 'interrupted'].includes(saved.status) ? saved.status : 'complete';
      turns[message.id] = { status, error: clean(saved.error, 300) };
    }
    const pendingReferences = references(value.references);
    const targetId = id(value.quickTargetId);
    const quickTargetId = [...pendingReferences, ...messages.flatMap(message => message.metadata?.references || [])]
      .some(ref => ref.id === targetId) ? targetId : '';
    return { version: 1, messages, turns, draft: clean(value.draft, 2000), references: pendingReferences,
      quickTargetId, trimmed: trimmed || !!value.trimmed };
  }
  function create({ storage = () => window.localStorage, allowed = () => true } = {}) {
    const key = (owner, articleId) => `${PREFIX}${encodeURIComponent(owner)}:${encodeURIComponent(articleId)}`;
    return {
      read(owner, articleId) {
        try { return normalize(JSON.parse(storage().getItem(key(owner, articleId)) || '{}')); }
        catch { return normalize(); }
      },
      write(owner, articleId, value) {
        if (!allowed(articleId)) return { saved: false, deleted: true };
        const normalized = normalize(value);
        // Live generation status must survive until refresh, where it becomes "interrupted".
        for (const [turnId, turn] of Object.entries(value.turns || {})) {
          if (normalized.turns[turnId] && ['submitted', 'streaming'].includes(turn.status)) normalized.turns[turnId].status = turn.status;
        }
        try { storage().setItem(key(owner, articleId), JSON.stringify(normalized)); return { saved: true, trimmed: normalized.trimmed }; }
        catch { return { saved: false, deleted: false }; }
      },
      remove(owner, articleId) { storage().removeItem(key(owner, articleId)); },
      prune(retainedIds) {
        const keep = new Set(['sample', ...retainedIds]);
        try {
          const target = storage(), remove = [];
          for (let i = 0; i < target.length; i++) {
            const name = target.key(i);
            if (!name?.startsWith(PREFIX)) continue;
            const articleId = decodeURIComponent(name.slice(PREFIX.length).split(':').at(-1));
            if (!keep.has(articleId)) remove.push(name);
          }
          remove.forEach(name => target.removeItem(name));
          return true;
        } catch { return false; }
      },
      has(owner, articleId) {
        try { const value = normalize(JSON.parse(storage().getItem(key(owner, articleId)) || '{}'));
          return Boolean(value.messages.length || value.draft.trim() || value.references.length); } catch { return false; }
      },
    };
  }
  return { create, normalize, references, PREFIX };
});
