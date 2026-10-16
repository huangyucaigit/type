import { createHash, createHmac, randomBytes } from 'node:crypto';

const SMS_HOST = 'dysmsapi.aliyuncs.com';
const EMAIL_PATH = '/v2/email/outbound-emails';
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest();
const percentEncode = value => encodeURIComponent(String(value))
  .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const canonicalQuery = query => Object.entries(query).map(([name, value]) => [percentEncode(name), percentEncode(value)])
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([name, value]) => `${name}=${value}`).join('&');

export class AuthProviderError extends Error {
  constructor(message, { status = 503, code = 'PROVIDER_UNAVAILABLE' } = {}) {
    super(message);
    this.name = 'AuthProviderError';
    this.status = status;
    this.code = code;
  }
}

// ACS3 reference and its fixed signing vector:
// https://www.alibabacloud.com/help/en/sdk/product-overview/v3-request-structure-and-signature
export function signAliyunRequest({ accessKeyId, accessKeySecret, host, action, version,
  method = 'POST', pathname = '/', query = {}, body = '', contentType,
  now = new Date(), nonce = randomBytes(16).toString('hex'), securityToken }) {
  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-version': version,
    'x-acs-date': now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': nonce,
    'x-acs-content-sha256': sha256(body),
  };
  if (contentType) headers['content-type'] = contentType;
  if (securityToken) headers['x-acs-security-token'] = securityToken;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map(name => `${name}:${String(headers[name]).trim()}\n`).join('');
  const queryString = canonicalQuery(query);
  const canonicalRequest = [method, pathname, queryString, canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const signature = hmac(accessKeySecret, `ACS3-HMAC-SHA256\n${sha256(canonicalRequest)}`).toString('hex');
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  headers.accept = 'application/json';
  return { url: `https://${host}${pathname}${queryString ? `?${queryString}` : ''}`, method, headers, body };
}

// AWS SigV4: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
export function signAwsRequest({ accessKeyId, secretAccessKey, region, host, service = 'ses',
  method = 'POST', pathname = EMAIL_PATH, query = {}, body = '', contentType = 'application/json',
  now = new Date(), sessionToken }) {
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const headers = { host, 'x-amz-date': timestamp };
  if (contentType) headers['content-type'] = contentType;
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map(name => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const queryString = canonicalQuery(query);
  const canonicalRequest = [method, pathname, queryString, canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  headers.accept = 'application/json';
  return { url: `https://${host}${pathname}${queryString ? `?${queryString}` : ''}`, method, headers, body };
}

function configurationValue(value, { max = 256 } = {}) {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\r\n\0]/.test(value)
    ? value.trim() : '';
}

function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@<>"\x00-\x1f]+@[^\s@<>"\x00-\x1f]+\.[^\s@<>"\x00-\x1f]+$/.test(email);
}

function validatedLink(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) return null;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return null;
    return url.href;
  } catch { return null; }
}

async function requestJson(fetchImpl, signedRequest, { kind, timeout }) {
  const message = kind === 'SMS' ? '短信发送暂时不可用，请稍后重试。' : '邮件发送暂时不可用，请稍后重试。';
  const failure = () => new AuthProviderError(message, { code: `${kind}_UNAVAILABLE` });
  try {
    // No automatic retry: both providers can accept a request before a timeout.
    const response = await fetchImpl(signedRequest.url, {
      method: signedRequest.method,
      headers: signedRequest.headers,
      body: signedRequest.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw failure();
    const text = await response.text();
    if (text.length > 32768) throw failure();
    const result = JSON.parse(text);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure();
    return result;
  } catch {
    // Provider error bodies and transport errors can include credentials or tokens.
    throw failure();
  }
}

export function createAuthProviders({ env = process.env, fetchImpl = fetch } = {}) {
  const sms = {
    accessKeyId: configurationValue(env.ALIYUN_ACCESS_KEY_ID),
    accessKeySecret: configurationValue(env.ALIYUN_ACCESS_KEY_SECRET),
    region: configurationValue(env.ALIYUN_SMS_REGION_ID || 'cn-hangzhou'),
    signName: configurationValue(env.ALIYUN_SMS_SIGN_NAME),
    template: configurationValue(env.ALIYUN_SMS_LOGIN_TEMPLATE_CODE),
    securityToken: configurationValue(env.ALIYUN_SECURITY_TOKEN, { max: 8192 }),
  };
  const email = {
    accessKeyId: configurationValue(env.AWS_ACCESS_KEY_ID),
    secretAccessKey: configurationValue(env.AWS_SECRET_ACCESS_KEY),
    region: configurationValue(env.AWS_REGION || 'us-east-1'),
    from: configurationValue(env.SES_FROM_EMAIL),
    sessionToken: configurationValue(env.AWS_SESSION_TOKEN, { max: 8192 }),
  };
  const status = Object.freeze({
    sms: Boolean(sms.accessKeyId && sms.accessKeySecret && sms.signName && /^SMS_\d+$/.test(sms.template)
      && /^[a-z]{2}(?:-[a-z0-9]+)+$/.test(sms.region)),
    email: Boolean(email.accessKeyId && email.secretAccessKey && validEmail(email.from)
      && /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(email.region)),
  });

  async function sendSms({ phone, code } = {}) {
    if (typeof phone !== 'string' || !/^1[3-9]\d{9}$/.test(phone)
      || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw new AuthProviderError('请输入有效的中国大陆手机号。', { status: 400, code: 'INVALID_INPUT' });
    }
    if (!status.sms) throw new AuthProviderError('短信登录暂未配置，请使用邮箱登录。', { code: 'SMS_UNAVAILABLE' });
    // RPC query parameters may be sent as a POST form. Keep codes out of URLs.
    const body = canonicalQuery({ PhoneNumbers: phone, SignName: sms.signName,
      TemplateCode: sms.template, TemplateParam: JSON.stringify({ code }), RegionId: sms.region });
    const request = signAliyunRequest({ ...sms, host: SMS_HOST, action: 'SendSms', version: '2017-05-25',
      body, contentType: 'application/x-www-form-urlencoded' });
    const result = await requestJson(fetchImpl, request, { kind: 'SMS', timeout: 15000 });
    if (result.Code !== 'OK') throw new AuthProviderError('短信发送暂时不可用，请稍后重试。', { code: 'SMS_UNAVAILABLE' });
    // Acceptance is distinct from carrier delivery; never return a fake OTP.
    return { accepted: true };
  }

  async function sendEmail({ email: recipient, url } = {}, purpose) {
    const link = validatedLink(url);
    if (!validEmail(recipient) || !link) {
      throw new AuthProviderError('邮件地址或操作链接无效。', { status: 400, code: 'INVALID_INPUT' });
    }
    if (!status.email) throw new AuthProviderError('邮件服务暂未配置，请稍后重试。', { code: 'EMAIL_UNAVAILABLE' });
    const reset = purpose === 'reset';
    const title = reset ? '重置密码' : '绑定邮箱';
    const body = JSON.stringify({ FromEmailAddress: email.from, Destination: { ToAddresses: [recipient] },
      Content: { Simple: { Subject: { Data: `【火星叔叔】${title}`, Charset: 'UTF-8' },
        Body: { Text: { Data: `你好，\n\n请打开以下链接完成${title}：\n${link}\n\n链接将在短时间内失效，请尽快完成。请勿转发此邮件。\n如果这不是你本人的操作，请忽略此邮件。\n\n火星叔叔 · 英语范文练习`, Charset: 'UTF-8' } } } } });
    const suffix = email.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
    const request = signAwsRequest({ ...email, host: `email.${email.region}.${suffix}`, body });
    const result = await requestJson(fetchImpl, request, { kind: 'EMAIL', timeout: 20000 });
    if (typeof result.MessageId !== 'string' || !result.MessageId) {
      throw new AuthProviderError('邮件发送暂时不可用，请稍后重试。', { code: 'EMAIL_UNAVAILABLE' });
    }
    return { accepted: true };
  }

  return { status, sendSms,
    sendResetEmail: args => sendEmail(args, 'reset'),
    sendBindEmail: args => sendEmail(args, 'bind') };
}
