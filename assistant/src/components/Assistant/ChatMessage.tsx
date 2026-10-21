// Adapted from Mintlify Astro Starter, MIT. See assistant/UPSTREAM.md.
import * as React from 'react';
import { cn } from '../ui';
import { References } from './References';
import { QUICK_QUESTIONS } from '../../quick-questions.mjs';
export const ChatMessage = React.forwardRef<HTMLDivElement, any>(({ className, message, ...props }, ref) => {
  const content = message.parts.filter(part => part.type === 'text').map(part => part.text).join('');
  const quick = QUICK_QUESTIONS.find(item => item.prompt === content);
  return <div className="la-user-wrap">
    <div ref={ref} className={cn('la-user-message', className)} {...props}>
      <References items={message.metadata?.references}/>
      <div className="la-message-text">{quick?.question || content}</div>
    </div>
  </div>;
});
ChatMessage.displayName = 'ChatMessage';
