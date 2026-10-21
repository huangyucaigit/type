export function References({ items = [], onRemove }) {
  if (!items.length) return null;
  return <div className="la-references" aria-label={onRemove ? '待发送引用' : '本次引用'}>
    {items.map((item, index) => <div className="la-reference" key={item.id}>
      <details><summary title={item.text}><span>引用 {index + 1}</span> {item.text}</summary>
        <blockquote lang="en">{item.text}</blockquote>
        {item.sentence && item.sentence !== item.text && <p lang="en">所在句：{item.sentence}</p>}
      </details>
      {onRemove && <button type="button" onClick={() => onRemove(item.id)} aria-label={`移除引用 ${index + 1}`} title="移除引用">×</button>}
    </div>)}
  </div>;
}
