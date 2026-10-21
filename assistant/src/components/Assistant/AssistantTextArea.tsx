// Adapted from Mintlify Astro Starter, MIT. See assistant/UPSTREAM.md.
import { useRef, useEffect } from 'react';
import { Icon } from '../ui';
export function AssistantTextArea({ value, onChange, onSubmit, onStop, isLoading, shouldFocus, isMobile = false }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (shouldFocus && !isMobile) textareaRef.current?.focus({ preventScroll: true }); }, [shouldFocus, isMobile]);
  const handleKeyDown = (event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey && !isMobile) {
      event.preventDefault();
      if (!isLoading && value.trim()) onSubmit();
    }
  };
  return <div className="la-composer">
    <textarea ref={textareaRef} id="learningAssistantInput" value={value} maxLength={2000}
      onChange={event => onChange(event.target.value)} onKeyDown={handleKeyDown}
      aria-label="向学习助手提问" placeholder="问问词义、句子结构，或让助手帮你改写…" rows={3}/>
    <button type="button" onClick={isLoading ? onStop : onSubmit} disabled={!isLoading && !value.trim()}
      className="la-send" aria-label={isLoading ? '停止生成' : '发送问题'} title={isLoading ? '停止生成' : '发送问题'}>
      {isLoading ? <span className="la-stop-icon"/> : <Icon name="send"/>}
    </button>
  </div>;
}
