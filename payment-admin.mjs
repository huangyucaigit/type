import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthService, AuthError } from './auth-service.mjs';
import { PaymentError } from './payment-client.mjs';
import { readPaymentOptions } from './payment-config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export async function runPaymentAdmin(args = process.argv.slice(2)) {
  if (!args.length || args.includes('--help')) {
    console.log('Usage: node payment-admin.mjs <status|retry-notification> --order <orderNo> [--database <auth.sqlite>]');
    console.log('       node payment-admin.mjs create-acceptance --user <existingUserId> --request <stableUUID> [--database <auth.sqlite>]');
    console.log('Private operator tool. Acceptance orders cost 1 fen for 1 day; payment requires a manual QR scan.');
    console.log('Notification retry never creates a payment or charges money.');
    return;
  }
  const command = args[0], options = {};
  if (!['status', 'retry-notification', 'create-acceptance'].includes(command)) throw new Error('Unsupported payment management command.');
  const allowed = command === 'create-acceptance' ? ['--user', '--request', '--database'] : ['--order', '--database'];
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('Invalid payment management arguments.');
    options[key] = value;
  }
  if (command === 'create-acceptance') {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(options['--user'] || '')
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(options['--request'] || '')) {
      throw new Error('An existing --user and stable UUID --request are required.');
    }
  } else if (!/^[A-Za-z0-9_-]{1,64}$/u.test(options['--order'] || '')) throw new Error('A valid --order is required.');
  try { process.loadEnvFile(path.join(ROOT, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read private application configuration.'); }
  const filename = path.resolve(options['--database'] || path.join(process.env.ZIJIAN_AUTH_DATA_DIR || path.join(ROOT, '.data'), 'auth.sqlite'));
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new Error('The selected account database does not exist; no database was created.');
  const service = createAuthService({ filename, paymentOptions: readPaymentOptions() });
  try {
    const order = command === 'create-acceptance'
      ? await service.createPaymentAcceptanceOrder({ userId: options['--user'], requestId: options['--request'] })
      : command === 'status' ? service.getBillingOrder(options['--order'])
        : await service.retryBillingNotification(options['--order']);
    console.log(JSON.stringify(order, null, 2));
  } finally { service.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runPaymentAdmin(); }
  catch (error) {
    console.error(error instanceof AuthError || error instanceof PaymentError ? error.message : 'Payment management operation failed. Check command, database and private configuration.');
    process.exitCode = 1;
  }
}
