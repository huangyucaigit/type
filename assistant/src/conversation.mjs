export const messageText = message => (message?.parts || []).filter(p => p.type === 'text').map(p => p.text).join('');

export function requestMessages(messages, turns) {
  const pairs = [];
  for (let i = 0; i < messages.length; i++) {
    const user = messages[i];
    if (user.role !== 'user') continue;
    const answer = messages[i + 1]?.role === 'assistant' ? messages[i + 1] : null;
    if (i === messages.length - 1 || (answer && i + 1 === messages.length - 1 && turns[user.id]?.status === 'submitted')) {
      pairs.push([user]);
    } else if (answer && (!turns[user.id] || turns[user.id].status === 'complete')) {
      pairs.push([user, { ...answer, parts: [{ type: 'text', text: messageText(answer).slice(0, 8000) }] }]);
    }
  }
  const latest = pairs.slice(-7);
  while (latest.length > 1 && JSON.stringify(latest).length > 65000) latest.shift();
  return latest.flat().map(({ id, role, parts, metadata }) => ({ id, role,
    parts: [{ type: 'text', text: messageText({ parts }) }], ...(role === 'user' ? { metadata } : {}) }));
}
