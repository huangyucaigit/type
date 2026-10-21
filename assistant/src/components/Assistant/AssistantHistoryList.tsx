// Message list/loading structure adapted from Mintlify Astro Starter (MIT).
import { ChatMessage } from './ChatMessage';
import { ChatResponse } from './ChatResponse';
export function AssistantHistoryList({ messages, turns, isLoading, onRetry }) {
  const groups = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue;
    groups.push({ user: messages[i], answer: messages[i + 1]?.role === 'assistant' ? messages[i + 1] : null });
  }
  return <div className="la-history">
    {groups.map(({ user, answer }, index) => {
      const turn = turns[user.id] || { status: 'complete' };
      const last = index === groups.length - 1;
      const failed = ['failed', 'interrupted'].includes(turn.status);
      return <section className="la-turn" key={user.id} aria-label={`第 ${index + 1} 次问答`}>
        <ChatMessage message={user}/>
        {answer && <ChatResponse message={answer}/>}
        {last && isLoading && !answer?.parts?.some(p => p.type === 'text' && p.text) && <p className="la-loading" role="status">正在思考你的问题<span>…</span></p>}
        {failed && <p className="la-turn-error" role="status">{turn.error || '上次回答中断，已保留你的问题。'}</p>}
        {turn.status === 'stopped' && <p className="la-turn-status">已停止生成，已收到的内容已保留。</p>}
        {last && !isLoading && <button className="la-text-action" type="button" onClick={() => onRetry(user)}>{failed ? '重试' : '重新生成'}</button>}
      </section>;
    })}
  </div>;
}
