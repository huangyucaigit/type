import { useEffect, useId, useState } from 'react';
import { QUICK_QUESTIONS, recommendedQuestions } from '../../quick-questions.mjs';

export function QuickQuestions({ target, isLoading, onAsk }) {
  const [expanded, setExpanded] = useState(false);
  const moreId = useId();
  useEffect(() => setExpanded(false), [target?.reference.id]);
  if (!target) return <p className="la-quick-empty">选中范文并添加到助手，即可快捷学习。</p>;
  const suggested = recommendedQuestions(target.reference);
  const more = QUICK_QUESTIONS.filter(item => !suggested.some(choice => choice.id === item.id));
  function ask(item) { setExpanded(false); onAsk(item.id); }
  const button = item => <button type="button" key={item.id} onClick={() => ask(item)} disabled={isLoading}>{item.label}</button>;
  return <div className="la-quick" aria-label="快捷提问">
    <p className="la-quick-target" title={target.reference.text}><span>{target.label}</span><span lang="en">{target.reference.text}</span></p>
    <div className="la-quick-buttons">
      {suggested.map(button)}
      <button type="button" className="la-quick-more-toggle" aria-expanded={expanded} aria-controls={moreId}
        disabled={isLoading} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '更多'}</button>
    </div>
    {expanded && <div className="la-quick-extra" id={moreId} aria-label="更多快捷提问">{more.map(button)}</div>}
  </div>;
}
