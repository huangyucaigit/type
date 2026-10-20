'use strict';

// Existing AI route tests use a real registered account and a real starter coupon.
// Provider traffic is mocked; authorization itself is never bypassed.
async function createTestAuth(options = {}) {
  const { createAuthService } = await import('../auth-service.mjs');
  return createAuthService({ filename: ':memory:', drawStarterDays: () => 3, providers: {
    status: { sms: true, email: true },
    sendSms: async () => {}, sendResetEmail: async () => {}, sendBindEmail: async () => {},
  }, ...options });
}

async function authenticate(request, host) {
  const cookies = new Map();
  let csrfToken;
  const send = async (url, body) => {
    const result = await request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: `http://${host}`, 'Content-Type': 'application/json', Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = typeof result.headers.getSetCookie === 'function' ? result.headers.getSetCookie() : result.headers['set-cookie'] || [];
    for (const item of setCookies) {
      const pair = item.split(';')[0], equals = pair.indexOf('=');
      cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    const data = typeof result.json === 'function' ? await result.json() : JSON.parse(result.body);
    if (result.status !== 200) throw new Error(`Test authentication failed (${result.status}): ${data.error}`);
    csrfToken = data.csrfToken || csrfToken;
    return data;
  };
  await send('/api/auth/session');
  await send('/api/auth/register', { nickname: '练习同学', email: 'ai-route-test@example.test', password: 'Test-password-7239' });
  const state = await send('/api/coupons/starter/claim', { fingerprint: 'a'.repeat(64) });
  if (!state.entitlement.hasAccess) throw new Error('Test account did not receive its starter coupon.');
  return [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
}

module.exports = { createTestAuth, authenticate };
