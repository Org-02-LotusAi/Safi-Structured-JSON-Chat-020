// Runs the built worker and server as two child processes with prefixed logs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency); real environment variables win.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const services = [
  { name: 'worker', entry: path.join(root, 'worker', 'dist', 'main.js') },
  { name: 'server', entry: path.join(root, 'server', 'dist', 'main.js') },
];
for (const s of services) {
  if (!fs.existsSync(s.entry)) {
    console.error(`start: ${s.entry} not found; run "npm run build" first`);
    process.exit(1);
  }
}

const children = [];
let exiting = false;

function prefixLines(stream, out, name) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      out.write(`[${name}] ${buf.slice(0, i)}\n`);
      buf = buf.slice(i + 1);
    }
  });
  stream.on('end', () => {
    if (buf) out.write(`[${name}] ${buf}\n`);
  });
}

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  const timer = setTimeout(() => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    process.exit(code);
  }, 10_000);
  Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.once('exit', r))))).then(() => {
    clearTimeout(timer);
    process.exit(code);
  });
}

for (const s of services) {
  const child = spawn(process.execPath, [s.entry], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  prefixLines(child.stdout, process.stdout, s.name);
  prefixLines(child.stderr, process.stderr, s.name);
  child.on('exit', (code, signal) => {
    if (!exiting) console.error(`start: ${s.name} exited (${signal ?? code}); stopping everything`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
