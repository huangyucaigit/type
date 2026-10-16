import { readFile as readFileFromDisk } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `私有时长券活动管理工具

用法：
  node coupon-admin.mjs create --file <活动配置.json> [--database <数据库路径>]
  node coupon-admin.mjs list [--database <数据库路径>]
  node coupon-admin.mjs disable <活动 ID> [--database <数据库路径>]
  node coupon-admin.mjs enable <活动 ID> [--database <数据库路径>]
  node coupon-admin.mjs --help

默认数据库与应用一致：ZIJIAN_AUTH_DATA_DIR/auth.sqlite，未配置时使用 .data/auth.sqlite。
create 成功时输出可分发的兑换码；list 只输出活动及渠道统计。
`;

export class CouponAdminUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CouponAdminUsageError';
    this.code = 'USAGE_ERROR';
  }
}

export class CouponConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CouponConfigError';
    this.code = 'INVALID_CAMPAIGN';
  }
}

/** Parse explicit maintenance commands; importing this file never opens the database. */
export function parseCouponArgs(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) {
    throw new CouponAdminUsageError('命令参数必须是字符串数组。');
  }
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) return { command: 'help' };
  const [command, ...args] = argv;
  if (!['create', 'list', 'disable', 'enable'].includes(command)) {
    throw new CouponAdminUsageError('请明确指定 create、list、disable 或 enable。');
  }
  const parsed = { command };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--database' || value === '--file') {
      const key = value === '--database' ? 'filename' : 'file';
      if (key === 'file' && command !== 'create') throw new CouponAdminUsageError('--file 仅用于 create。');
      if (Object.hasOwn(parsed, key)) throw new CouponAdminUsageError(`${value} 不可重复。`);
      const next = args[++index];
      if (!next || next.startsWith('--')) throw new CouponAdminUsageError(`${value} 需要指定路径。`);
      parsed[key] = next;
    } else if (!value.startsWith('-') && ['enable', 'disable'].includes(command) && !parsed.id) {
      parsed.id = value;
    } else {
      throw new CouponAdminUsageError(`无法识别参数：${value}`);
    }
  }
  if (command === 'create' && !parsed.file) throw new CouponAdminUsageError('create 需要 --file <活动配置.json>。');
  if (['enable', 'disable'].includes(command) && !/^[A-Za-z0-9_-]{3,64}$/.test(parsed.id || '')) {
    throw new CouponAdminUsageError(`${command} 需要有效的活动 ID（3 至 64 位字母、数字、下划线或短横线）。`);
  }
  return parsed;
}

function objectValue(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CouponConfigError(`${label}必须是 JSON 对象。`);
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new CouponConfigError(`${label}包含未知字段：${unknown}`);
  return value;
}

function stringValue(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new CouponConfigError(`${label}需要 1 至 ${max} 个字符。`);
  }
  return value.trim();
}

function positiveInteger(value, label, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new CouponConfigError(`${label}必须是 1 至 ${max} 的整数。`);
  }
  return value;
}

/** Dates must include seconds and a timezone, so operator locale cannot change a deadline. */
function dateValue(value, label) {
  if (typeof value !== 'string') throw new CouponConfigError(`${label}必须是包含时区的 ISO 日期，例如 2026-11-01T00:00:00+08:00。`);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) throw new CouponConfigError(`${label}必须是包含时区的 ISO 日期，例如 2026-11-01T00:00:00+08:00。`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , zoneHour, zoneMinute] = parts;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  const timestamp = Date.parse(value);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
      Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
      (zone !== 'Z' && (Number(zoneHour) > 23 || Number(zoneMinute) > 59)) ||
      !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new CouponConfigError(`${label}不是有效日期。`);
  }
  return timestamp;
}

/** Convert the human JSON format to the service contract without opening storage. */
export function normalizeCampaignConfig(input) {
  objectValue(input, '活动配置', ['id', 'title', 'days', 'startsAt', 'endsAt', 'maxRedemptions', 'codes']);
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(id)) throw new CouponConfigError('活动 ID 需要 3 至 64 位字母、数字、下划线或短横线。');
  const campaign = {
    id,
    title: stringValue(input.title, '活动标题', 100),
    days: positiveInteger(input.days, '赠送天数', 365),
    endsAt: dateValue(input.endsAt, '兑换截止时间'),
    maxRedemptions: positiveInteger(input.maxRedemptions, '总兑换数量', 1000000),
  };
  if (input.startsAt !== undefined) {
    campaign.startsAt = dateValue(input.startsAt, '活动开始时间');
    if (campaign.endsAt <= campaign.startsAt) throw new CouponConfigError('兑换截止时间必须晚于活动开始时间。');
  }
  if (!Array.isArray(input.codes) || input.codes.length < 1 || input.codes.length > 1000) {
    throw new CouponConfigError('每个活动需要 1 至 1000 个渠道兑换码。');
  }
  const seen = new Set();
  campaign.codes = input.codes.map(item => {
    objectValue(item, '渠道配置', ['code', 'channel']);
    const code = typeof item.code === 'string' ? item.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9_-]{3,64}$/.test(code)) throw new CouponConfigError('兑换码需要 3 至 64 位英文字母、数字、下划线或短横线。');
    if (seen.has(code)) throw new CouponConfigError('同一活动内的兑换码不可重复（不区分大小写及前后空格）。');
    seen.add(code);
    return { code, channel: stringValue(item.channel, '渠道名称', 64) };
  });
  return campaign;
}

function campaignSummary(campaign) {
  return {
    id: campaign.id,
    title: campaign.title,
    days: campaign.days,
    startsAt: new Date(campaign.startsAt).toISOString(),
    endsAt: new Date(campaign.endsAt).toISOString(),
    maxRedemptions: campaign.maxRedemptions,
    redemptions: campaign.redemptions,
    enabled: campaign.enabled,
    codeCount: campaign.codes.length,
    channels: campaign.codes.map(({ channel, redemptions }) => ({ channel, redemptions })),
  };
}

export async function runCouponAdmin(argv, {
  write = value => process.stdout.write(`${value}\n`),
  writeError = value => process.stderr.write(`${value}\n`),
  readFile = readFileFromDisk,
  createService,
} = {}) {
  let service;
  try {
    const parsed = parseCouponArgs(argv);
    if (parsed.command === 'help') { write(HELP); return 0; }
    // Read and validate first: an invalid import must not create a new database.
    let config;
    if (parsed.command === 'create') {
      let source;
      try { source = await readFile(parsed.file, 'utf8'); }
      catch { throw new CouponConfigError('无法读取活动配置文件，请检查 --file 路径与权限。'); }
      let input;
      try { input = JSON.parse(source.replace(/^\uFEFF/, '')); }
      catch { throw new CouponConfigError('活动配置文件不是有效的 JSON。'); }
      config = normalizeCampaignConfig(input);
    }
    const factory = createService || (await import('./auth-service.mjs')).createAuthService;
    service = await factory(parsed.filename ? { filename: parsed.filename } : {});
    if (parsed.command === 'create') {
      const campaign = await service.createCampaign(config);
      write(JSON.stringify({ campaign: { ...campaignSummary(campaign), codes: campaign.codes } }, null, 2));
    } else if (parsed.command === 'list') {
      const campaigns = await service.getCampaigns();
      write(JSON.stringify({ campaigns: campaigns.map(campaignSummary) }, null, 2));
    } else {
      const campaign = await service.setCampaignEnabled(parsed.id, parsed.command === 'enable');
      write(JSON.stringify({ campaign: campaignSummary(campaign) }, null, 2));
    }
    return 0;
  } catch (error) {
    if (error instanceof CouponAdminUsageError) {
      writeError(`${error.message}\n运行 node coupon-admin.mjs --help 查看用法。`);
      return 2;
    }
    if (error instanceof CouponConfigError || error?.name === 'AuthError') {
      writeError(`${error.code}: ${error.message}`);
    } else {
      writeError('活动操作失败，请检查数据库路径、权限与配置。');
    }
    return 1;
  } finally {
    if (service) await service.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/** Match the application entry point while keeping imports and injected test runners side-effect free. */
export async function runCouponAdminMain(argv, {
  envFilename = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'),
  loadEnvFile = filename => process.loadEnvFile(filename),
  ...runnerOptions
} = {}) {
  if (!(argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0]))) {
    try { await loadEnvFile(envFilename); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        const writeError = runnerOptions.writeError || (value => process.stderr.write(`${value}\n`));
        writeError('无法读取 .env，请检查文件格式与权限。');
        return 1;
      }
    }
  }
  return runCouponAdmin(argv, runnerOptions);
}

if (isMain) process.exitCode = await runCouponAdminMain(process.argv.slice(2));
