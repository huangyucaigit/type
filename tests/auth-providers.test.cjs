const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const providersPromise = import('../auth-providers.mjs');

const configured = {
  ALIYUN_ACCESS_KEY_ID: 'sms-test-id',
  ALIYUN_ACCESS_KEY_SECRET: 'sms-test-secret',
  ALIYUN_SMS_REGION_ID: 'cn-hangzhou',
  ALIYUN_SMS_SIGN_NAME: '长沙松鼠信息火星叔叔',
  ALIYUN_SMS_LOGIN_TEMPLATE_CODE: 'SMS_172825132',
  AWS_ACCESS_KEY_ID: 'email-test-id',
  AWS_SECRET_ACCESS_KEY: 'email-test-secret',
  AWS_REGION: 'us-east-1',
  SES_FROM_EMAIL: 'sender@example.test',
};
const reset = { email: 'reader@example.test', url: 'https://type.example.test/?reset=single-use-token' };
const response = body => new Response(JSON.stringify(body), { status: 200 });

test('ACS3 signer matches the independent fixed vector from Alibaba Cloud', async () => {
  // https://www.alibabacloud.com/help/en/sdk/product-overview/v3-request-structure-and-signature
  const { signAliyunRequest } = await providersPromise;
  const signed = signAliyunRequest({ accessKeyId: 'YourAccessKeyId', accessKeySecret: 'YourAccessKeySecret',
    host: 'ecs.cn-shanghai.aliyuncs.com', action: 'RunInstances', version: '2014-05-26',
    now: new Date('2023-10-26T10:22:32Z'), nonce: '3156853299f313e23d1673dc12e1703d',
    query: { RegionId: 'cn-shanghai', ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd' } });
  assert.equal(signed.headers.authorization,
    'ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0');
  assert.equal(signed.headers['x-acs-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('AWS SigV4 signer matches the independent IAM ListUsers fixed vector from AWS', async () => {
  // https://aws.amazon.com/jp/builders-flash/202210/way-to-operate-api-2/
  const { signAwsRequest } = await providersPromise;
  const signed = signAwsRequest({ accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'iam',
    host: 'iam.amazonaws.com', method: 'GET', pathname: '/',
    contentType: 'application/x-www-form-urlencoded; charset=utf-8',
    query: { Version: '2010-05-08', Action: 'ListUsers' }, now: new Date('2015-08-30T12:36:00Z') });
  assert.equal(signed.headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
});

test('provider availability exposes booleans without credentials', async () => {
  const { createAuthProviders } = await providersPromise;
  assert.deepEqual(createAuthProviders({ env: {} }).status, { sms: false, email: false });
  const providers = createAuthProviders({ env: configured });
  assert.deepEqual(providers.status, { sms: true, email: true });
  assert.equal(Object.isFrozen(providers.status), true);
  assert.equal(JSON.stringify(providers.status).includes('secret'), false);
});

test('unconfigured providers return safe 503 without making requests', async () => {
  const { createAuthProviders, AuthProviderError } = await providersPromise;
  let calls = 0;
  const providers = createAuthProviders({ env: {}, fetchImpl: async () => { calls += 1; } });
  await assert.rejects(providers.sendSms({ phone: '13341313711', code: '124590' }), error =>
    error instanceof AuthProviderError && error.status === 503 && error.code === 'SMS_UNAVAILABLE');
  await assert.rejects(providers.sendResetEmail(reset), error => error.status === 503 && error.code === 'EMAIL_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('invalid or header-injecting configuration cannot enable providers', async () => {
  const { createAuthProviders } = await providersPromise;
  for (const changed of [
    { ALIYUN_ACCESS_KEY_ID: 'id\r\nother: header', AWS_ACCESS_KEY_ID: 'id\nother' },
    { ALIYUN_SMS_LOGIN_TEMPLATE_CODE: 'invalid', AWS_REGION: 'us-east-1/evil.test' },
    { ALIYUN_SMS_REGION_ID: 'cn-hangzhou/evil', SES_FROM_EMAIL: 'Name <sender@example.test>' },
  ]) {
    assert.deepEqual(createAuthProviders({ env: { ...configured, ...changed } }).status, { sms: false, email: false });
  }
});

test('SMS sends one signed HTTPS POST form with the selected signature and login template', async () => {
  const { createAuthProviders } = await providersPromise;
  let captured;
  let calls = 0;
  const providers = createAuthProviders({ env: configured, fetchImpl: async (url, options) => {
    calls += 1;
    captured = { url, ...options };
    return response({ Code: 'OK', BizId: 'accepted-only', RequestId: 'test-request' });
  } });
  assert.deepEqual(await providers.sendSms({ phone: '13341313711', code: '104592' }), { accepted: true });
  assert.equal(calls, 1);
  assert.equal(captured.url, 'https://dysmsapi.aliyuncs.com/');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(captured.headers['x-acs-action'], 'SendSms');
  assert.equal(captured.headers['x-acs-version'], '2017-05-25');
  assert.match(captured.headers.authorization, /^ACS3-HMAC-SHA256 Credential=sms-test-id,/);
  assert.match(captured.headers.authorization, /content-type;host;x-acs-action/);
  assert.equal(captured.headers['x-acs-content-sha256'], createHash('sha256').update(captured.body).digest('hex'));
  const form = new URLSearchParams(captured.body);
  assert.equal(form.get('PhoneNumbers'), '13341313711');
  assert.equal(form.get('SignName'), '长沙松鼠信息火星叔叔');
  assert.equal(form.get('TemplateCode'), 'SMS_172825132');
  assert.deepEqual(JSON.parse(form.get('TemplateParam')), { code: '104592' });
  assert.equal(captured.url.includes('104592'), false);
  assert.equal(captured.signal instanceof AbortSignal, true);
});

test('SMS rejects invalid numbers, batches, prefixes, and malformed codes before any send', async () => {
  const { createAuthProviders } = await providersPromise;
  let calls = 0;
  const providers = createAuthProviders({ env: configured, fetchImpl: async () => { calls += 1; } });
  for (const args of [undefined, {}, { phone: '+8613341313711', code: '123456' },
    { phone: '13341313711,18610455550', code: '123456' }, { phone: '12341313711', code: '123456' },
    { phone: '13341313711', code: 123456 }, { phone: '13341313711', code: '12345\n' }]) {
    await assert.rejects(providers.sendSms(args), error => error.status === 400 && error.code === 'INVALID_INPUT');
  }
  assert.equal(calls, 0);
});

test('a nonce is unique for each SMS request', async () => {
  const { createAuthProviders } = await providersPromise;
  const nonces = [];
  const providers = createAuthProviders({ env: configured, fetchImpl: async (url, options) => {
    nonces.push(options.headers['x-acs-signature-nonce']);
    return response({ Code: 'OK' });
  } });
  await providers.sendSms({ phone: '13341313711', code: '123456' });
  await providers.sendSms({ phone: '13341313711', code: '123456' });
  assert.match(nonces[0], /^[a-f0-9]{32}$/);
  assert.notEqual(nonces[0], nonces[1]);
});

test('SMS provider rejects business failures without returning sensitive provider messages', async () => {
  const { createAuthProviders } = await providersPromise;
  const providers = createAuthProviders({ env: configured, fetchImpl: async () =>
    response({ Code: 'isv.SMS_SIGNATURE_ILLEGAL', Message: 'sms-test-secret 123456 13341313711' }) });
  await assert.rejects(providers.sendSms({ phone: '13341313711', code: '123456' }), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'SMS_UNAVAILABLE');
    assert.equal(/secret|123456|13341313711/.test(error.stack), false);
    assert.equal('cause' in error, false);
    return true;
  });
});

test('SES reset and binding emails use signed HTTPS API requests and distinct UTF-8 content', async () => {
  const { createAuthProviders } = await providersPromise;
  const captured = [];
  const providers = createAuthProviders({ env: configured, fetchImpl: async (url, options) => {
    captured.push({ url, ...options });
    return response({ MessageId: 'provider-accepted-only' });
  } });
  assert.deepEqual(await providers.sendResetEmail(reset), { accepted: true });
  assert.deepEqual(await providers.sendBindEmail({ ...reset, url: 'https://type.example.test/?bind=token' }), { accepted: true });
  for (const request of captured) {
    assert.equal(request.url, 'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 Credential=email-test-id\/\d{8}\/us-east-1\/ses\/aws4_request,/);
    const payload = JSON.parse(request.body);
    assert.equal(payload.FromEmailAddress, 'sender@example.test');
    assert.deepEqual(payload.Destination, { ToAddresses: ['reader@example.test'] });
    assert.equal(payload.Content.Simple.Subject.Charset, 'UTF-8');
    assert.equal(payload.Content.Simple.Body.Text.Charset, 'UTF-8');
    assert.match(payload.Content.Simple.Body.Text.Data, /请勿转发/);
    assert.equal('Html' in payload.Content.Simple.Body, false);
  }
  assert.match(JSON.parse(captured[0].body).Content.Simple.Subject.Data, /重置密码/);
  assert.match(JSON.parse(captured[0].body).Content.Simple.Body.Text.Data, /https:\/\/type.example.test\/\?reset=single-use-token/);
  assert.match(JSON.parse(captured[1].body).Content.Simple.Subject.Data, /绑定邮箱/);
});

test('SES refuses invalid recipients and unsafe operation links', async () => {
  const { createAuthProviders } = await providersPromise;
  let calls = 0;
  const providers = createAuthProviders({ env: configured, fetchImpl: async () => { calls += 1; } });
  for (const args of [
    { ...reset, email: 'reader@example.test\r\nBcc:other@example.test' },
    { ...reset, email: 'reader@example.test,other@example.test' },
    { ...reset, url: 'javascript:alert(1)' },
    { ...reset, url: 'http://type.example.test/reset' },
    { ...reset, url: 'https://user:pass@type.example.test/reset' },
    { ...reset, url: 'https://type.example.test/\nreset' },
  ]) {
    await assert.rejects(providers.sendResetEmail(args), error => error.status === 400 && error.code === 'INVALID_INPUT');
  }
  assert.equal(calls, 0);
});

test('SES allows HTTP links only for local preview', async () => {
  const { createAuthProviders } = await providersPromise;
  const providers = createAuthProviders({ env: configured, fetchImpl: async () => response({ MessageId: 'accepted' }) });
  assert.deepEqual(await providers.sendResetEmail({ ...reset, url: 'http://127.0.0.1:4173/?reset=token' }), { accepted: true });
});

test('STS session credentials are included in the provider signatures', async () => {
  const { createAuthProviders } = await providersPromise;
  const captured = [];
  const providers = createAuthProviders({ env: { ...configured, AWS_SESSION_TOKEN: 'aws-session-token', ALIYUN_SECURITY_TOKEN: 'aliyun-session-token' },
    fetchImpl: async (url, options) => { captured.push(options.headers); return response({ Code: 'OK', MessageId: 'accepted' }); } });
  await providers.sendSms({ phone: '13341313711', code: '123456' });
  await providers.sendBindEmail(reset);
  assert.equal(captured[0]['x-acs-security-token'], 'aliyun-session-token');
  assert.match(captured[0].authorization, /x-acs-security-token;/);
  assert.equal(captured[1]['x-amz-security-token'], 'aws-session-token');
  assert.match(captured[1].authorization, /x-amz-security-token,/);
});

test('SES acceptance needs a MessageId and never treats a malformed success as sent', async () => {
  const { createAuthProviders } = await providersPromise;
  for (const body of [{}, { MessageId: '' }, { MessageId: 42 }, null, []]) {
    const providers = createAuthProviders({ env: configured, fetchImpl: async () => response(body) });
    await assert.rejects(providers.sendResetEmail(reset), error => error.status === 503 && error.code === 'EMAIL_UNAVAILABLE');
  }
});

test('network, timeout, HTTP, and malformed responses fail safely without retrying', async () => {
  const { createAuthProviders } = await providersPromise;
  for (const failure of [
    async () => { throw new Error('secret email-test-secret reset-token'); },
    async () => { throw new DOMException('secret', 'TimeoutError'); },
    async () => new Response('secret', { status: 429 }),
    async () => new Response('not JSON', { status: 200 }),
    async () => new Response('x'.repeat(32769), { status: 200 }),
  ]) {
    let calls = 0;
    const providers = createAuthProviders({ env: configured, fetchImpl: async (...args) => { calls += 1; return failure(...args); } });
    await assert.rejects(providers.sendResetEmail(reset), error => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'EMAIL_UNAVAILABLE');
      assert.equal(/secret|reset-token/.test(error.stack), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});
