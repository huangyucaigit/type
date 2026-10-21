import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL('./src/main.tsx', import.meta.url))],
  outfile: `${root}learning-assistant.js`, bundle: true, format: 'esm',
  platform: 'browser', target: ['es2022'], jsx: 'automatic', minify: true,
  legalComments: 'linked', define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile(`${root}learning-assistant.css`, await readFile(new URL('./src/assistant.css', import.meta.url)));
const legalPath = `${root}learning-assistant.js.LEGAL.txt`;
const generated = await readFile(legalPath, 'utf8').catch(() => '');
const mintlify = await readFile(new URL('./licenses/Mintlify-MIT.txt', import.meta.url), 'utf8');
const sdk = await readFile(new URL('./licenses/AI-SDK-Apache-2.0.txt', import.meta.url), 'utf8');
await writeFile(legalPath, `${generated}\n\nAdapted Mintlify assistant frontend\n${mintlify}\n\nAI SDK — Copyright 2023 Vercel, Inc.\n${sdk}`);
