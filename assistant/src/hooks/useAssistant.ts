// Adapted from Mintlify Astro Starter, MIT. See assistant/UPSTREAM.md.
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestMessages } from '../conversation.mjs';
import { QUICK_QUESTIONS, questionTarget } from '../quick-questions.mjs';

function safeError(error) {
  const value = error?.message;
  return typeof value === 'string' && /[\u4e00-\u9fff]/u.test(value) && value.length <= 300
    ? value : '连接中断，已保留你的问题，请重试。';
}

export function useAssistant({ owner, article, history, registerOperation }) {
  const initial = useRef(history.read(owner, article.id));
  const [input, setInput] = useState(initial.current.draft);
  const [references, setReferences] = useState(initial.current.references);
  const [quickTargetId, setQuickTargetId] = useState(initial.current.quickTargetId || '');
  const [turns, setTurns] = useState(initial.current.turns);
  const [notice, setNotice] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const [preparing, setPreparing] = useState(false);
  const live = useRef(true), lock = useRef(false), currentTurn = useRef(null);
  const latest = useRef({ article, turns });
  latest.current.article = article;
  latest.current.turns = turns;
  const mark = useCallback((status, error = '') => {
    if (!live.current || !currentTurn.current) return;
    const turnId = currentTurn.current;
    setTurns(previous => ({ ...previous, [turnId]: { status, error } }));
  }, []);

  const chat = useChat({
    id: `${owner}:${article.id}`,
    messages: initial.current.messages,
    transport: new DefaultChatTransport({
      api: '/api/assistant', credentials: 'same-origin',
      prepareSendMessagesRequest: ({ messages }) => ({ body: {
        owner, article: { title: latest.current.article.title, text: latest.current.article.text.slice(0, 12000) },
        messages: requestMessages(messages, latest.current.turns),
      } }),
      fetch: async (url, options) => {
        let response;
        try { response = await fetch(url, options); }
        catch (error) { if (options?.signal?.aborted) throw error; throw new Error('连接中断，已保留你的问题，请重试。'); }
        if (!response.ok) {
          let data;
          try { data = await response.json(); } catch { /* Use a safe local fallback. */ }
          if (['ACCESS_EXPIRED', 'SESSION_INVALID', 'GUEST_REQUIRED', 'ASSISTANT_OWNER_CHANGED'].includes(data?.code)) void window.ZijianAuth?.refresh();
          throw new Error(safeError({ message: data?.error }));
        }
        return response;
      },
    }),
    onError: error => { mark('failed', safeError(error)); lock.current = false; },
    onFinish: ({ isAbort, isError, isDisconnect }) => {
      if (isAbort) mark('stopped');
      else if (isError || isDisconnect) {
        if (live.current && currentTurn.current) {
          const turnId = currentTurn.current;
          setTurns(previous => ({ ...previous, [turnId]: { status: 'failed', error: previous[turnId]?.error || '回答中断，已保留你的问题，请重试。' } }));
        }
      }
      else mark('complete');
      lock.current = false;
    },
  });
  const { messages, status, sendMessage, setMessages, clearError, stop } = chat;
  const isLoading = preparing || status === 'submitted' || status === 'streaming';
  const snapshot = useRef(null);
  snapshot.current = { messages, turns, draft: input, references, quickTargetId };
  const flush = useCallback(() => {
    if (!snapshot.current) return;
    const result = history.write(owner, article.id, snapshot.current);
    if (live.current) setStorageNotice(result.saved ? (result.trimmed ? '较早的对话已自动清理，保留最近学习记录。' : '')
      : result.deleted ? '这篇范文已从最近范文移除，对话仅在本次页面中保留。' : '浏览器暂时无法保存对话，本次仍可使用；刷新后可能丢失。');
  }, [owner, article.id, history]);
  useEffect(() => { const timer = setTimeout(flush, 250); return () => clearTimeout(timer); }, [messages, turns, input, references, quickTargetId, flush]);
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    const hide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      live.current = false;
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hide);
      stop(); flush();
    };
  }, [flush, stop]);

  async function send(text, refs, retryUser = null, quick = false) {
    if (!text.trim() || text.length > 2000 || lock.current || isLoading) return;
    lock.current = true; setPreparing(true); setNotice('');
    try {
      await window.ZijianAuth?.ready;
      if (window.ZijianAuth && !await window.ZijianAuth.ensureAccess()) {
        if (live.current) setNotice('当前没有可用时长。你的问题和引用已保留，可通过页面右上角处理账号与时长后再发送。');
        return;
      }
      if (!live.current) return;
      clearError();
      let user = retryUser;
      if (user) {
        const index = messages.findIndex(message => message.id === user.id);
        if (index < 0) return;
        setMessages(messages.slice(0, index));
      } else {
        user = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: text.trim() }], metadata: { references: refs } };
        if (quick) setReferences(previous => previous.filter(ref => ref.id !== refs[0].id));
        else { setInput(''); setReferences([]); }
        if (refs.length) setQuickTargetId(refs.at(-1).id);
      }
      currentTurn.current = user.id;
      setTurns(previous => ({ ...previous, [user.id]: { status: 'submitted', error: '' } }));
      // prepareSendMessagesRequest reads the synchronous snapshot before React commits.
      latest.current.turns = { ...latest.current.turns, [user.id]: { status: 'submitted' } };
      await sendMessage(user);
    } catch (error) { if (live.current) { mark('failed', safeError(error)); setNotice(safeError(error)); } }
    finally { lock.current = false; if (live.current) setPreparing(false); }
  }

  function acceptSelection(operation) {
    const ref = operation.selection;
    if (ref.text.length > 2000) { setNotice('一次最多添加 2,000 个字符，请缩小选区。'); return; }
    setReferences(previous => {
      if (previous.some(item => item.id === ref.id)) { setQuickTargetId(ref.id); setNotice('这段内容已经添加，可继续快捷学习。'); return previous; }
      if (previous.length >= 5 || JSON.stringify([...previous, ref]).length > 16000) { setNotice('引用已达上限，请先移除部分内容。'); return previous; }
      setQuickTargetId(ref.id);
      setNotice(''); return [...previous, ref];
    });
  }
  const operationRef = useRef(acceptSelection); operationRef.current = acceptSelection;
  useEffect(() => registerOperation(operation => operationRef.current(operation)), [registerOperation]);

  function onClear() {
    if ((messages.length || input || references.length) && !window.confirm('清空这篇范文的学习对话和待发送内容？范文与练习进度会保留。')) return;
    stop(); currentTurn.current = null; lock.current = false;
    setMessages([]); setTurns({}); setInput(''); setReferences([]); setQuickTargetId(''); clearError(); setNotice('');
  }
  function onStop() { mark('stopped'); void stop(); lock.current = false; }
  function onRetry(user) { void send(user.parts.filter(p => p.type === 'text').map(p => p.text).join(''), user.metadata?.references || [], user); }
  const quickTarget = questionTarget(references, messages, quickTargetId);
  function onQuickAsk(id) {
    const action = QUICK_QUESTIONS.find(item => item.id === id);
    if (!action || !quickTarget || lock.current || isLoading) return;
    void send(action.prompt, [quickTarget.reference], null, true);
  }
  return { input, setInput, references, removeReference: id => setReferences(previous => previous.filter(item => item.id !== id)),
    messages, status, turns, notice, storageNotice, isLoading, onClear, onStop, onRetry, quickTarget, onQuickAsk,
    handleSubmit: () => void send(input, references) };
}
