(() => {
  "use strict";

  // Restore these entries after the SMS signature has passed review.
  const SHOW_SMS_AUTH = false;

  const $ = id => document.getElementById(id);
  const dialog = $("authDialog");
  const plans = $("plansDialog");
  if (!dialog || !plans) return;
  const content = $("authContent");
  const initialEntitlement = { status: "guest_available", hasAccess: false };
  let state = { user: null, guest: { status: "available" }, starter: { status: "login_required" }, entitlement: initialEntitlement, providers: {}, csrfToken: "" };
  let view = SHOW_SMS_AUTH ? "sms" : "login";
  let busy = false;
  let unavailable = false;
  let refreshing = null;
  let snapshotServerTime = 0;
  let snapshotPerformance = performance.now();
  let resetToken = "";
  let bindToken = "";
  let sendUntil = 0;
  let pendingEmail = "";
  let channel = null;
  let stateRevision = 0;
  let startingGuest = null;
  let guestStartFailed = false;
  let pendingRedeem = false;
  let pendingCouponCode = "";
  let grantNotice = "";
  let pendingStarter = false;
  let drawingStarter = null;
  let referralCode = "";
  let recordingReferral = null;

  const time = value => typeof value === "number" ? value : Date.parse(value || "") || 0;
  const serverNow = () => snapshotServerTime + Math.max(0, performance.now() - snapshotPerformance);
  const accessEnd = () => time(state.entitlement?.expiresAt || state.entitlement?.trialEndsAt || state.guest?.endsAt);
  const hasAccess = () => !unavailable && state.entitlement?.hasAccess === true
    && (!accessEnd() || accessEnd() > serverNow());
  const canStartGuest = () => !unavailable && !guestStartFailed && state.guest?.status === "available";
  // Drafts stay editable while the first practice gesture starts the server clock.
  // AI calls always await ensureAccess before making a protected request.
  const canPractice = () => hasAccess() || canStartGuest();
  const canClaim = () => !!state.user && state.starter?.status === "available";
  const expiryLabel = () => new Date(accessEnd()).toLocaleString("zh-CN", { hour12: false });
  const isDialogOpen = () => dialog.open || plans.open || !!window.ZijianStarterWheel?.isOpen() || !!window.ZijianShare?.isOpen() || !!window.ZijianBilling?.isOpen();
  const drawnDays = () => state.starterDraw?.status === "pending" && Number.isInteger(state.starterDraw.days)
    && state.starterDraw.days >= 3 && state.starterDraw.days <= 7 ? state.starterDraw.days : 0;
  const accountName = () => state.user?.email || state.user?.phone || "我的账户";
  const shortAccountName = () => state.user?.email
    ? (state.user.email.length > 22 ? `${state.user.email.slice(0, 18)}…` : state.user.email)
    : state.user?.phone ? `${state.user.phone.slice(0, 3)}****${state.user.phone.slice(-4)}` : "我的账户";

  // Reset and verification tokens are consumed from memory, never kept in the URL.
  try {
    const url = new URL(window.location.href);
    const invitation = url.searchParams.get("ref") || "";
    if (/^[A-Za-z0-9_-]{16,80}$/u.test(invitation)) referralCode = invitation;
    else if (url.searchParams.has("ref")) url.searchParams.delete("ref");
    resetToken = url.searchParams.get("reset") || "";
    bindToken = url.searchParams.get("bind") || "";
    if (resetToken || bindToken || invitation && !referralCode) {
      url.searchParams.delete("reset");
      url.searchParams.delete("bind");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  } catch { /* A local file page still displays a useful service message. */ }

  function message(text = "", error = false) {
    $("authMessage").textContent = text;
    $("authMessage").hidden = !text;
    $("authMessage").classList.toggle("is-error", error);
  }

  function announce() {
    window.dispatchEvent(new CustomEvent("authchange", { detail: state }));
  }

  function notifyOtherTabs() {
    channel?.postMessage("refresh");
    try { localStorage.setItem("zijian-account-change", `${Date.now()}-${Math.random()}`); } catch { /* Private browsing may disallow storage. */ }
  }

  function accept(data, notify = false) {
    if (!data || !Object.hasOwn(data, "user") || !data.entitlement || typeof data.csrfToken !== "string" || !time(data.serverTime)) return false;
    if (state.user?.id !== data.user?.id) grantNotice = "";
    state = data;
    unavailable = false;
    guestStartFailed = false;
    snapshotServerTime = time(data.serverTime);
    snapshotPerformance = performance.now();
    if (notify) stateRevision += 1;
    renderStatus();
    if (dialog.open && view === "account") renderView(state.user ? "account" : "login");
    announce();
    if (notify) notifyOtherTabs();
    return true;
  }

  async function request(path, body, isCurrent) {
    if (window.location.protocol === "file:") throw new Error("请通过网站或本地服务访问，才能开始体验。");
    if (body !== undefined && !state.csrfToken) {
      await refresh();
      if (!state.csrfToken || unavailable) throw new Error("账户服务暂时不可用，请稍后重新连接。");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    let response;
    try {
      response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": state.csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      throw new Error("暂时无法连接账户服务，请稍后重试。当前文章和输入仍保留在页面中。");
    } finally { clearTimeout(timeout); }
    let data;
    try { data = await response.json(); } catch { throw new Error("账户服务返回异常，请稍后重试。"); }
    if (isCurrent && !isCurrent()) {
      const error = new Error("账户已切换，请重新查看订单。");
      error.code = "AUTH_STATE_CHANGED";
      throw error;
    }
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/auth/login" && path !== "/api/auth/sms/login") void refresh();
      const error = new Error(typeof data.error === "string" ? data.error : "操作暂未完成，请稍后重试。");
      error.code = data.code;
      error.retryAfter = data.retryAfter;
      throw error;
    }
    if (body !== undefined) accept(data, true);
    return data;
  }

  async function billingRequest(path, body) {
    await ready;
    if (typeof path !== "string" || !/^\/api\/billing\/[A-Za-z0-9_/-]+$/u.test(path)) throw new Error("支付请求地址无效。");
    const userId = state.user?.id || null;
    const revision = stateRevision;
    return request(path, body, () => (state.user?.id || null) === userId && stateRevision === revision);
  }

  async function refresh() {
    if (refreshing) return refreshing;
    const revision = stateRevision;
    refreshing = (async () => {
      try {
        const data = await request("/api/auth/session");
        if (revision !== stateRevision) return;
        if (!accept(data)) throw new Error("账户状态暂时不可用。");
      } catch {
        if (revision !== stateRevision) return;
        unavailable = true;
        renderStatus();
        announce();
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  function renderStatus() {
    $("accountButton").textContent = state.user ? shortAccountName() : "登录 / 注册";
    $("accountButton").title = state.user ? accountName() : "登录或注册账户";
    let title = "免登录体验 24 小时";
    let description = "首次练习时开始连续计时；登录或注册后可在账户中查看新手券。";
    $("accessRetry").hidden = !unavailable && !guestStartFailed;
    if (unavailable) {
      title = "账户服务暂未连接";
      description = window.location.protocol === "file:"
        ? "请通过网站或本地服务访问，以开始免登录体验。"
        : "请恢复连接后重试。当前文章和输入仍可查看、复制。";
    } else if (guestStartFailed) {
      title = "体验暂未开启";
      description = "请重试连接；文章和已输入的文字会保留。";
    } else if (hasAccess() && state.entitlement.source === "guest") {
      title = "游客体验";
      description = `${expiryLabel()} 到期；可在右上角账户中领取或兑换时长券。`;
    } else if (hasAccess()) {
      title = "练习时长";
      description = `${expiryLabel()} 到期${canClaim() ? "；可在账户中领取 3–7 天新手券" : ""}。`;
    } else if (canClaim()) {
      title = canStartGuest() ? "免登录体验 24 小时" : "新手券待领取";
      description = "在右上角账户中领取 3–7 天新手券，游客剩余时长会一并保留。";
    } else if (state.guest?.status !== "available" && !state.user) {
      title = state.guest?.status === "transferred" ? "登录原账户继续" : "游客体验已结束";
      description = state.guest?.status === "transferred" ? "登录原账户继续使用。文章和当前输入仍可查看、复制。" : "登录后可领取新手券或兑换渠道券。文章和当前输入仍可查看、复制。";
    } else if (state.guest?.status !== "available") {
      title = "练习时长已用完";
      description = "可在右上角账户中兑换时长券继续练习；文章和当前输入仍可查看、复制。";
    }
    if ($("accessTitle").textContent !== title) $("accessTitle").textContent = title;
    $("accessStatus").title = description;
    $("plansTrialAction").hidden = !!state.user && !canClaim();
    $("plansTrialAction").textContent = drawnDays() ? `领取抽中的 ${drawnDays()} 天` : "抽 3–7 天新手券";
    $("accessCountdown").hidden = !hasAccess();
    tick();
  }

  function tick() {
    if (accessEnd() && state.entitlement.hasAccess) {
      const remaining = Math.max(0, accessEnd() - serverNow());
      if (remaining <= 0) {
        state = { ...state, guest: state.entitlement.source === "guest" ? { ...state.guest, status: "expired" } : state.guest,
          entitlement: { ...state.entitlement, status: "expired", hasAccess: false } };
        renderStatus();
        announce();
        return;
      }
      const seconds = Math.ceil(remaining / 1000);
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor(seconds % 86400 / 3600);
      const minutes = Math.floor(seconds % 3600 / 60);
      const label = `剩余 ${days ? `${days} 天 ` : ""}${hours} 小时 ${String(minutes).padStart(2, "0")} 分`;
      if ($("accessCountdown").textContent !== label) $("accessCountdown").textContent = label;
    }
    const send = content.querySelector("[data-send-code]");
    if (send) {
      const seconds = Math.max(0, Math.ceil((sendUntil - performance.now()) / 1000));
      send.disabled = busy || seconds > 0 || state.providers.sms === false;
      send.textContent = seconds ? `${seconds} 秒后重发` : "获取验证码";
    }
  }

  function field(id, label, type = "text", extra = "") {
    return `<label class="auth-field" for="${id}"><span>${label}</span><input id="${id}" name="${id}" type="${type}" required ${extra}></label>`;
  }
  const emailField = () => field("authEmail", "邮箱", "email", 'autocomplete="username" maxlength="254" placeholder="yourname@example.com"');
  const passwordField = (label = "密码", current = false) => field("authPassword", label, "password", `autocomplete="${current ? "current-password" : "new-password"}" minlength="8" maxlength="128" placeholder="至少 8 个字符"`);
  const phoneField = () => field("authPhone", "中国大陆手机号", "tel", 'autocomplete="tel-national" inputmode="tel" pattern="1[3-9][0-9]{9}" maxlength="11" placeholder="请输入 11 位手机号"');
  const codeField = () => `<div class="auth-code-row">${field("authCode", "短信验证码", "text", 'autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="6 位验证码"')}<button class="button button-secondary" type="button" data-send-code>获取验证码</button></div>`;
  const submit = label => `<button type="submit" class="button button-primary auth-submit">${label}</button>`;
  const route = (label, target) => `<button type="button" class="auth-text-button" data-auth-view="${target}">${label}</button>`;
  const form = body => `<form id="authForm" class="auth-form">${body}</form>`;

  function starterDescription() {
    const starter = state.starter || {};
    if (starter.status === "available") return `${drawnDays() ? `已抽中 ${drawnDays()} 天，待领取 · ` : "可抽取 3–7 天新手券 · "}${new Date(time(starter.claimDeadline)).toLocaleString("zh-CN", { hour12: false })} 前领取`;
    if (starter.status === "claimed") return `已领取 ${starter.days || ""} 天新手券`;
    if (starter.status === "browser_used") return "当前浏览器已领取过新手奖励";
    if (starter.status === "expired") return "已超过注册后 7 天领取期限";
    if (starter.status === "legacy_claimed") return "已领取过原有新手试用";
    return "登录后可查看领取资格";
  }

  function renderView(next, notice = "") {
    if (!SHOW_SMS_AUTH && next === "sms") next = "login";
    if (!SHOW_SMS_AUTH && next === "bindPhone") next = state.user ? "account" : "login";
    view = next;
    message(notice);
    const definitions = {
      sms: ["欢迎回来", "短信验证码登录，首次登录将自动创建账户。", `<div class="auth-tabs" role="group" aria-label="登录方式"><button type="button" class="is-selected" data-auth-view="sms" aria-pressed="true">短信登录</button><button type="button" data-auth-view="login" aria-pressed="false">邮箱登录</button></div>${form(phoneField() + codeField() + submit("登录 / 注册"))}<p class="auth-footnote">仅支持中国大陆手机号。登录状态最长保留 365 天；你可以随时退出。</p>`],
      login: ["欢迎回来", "使用邮箱与密码登录，继续你的练习。", `${SHOW_SMS_AUTH ? '<div class="auth-tabs" role="group" aria-label="登录方式"><button type="button" data-auth-view="sms" aria-pressed="false">短信登录</button><button type="button" class="is-selected" data-auth-view="login" aria-pressed="true">邮箱登录</button></div>' : ""}${form(emailField() + passwordField("密码", true) + submit("登录"))}<div class="auth-links">${route("注册邮箱账户", "register")}${route("忘记密码？", "forgot")}</div><p class="auth-footnote">登录状态最长保留 365 天；你可以随时退出。</p>`],
      register: ["创建你的账户", "注册后 7 天内可领取一次 3–7 天新手券；注册本身不会自动领取。", form(emailField() + passwordField("设置密码") + submit("注册并登录")) + `<div class="auth-links">${SHOW_SMS_AUTH ? route("短信登录 / 注册", "sms") : ""}${route("已有账户，去登录", "login")}</div><p class="auth-footnote">无需邮箱验证码。请填写你能收信的邮箱，找回密码时会向该邮箱发送邮件。</p>`],
      forgot: ["找回密码", "填写注册邮箱，我们会向该邮箱发送密码重置链接。", form(emailField() + submit("发送重置邮件")) + `<div class="auth-links">${route("返回邮箱登录", "login")}</div>`],
      reset: ["设置新密码", "重置成功后，原有登录状态将失效，请使用新密码重新登录。", form(passwordField("新密码") + submit("重置密码"))],
      bindEmail: [state.user?.email ? "验证邮箱" : "绑定邮箱", state.user?.email ? "确认邮箱归属。请输入当前邮箱与登录密码，接收确认邮件。" : "添加邮箱与密码登录方式。确认邮件中的链接后生效。", form(emailField() + passwordField(state.user?.email ? "当前密码" : "设置密码", !!state.user?.email) + submit("发送确认邮件")) + `<div class="auth-links">${route("返回我的账户", "account")}</div>`],
      bindPhone: ["绑定手机号", "验证手机后，可使用短信登录同一账户。", form(phoneField() + codeField() + submit("验证并绑定")) + `<div class="auth-links">${route("返回我的账户", "account")}</div>`],
      changePassword: ["修改密码", "修改后将退出已有登录，请使用新密码重新登录。", form(field("authCurrentPassword", "当前密码", "password", 'autocomplete="current-password" maxlength="128"') + passwordField("新密码") + submit("修改密码")) + `<div class="auth-links">${route("返回我的账户", "account")}</div>`],
      confirmEmail: ["确认邮箱", "正在确认邮件中的链接…", ""],
      redeem: ["兑换时长券", "兑换成功立即生效；已有有效期会顺延，到期后从兑换时开始计时。", form(field("couponCode", "活动兑换码", "text", 'autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="80" placeholder="输入你获得的兑换码"') + submit("兑换并延长时长")) + `<p class="auth-footnote">同一活动限每账号兑换一次，不同活动可叠加，也可与新手券及付费时长叠加。请在活动截止前兑换。</p><div class="auth-links">${route("返回我的账户", "account")}</div>`],
    };
    if (pendingStarter && drawnDays() && ["sms", "login", "register"].includes(next)) {
      definitions[next][1] = `你已抽中 ${drawnDays()} 天练习时长，${next === "register" ? "注册" : "登录或注册"}完成后按资格领取并立即生效。`;
      const label = next === "register" ? "注册并领取" : next === "sms" ? "登录 / 注册并领取" : "登录并领取";
      definitions[next][2] = definitions[next][2].replace(/(<button type="submit"[^>]*>)[^<]*(<\/button>)/u, `$1${label} ${drawnDays()} 天$2`);
    }
    if (next === "account") {
      $("authTitle").textContent = "我的账户";
      $("authDescription").textContent = "同一账户的练习权益在不同设备间保持一致，范文仅保存在当前浏览器。";
      const phoneDetails = SHOW_SMS_AUTH || state.user?.phone ? '<div><dt>手机</dt><dd id="accountPhone"></dd></div>' : "";
      content.innerHTML = '<dl class="account-details"><div><dt>邮箱</dt><dd id="accountEmail"></dd></div>' + phoneDetails + '<div><dt>练习时长</dt><dd id="accountEntitlement"></dd></div><div><dt>新手奖励</dt><dd id="accountStarter"></dd></div></dl><div id="accountActions" class="account-actions"></div>';
      $("accountEmail").textContent = state.user?.email ? `${state.user.email}${state.user.emailVerified ? " · 已验证" : " · 未验证"}` : "尚未绑定";
      if (SHOW_SMS_AUTH || state.user?.phone) $("accountPhone").textContent = state.user?.phone || "尚未绑定";
      $("accountEntitlement").textContent = hasAccess() ? `${state.entitlement.source === "guest" ? "游客体验" : "有效期"}至 ${expiryLabel()}` : canStartGuest() ? "游客 24 小时体验尚未开始" : "当前无可用时长";
      $("accountStarter").textContent = starterDescription();
      const actions = $("accountActions");
      if (canClaim()) {
        actions.innerHTML += `<button type="button" class="button button-primary" data-open-starter>${drawnDays() ? `领取抽中的 ${drawnDays()} 天` : "抽 3–7 天新手券"}</button><p class="coupon-rules">3、4、5、6、7 天各有 20% 机会，抽奖结果固定，领取即生效。游客剩余时长会一并转入；未开始体验时保留完整 24 小时。每账号、每浏览器限一份新手奖励。</p>`;
      }
      actions.innerHTML += route("兑换时长券", "redeem");
      if (!state.user?.email || !state.user.emailVerified) actions.innerHTML += route(state.user?.email ? "验证邮箱" : "绑定邮箱", "bindEmail");
      if (SHOW_SMS_AUTH && !state.user?.phone && (!state.user?.email || state.user.emailVerified)) actions.innerHTML += route("绑定手机号", "bindPhone");
      if (state.user?.email) actions.innerHTML += route("修改密码", "changePassword");
      actions.innerHTML += '<button type="button" class="auth-text-button" data-open-plans>查看套餐</button><button type="button" class="auth-text-button" data-open-billing-history>订单记录</button><button type="button" class="auth-text-button account-logout" data-logout>退出登录</button>';
      if (SHOW_SMS_AUTH && state.user?.email && !state.user.emailVerified && !state.user.phone) {
        const note = document.createElement("p");
        note.className = "auth-footnote";
        note.textContent = "邮箱注册不要求验证。为保护账户，绑定手机号前需要先验证当前邮箱；这不影响领取时长券和练习。";
        content.append(note);
      }
    } else {
      const selected = definitions[next] || definitions.login;
      $("authTitle").textContent = selected[0];
      $("authDescription").textContent = selected[1];
      content.innerHTML = selected[2];
      if (["sms", "login", "register"].includes(next) && !state.user) {
        content.innerHTML += `<div class="auth-benefits">${pendingStarter ? "" : '<button type="button" class="auth-text-button" data-open-starter>抽 3–7 天新手券</button>'}<div class="auth-links"><button type="button" class="auth-text-button" data-open-redeem>兑换时长券</button><button type="button" class="auth-text-button" data-open-plans>查看套餐</button></div></div>`;
      }
      if (next === "bindEmail" && state.user?.email) {
        $("authEmail").value = state.user.email;
        $("authEmail").readOnly = true;
      } else if (pendingEmail && $("authEmail")) $("authEmail").value = pendingEmail;
      if (next === "redeem") $("couponCode").value = pendingCouponCode;
      if (["sms", "bindPhone"].includes(next) && state.providers.sms === false) message("短信服务暂不可用，请稍后重试，或使用邮箱登录。", true);
      if (["forgot", "bindEmail"].includes(next) && state.providers.email === false) message("邮件服务暂不可用，请稍后重试。", true);
    }
    content.querySelectorAll("[data-auth-view]").forEach(button => button.addEventListener("click", () => renderView(button.dataset.authView)));
    content.querySelector("[data-send-code]")?.addEventListener("click", () => void sendCode());
    content.querySelector("[data-open-starter]")?.addEventListener("click", openStarterWheel);
    content.querySelector("[data-logout]")?.addEventListener("click", () => void logout());
    content.querySelector("[data-open-plans]")?.addEventListener("click", openPlans);
    content.querySelector("[data-open-billing-history]")?.addEventListener("click", () => window.ZijianBilling?.openHistory());
    content.querySelector("[data-open-redeem]")?.addEventListener("click", openRedeem);
    content.querySelector("#authForm")?.addEventListener("submit", event => { event.preventDefault(); void submitForm(); });
    setBusy(busy);
  }

  function open(next = state.user ? "account" : SHOW_SMS_AUTH ? "sms" : "login", notice = "") {
    window.ZijianBilling?.close();
    window.ZijianShare?.close();
    window.ZijianStarterWheel?.close();
    if (plans.open) plans.close();
    renderView(next, notice);
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => content.querySelector("input:not([readonly]),button")?.focus({ preventScroll: true }));
  }

  function openPlans() {
    window.ZijianBilling?.close();
    window.ZijianShare?.close();
    window.ZijianStarterWheel?.close();
    if (dialog.open) dialog.close();
    renderStatus();
    if (!plans.open) plans.showModal();
  }

  function setBusy(value) {
    busy = value;
    content.querySelectorAll("button,input").forEach(node => { node.disabled = value; });
    content.setAttribute("aria-busy", String(value));
    tick();
  }

  async function sendCode() {
    if (!SHOW_SMS_AUTH || busy || sendUntil > performance.now()) return;
    const phone = $("authPhone").value.trim();
    if (!/^1[3-9]\d{9}$/u.test(phone)) { message("请填写有效的 11 位中国大陆手机号。", true); $("authPhone").focus(); return; }
    setBusy(true);
    message();
    try {
      const data = await request("/api/auth/sms/send", { phone, purpose: view === "bindPhone" ? "bind" : "login" });
      sendUntil = performance.now() + Math.max(60, Number(data.retryAfter) || 60) * 1000;
      message(data.message || "验证码已提交发送，请查看短信。验证码有效期为 5 分钟。");
    } catch (error) {
      if (error.retryAfter) sendUntil = performance.now() + Number(error.retryAfter) * 1000;
      message(error.message, true);
    } finally { setBusy(false); }
  }

  async function submitForm() {
    if (!SHOW_SMS_AUTH && ["sms", "bindPhone"].includes(view)) { renderView(state.user ? "account" : "login"); return; }
    const currentForm = $("authForm");
    if (busy || !currentForm?.reportValidity()) return;
    const email = $("authEmail")?.value.trim();
    const password = $("authPassword")?.value;
    const phone = $("authPhone")?.value.trim();
    const code = $("authCode")?.value.trim();
    const currentView = view;
    if (email) pendingEmail = email;
    const operations = {
      login: ["/api/auth/login", { email, password }],
      register: ["/api/auth/register", { email, password }],
      sms: ["/api/auth/sms/login", { phone, code }],
      forgot: ["/api/auth/password/forgot", { email }],
      reset: ["/api/auth/password/reset", { token: resetToken, password }],
      bindEmail: ["/api/auth/email/bind", { email, password }],
      bindPhone: ["/api/auth/phone/bind", { phone, code }],
      changePassword: ["/api/auth/password/change", { currentPassword: $("authCurrentPassword")?.value, password }],
      redeem: ["/api/coupons/redeem", { code: $("couponCode")?.value.trim() }],
    };
    const operation = operations[currentView];
    if (!operation) return;
    if (currentView === "redeem") pendingCouponCode = $("couponCode").value.trim();
    setBusy(true);
    message();
    try {
      if (currentView === "register" || currentView === "sms") {
        await ready;
        await recordReferral();
        // Existing cookies keep attribution even when Web Crypto is unavailable.
        operation[1].fingerprint = await fingerprint().catch(() => undefined);
      }
      const data = await request(...operation);
      if (["login", "register", "sms"].includes(currentView)) {
        if (pendingStarter) {
          pendingStarter = false;
          if (canClaim()) { busy = false; await claim(); }
          else renderView("account", `登录成功。此账号无法领取新手奖励：${starterDescription()}。`);
        } else if (bindToken) await confirmEmail();
        else if (pendingRedeem) { pendingRedeem = false; renderView("redeem"); }
        else if (currentView === "register" || canClaim()) renderView("account", canClaim()
          ? `${currentView === "register" ? "注册" : "登录"}成功。新手券需主动领取，${canPractice() ? "当前体验仍可继续" : "领取后即可继续练习"}。`
          : `${currentView === "register" ? "注册" : "登录"}成功。下方可查看新手奖励资格，也可兑换活动时长券。`);
        else if (dialog.open) dialog.close();
      } else if (currentView === "redeem") {
        pendingCouponCode = "";
        grantNotice = "时长券兑换成功";
        renderStatus();
        renderView("account", data.message || `兑换成功，练习时长已延长至 ${expiryLabel()}。`);
      } else if (["forgot", "bindEmail"].includes(currentView)) {
        message(data.message || (currentView === "forgot" ? "如果该邮箱已注册，将收到密码重置邮件，请查收。" : "确认邮件已发送，请在邮件中完成验证。"));
      } else if (["reset", "changePassword"].includes(currentView)) {
        resetToken = "";
        await refresh();
        renderView("login", "密码已更新，请使用新密码登录。");
      } else if (currentView === "bindPhone") renderView("account", "手机号已绑定，可用于登录同一账户。");
    } catch (error) {
      message(error.message, true);
      if (error.code === "CSRF_INVALID") await refresh();
    } finally { setBusy(false); }
  }

  async function fingerprint() {
    try {
      if (!window.crypto?.subtle) throw new Error("Web Crypto unavailable");
      const value = JSON.stringify({ language: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: [screen.width, screen.height].sort((a, b) => a - b), colorDepth: screen.colorDepth,
        browser: navigator.userAgent, concurrency: navigator.hardwareConcurrency || 0 });
      const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    } catch { throw new Error("浏览器无法生成试用标识，请使用新版浏览器通过 HTTPS 或本地服务访问。"); }
  }

  function clearReferralCode() {
    referralCode = "";
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("ref");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch { /* Attribution lives on the server after a successful visit. */ }
  }

  async function recordReferral() {
    if (!referralCode) return;
    if (recordingReferral) return recordingReferral;
    recordingReferral = (async () => {
      try {
        await request("/api/referrals/visit", { code: referralCode, fingerprint: await fingerprint() });
        clearReferralCode();
      } catch (error) {
        if (["INVALID_REFERRAL", "REFERRAL_NOT_FOUND", "INVALID_REFERRAL_CODE"].includes(error.code)) clearReferralCode();
        else throw error;
      }
    })().finally(() => { recordingReferral = null; });
    return recordingReferral;
  }

  async function prepareReferral() {
    await ready;
    if (!state.user) throw new Error("请先登录，再生成专属邀请卡片。");
    await request("/api/referrals/prepare", { fingerprint: await fingerprint() });
    return state;
  }

  async function claim() {
    if (busy) return false;
    if (unavailable) { await refresh(); if (unavailable) { open(undefined, "账户服务暂不可用，请稍后重新连接。"); return false; } }
    if (!state.user) { openStarterRegistration(); return false; }
    if (!canClaim()) { open("account", `此账号无法领取新手奖励：${starterDescription()}。`); return false; }
    busy = true;
    $("plansTrialAction").disabled = true;
    if (dialog.open) setBusy(true);
    try {
      const data = await request("/api/coupons/starter/claim", { fingerprint: await fingerprint() });
      const days = data.starter?.days || data.lastGrant?.days;
      grantNotice = days ? `已领到 ${days} 天新手券` : "新手券已生效";
      renderStatus();
      open("account", `${grantNotice}，练习时长已延长至 ${expiryLabel()}。游客剩余时间已按规则保留。`);
      return true;
    } catch (error) {
      // A response can be lost after a successful commit. Recover the existing
      // reward before offering another attempt, without granting it twice.
      await refresh();
      if (!unavailable && state.starter?.status === "claimed") {
        open("account", `已领取 ${state.starter.days} 天新手券，练习时长至 ${expiryLabel()}。`);
        return true;
      }
      open("account", error.message);
      message(error.message, true);
      return false;
    }
    finally {
      busy = false;
      $("plansTrialAction").disabled = false;
      if (dialog.open) setBusy(false);
    }
  }

  async function drawStarter() {
    if (drawingStarter) return drawingStarter;
    drawingStarter = (async () => {
      await ready;
      if (unavailable) await refresh();
      if (unavailable) throw new Error("账户服务暂不可用，请稍后重试。");
      try { return await request("/api/coupons/starter/draw", { fingerprint: await fingerprint() }); }
      catch (error) {
        await refresh();
        if (!unavailable && drawnDays()) return state;
        throw error;
      }
    })().finally(() => { drawingStarter = null; });
    return drawingStarter;
  }

  function openStarterWheel() {
    window.ZijianBilling?.close();
    window.ZijianShare?.close();
    if (dialog.open) dialog.close();
    if (plans.open) plans.close();
    window.ZijianStarterWheel?.open();
  }

  function openStarterRegistration() {
    pendingStarter = !!drawnDays();
    pendingRedeem = false;
    open("register");
  }

  function openStarterLogin() {
    pendingStarter = !!drawnDays();
    pendingRedeem = false;
    open("login");
  }

  async function logout() {
    if (busy) return;
    setBusy(true);
    try { await request("/api/auth/logout", {}); await refresh(); open("login", "已退出登录，当前页面的文章和输入已保留。"); }
    catch (error) { message(error.message, true); }
    finally { setBusy(false); }
  }

  function accessAction() {
    if (unavailable) { void refresh(); return; }
    if (guestStartFailed) { guestStartFailed = false; void ensureAccess(); return; }
    if (!state.user || canClaim()) openStarterWheel();
    else if (hasAccess() || canStartGuest()) open("account");
    else openRedeem();
  }

  function requireAccess() {
    if (hasAccess()) return true;
    if (canStartGuest()) { void ensureAccess(); return true; }
    if (unavailable) open(state.user ? "account" : "login", "请恢复与账户服务的连接后再开始练习。");
    else if (guestStartFailed) { guestStartFailed = false; void ensureAccess(); }
    else if (!state.user) open("login", state.guest?.status === "transferred" ? "游客时长已转入账户，请登录继续练习。" : "免登录体验已结束，登录后可领取新手券或兑换时长券。");
    else open("account", canClaim() ? "领取新手券即可继续练习，领取后立即开始连续计时。" : "当前没有可用时长，可以兑换渠道时长券。文章和输入会保留。");
    return false;
  }

  async function ensureAccess() {
    if (hasAccess()) return true;
    if (startingGuest) return startingGuest;
    startingGuest = (async () => {
      await ready;
      if (hasAccess()) return true;
      if (!canStartGuest()) { requireAccess(); return false; }
      try {
        await request("/api/guest/start", { fingerprint: await fingerprint() });
        if (hasAccess()) return true;
        requireAccess();
      } catch (error) {
        // Resolve an uncertain POST before letting the learner retry: the server
        // may already have started the same one-time guest period.
        await refresh();
        if (hasAccess()) return true;
        guestStartFailed = true;
        renderStatus();
        $("accessTitle").textContent = "体验暂未开启";
        $("accessStatus").title = error.message;
        announce();
      }
      return false;
    })().finally(() => { startingGuest = null; });
    return startingGuest;
  }

  function runWithAccess(action) {
    if (hasAccess()) return action();
    return ensureAccess().then(allowed => allowed ? action() : undefined);
  }

  function openRedeem() {
    pendingStarter = false;
    if (!state.user) {
      pendingRedeem = true;
      open("login", "请先登录或注册，再兑换时长券。兑换成功后立即延长账户有效期。");
    } else open("redeem");
  }

  async function confirmEmail() {
    if (!bindToken) return;
    if (!state.user) {
      open("login", `请先登录要绑定邮箱的原账户，再完成邮箱确认。${SHOW_SMS_AUTH ? "短信账户可切换到短信登录。" : "请在原账户仍保持登录的浏览器中打开确认链接。"}`);
      return;
    }
    open("confirmEmail");
    try {
      const data = await request("/api/auth/email/confirm", { token: bindToken });
      bindToken = "";
      await refresh();
      open(state.user ? "account" : "login", data.message || "邮箱已确认，可以使用邮箱与密码登录。");
    } catch (error) {
      if (error.code === "INVALID_TOKEN") bindToken = "";
      renderView(state.user ? "account" : "login", error.message);
      message(error.message, true);
    }
  }

  $("accountButton").addEventListener("click", () => open());
  $("accessRetry").addEventListener("click", accessAction);
  $("plansTrialAction").addEventListener("click", accessAction);
  $("closeAuth").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { pendingStarter = false; pendingRedeem = false; });
  $("closePlans").addEventListener("click", () => plans.close());
  $("plansDone").addEventListener("click", () => plans.close());
  [dialog, plans].forEach(panel => panel.addEventListener("click", event => {
    if (event.target !== panel) return;
    const rect = panel.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) panel.close();
  }));
  document.addEventListener("beforeinput", event => {
    if (event.target.matches?.("#typingInput,.sentence-answer") && !requireAccess()) event.preventDefault();
  }, true);
  document.addEventListener("input", event => {
    if (event.target.matches?.("#typingInput,.sentence-answer") && !hasAccess()) requireAccess();
  }, true);
  window.addEventListener("focus", () => void refresh());
  window.addEventListener("pageshow", () => void refresh());
  window.addEventListener("storage", event => { if (event.key === "zijian-account-change") void refresh(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  try { channel = new BroadcastChannel("zijian-account"); channel.onmessage = () => void refresh(); } catch { /* Storage events still synchronize tabs. */ }
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
  renderStatus();
  const ready = refresh().then(async () => {
    // A referral visit records attribution without starting the guest clock.
    await recordReferral().catch(() => {});
    if (resetToken) open("reset");
    else if (bindToken) await confirmEmail();
  });
  window.ZijianAuth = Object.freeze({ hasAccess, canPractice, ensureAccess, runWithAccess, requireAccess, open, openPlans, openRedeem, isDialogOpen, refresh, ready, drawStarter, claimStarter: claim, openStarterRegistration, openStarterLogin, prepareReferral, billingRequest, getState: () => state });
})();
