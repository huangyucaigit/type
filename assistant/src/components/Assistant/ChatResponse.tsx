// Markdown rendering and copy affordance adapted from Mintlify Astro Starter (MIT).
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../ui';
import { messageText } from '../../conversation.mjs';
export function ChatResponse({ message }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const content = messageText(message);
  async function copy() {
    try { await navigator.clipboard.writeText(content); setCopied(true); setCopyError(false); setTimeout(() => setCopied(false), 2000); }
    catch { setCopyError(true); }
  }
  return <div className="la-response">
    <div className="la-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
        a: ({ href, children }) => {
          const safe = typeof href === 'string' && /^https:\/\//i.test(href);
          return safe ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
        },
        img: ({ alt }) => <span>{alt || '[图片]'}</span>,
        table: ({ children }) => <div className="la-table-scroll"><table>{children}</table></div>,
        p: ({ children }) => <p>{children}</p>,
      }}>{content}</ReactMarkdown>
    </div>
    {content && <div className="la-copy-row"><button type="button" onClick={copy} aria-label="复制回答" title="复制回答">
      <Icon name={copied ? 'check' : 'copy'}/><span>{copied ? '已复制' : '复制'}</span>
    </button>{copyError && <span role="status">复制失败，请选中文字复制。</span>}</div>}
  </div>;
}
