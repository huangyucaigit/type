(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.document) api.mount(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PLAN_IDS = ['monthly', 'quarterly', 'yearly'];
  const userId = state => state?.user?.id == null ? null : String(state.user.id);
  const amount = fen => Number.isInteger(fen) && fen >= 0 ? (fen / 100).toFixed(2) : '—';
  const date = value => Number.isFinite(Number(value)) && Number(value) > 0
    ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—';
  const paid = order => order?.status === 'PAID' && !!order.grantedAt;
  const confirmedPayment = order => order?.paymentStatus === 'PAID' || order?.attemptStatus === 'SUCCEEDED' || order?.status === 'PAID';
  const ended = order => ['CLOSED', 'REJECTED'].includes(order?.attemptStatus) && !confirmedPayment(order);
  const expired = (order, now) => !confirmedPayment(order) && (order?.attemptStatus === 'EXPIRED'
    || (Number(order?.expiresAt) > 0 && Number(order.expiresAt) <= now));

  function orderView(order, now = Date.now()) {
    if (!order) return { title: '正在准备订单', description: '订单金额与时长由服务器确认。', phase: 'loading', canPay: false };
    if (paid(order)) return { title: '时长已到账', description: `已增加 ${order.days} 天练习时长，有效期至 ${date(order.entitlementEndsAt)}。`, phase: 'paid', canPay: false };
    if (confirmedPayment(order)) return { title: '支付已确认，时长处理中', description: '正在确认到账结果，请稍候。无需重复支付，可刷新状态或稍后从订单记录查看。', phase: 'processing', canPay: false };
    if (order.attemptStatus === 'CLOSING') return { title: '正在确认订单关闭', description: '请等待服务器确认。在结果确定之前，请勿重复创建订单。', phase: 'closing', canPay: false };
    if (ended(order)) return { title: order.attemptStatus === 'REJECTED' ? '支付未完成' : '订单已取消', description: '如需继续，可重新获取付款码。', phase: 'closed', canPay: false };
    if (expired(order, now)) return { title: '付款码已过期', description: '先确认关闭旧付款码，再重新获取，避免重复支付。', phase: 'expired', canPay: false };
    if (['CREATING', 'UNKNOWN'].includes(order.attemptStatus) || !order.codeUrl) return { title: '正在确认付款码', description: '订单已保留，可刷新状态或重试。不会重复创建购买订单。', phase: 'pending', canPay: false };
    return { title: '扫码购买练习时长', description: '付款完成后自动更新时长。关闭窗口后，可从订单记录继续。', phase: 'unpaid', canPay: true };
  }

  function createController(options) {
    let active = false, revision = 0, currentUser = userId(options.getState()), operation = null;
    let billing = null, plans = [], order = null, orders = [], intent = null, serverOffset = 0;
    let screen = 'checkout', planId = null, error = '', busy = false;
    const now = () => (options.now?.() ?? Date.now()) + serverOffset;
    const snapshot = () => ({ active, screen, billing, plans, order, orders, planId, error, busy, now: now() });
    const emit = () => options.onChange?.(snapshot());
    const storageKey = id => `zijian-billing-pending:${id}`;
    const readIntent = id => {
      try {
        const value = JSON.parse(options.storage?.getItem(storageKey(id)) || 'null');
        if (value && PLAN_IDS.includes(value.planId) && typeof value.requestId === 'string'
          && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.requestId)
          && (!value.orderNo || /^[A-Za-z0-9_-]{1,100}$/.test(value.orderNo))) return value;
      } catch { /* Storage is an optional recovery aid. */ }
      return null;
    };
    function persist() {
      if (!currentUser) return;
      try {
        if (intent) options.storage?.setItem(storageKey(currentUser), JSON.stringify(intent));
        else options.storage?.removeItem(storageKey(currentUser));
      } catch { /* The server still owns and deduplicates orders. */ }
    }
    function accept(data) {
      if (data?.billing) billing = data.billing;
      if (Array.isArray(data?.plans)) plans = data.plans;
      else if (Array.isArray(data?.billing?.plans)) plans = data.billing.plans;
      const serverTime = typeof data?.serverTime === 'number' ? data.serverTime : Date.parse(data?.serverTime || '');
      if (Number.isFinite(serverTime)) serverOffset = serverTime - (options.now?.() ?? Date.now());
      if (data?.order) {
        order = data.order;
        if (intent) { intent.orderNo = order.orderNo; persist(); }
        if (paid(order) || ended(order)) { intent = null; persist(); }
      }
      if (Array.isArray(data?.orders)) orders = data.orders;
    }
    async function run(action, { quiet = false } = {}) {
      if (operation) return operation;
      const ticket = revision, expectedUser = currentUser;
      const isCurrent = () => ticket === revision && expectedUser === userId(options.getState());
      busy = true;
      if (!quiet) error = '';
      emit();
      const pending = Promise.resolve().then(() => action(isCurrent)).then(data => {
        if (!isCurrent()) return null;
        accept(data); error = ''; return data;
      }).catch(cause => {
        if (isCurrent()) error = cause?.message || '订单暂时无法更新，请稍后重试。';
        return null;
      }).finally(() => {
        if (operation === pending) operation = null;
        if (isCurrent()) { busy = false; emit(); }
      });
      operation = pending;
      return pending;
    }
    async function metadata() {
      try { const data = await options.request('/api/billing/plans'); accept(data); emit(); return data; }
      catch (cause) { if (!billing) { billing = { enabled: false, mode: 'disabled' }; error = cause?.message || '套餐暂时无法加载。'; emit(); } return null; }
    }
    async function open(nextPlan) {
      await options.ready?.();
      if (!userId(options.getState())) return false;
      accountChanged();
      active = true; screen = 'checkout'; planId = PLAN_IDS.includes(nextPlan) ? nextPlan : 'monthly';
      order = null; orders = []; error = ''; revision++; operation = null; busy = false; emit();
      const expectedUser = currentUser, ticket = revision;
      return run(async isCurrent => {
        const data = await options.request('/api/billing/plans');
        if (data?.billing?.enabled === false || data?.billing?.available === false) return data;
        if (!active || ticket !== revision || expectedUser !== currentUser || !isCurrent()) return null;
        intent = readIntent(currentUser);
        if (intent?.orderNo) return options.request(`/api/billing/orders/${encodeURIComponent(intent.orderNo)}`);
        if (!intent || intent.planId !== planId) {
          intent = { planId, requestId: options.uuid() }; persist();
        }
        try { return await options.request('/api/billing/orders', { planId: intent.planId, requestId: intent.requestId }); }
        catch (cause) {
          if (cause?.code !== 'ACTIVE_ORDER_EXISTS' || !isCurrent()) throw cause;
          const history = await options.request('/api/billing/orders');
          if (!isCurrent()) return null;
          const existing = history?.orders?.find(item => !paid(item) && !ended(item));
          if (!existing) throw cause;
          return options.request(`/api/billing/orders/${encodeURIComponent(existing.orderNo)}`);
        }
      });
    }
    async function openHistory() {
      await options.ready?.();
      if (!userId(options.getState())) return false;
      accountChanged(); active = true; screen = 'history'; order = null; error = ''; revision++; operation = null; busy = false; emit();
      return run(() => options.request('/api/billing/orders'));
    }
    function resume(nextOrder) {
      if (!currentUser || !nextOrder?.orderNo || !active) return Promise.resolve(null);
      screen = 'checkout'; order = nextOrder; planId = nextOrder.planId; error = ''; emit();
      return run(() => options.request(`/api/billing/orders/${encodeURIComponent(nextOrder.orderNo)}`));
    }
    function update(action, quiet = false) {
      if (!active || !currentUser || !order?.orderNo) return Promise.resolve(null);
      const suffix = action ? `/${action}` : '', orderNo = order.orderNo;
      return run(() => options.request(`/api/billing/orders/${encodeURIComponent(orderNo)}${suffix}`, action ? {} : undefined), { quiet });
    }
    function retry() {
      if (order?.orderNo) return update('retry');
      if (!active || !currentUser) return Promise.resolve(null);
      if (!intent) return open(planId);
      return run(() => options.request('/api/billing/orders', { planId: intent.planId, requestId: intent.requestId }));
    }
    function accountChanged() {
      const nextUser = userId(options.getState());
      if (nextUser === currentUser) return false;
      currentUser = nextUser; revision++; operation = null; active = false; busy = false;
      order = null; orders = []; intent = null; error = ''; emit(); return true;
    }
    return { snapshot, metadata, open, openHistory, resume, retry, accountChanged,
      sync: () => update('sync'), cancel: () => update('close'), poll: () => update('', true),
      mockComplete: () => billing?.mode === 'mock' && orderView(order, now()).canPay ? update('mock-complete') : Promise.resolve(null),
      close() { active = false; revision++; operation = null; busy = false; emit(); },
    };
  }

  function requestUuid(crypto) {
    if (crypto?.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function mount(window) {
    const document = window.document, $ = id => document.getElementById(id);
    const dialog = $('billingDialog'), content = $('billingContent');
    if (!dialog || !content) return;
    const auth = () => window.ZijianAuth;
    let pendingLogin = null, renderKey = '', qrCache = null, lastPoll = 0, refreshedGrant = '';
    const storage = (() => { try { return window.localStorage; } catch { return null; } })();
    const node = (tag, text, className) => {
      const element = document.createElement(tag);
      if (text != null) element.textContent = text;
      if (className) element.className = className;
      return element;
    };
    function button(text, action, { primary = false, disabled = false, id = '' } = {}) {
      const element = node('button', text, `button ${primary ? 'button-primary' : 'button-secondary'}`);
      element.type = 'button'; element.disabled = disabled;
      if (id) element.id = id;
      element.addEventListener('click', action);
      return element;
    }
    const controller = createController({
      getState: () => auth()?.getState?.() || {}, ready: () => auth()?.ready,
      request: (path, body) => auth().billingRequest(path, body), storage,
      uuid: () => requestUuid(window.crypto),
      onChange: render,
    });
    function qrImage(codeUrl) {
      if (qrCache?.url === codeUrl) return qrCache.image.cloneNode();
      if (typeof window.qrcode !== 'function') throw new Error('二维码组件暂时不可用，请重新打开订单。');
      const qr = window.qrcode(0, 'M'); qr.addData(codeUrl, 'Byte'); qr.make();
      const count = qr.getModuleCount(), quiet = 4, cell = Math.max(3, Math.ceil(220 / (count + quiet * 2)));
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = (count + quiet * 2) * cell;
      const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#20372a';
      for (let row = 0; row < count; row++) for (let column = 0; column < count; column++) {
        if (qr.isDark(row, column)) context.fillRect((column + quiet) * cell, (row + quiet) * cell, cell, cell);
      }
      const image = node('img', null, 'billing-qr'); image.src = canvas.toDataURL('image/png');
      image.alt = '本订单付款二维码'; image.width = image.height = 220;
      qrCache = { url: codeUrl, image }; return image.cloneNode();
    }
    function details(order) {
      const list = node('dl', null, 'billing-details');
      for (const [label, value] of [['套餐', `${order.planName || order.planId} · ${order.days} 天`], ['金额', `¥${amount(order.amountFen)}`],
        ['订单号', order.orderNo], ['创建时间', date(order.createdAt)]]) {
        const row = node('div'); row.append(node('dt', label), node('dd', value)); list.append(row);
      }
      return list;
    }
    function updateClock() {
      const state = controller.snapshot(), clock = $('billingCountdown');
      if (!clock || !state.order) return;
      const remaining = Math.max(0, Math.ceil((Number(state.order.expiresAt) - state.now) / 1000));
      clock.textContent = `付款码剩余 ${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
      if (remaining === 0 && !expired(state.order, state.now)) return;
      if (remaining === 0 && state.active) { renderKey = ''; render(state); }
    }
    function render(state) {
      const enabled = state.billing?.enabled === true && state.billing?.available !== false;
      for (const purchase of document.querySelectorAll('[data-buy-plan]')) purchase.disabled = !enabled || state.busy;
      const plansNote = $('billingPlansNote');
      if (plansNote) plansNote.textContent = state.billing?.mode === 'mock'
        ? '本地预览使用模拟支付，不会扣款；真实购买请前往正式网站。'
        : enabled ? '付款完成后自动增加练习时长，可在订单记录中查看。' : '套餐暂未开放购买，已有时长可正常使用。';
      if ($('billingLiveSiteLink')) $('billingLiveSiteLink').hidden = state.billing?.mode !== 'mock';
      if (!state.active) { if (dialog.open) dialog.close(); return; }
      content.setAttribute('aria-busy', String(state.busy));
      if (paid(state.order)) {
        const grant = `${userId(auth()?.getState?.())}:${state.order.orderNo}:${state.order.grantedAt}`;
        if (grant !== refreshedGrant) { refreshedGrant = grant; void auth()?.refresh?.(); }
      }
      const view = orderView(state.order, state.now), modeLabel = $('billingModeLabel');
      if (modeLabel) modeLabel.textContent = state.billing?.mode === 'mock' ? '本地模拟支付 · 不扣款' : '练习时长';
      $('billingTitle').textContent = state.screen === 'history' ? '我的订单' : view.title;
      $('billingDescription').textContent = state.screen === 'history' ? '最近 20 笔订单。未完成的订单可继续查看。' : view.description;
      const message = $('billingMessage'); message.textContent = state.error; message.hidden = !state.error;
      const key = JSON.stringify([state.screen, state.order, state.orders, enabled, view.phase,
        state.busy && !state.order && !state.orders.length]);
      if (key === renderKey) {
        for (const action of content.querySelectorAll('button')) action.disabled = state.busy;
        return;
      }
      renderKey = key; content.replaceChildren();
      if (state.screen === 'history') {
        if (state.busy && !state.orders.length) content.append(node('p', '正在读取订单…', 'billing-empty'));
        else if (!state.orders.length) content.append(node('p', '还没有订单。选择适合自己的练习时长，即可开始。', 'billing-empty'));
        for (const order of state.orders) {
          const row = node('article', null, 'billing-history-item'), summary = node('div');
          summary.append(node('h3', `${order.planName || order.planId} · ¥${amount(order.amountFen)}`),
            node('p', `${date(order.createdAt)} · ${orderView(order, state.now).title}`), node('small', order.orderNo));
          row.append(summary, button('查看', () => controller.resume(order), { disabled: state.busy })); content.append(row);
        }
        content.append(button('刷新订单', () => controller.openHistory(), { disabled: state.busy, id: 'billingRefreshHistory' }));
        return;
      }
      if (!state.order) {
        content.append(node('p', state.busy ? '正在准备订单，请稍候…' : enabled ? '订单暂未创建，请重试。' : '套餐暂未开放购买。', 'billing-empty'));
        if (!state.busy && enabled) content.append(button('重试创建订单', () => controller.retry(), { primary: true, id: 'billingRetry' }));
        content.append(button('查看订单记录', () => controller.openHistory(), { disabled: state.busy }));
        return;
      }
      if (view.canPay) {
        const qrBox = node('div', null, 'billing-qr-box');
        try { qrBox.append(qrImage(state.order.codeUrl)); } catch (cause) { qrBox.append(node('p', cause.message, 'billing-message')); }
        const countdown = node('p', '', 'billing-countdown'); countdown.id = 'billingCountdown'; qrBox.append(countdown);
        if (state.billing?.mode === 'mock') qrBox.append(node('p', '此二维码用于模拟演示，无需微信付款。', 'billing-qr-note'));
        else qrBox.append(node('p', '请使用微信扫一扫完成付款。', 'billing-qr-note'));
        content.append(qrBox);
      }
      if (view.phase === 'paid') content.append(node('p', `练习有效期至 ${date(state.order.entitlementEndsAt)}`, 'billing-success'));
      content.append(details(state.order));
      const actions = node('div', null, 'billing-actions');
      if (view.canPay && state.billing?.mode === 'mock') actions.append(button('模拟支付成功', () => controller.mockComplete(), { primary: true, disabled: state.busy, id: 'billingMockPay' }));
      if (!paid(state.order)) actions.append(button(view.phase === 'processing' ? '刷新到账状态' : '我已完成支付，刷新状态', () => controller.sync(), { disabled: state.busy, id: 'billingSync' }));
      if (['unpaid', 'expired'].includes(view.phase)) actions.append(button(view.phase === 'expired' ? '关闭过期付款码' : '取消订单', () => controller.cancel(), { disabled: state.busy, id: 'billingCancel' }));
      if (['closed', 'pending'].includes(view.phase)) actions.append(button('重新获取付款码', () => controller.retry(), { primary: true, disabled: state.busy, id: 'billingRetry' }));
      if (view.phase === 'paid') actions.append(button('继续练习', close, { primary: true, id: 'billingContinue' }));
      actions.append(button('订单记录', () => controller.openHistory(), { disabled: state.busy })); content.append(actions);
      updateClock();
    }
    function showDialog() {
      for (const id of ['plansDialog', 'authDialog', 'starterWheelDialog', 'shareDialog']) { if ($(id)?.open) $(id).close(); }
      if (!dialog.open) dialog.showModal();
      renderKey = ''; lastPoll = Date.now();
    }
    async function open(planId) {
      await auth()?.ready;
      if (!auth()?.getState?.().user) { pendingLogin = { planId }; auth()?.open(); return; }
      pendingLogin = null; showDialog(); return controller.open(planId);
    }
    async function openHistory() {
      await auth()?.ready;
      if (!auth()?.getState?.().user) { pendingLogin = { history: true }; auth()?.open(); return; }
      pendingLogin = null; showDialog(); return controller.openHistory();
    }
    function close() { controller.close(); if (dialog.open) dialog.close(); }
    $('closeBilling')?.addEventListener('click', close);
    dialog.addEventListener('close', () => controller.close());
    dialog.addEventListener('click', event => { if (event.target === dialog && (event.offsetX < 0 || event.offsetX > dialog.clientWidth || event.offsetY < 0 || event.offsetY > dialog.clientHeight)) close(); });
    for (const purchase of document.querySelectorAll('[data-buy-plan]')) { purchase.disabled = true; purchase.addEventListener('click', () => open(purchase.dataset.buyPlan)); }
    $('openBillingHistory')?.addEventListener('click', openHistory);
    $('plansDialog')?.addEventListener('toggle', () => { if ($('plansDialog').open) void controller.metadata(); });
    $('authDialog')?.addEventListener('close', () => { if (!auth()?.getState?.().user) pendingLogin = null; });
    window.addEventListener('authchange', () => {
      controller.accountChanged();
      if (pendingLogin && auth()?.getState?.().user) {
        const pending = pendingLogin; pendingLogin = null;
        void (pending.history ? openHistory() : open(pending.planId));
      }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) lastPoll = 0; });
    window.setInterval(() => {
      const state = controller.snapshot();
      if (!state.active || !dialog.open || document.hidden) return;
      updateClock();
      if (state.screen === 'checkout' && state.order && !paid(state.order) && !ended(state.order) && !state.busy && Date.now() - lastPoll >= 3000) {
        lastPoll = Date.now(); void controller.poll();
      }
    }, 1000);
    window.ZijianBilling = { open, openHistory, close, isOpen: () => dialog.open };
    Promise.resolve(auth()?.ready).then(() => controller.metadata());
    return controller;
  }
  return { PLAN_IDS, amount, orderView, createController, requestUuid, mount };
});
