// TEST-ONLY harness: real nats-server + real built worker/server processes + fake OpenAI upstream.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOpenAI, type FakeBehavior, type FakeOpenAI } from '../helpers/fake-openai.js';
import { startNatsServer, type TestNats } from '../helpers/nats-server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const E2E_USER = 'pilot';
export const E2E_PASS = 'e2e-pilot-password-123';

interface Stack {
  nats: TestNats;
  fake: FakeOpenAI;
  server: ChildProcess;
  worker: ChildProcess | null;
  control: http.Server | null;
  dataDir: string;
  logs: string[];
}

let stack: Stack | null = null;

function waitHttps(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => (Date.now() > deadline ? reject(new Error(`timed out waiting for ${url}`)) : setTimeout(tick, 200));
    const tick = () => {
      // Local readiness probe against the self-signed dev certificate.
      const req = https.get(url, { rejectUnauthorized: false }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
    };
    tick();
  });
}

function spawnNode(name: string, entry: string, env: Record<string, string>, logs: string[]): ChildProcess {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sink = (d: Buffer) => logs.push(`[${name}] ${d.toString().trimEnd()}`);
  child.stdout?.on('data', sink);
  child.stderr?.on('data', sink);
  return child;
}

function killAndWait(c: ChildProcess | null): Promise<void> {
  if (!c || c.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    c.once('exit', () => resolve());
    c.kill();
  });
}

export async function startStack(port: number): Promise<{ controlUrl: string }> {
  for (const f of ['shared/dist/index.js', 'worker/dist/main.js', 'server/dist/main.js', 'web/dist/index.html']) {
    if (!fs.existsSync(path.join(root, f))) throw new Error(`${f} missing; run "npm run build" first`);
  }
  if (!fs.existsSync(path.join(root, 'infra/certs/dev.crt'))) {
    execFileSync(process.execPath, ['scripts/gen-dev-cert.mjs'], { cwd: root });
  }

  const logs: string[] = [];
  const nats = await startNatsServer();
  const fake = await startFakeOpenAI();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safi-e2e-'));

  const common = { NATS_URL: nats.url, OPENAI_MODEL: 'gpt-6-luna', OPENAI_BASE_URL: fake.baseURL, MAX_OUTPUT_TOKENS: '512' };
  const workerEnv = { ...common, OPENAI_API_KEY: 'sk-e2e-not-a-real-key', LOG_LEVEL: 'info' };
  const serverEnv = {
    ...common,
    PILOT_USERNAME: E2E_USER,
    PILOT_PASSWORD: E2E_PASS,
    SESSION_SECRET: 'e2e-session-secret-0123456789abcdef-0123',
    USER_RATE_PER_MIN: '10',
    PILOT_API_CALL_CAP: '40',
    TLS_CERT_FILE: path.join(root, 'infra/certs/dev.crt'),
    TLS_KEY_FILE: path.join(root, 'infra/certs/dev.key'),
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    WEB_DIST_DIR: path.join(root, 'web/dist'),
  };

  const startWorker = () => spawnNode('worker', path.join(root, 'worker/dist/main.js'), workerEnv, logs);
  const s: Stack = {
    nats,
    fake,
    worker: startWorker(),
    server: spawnNode('server', path.join(root, 'server/dist/main.js'), serverEnv, logs),
    control: null,
    dataDir,
    logs,
  };
  stack = s;
  try {
    await waitHttps(`https://127.0.0.1:${port}/healthz`, 30_000);
    const until = Date.now() + 20_000;
    while (!logs.some((l) => l.includes('worker started'))) {
      if (Date.now() > until) throw new Error('worker did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (e) {
    const out = logs.join('\n');
    await stopStack();
    throw new Error(`${(e as Error).message}\n${out}`);
  }

  // Control API so tests (separate processes) can script the fake upstream and stop/start the worker.
  const control = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const send = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      try {
        if (req.method === 'POST' && req.url === '/script') {
          fake.script(...(JSON.parse(raw) as FakeBehavior[]));
          return send(200, { ok: true });
        }
        if (req.method === 'POST' && req.url === '/reset') {
          fake.requests.length = 0;
          return send(200, { ok: true });
        }
        if (req.method === 'GET' && req.url === '/requests') return send(200, fake.requests);
        if (req.method === 'POST' && req.url === '/worker/stop') {
          await killAndWait(s.worker);
          s.worker = null;
          return send(200, { ok: true });
        }
        if (req.method === 'POST' && req.url === '/worker/start') {
          const mark = logs.length;
          if (!s.worker || s.worker.exitCode !== null) s.worker = startWorker();
          // Wait until the new worker has logged that it is subscribed.
          const until = Date.now() + 20_000;
          while (!logs.slice(mark).some((l) => l.includes('worker started'))) {
            if (Date.now() > until) return send(500, { error: 'worker did not start', logs: logs.slice(mark) });
            await new Promise((r) => setTimeout(r, 100));
          }
          return send(200, { ok: true });
        }
        if (req.method === 'GET' && req.url === '/logs') return send(200, logs);
        send(404, { error: 'unknown' });
      } catch (e) {
        send(500, { error: (e as Error).message });
      }
    });
  });
  s.control = control;
  await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
  const addr = control.address() as AddressInfo;
  return { controlUrl: `http://127.0.0.1:${addr.port}` };
}

export async function stopStack(): Promise<void> {
  const s = stack;
  if (!s) return;
  stack = null;
  const control = s.control;
  if (control) await new Promise<void>((r) => control.close(() => r()));
  await killAndWait(s.server);
  await killAndWait(s.worker);
  await s.fake.close();
  await s.nats.stop();
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}
