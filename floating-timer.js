(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.document) api.mount(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STORAGE_KEY = 'mars-ielts-typing:timer-collapsed:v1';
  const validMode = mode => mode === 'realtime' || mode === 'sentence';

  // Presentation only: clocks stay owned by their existing practice controllers.
  function createController({ storage, onChange } = {}) {
    let collapsed = true, mode = 'realtime';
    try { collapsed = storage?.getItem(STORAGE_KEY) !== '0'; } catch { /* Keep working without storage. */ }
    const readings = {
      realtime: { value: '00:00', running: false, started: false },
      sentence: { value: '00:00', running: false, started: false },
    };
    const snapshot = () => Object.freeze({ collapsed, mode, ...readings[mode] });
    const publish = () => { const state = snapshot(); onChange?.(state); return state; };
    const controller = {
      snapshot,
      update(reading = {}) {
        if (!validMode(reading.mode) || typeof reading.value !== 'string' || !/^\d+:\d{2}(?::\d{2})?$/u.test(reading.value)) return snapshot();
        const previous = readings[reading.mode];
        const next = { value: reading.value, running: reading.running === true,
          started: reading.started === true || reading.running === true };
        readings[reading.mode] = next;
        return reading.mode === mode && (previous.value !== next.value || previous.running !== next.running || previous.started !== next.started)
          ? publish() : snapshot();
      },
      setMode(next) {
        if (!validMode(next) || mode === next) return snapshot();
        mode = next;
        return publish();
      },
      setCollapsed(next, persist = true) {
        if (typeof next !== 'boolean' || collapsed === next) return snapshot();
        collapsed = next;
        if (persist) {
          try { storage?.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* Session choice still applies. */ }
        }
        return publish();
      },
    };
    publish();
    return controller;
  }

  function mount(window) {
    const document = window.document;
    const $ = id => document.getElementById(id);
    const timer = $('floatingTimer'), panel = $('timerExpanded');
    const collapse = $('timerCollapse'), expand = $('timerExpand');
    if (!timer || !panel || !collapse || !expand) return;
    let storage;
    try { storage = window.localStorage; } catch { /* A disabled storage preference must not break practice. */ }
    const controller = createController({ storage, onChange(state) {
      timer.setAttribute('data-collapsed', String(state.collapsed));
      panel.hidden = state.collapsed;
      panel.inert = state.collapsed;
      expand.hidden = !state.collapsed;
      collapse.setAttribute('aria-expanded', String(!state.collapsed));
      expand.setAttribute('aria-expanded', String(!state.collapsed));
      const value = $('timerCompactValue');
      if (value.textContent !== state.value) value.textContent = state.value;
      value.hidden = !state.started;
      $('timerCompactIcon').hidden = state.started;
      $('timerCompactDot').hidden = !state.started;
      expand.setAttribute('data-running', String(state.running));
      const mode = state.mode === 'sentence' ? '分句' : '全文';
      const status = state.running ? '计时中' : state.started ? '已暂停' : '未开始';
      expand.setAttribute('aria-label', `展开${mode}模式秒表，${status}${state.started ? `，${state.value}` : ''}`);
      expand.title = `${mode}模式 · ${status}${state.started ? ` ${state.value}` : ''}，点击展开`;
    } });
    collapse.addEventListener('click', () => { controller.setCollapsed(true); expand.focus({ preventScroll: true }); });
    expand.addEventListener('click', () => { controller.setCollapsed(false); collapse.focus({ preventScroll: true }); });
    window.addEventListener('storage', event => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      const focusWithin = timer.contains?.(document.activeElement);
      const state = controller.setCollapsed(event.newValue !== '0', false);
      if (focusWithin) (state.collapsed ? expand : collapse).focus({ preventScroll: true });
    });
    window.ZijianTimer = Object.freeze({ update: controller.update, setMode: controller.setMode,
      isCollapsed: () => controller.snapshot().collapsed });
  }
  return { STORAGE_KEY, createController, mount };
});
