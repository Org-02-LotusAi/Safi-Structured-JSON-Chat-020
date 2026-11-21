// Recovery drill for a docker compose deployment (SOW A11 + A13).
//   1. baseline chat succeeds
//   2. stop worker  -> chat must fail with worker_unavailable (no responders: nothing delivered, no false success)
//   3. start worker -> a new chat must succeed
//   4. restart nats -> JetStream audit receipts must still be present, and a new chat must succeed
// Run from the repo root after:  docker compose --env-file .env -f infra/docker-compose.yml up -d --build
// Needs .env (PILOT_USERNAME/PASSWORD, NATS_USER/PASS). The drill briefly publishes NATS on 127.0.0.1:4222
// through infra/docker-compose.dev.yml so it can count receipts; it recreates only the nats container.
// Env: DRILL_BASE_URL (default https://localhost:8443), DRILL_NATS_URL (default nats://127.0.0.1:4222).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader; real environment wins.
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

const baseUrl = new URL(process.env.DRILL_BASE_URL || 'https://localhost:8443');
const natsUrl = process.env.DRILL_NATS_URL || 'nats://127.0.0.1:4222';
const user = process.env.PILOT_USERNAME;
const pass = process.env.PILOT_PASSWORD;
if (!user || !pass) {
  console.error('BLOCKED: PILOT_USERNAME and PILOT_PASSWORD are required (set them in .env).');
  process.exit(2);
}
// Only a localhost deployment with a dev self-signed cert is allowed to skip certificate verification.
const insecureLocal = ['localhost', '127.0.0.1'].includes(baseUrl.hostname) && process.env.DRILL_STRICT_TLS !== '1';

const compose = ['compose', '--env-file', '.env', '-f', 'infra/docker-compose.yml', '-f', 'infra/docker-compose.dev.yml'];
const dc = (...args) => execFileSync('docker', [...compose, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const checks = [];
const log = (msg) => console.log(`[drill ${new Date().toISOString()}] ${msg}`);
function check(name, ok, detail) {
  checks.push({ name, result: ok ? 'PASS' : 'FAIL', detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function http(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      {
        host: baseUrl.hostname,
        port: baseUrl.port || 443,
        path: p,
        method,
        rejectUnauthorized: !insecureLocal,
        headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode, json, setCookie: res.headers['set-cookie'] });
        });
      },
    );
    req.setTimeout(45_000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let session = null;
async function login() {
  const r = await http('POST', '/api/login', { body: { username: user, password: pass } });
  if (r.status !== 200) throw new Error(`login failed (${r.status})`);
  const cookie = (r.setCookie || []).map((c) => c.split(';')[0]).join('; ');
  session = { cookie, csrf: r.json.csrf_token, conversation_id: r.json.conversation_id };
}
async function chat(text) {
  const r = await http('POST', '/api/chat', {
    headers: { cookie: session.cookie, 'x-safi-csrf': session.csrf },
    body: { request_id: randomUUID(), conversation_id: session.conversation_id, schema_id: 'safi.reply.summary', text },
  });
  return r;
}

// After NATS restarts, clients notice the dead socket and reconnect within a few seconds. A request
// published into the dead socket before that is lost (core NATS is at-most-once) and surfaces as a
// 504 after 30 s, so wait for the server's own view of the connection before sending.
async function settleNats() {
  await sleep(5000);
  await retry('server reconnected to nats', async () => {
    const r = await http('GET', '/api/status', { headers: { cookie: session.cookie } });
    return r.status === 200 && r.json?.nats === 'connected';
  }, 30, 1000);
  await sleep(3000); // worker resubscribes independently
}

async function streamCount() {
  const { connect } = await import('@nats-io/transport-node');
  const { jetstream } = await import('@nats-io/jetstream');
  const nc = await connect({ servers: natsUrl, user: process.env.NATS_USER || undefined, pass: process.env.NATS_PASS || undefined, timeout: 5000 });
  try {
    const info = await jetstream(nc).jetstreamManager().then((m) => m.streams.info('SAFI_CHAT_AUDIT'));
    return { messages: info.state.messages, last_seq: info.state.last_seq, max_age_ns: info.config.max_age, max_bytes: info.config.max_bytes };
  } finally {
    await nc.close();
  }
}

function tcpOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function retry(label, fn, attempts, delayMs) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) {
      last = e;
    }
    await sleep(delayMs);
  }
  throw new Error(`${label}: gave up${last ? ` (${last.message})` : ''}`);
}

async function main() {
  log(`target ${baseUrl.origin}; tls verification ${insecureLocal ? 'OFF (localhost dev cert)' : 'ON'}`);
  // Expose NATS on loopback (dev override) so receipts can be counted from the host.
  dc('up', '-d', 'nats'); // recreates only the nats container (volume kept) with the loopback port
  await retry('nats port open', () => tcpOpen(Number(new URL(natsUrl).port || 4222)), 30, 1000);
  await login();
  // Recreating nats above makes worker and server reconnect; wait until a request goes through.
  await settleNats();
  await retry('stack ready', async () => {
    const r = await chat('Drill warm-up.');
    return r.status === 200 && r.json?.outcome === 'ok' ? r : null;
  }, 10, 3000).catch(() => null);

  const base = await chat('Drill baseline: say hello.');
  check('baseline chat ok', base.status === 200 && base.json?.outcome === 'ok', `status ${base.status}`);
  check('baseline audit persisted', base.json?.audit === 'persisted', String(base.json?.audit));
  const before = await streamCount();
  check('receipts present before drill', before.messages >= 1, `messages=${before.messages}`);

  // A11: worker down
  dc('stop', 'worker');
  log('worker stopped');
  const down = await chat('Drill: worker is down.');
  check('worker down -> worker_unavailable (no false success)', down.status === 504 && down.json?.error?.code === 'worker_unavailable' && down.json?.outcome === 'error', `status ${down.status} code ${down.json?.error?.code}`);

  dc('start', 'worker');
  log('worker started');
  const recovered = await retry('worker recovered', async () => {
    const r = await chat('Drill: worker restarted.');
    return r.status === 200 && r.json?.outcome === 'ok' ? r : null;
  }, 10, 3000).catch(() => null);
  check('after worker restart a new request succeeds', !!recovered, recovered ? `status ${recovered.status}` : 'no success');

  // A13: NATS restart, JetStream receipts persist
  const beforeNats = await streamCount();
  dc('restart', 'nats');
  log('nats restarted');
  const after = await retry('stream readable after nats restart', () => streamCount().catch(() => null), 30, 1000).catch(() => null);
  check('receipts persisted across nats restart', !!after && after.messages >= beforeNats.messages, after ? `before=${beforeNats.messages} after=${after.messages}` : 'stream unreadable');

  await settleNats();
  const t0 = Date.now();
  const postNats = await retry('chat after nats restart', async () => {
    const r = await chat('Drill: nats restarted.');
    log(`chat after nats restart: status ${r.status} code ${r.json?.error?.code ?? 'ok'} (${Date.now() - t0} ms since restart)`);
    return r.status === 200 && r.json?.outcome === 'ok' ? r : null;
  }, 10, 3000).catch(() => null);
  check('chat works after nats restart (reconnect)', !!postNats, postNats ? `audit ${postNats.json?.audit}` : 'no success');
  const final = await streamCount().catch(() => null);
  check('new receipts published after recovery', !!final && !!after && final.messages > after.messages, final && after ? `after=${after.messages} final=${final.messages}` : 'n/a');

  const passed = checks.every((c) => c.result === 'PASS');
  const outDir = path.join(root, 'evidence', 'recovery');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const gitSha = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(); } catch { return null; } })();
  const gitDirty = (() => { try { return execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim().length > 0; } catch { return null; } })();
  const report = { drill: 'recovery', at_utc: new Date().toISOString(), git_sha: gitSha, git_dirty: gitDirty, target: baseUrl.origin, overall: passed ? 'PASS' : 'FAIL', stream_before: before, stream_final: final, checks };
  const file = path.join(outDir, `drill-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  log(`overall ${report.overall}; report ${path.relative(root, file)}`);
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error(`drill aborted: ${e.message}`);
  process.exit(1);
});
