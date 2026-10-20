(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.document) api.mount(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAYS = [3, 4, 5, 6, 7];
  const validDays = days => Number.isInteger(days) && DAYS.includes(days);

  // Segment zero is centered at twelve o'clock. Each following segment is
  // clockwise, so its winning stop is the corresponding counterclockwise turn.
  function winningRotation(days, current = 0) {
    if (!validDays(days)) throw new RangeError('Invalid starter coupon duration');
    const stop = (360 - DAYS.indexOf(days) * 72) % 360;
    const start = Number.isFinite(current) ? current : 0;
    const delta = (stop - ((start % 360) + 360) % 360 + 360) % 360;
    return start + 4 * 360 + delta;
  }

  function createController(options) {
    let state = options.getState();
    let phase = 'ready';
    let error = '';
    let operation = null;
    const snapshot = () => ({ state, phase, error,
      days: phase === 'drawing' ? null : (state?.starterDraw?.status === 'pending' && validDays(state.starterDraw.days) ? state.starterDraw.days : null),
    });
    const emit = () => options.onChange?.(snapshot());
    const refresh = (next = options.getState()) => { state = next; emit(); return state; };

    function spin() {
      if (operation) return operation;
      state = options.getState();
      if (state?.starterDraw?.status === 'pending' && validDays(state.starterDraw.days)) {
        error = ''; emit(); return Promise.resolve(state);
      }
      if (state?.starterDraw?.status !== 'available') {
        emit(); return Promise.resolve(state);
      }
      phase = 'drawing'; error = ''; emit();
      operation = Promise.resolve().then(() => options.draw()).then(async next => {
        state = next && typeof next === 'object' ? next : options.getState();
        if (state?.starterDraw?.status === 'pending') {
          if (!validDays(state.starterDraw.days)) throw new Error('抽奖结果暂时无法读取，请重试。');
          await options.animate?.(state.starterDraw.days);
        }
        return state;
      }).catch(cause => {
        state = options.getState();
        error = cause?.message || '抽奖暂时未完成，请重试。';
        return null;
      }).finally(() => { phase = 'ready'; operation = null; emit(); });
      return operation;
    }

    function claim() {
      if (operation) return operation;
      state = options.getState();
      if (state?.starterDraw?.status !== 'pending' || !validDays(state.starterDraw.days)) return Promise.resolve(state);
      if (!state.user) { options.register(); return Promise.resolve(state); }
      phase = 'claiming'; error = ''; emit();
      operation = Promise.resolve().then(() => options.claim()).then(next => {
        state = next && typeof next === 'object' ? next : options.getState(); return state;
      }).catch(cause => {
        state = options.getState(); error = cause?.message || '领取暂时未完成，请重试。'; return null;
      }).finally(() => { phase = 'ready'; operation = null; emit(); });
      return operation;
    }

    return { snapshot, refresh, spin, claim };
  }

  function wheelMarkup() {
    const point = angle => {
      const radians = angle * Math.PI / 180;
      return `${(150 + Math.cos(radians) * 132).toFixed(3)} ${(150 + Math.sin(radians) * 132).toFixed(3)}`;
    };
    const fills = ['#e5eddd', '#d4e1ca', '#becfb2', '#789473', '#4f725c'];
    let markup = '<circle cx="150" cy="150" r="145" fill="#f0f3e9"/><circle cx="150" cy="150" r="139" fill="#fffefa"/>';
    DAYS.forEach((days, index) => {
      const start = -126 + index * 72, end = start + 72;
      markup += `<path class="starter-wheel-sector" d="M150 150 L${point(start)} A132 132 0 0 1 ${point(end)} Z" fill="${fills[index]}"/>`;
      markup += `<g transform="rotate(${index * 72} 150 150)"><text class="starter-wheel-label" x="150" y="69" text-anchor="middle" fill="${index >= 3 ? '#fffefa' : '#405e46'}">${days}<tspan x="150" dy="20">天</tspan></text></g>`;
    });
    return markup;
  }

  function mount(window) {
    const document = window.document, $ = id => document.getElementById(id);
    const dialog = $('starterWheelDialog'), entry = $('starterWheelEntry');
    if (!dialog || !entry) return;
    const auth = () => window.ZijianAuth;
    const rotor = $('starterWheelRotor'), action = $('starterWheelAction'), login = $('starterWheelLogin');
    let rotation = 0, animatedDays = null;
    rotor.innerHTML = wheelMarkup();
    const close = () => { if (dialog.open) dialog.close(); };
    const controller = createController({
      getState: () => auth()?.getState?.() || {},
      draw: () => {
        if (!auth()?.drawStarter) throw new Error('抽奖服务暂时无法连接，请稍后重试。');
        return auth().drawStarter();
      },
      claim: async () => { await auth().claimStarter(); return auth().getState(); },
      register: () => { close(); auth()?.openStarterRegistration?.(); },
      animate: async days => {
        animatedDays = days;
        rotation = winningRotation(days, rotation);
        if (!dialog.open) { rotor.style.transition = 'none'; rotor.style.transform = `rotate(${rotation}deg)`; return; }
        rotor.style.transition = '';
        rotor.style.transform = `rotate(${rotation}deg)`;
        if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          await new Promise(resolve => window.setTimeout(resolve, 2550));
        }
      },
      onChange: render,
    });

    function render(view) {
      const { state, phase, error, days } = view;
      const status = state?.starterDraw?.status;
      entry.hidden = !['available', 'pending'].includes(status);
      const busy = phase !== 'ready';
      action.disabled = busy;
      login.disabled = busy;
      dialog.setAttribute('aria-busy', String(busy));
      const eligible = ['available', 'pending'].includes(status);
      $('starterWheelVisual').hidden = !eligible;
      login.hidden = !(days && !state.user && !busy);
      const message = $('starterWheelMessage');
      message.classList.toggle('is-error', Boolean(error));
      message.hidden = !error && !days && eligible;
      if (error) message.textContent = error;
      else if (days) message.textContent = state.user ? `已抽中 ${days} 天，领取后立即生效。` : `已抽中 ${days} 天，注册后即可领取。`;
      else if (!eligible) message.textContent = status === 'claimed' ? '这份新手奖励已经领过了，可在账户中查看剩余时长。' : '当前账号或浏览器暂不符合领取条件，可在账户中查看详情。';
      else message.textContent = '';
      if (days) {
        $('starterWheelTitle').textContent = `抽中 ${days} 天免费时长`;
        $('starterWheelDescription').textContent = '关闭后也会为你保留结果，领取时叠加剩余体验时长。';
        action.textContent = phase === 'claiming' ? '正在领取…' : state.user ? `领取 ${days} 天` : `注册并领取 ${days} 天`;
        if (animatedDays !== days) {
          rotation = winningRotation(days, 0) % 360;
          rotor.style.transition = 'none';
          rotor.style.transform = `rotate(${rotation}deg)`;
          animatedDays = days;
        }
      } else {
        $('starterWheelTitle').textContent = eligible ? '抽一份免费练习时长' : '新手礼';
        $('starterWheelDescription').textContent = !eligible ? '新手奖励每账号、每浏览器限领一份。' : state.user ? '免费抽取 3–7 天练习时长，领取后立即生效。' : '免费抽取 3–7 天练习时长，注册后领取。';
        action.textContent = busy ? (phase === 'claiming' ? '正在领取…' : '正在抽奖…') : eligible ? (error ? '重试抽奖' : '免费抽一次') : '查看我的账户';
      }
    }

    async function open() {
      await Promise.resolve(auth()?.ready).catch(() => {});
      controller.refresh();
      if (!dialog.open) dialog.showModal();
      action.focus();
    }
    entry.addEventListener('click', open);
    $('closeStarterWheel').addEventListener('click', close);
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    });
    action.addEventListener('click', () => {
      const view = controller.snapshot();
      if (view.phase !== 'ready') return;
      if (view.days) { controller.claim(); return; }
      if (view.state?.starterDraw?.status === 'available') { controller.spin(); return; }
      close(); auth()?.open?.();
    });
    login.addEventListener('click', () => { close(); auth()?.openStarterLogin?.(); });
    window.addEventListener('authchange', () => controller.refresh());
    window.ZijianStarterWheel = { open, close, isOpen: () => dialog.open };
    Promise.resolve(auth()?.ready).then(() => controller.refresh()).catch(() => controller.refresh());
  }

  return { DAYS, winningRotation, createController, wheelMarkup, mount };
});
