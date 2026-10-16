(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.document) api.mount(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SITE_ORIGIN = 'https://type.where.work';
  const CARD_WIDTH = 1080;
  const CARD_HEIGHT = 1440;
  const REWARD_LIMIT = 3;
  const validCode = code => typeof code === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(code);
  const integer = (value, max) => Number.isInteger(value) ? Math.min(max, Math.max(0, value)) : 0;

  function buildShareModel(state, href = SITE_ORIGIN) {
    let origin = SITE_ORIGIN, local = false;
    try {
      const location = new URL(href);
      if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && ['http:', 'https:'].includes(location.protocol)) {
        origin = location.origin;
        local = true;
      }
    } catch { /* Production cards always have a working canonical address. */ }
    const signedIn = !!state?.user;
    const code = signedIn && validCode(state.referral?.code) ? state.referral.code : '';
    const url = new URL('/', origin);
    if (code) url.searchParams.set('ref', code);
    const count = integer(state?.referral?.rewardedCount, REWARD_LIMIT);
    const totalDays = integer(state?.referral?.totalDays, REWARD_LIMIT * 7);
    return Object.freeze({
      url: url.href, local, signedIn, personal: !!code,
      rewardedCount: count, totalDays, remaining: REWARD_LIMIT - count,
      rules: code
        ? `每邀请一位新朋友注册，你随机获赠 3–7 天，最多奖励 3 次。已获奖 ${count} / 3 次${totalDays ? `，累计 ${totalDays} 天` : ''}。朋友仍可领取新手券。`
        : '朋友打开即可体验。登录后分享专属卡片，每邀请一位新朋友注册，你随机获赠 3–7 天，最多奖励 3 次。',
    });
  }

  // A late prepare/render must never restore another account's invitation link.
  function createController(options) {
    let active = false, revision = 0, preparedUser = null, pendingUser = null;
    let current = { phase: 'closed', model: null, image: null, error: '' };
    const userId = state => state?.user?.id ?? (state?.user ? state.user.email || state.user.phone || 'signed-in' : null);
    const publish = next => { current = next; options.onChange?.(next); };

    async function refresh(prepareAgain = false) {
      if (!active) return null;
      const ticket = ++revision;
      const isCurrent = () => active && revision === ticket;
      publish({ phase: 'loading', model: null, image: null, error: '' });
      try {
        await Promise.resolve(options.ready?.());
        if (!isCurrent()) return null;
        let state = options.getState();
        const expectedUser = userId(state);
        if (expectedUser && (prepareAgain || preparedUser !== expectedUser)) {
          pendingUser = { id: expectedUser, ticket };
          publish({ phase: 'preparing', model: null, image: null, error: '' });
          try { await options.prepare(); }
          finally { if (pendingUser?.ticket === ticket) pendingUser = null; }
          if (!isCurrent()) return null;
          state = options.getState();
          if (userId(state) !== expectedUser) return refresh(true);
          preparedUser = expectedUser;
        }
        if (!expectedUser) preparedUser = null;
        const model = buildShareModel(state, options.href());
        if (model.signedIn && !model.personal) throw new Error('邀请链接暂时未能生成，请关闭后重试。');
        publish({ phase: 'rendering', model: null, image: null, error: '' });
        const image = await options.render(model, isCurrent);
        if (!isCurrent()) return null;
        if (!image?.dataUrl) throw new Error('卡片暂时未能生成，请关闭后重试。');
        publish({ phase: 'ready', model, image, error: '' });
        return model;
      } catch (error) {
        if (isCurrent()) publish({ phase: 'error', model: null, image: null,
          error: error?.message || '卡片暂时未能生成，请关闭后重试。' });
        return null;
      }
    }

    function authChanged() {
      if (!active) return null;
      if (pendingUser && userId(options.getState()) === pendingUser.id) return null;
      if (current.phase === 'loading') return null;
      return refresh();
    }
    return {
      open() { active = true; return refresh(true); },
      close() { active = false; ++revision; pendingUser = null; publish({ phase: 'closed', model: null, image: null, error: '' }); },
      authChanged,
      snapshot: () => current,
    };
  }

  function roundRect(context, x, y, width, height, radius, fill, stroke = '') {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    if (fill) { context.fillStyle = fill; context.fill(); }
    if (stroke) { context.strokeStyle = stroke; context.stroke(); }
  }

  function drawCard(canvas, model, makeQr) {
    if (typeof makeQr !== 'function') throw new Error('二维码暂时未能生成，请刷新页面后重试。');
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法生成图片，可以复制链接分享。');
    const sans = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
    const serif = 'Georgia, "Times New Roman", serif';
    const text = (value, x, y, size, color = '#2b3f32', font = sans, weight = '400') => {
      context.fillStyle = color;
      context.font = `${weight} ${size}px ${font}`;
      context.fillText(value, x, y);
    };
    context.fillStyle = '#f7f5ed';
    context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
    context.lineWidth = 2;
    roundRect(context, 30, 30, 1020, 1380, 30, '', '#dce2d2');

    // Quiet paper and typography keep the exported image readable in a chat.
    roundRect(context, 76, 88, 76, 76, 20, '#446955');
    text('T.', 96, 144, 55, '#fffefa', serif);
    text('火星叔叔', 174, 125, 35, '#2b3f32', sans, '600');
    text('IELTS WRITING · DAILY PRACTICE', 175, 158, 15, '#84917c', serif);
    if (model.local) {
      roundRect(context, 824, 101, 178, 43, 21, '#e9eddf');
      text('本地预览', 860, 130, 24, '#718066');
    }

    text('给正在努力的你', 78, 274, 25, '#718569');
    text('把每一次敲击，', 72, 380, 67, '#2e4937', sans, '600');
    text('变成下一次进步。', 72, 472, 67, '#2e4937', sans, '600');
    text('Small steps. Stronger words.', 78, 538, 36, '#7c8c70', serif, 'italic');

    // A restrained rule and an oversized letter echo the site's writing paper.
    context.fillStyle = '#e4e9d9';
    context.fillRect(78, 594, 924, 2);
    text('Aa', 786, 779, 138, '#e3e8d8', serif, 'italic');
    text('雅思作文打字练习', 78, 680, 46, '#3d5b42', sans, '600');
    text('导入自己的范文，练熟每一句英文。', 80, 738, 28, '#7b8871');
    const labels = ['全文 / 分句', '划词翻译', 'AI 纠错'];
    let labelX = 78;
    for (const label of labels) {
      context.font = `23px ${sans}`;
      const width = Math.ceil(context.measureText(label).width) + 38;
      roundRect(context, labelX, 783, width, 46, 23, '#ecefe3');
      text(label, labelX + 19, 814, 23, '#718367');
      labelX += width + 14;
    }

    roundRect(context, 76, 892, 928, 365, 24, '#edf1e5');
    const qr = makeQr(0, 'M');
    qr.addData(model.url, 'Byte');
    qr.make();
    const count = qr.getModuleCount(), quiet = 4;
    const cell = Math.floor(316 / (count + quiet * 2));
    const size = cell * (count + quiet * 2);
    const left = 98 + Math.floor((334 - size) / 2);
    const top = 908 + Math.floor((334 - size) / 2);
    roundRect(context, 98, 908, 334, 334, 16, '#ffffff');
    context.fillStyle = '#263d2e';
    for (let row = 0; row < count; row++) {
      for (let column = 0; column < count; column++) {
        if (qr.isDark(row, column)) context.fillRect(left + (column + quiet) * cell, top + (row + quiet) * cell, cell, cell);
      }
    }
    text('扫码，开始今天的练习', 470, 992, 31, '#36553e', sans, '600');
    text('免登录体验 24 小时', 470, 1054, 26, '#718267');
    text('注册还可抽 3–7 天新手券', 470, 1098, 25, '#718267');
    context.fillStyle = '#d5dfca';
    context.fillRect(470, 1144, 440, 2);
    text(model.personal ? '来自朋友的邀请' : '分享一份坚持', 470, 1194, 23, '#8a987f');

    // Show the same complete address that is encoded, including the invite code.
    let urlSize = 25;
    context.font = `${urlSize}px ${sans}`;
    while (context.measureText(model.url).width > 914 && urlSize > 14) {
      context.font = `${--urlSize}px ${sans}`;
    }
    text(model.url, 78, 1310, urlSize, '#75856b');
    text('每天一点进步，都算数。', 78, 1371, 24, '#8a977f');
    text('KEEP GOING.', 822, 1371, 20, '#9ba78e', serif);
    return { width: CARD_WIDTH, height: CARD_HEIGHT };
  }

  function mount(window) {
    const document = window.document;
    const $ = id => document.getElementById(id);
    const dialog = $('shareDialog');
    if (!dialog || !$('shareButton')) return;
    const auth = () => window.ZijianAuth;
    const image = $('shareImage'), canvas = $('shareCanvas'), status = $('shareStatus');
    const copy = $('copyShareLink'), save = $('saveShareCard'), native = $('shareNative');
    const link = $('shareLink'), login = $('shareLogin');
    let file = null;
    const statusText = (value, error = false) => { status.textContent = value; status.classList.toggle('is-error', error); };
    const controller = createController({
      getState: () => auth()?.getState?.(),
      ready: () => auth()?.ready,
      prepare: () => {
        if (typeof auth()?.prepareReferral !== 'function') throw new Error('邀请链接暂时未能生成，请刷新页面后重试。');
        return auth().prepareReferral();
      },
      href: () => window.location.href,
      render: async (model, isCurrent) => {
        try { await document.fonts?.ready; } catch { /* System font fallback remains readable. */ }
        if (!isCurrent()) return null;
        drawCard(canvas, model, window.qrcode);
        const dataUrl = canvas.toDataURL('image/png');
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        return { dataUrl, blob };
      },
      onChange: view => {
        const ready = view.phase === 'ready';
        image.hidden = !ready;
        copy.disabled = save.disabled = !ready;
        native.hidden = true;
        file = null;
        link.value = ready ? view.model.url : '';
        if (!ready) {
          image.removeAttribute('src');
          login.hidden = true;
          $('shareRules').textContent = '';
          statusText(view.phase === 'closed' ? '' : view.error || (view.phase === 'preparing' ? '正在生成你的专属邀请卡…' : '正在生成分享卡片…'), view.phase === 'error');
          return;
        }
        image.src = view.image.dataUrl;
        image.width = CARD_WIDTH;
        image.height = CARD_HEIGHT;
        $('shareRules').textContent = view.model.rules;
        login.hidden = view.model.signedIn;
        statusText(view.model.local ? '本地预览卡片，请上线后分享给朋友。' : '可保存高清图片；手机也可截图或长按卡片保存。');
        if (view.image.blob && typeof window.File === 'function') {
          file = new window.File([view.image.blob], '火星叔叔-练习邀请卡.png', { type: 'image/png' });
          try { native.hidden = !(window.navigator.share && window.navigator.canShare?.({ files: [file] })); }
          catch { native.hidden = true; }
        }
      },
    });

    function close() {
      controller.close();
      if (dialog.open) dialog.close();
    }
    async function open() {
      window.ZijianStarterWheel?.close?.();
      for (const id of ['authDialog', 'plansDialog', 'importDialog', 'historyDialog']) {
        const other = $(id);
        if (other?.open) other.close();
      }
      if (!dialog.open) dialog.showModal();
      $('closeShare').focus({ preventScroll: true });
      await controller.open();
    }
    $('shareButton').addEventListener('click', open);
    $('closeShare').addEventListener('click', close);
    dialog.addEventListener('close', () => controller.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    login.addEventListener('click', () => { close(); auth()?.open?.('login'); });
    copy.addEventListener('click', async () => {
      const model = controller.snapshot().model;
      if (!model) return;
      try {
        if (!window.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await window.navigator.clipboard.writeText(model.url);
        if (controller.snapshot().model === model) statusText('链接已复制，可以分享给朋友了。');
      } catch {
        if (controller.snapshot().model !== model) return;
        link.focus();
        link.select();
        link.setSelectionRange(0, link.value.length);
        statusText('请长按或使用复制快捷键复制已选中的链接。');
      }
    });
    save.addEventListener('click', () => {
      const current = controller.snapshot();
      if (current.phase !== 'ready') return;
      const anchor = document.createElement('a');
      anchor.href = current.image.dataUrl;
      anchor.download = '火星叔叔-练习邀请卡.png';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      statusText('高清图片已准备好。若未自动保存，可长按卡片保存或直接截图。');
    });
    native.addEventListener('click', async () => {
      const current = controller.snapshot(), sharedFile = file;
      if (current.phase !== 'ready' || !sharedFile) return;
      try {
        // Invoke directly in the click gesture; the PNG was prepared beforehand.
        await window.navigator.share({ files: [sharedFile], title: '火星叔叔 · 雅思作文打字练习', text: '把每一次敲击，变成下一次进步。' });
      } catch (error) {
        if (error?.name !== 'AbortError' && controller.snapshot() === current) statusText('暂时无法打开系统分享，可以保存图片或复制链接。');
      }
    });
    window.addEventListener('authchange', () => controller.authChanged());
    window.ZijianShare = { open, close, isOpen: () => dialog.open };
  }

  return { buildShareModel, createController, drawCard, mount, CARD_WIDTH, CARD_HEIGHT };
});
