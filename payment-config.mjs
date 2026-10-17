import { PaymentError } from './payment-client.mjs';

export function readPaymentOptions(env = process.env) {
  const mode = (env.ZIJIAN_PAYMENT_MODE || 'disabled').trim();
  if (!['disabled', 'mock', 'live'].includes(mode)) throw new PaymentError('支付模式配置无效。', { code: 'PAYMENT_CONFIG_INVALID' });
  if (mode !== 'live') return { mode };
  if (env.ZIJIAN_ENABLE_REAL_PAYMENTS !== '1') throw new PaymentError('真实支付开关尚未启用。', { code: 'REAL_PAYMENTS_DISABLED' });
  let notifyKeys;
  if (env.PAY_NOTIFY_KEYS_JSON) {
    try { notifyKeys = JSON.parse(env.PAY_NOTIFY_KEYS_JSON); }
    catch { throw new PaymentError('通知密钥配置无效。', { code: 'PAYMENT_CONFIG_INVALID' }); }
  }
  return { mode, config: {
    baseUrl: env.PAY_BASE_URL || 'https://pay.where.work', projectCode: env.PAY_PROJECT_CODE,
    apiKeyId: env.PAY_API_KEY_ID, apiSecretBase64: env.PAY_API_SECRET_BASE64,
    notifyKeyId: env.PAY_NOTIFY_KEY_ID, notifySecretBase64: env.PAY_NOTIFY_SECRET_BASE64,
    notifyUrl: env.PAY_NOTIFY_URL, ...(notifyKeys ? { notifyKeys } : {}),
  } };
}
