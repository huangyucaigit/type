'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let modulePromise;
const load = () => modulePromise ||= import('../coupon-admin.mjs');
const fixture = overrides => ({
  id: 'summer-launch',
  title: '体验活动',
  days: 7,
  startsAt: '2026-10-20T00:00:00+08:00',
  endsAt: '2027-11-01T00:00:00+08:00',
  maxRedemptions: 200,
  codes: [{ code: ' summer-xhs ', channel: ' 小红书 ' }, { code: 'SUMMER-DY', channel: '抖音' }],
  ...overrides,
});

function output() {
  const out = [], errors = [];
  return { out, errors, write: text => out.push(text), writeError: text => errors.push(text) };
}

test('CLI requires explicit subcommands and rejects ambiguous, missing or repeated arguments', async () => {
  const { parseCouponArgs, CouponAdminUsageError } = await load();
  assert.deepEqual(parseCouponArgs(['create', '--file', '活动.json', '--database', 'private.sqlite']), {
    command: 'create', file: '活动.json', filename: 'private.sqlite',
  });
  assert.deepEqual(parseCouponArgs(['disable', '--database', 'private.sqlite', 'summer-launch']), {
    command: 'disable', filename: 'private.sqlite', id: 'summer-launch',
  });
  for (const args of [[], ['delete', 'summer-launch'], ['create'], ['list', '--file', 'x.json'],
    ['create', '--file', '--database', 'x'], ['list', '--database', 'a', '--database', 'b'],
    ['disable'], ['enable', 'x'], ['enable', 'summer-launch', 'other'], ['list', '--unknown']]) {
    assert.throws(() => parseCouponArgs(args), CouponAdminUsageError, args.join(' '));
  }
});

test('configuration maps explicit timezone dates and normalizes distributed codes and channels', async () => {
  const { normalizeCampaignConfig } = await load();
  const config = normalizeCampaignConfig(fixture());
  assert.equal(config.startsAt, Date.UTC(2026, 9, 19, 16));
  assert.equal(config.endsAt, Date.UTC(2027, 9, 31, 16));
  assert.deepEqual(config.codes, [{ code: 'SUMMER-XHS', channel: '小红书' }, { code: 'SUMMER-DY', channel: '抖音' }]);
  const withoutStart = fixture();
  delete withoutStart.startsAt;
  assert.equal(Object.hasOwn(normalizeCampaignConfig(withoutStart), 'startsAt'), false);
});

test('configuration rejects ambiguous dates, calendar rollover and invalid or silently ignored values', async () => {
  const { normalizeCampaignConfig, CouponConfigError } = await load();
  for (const config of [null, [], fixture({ typo: true }), fixture({ days: '7' }), fixture({ days: 366 }),
    fixture({ maxRedemptions: 0 }), fixture({ maxRedemptions: 1000001 }), fixture({ id: 'x' }),
    fixture({ title: ' ' }), fixture({ codes: [] }), fixture({ codes: [{ code: 'A B', channel: 'x' }] }),
    fixture({ codes: [{ code: 'DUP', channel: 'x' }, { code: ' dup ', channel: 'y' }] }),
    fixture({ codes: [{ code: 'VALID', channel: 'x', days: 99 }] }),
    fixture({ endsAt: '2027-11-01T00:00:00' }), fixture({ endsAt: 1793462400000 }),
    fixture({ endsAt: '2027-02-29T00:00:00Z' }), fixture({ endsAt: '2027-04-31T00:00:00Z' }),
    fixture({ endsAt: '2027-11-01T24:00:00Z' }), fixture({ endsAt: '2027-11-01T00:00:60Z' }),
    fixture({ endsAt: '2027-11-01T00:00:00+24:00' }), fixture({ endsAt: '2026-10-19T00:00:00Z' })]) {
    assert.throws(() => normalizeCampaignConfig(config), CouponConfigError, JSON.stringify(config));
  }
  assert.equal(normalizeCampaignConfig(fixture({ endsAt: '2028-02-29T00:00:00.123Z' })).endsAt, Date.UTC(2028, 1, 29, 0, 0, 0, 123));
});

test('help and invalid input never open storage, and expected failures return useful exit codes', async () => {
  const { runCouponAdmin } = await load();
  let opened = 0;
  const factory = () => { opened += 1; throw new Error('should not open'); };
  const help = output();
  assert.equal(await runCouponAdmin(['--help'], { ...help, createService: factory }), 0);
  assert.match(help.out[0], /create --file/);
  const badArgs = output();
  assert.equal(await runCouponAdmin([], { ...badArgs, createService: factory }), 2);
  assert.match(badArgs.errors[0], /明确指定/);
  for (const source of ['{broken', JSON.stringify(fixture({ days: -1 }))]) {
    const result = output();
    assert.equal(await runCouponAdmin(['create', '--file', 'input.json'], {
      ...result, createService: factory, readFile: async () => source,
    }), 1);
    assert.match(result.errors[0], /INVALID_CAMPAIGN/);
  }
  const absent = output();
  assert.equal(await runCouponAdmin(['create', '--file', 'absent.json'], {
    ...absent, createService: factory, readFile: async () => { throw new Error('ENOENT'); },
  }), 1);
  assert.match(absent.errors[0], /无法读取/);
  assert.equal(opened, 0);
});

test('CLI create passes only validated business fields and explicit private database to the service', async () => {
  const { runCouponAdmin } = await load();
  const captured = [], result = output();
  let closed = false;
  const exitCode = await runCouponAdmin(['create', '--file', 'activity.json', '--database', 'isolated.sqlite'], {
    ...result,
    readFile: async () => `\uFEFF${JSON.stringify(fixture())}`,
    createService: options => {
      assert.deepEqual(options, { filename: 'isolated.sqlite' });
      return {
        createCampaign: config => { captured.push(config); return { ...config, enabled: true, redemptions: 0, codes: config.codes.map(code => ({ ...code, redemptions: 0 })) }; },
        close: () => { closed = true; },
      };
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(closed, true);
  assert.equal(captured[0].days, 7);
  assert.equal(captured[0].maxRedemptions, 200);
  const campaign = JSON.parse(result.out[0]).campaign;
  assert.equal(campaign.startsAt, '2026-10-19T16:00:00.000Z');
  assert.equal(campaign.codes[0].code, 'SUMMER-XHS');
});

test('listing and disabling output statistics without printing distribution codes', async () => {
  const { runCouponAdmin, normalizeCampaignConfig } = await load();
  const campaign = { ...normalizeCampaignConfig(fixture()), enabled: true, redemptions: 8,
    codes: [{ code: 'DO-NOT-PRINT', channel: '小红书', redemptions: 8 }] };
  let closed = 0;
  const list = output();
  assert.equal(await runCouponAdmin(['list'], {
    ...list, createService: options => { assert.deepEqual(options, {}); return { getCampaigns: () => [campaign], close: () => { closed += 1; } }; },
  }), 0);
  const summary = JSON.parse(list.out[0]).campaigns[0];
  assert.equal(summary.redemptions, 8);
  assert.equal(summary.codeCount, 1);
  assert.deepEqual(summary.channels, [{ channel: '小红书', redemptions: 8 }]);
  assert.doesNotMatch(list.out[0], /DO-NOT-PRINT/);
  const disable = output();
  assert.equal(await runCouponAdmin(['disable', campaign.id], {
    ...disable, createService: () => ({
      setCampaignEnabled: (id, enabled) => { assert.equal(id, campaign.id); assert.equal(enabled, false); return { ...campaign, enabled }; },
      close: () => { closed += 1; },
    }),
  }), 0);
  assert.equal(JSON.parse(disable.out[0]).campaign.enabled, false);
  assert.doesNotMatch(disable.out[0], /DO-NOT-PRINT/);
  assert.equal(closed, 2);
});

test('operation failures close storage and do not expose unexpected internals', async () => {
  const { runCouponAdmin } = await load();
  let closed = 0;
  const result = output();
  assert.equal(await runCouponAdmin(['list'], { ...result, createService: () => ({
    getCampaigns: () => { throw new Error('private-environment-value'); },
    close: () => { closed += 1; },
  }) }), 1);
  assert.equal(closed, 1);
  assert.doesNotMatch(result.errors.join(''), /private-environment-value/);
});

test('CLI main uses .env data directory, preserves external environment, and lets explicit database win', async t => {
  const { runCouponAdminMain } = await load();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-coupon-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = process.env.ZIJIAN_AUTH_DATA_DIR;
  const fromFile = path.join(directory, 'from-file'), fromProcess = path.join(directory, 'from-process');
  const envFilename = path.join(directory, 'private.env');
  await writeFile(envFilename, `ZIJIAN_AUTH_DATA_DIR=${fromFile.replaceAll('\\', '/')}\n`, 'utf8');
  try {
    delete process.env.ZIJIAN_AUTH_DATA_DIR;
    const fileResult = output();
    assert.equal(await runCouponAdminMain(['list'], { ...fileResult, envFilename }), 0);
    assert.equal(existsSync(path.join(fromFile, 'auth.sqlite')), true);
    process.env.ZIJIAN_AUTH_DATA_DIR = fromProcess;
    const processResult = output();
    assert.equal(await runCouponAdminMain(['list'], { ...processResult, envFilename }), 0);
    assert.equal(process.env.ZIJIAN_AUTH_DATA_DIR, fromProcess);
    assert.equal(existsSync(path.join(fromProcess, 'auth.sqlite')), true);
    const explicit = path.join(directory, 'explicit.sqlite'), explicitResult = output();
    assert.equal(await runCouponAdminMain(['list', '--database', explicit], { ...explicitResult, envFilename }), 0);
    assert.equal(existsSync(explicit), true);
    assert.deepEqual(JSON.parse(explicitResult.out[0]), { campaigns: [] });
  } finally {
    if (original === undefined) delete process.env.ZIJIAN_AUTH_DATA_DIR;
    else process.env.ZIJIAN_AUTH_DATA_DIR = original;
  }
});

test('CLI main ignores absent .env and hides environment read errors before opening storage', async () => {
  const { runCouponAdminMain } = await load();
  let opened = 0;
  const createService = () => { opened += 1; return { getCampaigns: () => [], close() {} }; };
  const absent = output();
  assert.equal(await runCouponAdminMain(['list'], { ...absent, createService,
    loadEnvFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), 0);
  assert.equal(opened, 1);
  const denied = output();
  assert.equal(await runCouponAdminMain(['list'], { ...denied, createService,
    loadEnvFile: () => { throw Object.assign(new Error('private-environment-value'), { code: 'EACCES' }); },
  }), 1);
  assert.equal(opened, 1);
  assert.match(denied.errors[0], /无法读取 .env/);
  assert.doesNotMatch(denied.errors[0], /private-environment-value/);
});

test('CLI creates and preserves activities across restarts, and enable/disable retains issued configuration', async t => {
  const { runCouponAdmin } = await load();
  const { createAuthService } = await import('../auth-service.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zijian-coupon-admin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'private.sqlite'), configFile = path.join(directory, 'campaign.json');
  await writeFile(configFile, JSON.stringify(fixture()), 'utf8');
  const factory = options => createAuthService({ ...options, now: () => Date.UTC(2026, 9, 21) });
  const run = async args => {
    const result = output();
    const code = await runCouponAdmin([...args, '--database', filename], { ...result, createService: factory });
    return { code, ...result };
  };
  const created = await run(['create', '--file', configFile]);
  assert.equal(created.code, 0, created.errors.join(''));
  assert.equal(JSON.parse(created.out[0]).campaign.codes.length, 2);
  // Issue real test entitlement through the service, then verify maintenance only changes availability.
  const issuingService = factory({ filename }), jar = new Map();
  let csrfToken, issuedDeadline;
  const call = async (pathname, body) => {
    const captured = new Map();
    const request = { method: body === undefined ? 'GET' : 'POST', headers: {
      cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), 'x-csrf-token': csrfToken,
    } };
    const value = await issuingService.handle({ request, response: {
      getHeader: key => captured.get(key), setHeader: (key, value) => captured.set(key, value),
    }, pathname, body, origin: 'https://example.test', clientIp: '127.0.0.1', secure: true });
    for (const cookie of captured.get('Set-Cookie') || []) {
      const pair = cookie.split(';')[0], separator = pair.indexOf('=');
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    if (value.csrfToken) csrfToken = value.csrfToken;
    return value;
  };
  try {
    await call('/api/auth/session');
    await call('/api/auth/register', { email: 'coupon-cli@example.test', password: 'Private-test-password-17' });
    const redeemed = await call('/api/coupons/redeem', { code: 'SUMMER-XHS' });
    issuedDeadline = redeemed.entitlement.expiresAt;
    assert.equal(redeemed.lastGrant.days, 7);
  } finally { issuingService.close(); }
  const disabled = await run(['disable', 'summer-launch']);
  assert.equal(disabled.code, 0, disabled.errors.join(''));
  assert.equal(JSON.parse(disabled.out[0]).campaign.enabled, false);
  const listed = await run(['list']);
  assert.equal(listed.code, 0, listed.errors.join(''));
  assert.equal(JSON.parse(listed.out[0]).campaigns[0].enabled, false);
  assert.equal(JSON.parse(listed.out[0]).campaigns[0].redemptions, 1);
  const enabled = await run(['enable', 'summer-launch']);
  assert.equal(enabled.code, 0, enabled.errors.join(''));
  assert.equal(JSON.parse(enabled.out[0]).campaign.enabled, true);
  const duplicate = await run(['create', '--file', configFile]);
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.errors.join(''), /CAMPAIGN_CONFLICT/);
  const service = factory({ filename });
  try {
    const campaigns = service.getCampaigns();
    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0].redemptions, 1);
    assert.deepEqual(campaigns[0].codes.map(code => code.code).sort(), ['SUMMER-DY', 'SUMMER-XHS']);
    const access = await service.requireAccess({ headers: { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } });
    assert.equal(access.entitlement.expiresAt, issuedDeadline);
    assert.equal(access.entitlement.hasAccess, true);
  } finally { service.close(); }
});
