import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AssistantSheet } from './components/Assistant/AssistantSheet';

export function mountAssistant(element, bridge) {
  const root = createRoot(element);
  let snapshot = bridge.getState(), handler = null;
  const queued = [];
  function registerOperation(callback) {
    handler = callback;
    for (const operation of queued.splice(0)) {
      if (operation.owner === snapshot.owner && operation.articleId === snapshot.article?.id) callback(operation);
    }
    return () => { if (handler === callback) handler = null; };
  }
  function update(value) {
    snapshot = value;
    flushSync(() => root.render(snapshot.article ? <AssistantSheet key={`${snapshot.owner}:${snapshot.article.id}`}
      snapshot={snapshot} setVisible={bridge.setVisible} history={bridge.history} registerOperation={registerOperation}/> : null));
  }
  update(snapshot);
  return { update, dispatch(operation) {
    if (operation.owner !== snapshot.owner || operation.articleId !== snapshot.article?.id) return;
    if (handler) handler(operation); else queued.push(operation);
  } };
}
