// Runs tests/e2e/live.spec.ts against a deployed pilot (real OpenAI). Loads .env like the other scripts.
//   E2E_BASE_URL=https://your.host npm run test:e2e:live        (bash)
//   $env:E2E_BASE_URL="https://your.host"; npm run test:e2e:live  (PowerShell)
// Exit 2 (BLOCKED) when preconditions are missing; otherwise the Playwright exit code.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
const base = process.env.E2E_BASE_URL || process.env.VERIFY_BASE_URL;
if (!base || !base.startsWith('https://')) {
  console.error('BLOCKED: set E2E_BASE_URL to the https:// URL of the deployed pilot (backed by the real OpenAI API).');
  process.exit(2);
}
if (!process.env.PILOT_USERNAME || !process.env.PILOT_PASSWORD) {
  console.error('BLOCKED: PILOT_USERNAME and PILOT_PASSWORD are required (set them in .env).');
  process.exit(2);
}
const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const r = spawnSync(process.execPath, [cli, 'test', 'tests/e2e/live.spec.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, E2E_LIVE: '1', E2E_START_STACK: '0', E2E_BASE_URL: base },
});
process.exit(r.status ?? 1);
