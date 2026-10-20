'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');

const NOW = Date.UTC(2026, 9, 16);
const DAY = 86400000;
const source = fs.readFileSync(require.resolve('../auth.js'), 'utf8');
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(condition) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for an asynchronous client request');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const guestState = (active = false) => ({
  user: null,
  guest: { status: active ? 'active' : 'available', startedAt: active ? NOW : null, endsAt: active ? NOW + DAY : null },
  starter: { status: 'login_required', days: null, claimDeadline: null },
  entitlement: { status: active ? 'guest' : 'guest_available', hasAccess: active, source: active ? 'guest' : null, expiresAt: active ? NOW + DAY : null },
  csrfToken: 'c'.repeat(64), serverTime: NOW, providers: { sms: true, email: true },
});

// The actual client runs against tiny event/element surfaces. Layout, native
// beforeinput/composition and the real practice scripts are covered in browser QA.
function page(fetchHandler, href = 'http://127.0.0.1:4173/') {
  const elements = new Map(), intervals = [], calls = [];
  let elapsed = 0;
  class Element {
    constructor(id = '') {
      this.id = id; this.value = ''; this.textContent = ''; this.hidden = false;
      this.open = false; this.disabled = false; this.dataset = {}; this.listeners = new Map();
      this.children = []; this.html = ''; this.attributes = new Map();
      const classes = new Set();
      this.classList = { contains: name => classes.has(name), toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      } };
    }
    addEventListener(name, handler) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(handler);
    }
    emit(name, extra = {}) {
      const event = { target: this, preventDefault() {}, ...extra };
      for (const handler of this.listeners.get(name) || []) handler(event);
      return event;
    }
    set innerHTML(value) {
      this.html = String(value); this.children = [];
      for (const match of this.html.matchAll(/<(button|input|form|div|dl|p)\b([^>]*)>/gu)) {
        const attrs = match[2], id = /\bid="([^"]+)"/u.exec(attrs)?.[1];
        const node = new Element(id || '');
        if (id) elements.set(id, node);
        node.tag = match[1]; node.attrs = attrs;
        for (const attribute of attrs.matchAll(/data-([a-z-]+)(?:="([^"]*)")?/gu)) {
          const key = attribute[1].replace(/-([a-z])/gu, (_all, letter) => letter.toUpperCase());
          node.dataset[key] = attribute[2] || '';
        }
        this.children.push(node);
      }
    }
    get innerHTML() { return this.html; }
    querySelectorAll(selector) {
      const all = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
      if (selector === '*') return all;
      if (selector === 'button,input') return all.filter(node => ['button', 'input'].includes(node.tag));
      const attribute = /^\[data-([^\]]+)\]$/u.exec(selector)?.[1];
      if (attribute) return all.filter(node => node.attrs?.includes(`data-${attribute}`));
      if (selector.startsWith('#')) return all.filter(node => node.id === selector.slice(1));
      return [];
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    append(node) { this.children.push(node); }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    reportValidity() { return true; }
    matches(selector) { return selector.includes(`#${this.id}`); }
  }
  function get(id) {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  }
  const document = new Element('document');
  document.getElementById = get;
  document.createElement = () => new Element();
  document.hidden = false;
  const window = new Element('window');
  window.location = { protocol: new URL(href).protocol, href };
  window.history = { replaceState(_state, _title, url) { window.location.href = new URL(url, window.location.href).href; } };
  window.crypto = webcrypto;
  window.dispatchEvent = event => window.emit(event.type, event);
  vm.runInNewContext(source, {
    window, document, navigator: { language: 'zh-CN', userAgent: 'Test Browser', hardwareConcurrency: 8 },
    screen: { width: 1440, height: 900, colorDepth: 24 }, performance: { now: () => elapsed },
    URL, TextEncoder, AbortController, Intl, Date,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    localStorage: { setItem() {} },
    requestAnimationFrame: callback => callback(),
    setInterval: callback => { intervals.push(callback); }, setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => { calls.push({ url, options }); return fetchHandler(url, options); },
  });
  return { auth: window.ZijianAuth, get, window, document, calls,
    advance(ms) { elapsed += ms; intervals[0](); } };
}

test('loading and opening the account do not start a guest clock; concurrent practice gestures share one activation', async () => {
  const post = deferred();
  const h = page(url => url === '/api/auth/session' ? response(guestState()) : post.promise);
  await h.auth.ready;
  await h.get('accountButton').emit('click');
  assert.equal(h.get('authDialog').open, true);
  h.get('authDialog').close();
  assert.deepEqual(h.calls.map(call => call.url), ['/api/auth/session']);
  assert.equal(h.auth.hasAccess(), false);
  assert.equal(h.auth.canPractice(), true);
  const first = h.auth.ensureAccess(), second = h.auth.ensureAccess();
  let prevented = false;
  h.document.emit('beforeinput', { target: h.get('typingInput'), preventDefault() { prevented = true; } });
  h.get('typingInput').value = 'Learning';
  for (let attempt = 0; attempt < 20 && h.calls.length < 2; attempt++) await flush();
  assert.equal(prevented, false);
  assert.equal(h.get('authDialog').open, false);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(h.calls[1].url, '/api/guest/start');
  assert.match(JSON.parse(h.calls[1].options.body).fingerprint, /^[a-f0-9]{64}$/u);
  post.resolve(response(guestState(true)));
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(h.auth.hasAccess(), true);
  assert.equal(h.get('typingInput').value, 'Learning');
});

test('the account entry defaults to SMS and email/password stays available as a secondary tab', async () => {
  const h = page(() => response(guestState()));
  await h.auth.ready;
  h.get('accountButton').emit('click');
  assert.match(h.get('authDescription').textContent, /推荐使用短信/u);
  assert.match(h.get('authContent').innerHTML, /id="authPhone"/u);
  assert.match(h.get('authContent').innerHTML, /30 分钟/u);
  for (const view of ['login', 'register', 'forgot']) {
    h.auth.open(view);
    assert.match(h.get('authContent').innerHTML, /id="authEmail"/u);
    if (view === 'register') assert.match(h.get('authContent').innerHTML, /id="authNickname"/u);
  }
  assert.deepEqual(h.calls.map(call => call.url), ['/api/auth/session']);
});

test('email accounts can bind phones after email verification and legacy names never leak in the header', async () => {
  for (const emailVerified of [false, true]) {
    const state = { ...guestState(), user: { id: 'student', email: 'student@example.test', emailVerified, phone: null } };
    const h = page(() => response(state));
    await h.auth.ready;
    h.auth.open('account');
    assert.match(h.get('authContent').innerHTML, /accountPhone/u);
    assert.equal(h.get('accountButton').textContent, '练习同学');
    assert.match(h.get('accountActions').innerHTML, /设置昵称/u);
    assert.equal(/data-auth-view="bindPhone"/u.test(h.get('accountActions').innerHTML), emailVerified);
    if (!emailVerified) {
      const verify = h.get('accountActions').querySelectorAll('[data-auth-view]').find(button => button.dataset.authView === 'bindEmail');
      assert.ok(verify);
      verify.emit('click');
      assert.match(h.get('authTitle').textContent, /验证邮箱/u);
      assert.doesNotMatch(h.get('authDescription').textContent, /绑定手机号|短信/u);
    }
    h.auth.open('bindPhone');
    assert.equal(h.get('authTitle').textContent, '绑定手机号');
    assert.match(h.get('authContent').innerHTML, /data-send-code/u);
    assert.deepEqual(h.calls.map(call => call.url), ['/api/auth/session']);
  }
});

test('SMS first registration keeps the verified phone and code in memory until a valid nickname is submitted', async () => {
  const initial = guestState();
  const signedIn = { ...initial, user: { id: 'sms-student', nickname: '短信同学', phone: '13341313711', email: null } };
  let attempts = 0;
  const h = page(url => url === '/api/auth/sms/login'
    ? ++attempts === 1 ? response({ code: 'NICKNAME_REQUIRED', error: '请设置昵称。' }, 400) : response(signedIn)
    : response(initial));
  await h.auth.ready; h.auth.open();
  h.get('authPhone').value = '13341313711'; h.get('authCode').value = '123456';
  h.get('authForm').emit('submit');
  await waitFor(() => h.get('authTitle').textContent === '设置你的昵称');
  assert.match(h.get('authContent').innerHTML, /id="authNickname"/u);
  assert.doesNotMatch(h.get('authContent').innerHTML, /id="authPhone"|id="authCode"/u);
  h.get('authNickname').value = '超'.repeat(11); h.get('authForm').emit('submit');
  await flush(); assert.equal(attempts, 1);
  h.get('authNickname').value = ' 短信同学 '; h.get('authForm').emit('submit');
  await waitFor(() => h.auth.getState().user);
  const posts = h.calls.filter(call => call.url === '/api/auth/sms/login').map(call => JSON.parse(call.options.body));
  assert.equal(posts[0].nickname, undefined);
  assert.equal(posts[1].nickname, '短信同学');
  assert.equal(posts[0].phone, posts[1].phone); assert.equal(posts[0].code, posts[1].code);
  assert.equal(h.get('accountButton').textContent, '短信同学');
  assert.equal(h.calls.filter(call => call.url === '/api/auth/sms/send').length, 0);
});

test('existing SMS users log in without a nickname form, and SMS sends show the 30 minute validity and cooldown', async () => {
  const initial = guestState(), signedIn = { ...initial, user: { id: 'old-sms', nickname: '原昵称', phone: '13341313711' } };
  const h = page(url => response(url === '/api/auth/sms/send' ? { message: '验证码已发送，30 分钟内有效。', retryAfter: 60 }
    : url === '/api/auth/sms/login' ? signedIn : initial));
  await h.auth.ready; h.auth.open();
  h.get('authPhone').value = '13341313711';
  h.get('authContent').querySelector('[data-send-code]').emit('click');
  await waitFor(() => h.get('authMessage').textContent.includes('30 分钟'));
  h.get('authContent').querySelector('[data-send-code]').emit('click');
  assert.equal(h.calls.filter(call => call.url === '/api/auth/sms/send').length, 1);
  h.get('authCode').value = '123456'; h.get('authForm').emit('submit');
  await waitFor(() => h.auth.getState().user);
  assert.equal(h.get('accountButton').textContent, '原昵称');
  assert.equal(JSON.parse(h.calls.find(call => call.url === '/api/auth/sms/login').options.body).nickname, undefined);
});

test('an uncertain SMS send shows usable-code guidance and waits before allowing another send', async () => {
  const initial = guestState();
  const signedIn = {...initial,user:{id:'sms-user',nickname:'短信同学',phone:'13341313711'}};
  const h = page(url => url === '/api/auth/sms/send' ? response({code:'SMS_SEND_UNCERTAIN',error:'短信发送结果暂未确认，收到验证码可直接登录。',retryAfter:60},503) : response(url === '/api/auth/sms/login' ? signedIn : initial));
  await h.auth.ready; h.auth.open(); h.get('authPhone').value='13341313711';
  h.get('authContent').querySelector('[data-send-code]').emit('click');
  await waitFor(() => h.get('authMessage').textContent.includes('收到验证码可直接登录'));
  h.get('authContent').querySelector('[data-send-code]').emit('click');
  assert.equal(h.calls.filter(call=>call.url==='/api/auth/sms/send').length,1);
  h.get('authCode').value='123456';
  h.get('authForm').emit('submit');
  await waitFor(()=>h.auth.getState().user);
  assert.equal(h.get('accountButton').textContent,'短信同学');
  assert.equal(h.calls.filter(call=>call.url==='/api/auth/sms/send').length,1);
});

test('email signup validates nickname before sending and uses the nickname in the header', async () => {
  const initial = guestState(), signedIn = { ...initial, user: { id: 'mail-student', nickname: '😀'.repeat(10), email: 'mail@example.test' } };
  const h = page(url => response(url === '/api/auth/register' ? signedIn : initial));
  await h.auth.ready; h.auth.open('register');
  h.get('authEmail').value = 'mail@example.test'; h.get('authPassword').value = 'Password-1234';
  for (const nickname of ['', '超'.repeat(11), '同\u200b学']) {
    h.get('authNickname').value = nickname; h.get('authForm').emit('submit'); await flush();
  }
  assert.equal(h.calls.filter(call => call.url === '/api/auth/register').length, 0);
  h.get('authNickname').value = '😀'.repeat(10); h.get('authForm').emit('submit');
  await waitFor(() => h.auth.getState().user);
  assert.equal(h.get('accountButton').textContent, '😀'.repeat(10));
  assert.equal(h.get('accountButton').title, '😀'.repeat(10));
  assert.equal(JSON.parse(h.calls.find(call => call.url === '/api/auth/register').options.body).nickname, '😀'.repeat(10));
});

test('old accounts can set a nickname and display it without interpolating it into markup', async () => {
  const initial = { ...guestState(), user: { id: 'legacy', email: 'private@example.test', nickname: null } };
  const renamed = { ...initial, user: { ...initial.user, nickname: '<b>同学</b>' } };
  const h = page(url => response(url === '/api/auth/profile' ? renamed : initial));
  await h.auth.ready; h.auth.open('nickname');
  assert.equal(h.get('accountButton').textContent, '练习同学');
  assert.equal(h.get('authNickname').value, '');
  h.get('authNickname').value = renamed.user.nickname; h.get('authForm').emit('submit');
  await waitFor(() => h.auth.getState().user.nickname);
  assert.equal(h.get('accountButton').textContent, renamed.user.nickname);
  assert.equal(h.get('accountNickname').textContent, renamed.user.nickname);
  assert.doesNotMatch(h.get('authContent').innerHTML, /<b>同学/u);
});

test('an uncertain guest POST resolves a granted session without repeating the activation or opening registration', async () => {
  let gets = 0;
  const h = page(url => {
    if (url === '/api/auth/session') return response(guestState(++gets > 1));
    return { ok: true, status: 200, json: async () => { throw new Error('Connection lost after server commit'); } };
  });
  await h.auth.ready;
  h.get('typingInput').value = 'My first draft';
  assert.equal(await h.auth.ensureAccess(), true);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(gets, 2);
  assert.equal(h.auth.hasAccess(), true);
  assert.equal(h.get('authDialog').open, false);
  assert.equal(h.get('typingInput').value, 'My first draft');
});

test('a failed first activation closes access while retaining drafts and keeping registration closed', async () => {
  const h = page(url => url === '/api/auth/session' ? response(guestState()) : response({ error: 'Temporarily unavailable' }, 503));
  await h.auth.ready;
  h.get('typingInput').value = 'Keep this text';
  assert.equal(await h.auth.ensureAccess(), false);
  assert.equal(h.auth.hasAccess(), false);
  assert.equal(h.auth.canPractice(), false);
  assert.equal(h.get('typingInput').value, 'Keep this text');
  assert.equal(h.get('authDialog').open, false);
  assert.match(h.get('accessTitle').textContent, /体验暂未开启/u);
});

test('the server deadline expires independently of the local wall clock and does not clear either practice draft', async () => {
  const state = guestState(true);
  state.entitlement.expiresAt = NOW + 1000;
  state.guest.endsAt = NOW + 1000;
  const h = page(() => response(state));
  await h.auth.ready;
  h.get('typingInput').value = 'Full article draft';
  h.get('sentenceAnswer-1').value = 'Sentence draft';
  h.advance(1001);
  assert.equal(h.auth.hasAccess(), false);
  assert.equal(h.auth.canPractice(), false);
  assert.equal(h.get('typingInput').value, 'Full article draft');
  assert.equal(h.get('sentenceAnswer-1').value, 'Sentence draft');
  assert.match(h.get('accessTitle').textContent, /体验已结束/u);
  assert.equal(h.get('accessPlans').hidden, true);
  assert.equal(h.get('authDialog').open, false);
  h.get('accountButton').emit('click');
  assert.equal(h.get('authDialog').open, true);
  assert.match(h.get('authContent').innerHTML, /id="authPhone"/);
});

test('logged-in users can always open plans directly from the toolbar while guests have no purchase button', async () => {
  for (const active of [true, false]) {
    const initial = { ...guestState(active), user: { id:'buyer',nickname:'同学' },
      guest:{status:active?'transferred':'expired'},starter:{status:'claimed'}, entitlement:{hasAccess:active,source:'account',expiresAt:active?NOW+DAY:NOW-1} };
    let loggedOut=false;
    const h=page(url=>{if(url==='/api/auth/logout')loggedOut=true;return response(loggedOut?guestState():initial);});
    await h.auth.ready;
    assert.equal(h.get('accessPlans').hidden,false);
    h.get('accessPlans').emit('click');
    assert.equal(h.get('plansDialog').open,true);
    assert.equal(h.get('authDialog').open,false);
    if(!active) assert.equal(h.get('accessTitle').textContent,'练习时长已结束');
    h.get('plansDialog').close();h.auth.open('account');
    h.get('accountActions').querySelector('[data-logout]').emit('click');
    await waitFor(()=>!h.auth.getState().user&&!h.get('authDialog').open);
    assert.equal(h.get('accessPlans').hidden,true);
  }
});

test('four access displays cover unused trials, expiry and hidden transferred guest time', async () => {
  const guestExpired={...guestState(),guest:{status:'expired',startedAt:NOW-DAY,endsAt:NOW-1},entitlement:{hasAccess:false,expiresAt:NOW-1}};
  const user={id:'student',nickname:'同学'};
  const cases=[
    {state:guestState(true),title:'游客体验',countdown:true,purchase:false},
    {state:guestExpired,title:'游客体验已结束',countdown:false,purchase:false,expired:true},
    {state:{...guestExpired,user,starter:{status:'available'}},title:'练习时长已结束',countdown:false,purchase:true,expired:true},
    {state:{...guestState(true),user,entitlement:{hasAccess:true,source:'account',expiresAt:NOW+DAY}},title:'',countdown:true,purchase:true},
    {state:{...guestState(true),user},title:'',countdown:true,purchase:true},
    {state:guestState(),title:'免费体验 24 小时',countdown:false,purchase:false},
    {state:{...guestState(),user},title:'免费体验 24 小时',countdown:false,purchase:true},
    ...[null,NOW-1,NOW+DAY].map(endsAt=>({state:{...guestState(),guest:{status:'transferred',endsAt},entitlement:{hasAccess:false,expiresAt:endsAt}},title:'',countdown:false,purchase:false,summaryHidden:true})),
  ];
  for(const item of cases){
    const h=page(()=>response(item.state));await h.auth.ready;
    assert.equal(h.get('accessTitle').textContent,item.title);
    assert.equal(!h.get('accessCountdown').hidden,item.countdown,item.title);
    assert.equal(!h.get('accessPlans').hidden,item.purchase,item.title);
    assert.equal(h.get('accessSummary').hidden,!!item.summaryHidden);
    assert.equal(h.get('accessTitle').hidden,!item.title);
    assert.equal(h.get('accessStatus').classList.contains('is-expired'),!!item.expired);
    assert.equal(h.get('accessRetry').hidden,true);
    assert.equal(h.get('shareButton').hidden,false);
    if(item.summaryHidden)assert.equal(h.get('accessStatus').title,'');
    assert.equal(h.get('authDialog').open,false);
    if(!item.state.user)assert.equal(h.get('accountButton').textContent,'登录 / 注册');
  }
});

test('hidden guest time restores on login and connection errors remain visible until retry succeeds', async () => {
  const transferred={...guestState(),guest:{status:'transferred',endsAt:NOW+DAY},entitlement:{hasAccess:false,expiresAt:NOW+DAY}};
  let current=transferred,fail=false;
  const h=page(()=>fail?response({error:'offline'},503):response(current));
  await h.auth.ready;
  assert.equal(h.get('accessSummary').hidden,true);
  fail=true;
  await h.auth.refresh();
  assert.equal(h.get('accessSummary').hidden,false);
  assert.equal(h.get('accessTitle').textContent,'暂时无法获取状态');
  assert.equal(h.get('accessRetry').hidden,false);
  assert.equal(h.get('accessStatus').classList.contains('is-expired'),false);
  fail=false;
  h.get('accessRetry').emit('click');
  await waitFor(()=>h.get('accessSummary').hidden);
  current={...transferred,user:{id:'student',nickname:'同学'},entitlement:{hasAccess:true,source:'account',expiresAt:NOW+DAY}};
  await h.auth.refresh();
  assert.equal(h.get('accountButton').textContent,'同学');
  assert.equal(h.get('accessSummary').hidden,false);
  assert.equal(h.get('accessTitle').hidden,true);
  assert.equal(h.get('accessCountdown').hidden,false);
  assert.equal(h.get('accessPlans').hidden,false);
  h.advance(DAY+1);
  assert.equal(h.get('accessTitle').hidden,false);
  assert.equal(h.get('accessTitle').textContent,'练习时长已结束');
  assert.equal(h.get('accessCountdown').hidden,true);
  assert.equal(h.get('accessStatus').classList.contains('is-expired'),true);
  assert.equal(h.get('authDialog').open,false);
});

test('an older session GET cannot replace a successful starter coupon grant', async () => {
  const initial = guestState();
  initial.user = { id: 'student', email: 'student@example.test' };
  initial.starter = { status: 'available', days: null, claimDeadline: NOW + 7 * DAY };
  const granted = { ...initial, guest: { status: 'transferred', endsAt: null },
    starter: { ...initial.starter, status: 'claimed', days: 5 },
    entitlement: { status: 'active', hasAccess: true, source: 'account', expiresAt: NOW + 6 * DAY } };
  const stale = deferred();
  let gets = 0;
  const h = page(url => url === '/api/auth/session' ? (++gets === 1 ? response(initial) : stale.promise) : response(granted));
  await h.auth.ready;
  const refresh = h.auth.refresh();
  h.auth.open('account');
  const claim = h.auth.claimStarter();
  for (let attempt = 0; attempt < 20 && !h.auth.hasAccess(); attempt++) await flush();
  assert.equal(h.auth.hasAccess(), true);
  await claim;
  assert.equal(h.auth.getState().starter.days, 5);
  stale.resolve(response(initial));
  await refresh;
  assert.equal(h.auth.hasAccess(), true);
  assert.equal(h.auth.getState().starter.status, 'claimed');
  assert.equal(h.auth.getState().entitlement.expiresAt, NOW + 6 * DAY);
  assert.match(h.get('authMessage').textContent, /5 天新手券/u);
});

test('concurrent draws share one request and a lost response recovers the saved result without starting practice', async () => {
  const initial = { ...guestState(), starterDraw: { status: 'available', days: null, drawnAt: null } };
  const drawn = { ...initial, starterDraw: { status: 'pending', days: 7, drawnAt: NOW } };
  const post = deferred();
  let gets = 0;
  const h = page(url => url === '/api/auth/session' ? response(++gets === 1 ? initial : drawn) : post.promise);
  await h.auth.ready;
  const first = h.auth.drawStarter(), second = h.auth.drawStarter();
  await waitFor(() => h.calls.length >= 2);
  assert.deepEqual(h.calls.map(call => call.url), ['/api/auth/session', '/api/coupons/starter/draw']);
  post.resolve({ ok: true, status: 200, json: async () => { throw new Error('Connection lost after draw'); } });
  assert.equal((await first).starterDraw.days, 7);
  assert.equal((await second).starterDraw.days, 7);
  assert.equal(h.auth.getState().guest.startedAt, null);
  assert.equal(h.auth.hasAccess(), false);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
});

for (const mode of ['register', 'login']) {
  test(`the wheel ${mode} intent grants the drawn days after authentication without a second click`, async () => {
    const initial = { ...guestState(), starterDraw: { status: 'pending', days: 6, drawnAt: NOW } };
    const signedIn = { ...initial, user: { id: 'new-student', email: 'new@example.test' },
      starter: { status: 'available', days: null, claimDeadline: NOW + 7 * DAY } };
    const granted = { ...signedIn, starter: { ...signedIn.starter, status: 'claimed', days: 6 },
      starterDraw: { ...initial.starterDraw, status: 'claimed' },
      entitlement: { status: 'active', hasAccess: true, source: 'account', expiresAt: NOW + 7 * DAY } };
    const h = page(url => response(url === '/api/auth/session' ? initial : url === '/api/coupons/starter/claim' ? granted : signedIn));
    await h.auth.ready;
    if (mode === 'login') h.auth.openStarterLogin();
    else h.auth.openStarterRegistration();
    h.auth.open(mode);
    h.get('authNickname').value = '练习同学';
    h.get('authEmail').value = 'new@example.test'; h.get('authPassword').value = 'Password-12345';
    h.get('authForm').emit('submit');
    await waitFor(() => h.auth.hasAccess());
    assert.equal(h.auth.getState().starter.days, 6);
    const posts = h.calls.filter(call => call.options.method === 'POST').map(call => call.url);
    assert.deepEqual(posts, [`/api/auth/${mode}`, '/api/coupons/starter/claim']);
    assert.match(h.get('authMessage').textContent, /6 天新手券/u);
  });
}

test('ordinary registration does not automatically claim a pending draw, and closing the reward form clears its intent', async () => {
  const initial = { ...guestState(), starterDraw: { status: 'pending', days: 4, drawnAt: NOW } };
  const signedIn = { ...initial, user: { id: 'new-student', email: 'new@example.test' },
    starter: { status: 'available', days: null, claimDeadline: NOW + 7 * DAY } };
  const h = page(url => response(url === '/api/auth/session' ? initial : signedIn));
  await h.auth.ready;
  h.auth.openStarterRegistration();
  h.get('authDialog').close(); h.get('authDialog').emit('close');
  h.auth.open('register');
  h.get('authNickname').value = '练习同学';
  h.get('authEmail').value = 'new@example.test'; h.get('authPassword').value = 'Password-12345';
  h.get('authForm').emit('submit');
  await waitFor(() => h.auth.getState().user);
  await flush();
  assert.deepEqual(h.calls.filter(call => call.options.method === 'POST').map(call => call.url), ['/api/auth/register']);
  assert.equal(h.auth.getState().starter.status, 'available');
});

test('logging into an account which already claimed never submits another grant from the wheel intent', async () => {
  const initial = { ...guestState(), starterDraw: { status: 'pending', days: 7, drawnAt: NOW } };
  const signedIn = { ...initial, user: { id: 'existing', email: 'existing@example.test' },
    starter: { status: 'claimed', days: 3, claimDeadline: NOW + DAY }, starterDraw: { status: 'claimed', days: 3, drawnAt: NOW } };
  const h = page(url => response(url === '/api/auth/session' ? initial : signedIn));
  await h.auth.ready;
  h.auth.openStarterLogin();
  h.auth.open('login');
  h.get('authEmail').value = 'existing@example.test'; h.get('authPassword').value = 'Password-12345';
  h.get('authForm').emit('submit');
  for (let attempt = 0; attempt < 20 && !h.auth.getState().user; attempt++) await flush();
  await flush();
  assert.deepEqual(h.calls.filter(call => call.options.method === 'POST').map(call => call.url), ['/api/auth/login']);
  assert.match(h.get('authMessage').textContent, /已领取 3 天/u);
});

test('an invitation records server attribution before registration without starting a guest clock', async () => {
  const code = 'InviteCode0123456789';
  const initial = guestState();
  const signedIn = { ...initial, user: { id: 'invitee', email: 'invited@example.test' } };
  const h = page(url => response(url === '/api/auth/register' ? signedIn : url === '/api/referrals/visit'
    ? { ...initial, referralVisit: { status: 'recorded' } } : initial), `http://127.0.0.1:4173/?ref=${code}&keep=1#practice`);
  await h.auth.ready;
  assert.deepEqual(h.calls.map(call => call.url), ['/api/auth/session', '/api/referrals/visit']);
  const attribution = JSON.parse(h.calls[1].options.body);
  assert.equal(attribution.code, code);
  assert.match(attribution.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(h.window.location.href, 'http://127.0.0.1:4173/?keep=1#practice');
  assert.equal(h.auth.getState().guest.startedAt, null);
  assert.equal(h.get('authDialog').open, false);
  h.auth.open('register');
  h.get('authNickname').value = '练习同学';
  h.get('authEmail').value = 'invited@example.test'; h.get('authPassword').value = 'Password-12345';
  h.get('authForm').emit('submit');
  await waitFor(() => h.auth.getState().user);
  const registration = JSON.parse(h.calls.find(call => call.url === '/api/auth/register').options.body);
  assert.equal(registration.fingerprint, attribution.fingerprint);
  assert.equal(h.calls.filter(call => call.url === '/api/referrals/visit').length, 1);
  assert.equal(h.calls.some(call => call.url === '/api/guest/start'), false);
});

test('a failed invitation visit retries before registering and never silently loses the invitation', async () => {
  let visits = 0;
  const initial = guestState();
  const signedIn = { ...initial, user: { id: 'invitee', email: 'retry@example.test' } };
  const h = page(url => url === '/api/referrals/visit' && ++visits === 1
    ? response({ error: 'Temporary failure', code: 'AUTH_UNAVAILABLE' }, 503)
    : response(url === '/api/auth/register' ? signedIn : initial), 'http://127.0.0.1:4173/?ref=RetryInviteCode012345');
  await h.auth.ready;
  assert.match(h.window.location.href, /ref=/u);
  h.auth.open('register');
  h.get('authNickname').value = '练习同学';
  h.get('authEmail').value = 'retry@example.test'; h.get('authPassword').value = 'Password-12345';
  h.get('authForm').emit('submit');
  await waitFor(() => h.auth.getState().user);
  assert.deepEqual(h.calls.map(call => call.url), ['/api/auth/session', '/api/referrals/visit', '/api/referrals/visit', '/api/auth/register']);
  assert.doesNotMatch(h.window.location.href, /ref=/u);
});

test('an invalid or unknown invitation does not block normal signup or disclose account details', async () => {
  const initial = guestState();
  const malformed = page(() => response(initial), 'http://127.0.0.1:4173/?ref=%3Cscript%3E');
  await malformed.auth.ready;
  assert.deepEqual(malformed.calls.map(call => call.url), ['/api/auth/session']);
  assert.doesNotMatch(malformed.window.location.href, /ref=/u);
  const unknown = page(url => url === '/api/referrals/visit'
    ? response({ error: '邀请链接无效。', code: 'REFERRAL_NOT_FOUND' }, 404) : response(initial),
  'http://127.0.0.1:4173/?ref=UnknownInviteCode0123');
  await unknown.auth.ready;
  assert.equal(unknown.auth.canPractice(), true);
  assert.doesNotMatch(unknown.window.location.href, /ref=/u);
  assert.equal(unknown.get('authDialog').open, false);
});

test('personal share preparation requires login and records only the browser fingerprint', async () => {
  const anonymous = page(() => response(guestState()));
  await anonymous.auth.ready;
  await assert.rejects(anonymous.auth.prepareReferral(), /请先登录/u);
  assert.deepEqual(anonymous.calls.map(call => call.url), ['/api/auth/session']);
  const state = { ...guestState(), user: { id: 'inviter', email: 'inviter@example.test' },
    referral: { code: 'PersonalInviteCode01', rewardedCount: 1, rewardLimit: 3, totalDays: 5, remaining: 2 } };
  const signedIn = page(() => response(state));
  await signedIn.auth.ready;
  const result = await signedIn.auth.prepareReferral();
  assert.equal(result.referral.remaining, 2);
  assert.deepEqual(signedIn.calls.map(call => call.url), ['/api/auth/session', '/api/referrals/prepare']);
  assert.deepEqual(Object.keys(JSON.parse(signedIn.calls[1].options.body)), ['fingerprint']);
  assert.equal(signedIn.auth.getState().guest.startedAt, null);
});

test('the share dialog blocks practice shortcuts and closes before an account dialog opens', async () => {
  const h = page(() => response(guestState()));
  await h.auth.ready;
  let open = true;
  h.window.ZijianShare = { isOpen: () => open, close: () => { open = false; } };
  assert.equal(h.auth.isDialogOpen(), true);
  h.auth.open('login');
  assert.equal(open, false);
  assert.equal(h.get('authDialog').open, true);
});

test('a late billing response cannot restore a previously logged-in account or its entitlement', async () => {
  const initial = { ...guestState(), user: { id: 'buyer-a', email: 'a@example.test' } };
  const other = { ...guestState(), user: { id: 'buyer-b', email: 'b@example.test' } };
  const pending = deferred();
  const h = page(url => url.startsWith('/api/billing/') ? pending.promise
    : response(url === '/api/auth/login' ? other : initial));
  await h.auth.ready;
  const purchase = h.auth.billingRequest('/api/billing/orders', { planId: 'monthly', requestId: 'request-12345678901234567890' });
  const rejected = assert.rejects(purchase, error => error.code === 'AUTH_STATE_CHANGED');
  await waitFor(() => h.calls.some(call => call.url === '/api/billing/orders'));
  h.auth.open('login');
  h.get('authEmail').value = 'b@example.test'; h.get('authPassword').value = 'Password-12345';
  h.get('authForm').emit('submit');
  await waitFor(() => h.auth.getState().user?.id === 'buyer-b');
  pending.resolve(response({ ...initial, entitlement: { hasAccess: true, expiresAt: NOW + 30 * DAY },
    order: { orderNo: 'private-order-a', status: 'PAID' } }));
  await rejected;
  assert.equal(h.auth.getState().user.id, 'buyer-b');
  assert.equal(h.auth.getState().entitlement.hasAccess, false);
});

test('billing requests use session CSRF and the billing dialog participates in modal blocking', async () => {
  const state = { ...guestState(), user: { id: 'buyer', email: 'buyer@example.test' } };
  const h = page(() => response(state));
  await h.auth.ready;
  await h.auth.billingRequest('/api/billing/orders', { planId: 'monthly', requestId: 'request-12345678901234567890' });
  assert.equal(h.calls.at(-1).options.headers['X-CSRF-Token'], state.csrfToken);
  assert.equal(h.calls.at(-1).options.credentials, 'same-origin');
  await assert.rejects(h.auth.billingRequest('/api/auth/logout', {}), /支付请求地址无效/u);
  let visible = true;
  h.window.ZijianBilling = { isOpen: () => visible, close: () => { visible = false; } };
  assert.equal(h.auth.isDialogOpen(), true);
  h.auth.open();
  assert.equal(visible, false);
});
