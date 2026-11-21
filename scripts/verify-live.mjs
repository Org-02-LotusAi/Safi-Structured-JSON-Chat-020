// Live acceptance verification against a RUNNING, deployed stack (SOW A02-A08, A12, A13 partial).
//
//   VERIFY_BASE_URL=https://your.host PILOT_USERNAME=... PILOT_PASSWORD=... NATS_URL=nats://... npm run verify:live
//
// Exit codes: 0 PASS, 1 FAIL (at least one check failed), 2 BLOCKED (preconditions not met; nothing was verified).
// BLOCKED is deliberate: A02-A05 must hit the REAL OpenAI API, so the script refuses to run against a worker
// that is not backed by it (fake/custom OPENAI_BASE_URL) or against a non-HTTPS / unreachable target.
// Writes evidence/live/<timestamp>/report.json with secrets redacted.
//
// VERIFY_SELFTEST_FAKE_UPSTREAM=1 exists only to exercise this script's own logic against a local stack with a
// fake upstream. It tolerates a self-signed cert, writes the report to VERIFY_OUT_DIR (default: OS temp dir,
// never evidence/live) and stamps overall = SELFTEST_ONLY. It can never produce acceptance evidence.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
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

const selftest = process.env.VERIFY_SELFTEST_FAKE_UPSTREAM === '1';
const checks = [];
const requestIds = new Set();
const secrets = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function blocked(reason) {
  console.error(`BLOCKED: ${reason}`);
  console.error('Nothing was verified. Fix the precondition and re-run; BLOCKED is not PASS.');
  process.exit(2);
}

function check(id, name, ok, detail) {
  checks.push({ id, name, result: ok ? 'PASS' : 'FAIL', detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` - ${detail}` : ''}`);
  return ok;
}
function skip(id, name, reason) {
  checks.push({ id, name, result: 'BLOCKED', detail: reason });
  console.log(`BLOCKED ${id} ${name} - ${reason}`);
}

// ---- preconditions -------------------------------------------------------
const rawBase = process.env.VERIFY_BASE_URL;
if (!rawBase) blocked('VERIFY_BASE_URL is not set (the HTTPS URL of the deployed pilot).');
let base;
try {
  base = new URL(rawBase);
} catch {
  blocked(`VERIFY_BASE_URL is not a valid URL: ${rawBase}`);
}
if (base.protocol !== 'https:') blocked(`VERIFY_BASE_URL must be https:// (got ${base.protocol}); A01 requires a real HTTPS URL.`);
const user = process.env.PILOT_USERNAME;
const pass = process.env.PILOT_PASSWORD;
if (!user || !pass) blocked('PILOT_USERNAME and PILOT_PASSWORD are required.');
secrets.push(pass);
if (process.env.NATS_PASS) secrets.push(process.env.NATS_PASS);
if (process.env.OPENAI_API_KEY) secrets.push(process.env.OPENAI_API_KEY);
const allowSelfSigned = selftest && ['localhost', '127.0.0.1'].includes(base.hostname);

function http(method, p, { body, headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = https.request(
      {
        host: base.hostname,
        port: base.port || 443,
        path: p,
        method,
        rejectUnauthorized: !allowSelfSigned,
        headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, json, raw, setCookie: res.headers['set-cookie'] });
        });
      },
    );
    req.setTimeout(60_000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login() {
  const r = await http('POST', '/api/login', { body: { username: user, password: pass } });
  if (r.status !== 200) return null;
  const cookie = (r.setCookie || []).map((c) => c.split(';')[0]).join('; ');
  secrets.push(cookie, r.json.csrf_token);
  return { cookie, csrf: r.json.csrf_token, conversation_id: r.json.conversation_id };
}

let health;
try {
  health = await http('GET', '/healthz');
} catch (e) {
  blocked(`cannot reach ${base.origin}/healthz over HTTPS (${e.code || e.message}); is the stack up and is the TLS certificate valid?`);
}
if (health.status !== 200) blocked(`${base.origin}/healthz returned ${health.status}.`);

const session = await login().catch(() => null);
if (!session) blocked('login failed; check PILOT_USERNAME / PILOT_PASSWORD for this deployment.');
let auth = { cookie: session.cookie, 'x-safi-csrf': session.csrf };

const statusRes = await http('GET', '/api/status', { headers: auth });
if (statusRes.status !== 200) blocked(`/api/status returned ${statusRes.status}.`);
const status0 = statusRes.json;
if (status0.upstream !== 'openai' && !selftest) {
  blocked(
    `the stack reports upstream "${status0.upstream}" (OPENAI_BASE_URL host ${status0.openai_base_url_host}); A02-A05 require the worker to call the REAL OpenAI API with a real OPENAI_API_KEY. ` +
      'This is expected on a machine without OpenAI access.',
  );
}
if (status0.nats !== 'connected') blocked(`server reports NATS ${status0.nats}.`);
if (status0.api_call_cap - status0.api_calls_used < 8) blocked(`only ${status0.api_call_cap - status0.api_calls_used} API calls left under the pilot cap; this run needs about 8.`);

// ---- helpers -------------------------------------------------------------
const { PILOT_SENDER_GUID, OPENAI_SERVICE_GUID, PILOT_CONTEXT, validateRequestEnvelope, validateResultEnvelope } = await import('@safi/shared');
const schemasRes = await http('GET', '/api/schemas');
const schemas = Object.fromEntries((schemasRes.json?.schemas ?? []).map((s) => [s.id, s]));

async function usedNow(headers = auth) {
  const r = await http('GET', '/api/status', { headers });
  return r.json.api_calls_used;
}
async function newConversation() {
  const r = await http('POST', '/api/conversations', { headers: auth, body: {} });
  if (r.status !== 200) throw new Error(`POST /api/conversations -> ${r.status}`);
  return r.json.conversation_id;
}
function chatBody(conversation_id, schema_id, text, extra = {}) {
  return { request_id: randomUUID(), conversation_id, schema_id, schema_sha256: schemas[schema_id]?.sha256, text, ...extra };
}
async function chat(body, headers = auth) {
  const r = await http('POST', '/api/chat', { headers, body });
  if (body.request_id) requestIds.add(body.request_id);
  return r;
}
function note(r) {
  const id = r.json?.envelope?.openai_request_id;
  return id ?? null;
}

// ---- NATS capture (A03) / audit (A13) -----------------------------------
let nc = null;
let natsNote = null;
let natsVersion = null;
const captured = [];
if (process.env.NATS_URL) {
  try {
    const { connect } = await import('@nats-io/transport-node');
    nc = await connect({ servers: process.env.NATS_URL, user: process.env.NATS_USER || undefined, pass: process.env.NATS_PASS || undefined, timeout: 5000, name: 'safi-verify-live' });
    const dec = new TextDecoder();
    const collect = async (subj) => {
      for await (const m of nc.subscribe(subj)) {
        try { captured.push({ subject: m.subject, at: Date.now(), json: JSON.parse(dec.decode(m.data)) }); } catch { /* ignore non-JSON */ }
      }
    };
    void collect('safi.chat.request.v1');
    void collect('_INBOX.>');
    await nc.flush();
    natsVersion = nc.info?.version ?? null;
  } catch (e) {
    natsNote = `cannot connect to NATS_URL (${e.message})`;
    nc = null;
  }
} else {
  natsNote = 'NATS_URL not set';
}

const report = {
  tool: 'verify-live',
  mode: selftest ? 'SELFTEST_FAKE_UPSTREAM' : 'live',
  started_at_utc: new Date().toISOString(),
  target_url: base.origin,
  git_sha: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(); } catch { return null; } })(),
  versions: { node: process.version, npm: /npm\/([^ ]+)/.exec(process.env.npm_config_user_agent || '')?.[1] ?? null, nats_server: null },
  status_before: { model: status0.model, upstream: status0.upstream, openai_base_url_host: status0.openai_base_url_host, api_calls_used: status0.api_calls_used, api_call_cap: status0.api_call_cap },
  openai_request_ids: [],
  stream: null,
  nats_capture_note: natsNote,
};

function validOk(r, schemaId) {
  const env = r.json?.envelope;
  const s = schemas[schemaId];
  return (
    r.status === 200 &&
    r.json?.outcome === 'ok' &&
    r.json?.validation?.envelope === 'pass' &&
    r.json?.validation?.body === 'pass' &&
    env?.schema_ref?.id === schemaId &&
    env?.schema_ref?.version === s?.version &&
    env?.schema_sha256 === s?.sha256
  );
}

// ---- A02 / A04: three-turn summary conversation -------------------------
const conv = await newConversation();
const turns = [
  'My favourite colour is teal. Please remember that.',
  'I also like the number 7.',
  'Using what I told you earlier, what is my favourite colour? Answer in one sentence.',
];
const turnResults = [];
for (const t of turns) {
  const r = await chat(chatBody(conv, 'safi.reply.summary', t));
  turnResults.push(r);
  await sleep(300);
}
const a02ok = turnResults.every((r) => validOk(r, 'safi.reply.summary'));
const ids = turnResults.map(note);
for (const i of ids) if (i) report.openai_request_ids.push(i);
check('A02', 'three real turns succeed with OpenAI request ids', a02ok && ids.every((i) => typeof i === 'string' && i.startsWith('req_')), `ids=${ids.join(',')}`);
const lastReply = String(turnResults[2].json?.envelope?.body?.reply ?? '').toLowerCase();
check('A02', 'turn 3 uses prior authorized context (mentions teal)', lastReply.includes('teal'), `reply length ${lastReply.length}`);
if (status0.upstream === 'openai') {
  const modelOk = turnResults.every((r) => String(r.json?.envelope?.model ?? '').startsWith(status0.model));
  check('A02', 'reply model matches configured model (not a fake upstream)', modelOk, `model=${turnResults[0].json?.envelope?.model}`);
}

const sumBody = turnResults[0].json?.envelope?.body ?? {};
const strictSummary =
  Object.keys(sumBody).sort().join(',') === 'followup_needed,reply,tone' &&
  typeof sumBody.reply === 'string' &&
  ['neutral', 'friendly'].includes(sumBody.tone) &&
  typeof sumBody.followup_needed === 'boolean';
check('A04', 'summary body independently matches safi.reply.summary 1.0.0 shape', strictSummary);
check('A04', 'UI-visible schema id/version/digest returned and match registry', validOk(turnResults[0], 'safi.reply.summary'), `sha256=${turnResults[0].json?.envelope?.schema_sha256}`);

// ---- A05: tasks ----------------------------------------------------------
const tasksRes = await chat(chatBody(conv, 'safi.reply.tasks', 'List three short tasks for planning a birthday party.'));
const tid = note(tasksRes);
if (tid) report.openai_request_ids.push(tid);
const tb = tasksRes.json?.envelope?.body ?? {};
const strictTasks =
  Object.keys(tb).sort().join(',') === 'followup_needed,reply,tasks' &&
  Array.isArray(tb.tasks) &&
  tb.tasks.every((t) => Object.keys(t).sort().join(',') === 'priority,task' && ['high', 'normal', 'low'].includes(t.priority) && typeof t.task === 'string');
check('A05', 'tasks schema yields typed tasks, validated', validOk(tasksRes, 'safi.reply.tasks') && strictTasks, `tasks=${Array.isArray(tb.tasks) ? tb.tasks.length : 'n/a'}`);

// ---- A06 / A07 / A08: rejected before any call ---------------------------
async function probe(id, name, body, expectStatus, expectCodes, headers = auth) {
  const before = await usedNow(headers);
  const r = await chat(body, headers);
  const after = await usedNow(headers);
  const codeOk = expectCodes.includes(r.json?.error?.code);
  check(id, name, expectStatus.includes(r.status) && codeOk && after === before, `status ${r.status} code ${r.json?.error?.code} calls ${before}->${after}`);
}
const okBase = () => chatBody(conv, 'safi.reply.summary', 'hello');
await probe('A06', 'unknown envelope field rejected', { ...okBase(), unexpected_field: 1 }, [400], ['ingress_rejected']);
await probe('A06', 'missing text rejected', (() => { const b = okBase(); delete b.text; return b; })(), [400], ['ingress_rejected']);
await probe('A06', 'oversize text rejected', { ...okBase(), text: 'x'.repeat(4001) }, [400, 413], ['ingress_rejected']);
await probe('A06', 'non-uuid request_id rejected', { ...okBase(), request_id: 'not-a-uuid' }, [400], ['ingress_rejected']);
await probe('A07', 'unknown schema id rejected', { ...okBase(), schema_id: 'safi.reply.nope', schema_sha256: undefined }, [400], ['schema_rejected']);
await probe('A07', 'mismatched schema sha256 rejected', { ...okBase(), schema_sha256: '0'.repeat(64) }, [400], ['schema_rejected']);
await probe('A07', 'browser-supplied raw schema rejected', { ...okBase(), schema: { type: 'object' } }, [400], ['ingress_rejected', 'schema_rejected']);
await probe('A08', 'forged from_guid / to_guid rejected', { ...okBase(), from_guid: 'a'.repeat(32), to_guid: 'b'.repeat(32) }, [400], ['ingress_rejected']);
await probe('A08', 'forged context / role / nats subject rejected', { ...okBase(), context: { thread_guid: 'c'.repeat(32) }, role: 'admin', nats_subject: 'safi.chat.request.v1' }, [400], ['ingress_rejected']);
await probe('A08', 'foreign conversation id rejected', { ...okBase(), conversation_id: randomUUID() }, [403], ['routing_rejected']);
// ---- A12: duplicate request_id -------------------------------------------
{
  const body = chatBody(conv, 'safi.reply.summary', 'Say the single word: duplicate-check.');
  const before = await usedNow();
  const first = await chat(body);
  const second = await chat(body);
  const after = await usedNow();
  const sameId = first.json?.envelope?.message_id && first.json.envelope.message_id === second.json?.envelope?.message_id;
  check('A12', 'duplicate request_id launches exactly one OpenAI call', after - before === 1 && first.status === 200 && second.status === 200 && sameId, `calls +${after - before}, statuses ${first.status}/${second.status}`);
  const did = note(first);
  if (did) report.openai_request_ids.push(did);
}

// Session-level denials last: a new login replaces the pilot session, so the first session ends here.
{
  const unauth = await http('POST', '/api/chat', { body: okBase() });
  check('A08', 'unauthenticated chat rejected', unauth.status === 401, `status ${unauth.status}`);
  await probe('A08', 'missing CSRF header rejected', okBase(), [403], ['ingress_rejected'], { cookie: session.cookie });
  const other = await login();
  const otherAuth = { cookie: other.cookie, 'x-safi-csrf': other.csrf };
  await probe('A08', 'a different session cannot use the first session conversation', okBase(), [403], ['routing_rejected'], otherAuth);
  auth = otherAuth;
}

// ---- A03: captured NATS traffic; A13: JetStream receipts ------------------
const validEnvelopeRequests = [];
if (nc) {
  await sleep(500);
  const mine = (m) => m.json?.conversation_id === conv;
  const reqs = captured.filter((m) => m.subject === 'safi.chat.request.v1' && mine(m));
  const replies = captured.filter((m) => m.subject.startsWith('_INBOX.') && mine(m) && m.json?.kind === 'chat.result');
  const turn3 = reqs.find((m) => m.json?.body?.text === turns[2]);
  const turn3Reply = replies.find((m) => m.json?.in_reply_to === turn3?.json?.message_id);
  report.nats_capture = turn3 && turn3Reply ? { request: turn3.json, reply: turn3Reply.json } : null;
  const a03 =
    !!turn3 && !!turn3Reply &&
    validateRequestEnvelope(turn3.json) === true &&
    validateResultEnvelope(turn3Reply.json) === true &&
    turn3.json.from_guid === PILOT_SENDER_GUID && turn3.json.to_guid === OPENAI_SERVICE_GUID &&
    turn3Reply.json.from_guid === OPENAI_SERVICE_GUID && turn3Reply.json.to_guid === PILOT_SENDER_GUID &&
    JSON.stringify(turn3.json.context) === JSON.stringify(PILOT_CONTEXT) &&
    JSON.stringify(turn3Reply.json.context) === JSON.stringify(PILOT_CONTEXT) &&
    turn3Reply.json.in_reply_to === turn3.json.message_id &&
    turn3Reply.json.conversation_id === turn3.json.conversation_id &&
    turn3Reply.json.schema_sha256 === turn3.json.schema_sha256;
  check('A03', 'captured real NATS request and reply: valid SAFI JSON, correct GUIDs, context, correlation', a03, turn3 ? `request ${turn3.json.message_id}` : 'no request captured');
  for (const m of reqs) validEnvelopeRequests.push(m.json.message_id);

  try {
    const { jetstream, jetstreamManager } = await import('@nats-io/jetstream');
    const jsm = await jetstreamManager(nc);
    void jetstream;
    const info = await jsm.streams.info('SAFI_CHAT_AUDIT');
    report.stream = {
      name: info.config.name,
      subjects: info.config.subjects,
      storage: info.config.storage,
      max_age_ns: info.config.max_age,
      max_bytes: info.config.max_bytes,
      messages: info.state.messages,
      first_seq: info.state.first_seq,
      last_seq: info.state.last_seq,
    };
    const receipts = [];
    for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq++) {
      const m = await jsm.streams.getMessage('SAFI_CHAT_AUDIT', { seq }).catch(() => null);
      if (m) receipts.push(m.json());
    }
    const mineReceipts = receipts.filter((r) => r.conversation_id === conv);
    const wantIds = new Set(validEnvelopeRequests);
    const got = new Set(mineReceipts.map((r) => r.message_id));
    const allPresent = [...wantIds].length > 0 && [...wantIds].every((id) => got.has(id));
    check('A13', 'JetStream receipts present for every request sent to NATS in this run', allPresent, `${got.size}/${wantIds.size} receipts`);
    const blob = JSON.stringify(mineReceipts);
    const leaked = [...turns, 'duplicate-check', ...secrets.filter(Boolean)].some((s) => blob.includes(s)) || /sk-[A-Za-z0-9]{8,}/.test(blob) || /safi_session/.test(blob);
    const shapeOk = mineReceipts.every((r) => r.receipt_version === '1' && ['ok', 'error'].includes(r.outcome) && !('text' in r) && !('body' in r));
    check('A13', 'receipts are redacted (no prompt text, reply text, keys or cookies)', !leaked && shapeOk);
    report.receipts_sample = mineReceipts.slice(0, 3);
  } catch (e) {
    skip('A13', 'JetStream receipts readable', `cannot read stream: ${e.message}`);
  }
  await nc.drain().catch(() => undefined);
} else {
  skip('A03', 'captured real NATS request and reply', `${natsNote}; run verify:live from a host that can reach the NATS port (e.g. the VM, with infra/docker-compose.dev.yml exposing 127.0.0.1:4222)`);
  skip('A13', 'JetStream receipts readable', natsNote);
}

// ---- finish ---------------------------------------------------------------
const statusEnd = (await http('GET', '/api/status', { headers: auth })).json;
report.status_after = { api_calls_used: statusEnd.api_calls_used, api_call_cap: statusEnd.api_call_cap };
report.finished_at_utc = new Date().toISOString();
report.versions.nats_server = natsVersion;
report.openai_request_ids = [...new Set(report.openai_request_ids)];
report.request_ids_sent = [...requestIds];
report.checks = checks;
const anyFail = checks.some((c) => c.result === 'FAIL');
const anyBlocked = checks.some((c) => c.result === 'BLOCKED');
report.overall = selftest ? 'SELFTEST_ONLY' : anyFail ? 'FAIL' : anyBlocked ? 'PARTIAL_BLOCKED' : 'PASS';
report.note = 'A01 and A14 require an independent human (see DOGFOOD.md). A09-A11 are covered by tests/e2e and drill:recovery.';

let text = JSON.stringify(report, null, 2);
for (const s of secrets.filter((x) => x && x.length >= 6)) text = text.split(s).join('[REDACTED]');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = selftest ? path.resolve(process.env.VERIFY_OUT_DIR || path.join(os.tmpdir(), 'safi-verify-selftest', stamp)) : path.join(root, 'evidence', 'live', stamp);
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, 'report.json');
fs.writeFileSync(file, text + '\n');
console.log(`\noverall ${report.overall}; report ${file}`);
process.exit(selftest ? (anyFail ? 1 : 0) : anyFail ? 1 : anyBlocked ? 2 : 0);
