// Secret scan (A13). Scans git-tracked files, the built web bundle (web/dist) and evidence/ for
// key/token patterns, plus the literal values of OPENAI_API_KEY / PILOT_PASSWORD / SESSION_SECRET /
// NATS_PASS from .env (when present). Never prints or stores a matched value: only file paths, pattern
// names and counts. Writes evidence/security/secret-scan-<timestamp>.json. Exit 1 on any hit.
//   npm run scan:secrets
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv() {
  const out = {};
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Known fake keys used as redaction/test fixtures. Allowed ONLY inside tests/ and counted separately;
// the same text anywhere else (src, docs, web bundle, evidence) is a hit.
const FAKE_PREFIXES = ['sk-test-', 'sk-e2e-', 'sk-abcdefgh', 'sk-supersecret', 'sk-proj-abcdefgh'];
const PATTERNS = [
  { name: 'openai-style-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, fakeOk: true },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  { name: 'private-key-block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'signed-session-cookie', re: /safi_session=s%3A[A-Za-z0-9._%-]{20,}|safi_session=[A-Za-z0-9._-]{20,}\.[A-Za-z0-9+/_%-]{20,}/g },
  { name: 'env-assignment-with-value', re: /^[ 	]*OPENAI_API_KEY[ 	]*=[ 	]*[^\s#]{8,}/gm },
];

const env = readEnv();
const literals = ['OPENAI_API_KEY', 'PILOT_PASSWORD', 'SESSION_SECRET', 'NATS_PASS']
  .map((k) => ({ name: k, value: env[k] }))
  .filter((l) => l.value && l.value.length >= 8);

function listTracked() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split('\0')
    .filter(Boolean);
}
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const targets = new Map(); // relative path -> scope
for (const f of listTracked()) targets.set(f, 'tracked');
for (const f of walk(path.join(root, 'web', 'dist'))) targets.set(path.relative(root, f).split(path.sep).join('/'), 'web-dist');
for (const f of walk(path.join(root, 'evidence'))) {
  const rel = path.relative(root, f).split(path.sep).join('/');
  if (!targets.has(rel)) targets.set(rel, 'evidence-untracked');
}

const hits = [];
let fakeFixtureHits = 0;
let scanned = 0;
const scope = { tracked: 0, 'web-dist': 0, 'evidence-untracked': 0 };
for (const [rel, sc] of targets) {
  const abs = path.join(root, rel);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    continue; // deleted-but-tracked or unreadable: nothing to scan
  }
  if (buf.includes(0)) continue; // binary (png etc.)
  const text = buf.toString('utf8');
  scanned += 1;
  scope[sc] += 1;
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      if (p.fakeOk && rel.startsWith('tests/') && FAKE_PREFIXES.some((x) => m[0].startsWith(x))) {
        fakeFixtureHits += 1;
        continue;
      }
      hits.push({ file: rel, scope: sc, pattern: p.name });
    }
  }
  for (const l of literals) {
    if (text.includes(l.value)) hits.push({ file: rel, scope: sc, pattern: `literal-${l.name}` });
  }
}

const summary = {};
for (const h of hits) {
  const k = `${h.pattern} :: ${h.file}`;
  summary[k] = (summary[k] ?? 0) + 1;
}
const report = {
  scan: 'secrets',
  at_utc: new Date().toISOString(),
  git_sha: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(); } catch { return null; } })(),
  git_dirty: (() => { try { return execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim().length > 0; } catch { return null; } })(),
  files_scanned: scanned,
  files_scanned_by_scope: scope,
  web_dist_present: scope['web-dist'] > 0,
  patterns: PATTERNS.map((p) => p.name),
  literal_env_values_checked: literals.map((l) => l.name), // names only; values are never printed or stored
  fake_test_fixture_matches_ignored: fakeFixtureHits,
  hit_count: hits.length,
  hits: Object.entries(summary).map(([k, count]) => ({ match: k, count })),
  overall: hits.length === 0 ? 'PASS' : 'FAIL',
};

const outDir = path.join(root, 'evidence', 'security');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `secret-scan-${report.at_utc.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(`scanned ${scanned} files (${JSON.stringify(scope)}); ${hits.length} hit(s); ignored ${fakeFixtureHits} fake test-fixture key match(es)`);
for (const h of report.hits) console.log(`HIT ${h.match} x${h.count}`);
console.log(`${report.overall}; report ${path.relative(root, file)}`);
process.exit(hits.length === 0 ? 0 : 1);
