// Adapted from Mintlify Astro Starter AssistantSheet, MIT. See assistant/UPSTREAM.md.
import { useRef, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Icon, cn } from '../ui';
import { useAssistant } from '../../hooks/useAssistant';
import { useSwipeToDismiss } from '../../hooks/useSwipeToDismiss';
import { AssistantHistoryList } from './AssistantHistoryList';
import { AssistantTextArea } from './AssistantTextArea';
import { References } from './References';
import { QuickQuestions } from './QuickQuestions';
const CHAT_SHEET_MIN_WIDTH = 380;
const CHAT_SHEET_MAX_WIDTH = 560;

export function AssistantSheet({ snapshot, setVisible, history, registerOperation }) {
  const { visible: isOpen, article, owner } = snapshot;
  const messagesRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const topBoundaryRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const stickToBottom = useRef(true);
  const [width, setWidth] = useState(CHAT_SHEET_MIN_WIDTH);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [shouldFocus, setShouldFocus] = useState(false);
  const isMobile = viewportWidth < 768;
  const isDocked = !isMobile && viewportWidth - width >= 900;
  const chat = useAssistant({ owner, article, history, registerOperation });
  const { input, setInput, messages, turns, isLoading, handleSubmit, onStop, onClear, onRetry } = chat;
  const handleClose = useCallback(() => setVisible(false), [setVisible]);
  const { dragY, isDragging } = useSwipeToDismiss({ enabled: isMobile && isOpen, sheetRef, scrollRef: messagesRef, topBoundaryRef, onDismiss: handleClose });
  useEffect(() => {
    const resize = () => {
      setViewportWidth(window.innerWidth);
      const view = window.visualViewport;
      document.documentElement.style.setProperty('--la-view-height', `${view?.height || window.innerHeight}px`);
      document.documentElement.style.setProperty('--la-view-top', `${view?.offsetTop || 0}px`);
    };
    resize(); window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize); window.visualViewport?.addEventListener('scroll', resize);
    return () => { window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize); };
  }, []);
  useEffect(() => {
    document.body.classList.toggle('assistant-docked', isOpen && isDocked);
    document.documentElement.style.setProperty('--learning-assistant-width', `${width}px`);
    return () => document.body.classList.remove('assistant-docked');
  }, [isOpen, isDocked, width]);
  useEffect(() => {
    if (isOpen) { returnFocus.current = document.activeElement as HTMLElement; setShouldFocus(true); }
    else {
      setShouldFocus(false);
      if (isMobile) document.getElementById('assistantToggle')?.focus({ preventScroll: true });
      else if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    }
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen || isDocked) return;
    const original = document.body.style.overflow;
    const page = document.querySelector('.page-shell') as HTMLElement | null;
    const wasInert = page?.inert;
    if (page) page.inert = true;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; if (page) page.inert = wasInert || false; };
  }, [isOpen, isDocked]);
  useEffect(() => {
    if (stickToBottom.current && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages, isOpen, turns]);
  function onKeyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); handleClose(); }
    if (event.key !== 'Tab' || isDocked) return;
    const nodes = Array.from(sheetRef.current?.querySelectorAll('button:not([disabled]),textarea,a[href],summary') || []) as HTMLElement[];
    if (!nodes.length) return;
    if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
  }
  function send() { stickToBottom.current = true; handleSubmit(); }
  const isMaximized = width >= CHAT_SHEET_MAX_WIDTH;
  return createPortal(<div className={cn('learning-assistant', isMobile && 'la-mobile', isMaximized && 'la-maximized', !isDocked && 'la-overlay', !isOpen && 'la-hidden')}
    aria-hidden={!isOpen} inert={!isOpen ? true : undefined}>
    {!isDocked && <div className="la-backdrop" onClick={handleClose}/>}
    <section id="learningAssistantPanel" ref={sheetRef} className={cn('la-sheet', isDragging && 'la-dragging')}
      role={isDocked ? 'complementary' : 'dialog'} aria-modal={!isDocked && isOpen ? true : undefined}
      aria-labelledby="learningAssistantTitle" onKeyDown={onKeyDown}
      style={{ width: isMobile ? undefined : `${width}px`, transform: isMobile ? `translateY(${dragY}px)` : undefined }}>
      {isMobile && <div className="la-drag-handle" aria-hidden="true"><span/></div>}
      <header className="la-header">
        <div><span className="la-title" id="learningAssistantTitle"><Icon name="gift"/>学习助手</span>
          <p title={article.title}>{article.title}</p></div>
        <div className="la-header-actions">
          <button type="button" onClick={() => setWidth(isMaximized ? CHAT_SHEET_MIN_WIDTH : CHAT_SHEET_MAX_WIDTH)}
            aria-label={isMaximized ? '缩小助手' : isMobile ? '展开助手' : '加宽助手'} title={isMaximized ? '缩小助手' : isMobile ? '展开助手' : '加宽助手'}><Icon name={isMaximized ? 'shrink' : 'expand'}/></button>
          <button type="button" onClick={onClear} aria-label="清空此篇对话" title="清空此篇对话"><Icon name="clear"/></button>
          <button type="button" onClick={handleClose} aria-label="收起学习助手" title="收起学习助手"><Icon name="close"/></button>
        </div>
      </header>
      <div className="la-messages" ref={messagesRef} onScroll={event => {
        const target = event.currentTarget; stickToBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
      }}>
        <div ref={topBoundaryRef} className="la-top-boundary"/>
        {messages.length ? <AssistantHistoryList messages={messages} turns={turns} isLoading={isLoading} onRetry={user => { stickToBottom.current = true; onRetry(user); }}/>
          : <div className="la-empty"><span className="la-empty-icon"><Icon name="gift"/></span><h2>读懂一句，再练好一句</h2>
            <p>选中范文里的单词或句子，添加到助手；也可以直接提问。</p>
            <button type="button" onClick={() => setInput('请帮我梳理这篇范文值得学习的表达和句子结构。')}>这篇范文有哪些值得学的表达？</button>
          </div>}
      </div>
      <footer className="la-footer">
        {chat.notice && <p className="la-notice" role="status">{chat.notice}</p>}
        {chat.storageNotice && <p className="la-storage-notice" role="status">{chat.storageNotice}</p>}
        <References items={chat.references} onRemove={chat.removeReference}/>
        <QuickQuestions target={chat.quickTarget} isLoading={isLoading} onAsk={id => { stickToBottom.current = true; chat.onQuickAsk(id); }}/>
        <AssistantTextArea value={input} onChange={setInput} onSubmit={send} onStop={onStop} isLoading={isLoading}
          shouldFocus={shouldFocus} isMobile={isMobile}/>
        <p className="la-footnote">对话保存在此浏览器 · AI 内容请结合原文判断</p>
      </footer>
    </section>
  </div>, document.body);
}
