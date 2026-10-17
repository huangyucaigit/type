'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('payments are disabled by default and mock mode never forwards real project secrets', async () => {
  const { readPaymentOptions } = await import('../payment-config.mjs');
  assert.deepEqual(readPaymentOptions({}), { mode: 'disabled' });
  assert.deepEqual(readPaymentOptions({ ZIJIAN_PAYMENT_MODE: 'mock', PAY_API_SECRET_BASE64: 'private-sentinel' }), { mode: 'mock' });
});
test('live payments require an independent explicit switch', async () => {
  const { readPaymentOptions } = await import('../payment-config.mjs');
  for (const flag of [undefined, '', '0', 'true']) {
    assert.throws(() => readPaymentOptions({ ZIJIAN_PAYMENT_MODE: 'live', ZIJIAN_ENABLE_REAL_PAYMENTS: flag }),
      error => error.code === 'REAL_PAYMENTS_DISABLED' && !error.message.includes('private-sentinel'));
  }
});
test('enabled live mode maps downloaded fields and independent notification key rotation', async () => {
  const { readPaymentOptions } = await import('../payment-config.mjs');
  const options = readPaymentOptions({ ZIJIAN_PAYMENT_MODE: 'live', ZIJIAN_ENABLE_REAL_PAYMENTS: '1',
    PAY_PROJECT_CODE: 'type-test', PAY_API_KEY_ID: 'api-test', PAY_API_SECRET_BASE64: 'test-api-key',
    PAY_NOTIFY_KEY_ID: 'notify-test', PAY_NOTIFY_SECRET_BASE64: 'test-notify-key',
    PAY_NOTIFY_URL: 'https://type.example.test/payments/notify', PAY_NOTIFY_KEYS_JSON: '{"notify-old":"test-old-key"}' });
  assert.equal(options.mode, 'live');
  assert.equal(options.config.baseUrl, 'https://pay.where.work');
  assert.equal(options.config.projectCode, 'type-test');
  assert.equal(options.config.apiSecretBase64, 'test-api-key');
  assert.equal(options.config.notifySecretBase64, 'test-notify-key');
  assert.deepEqual(options.config.notifyKeys, { 'notify-old': 'test-old-key' });
});
test('bad modes and malformed rotation JSON fail safely', async () => {
  const { readPaymentOptions } = await import('../payment-config.mjs');
  assert.throws(() => readPaymentOptions({ ZIJIAN_PAYMENT_MODE: 'automatic' }), error => error.code === 'PAYMENT_CONFIG_INVALID');
  assert.throws(() => readPaymentOptions({ ZIJIAN_PAYMENT_MODE: 'live', ZIJIAN_ENABLE_REAL_PAYMENTS: '1',
    PAY_NOTIFY_KEYS_JSON: 'private-sentinel-invalid-json' }), error => error.code === 'PAYMENT_CONFIG_INVALID' && !error.message.includes('sentinel'));
});
