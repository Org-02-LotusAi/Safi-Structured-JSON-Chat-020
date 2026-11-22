import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OPENAI_SERVICE_GUID, PILOT_SENDER_GUID, type ErrorCode, type RequestEnvelope } from '../shared/src/index.js';
import { NoRespondersFailure } from '../server/src/deps.js';
import { FileUsageStore, MemoryUsageStore } from '../server/src/limits.js';
import { TASKS_ID, chat, login, makeHarness } from './helpers/server-harness.js';

const rejectedBodies: Array<[string, Record<string, unknown>]> = [
  ['from_guid', { from_guid: 'a'.repeat(32) }],
  ['context', { context: { thread_guid: 'x' } }],
  ['role', { role: 'admin' }],
  ['subject', { subject: 'safi.chat.request.v1' }],
  ['model', { model: 'gpt-evil' }],
  ['schema', { schema: { type: 'object' } }],
];

describe('POST /api/chat ingress (A06/A07/A08)', () => {
  for (const [name, extra] of rejectedBodies) {
    it(`rejects unknown field "${name}" with 400 before NATS and without counting usage`, async () => {
      const h = await makeHarness();
      const l = await login(h.app);
      const res = await chat(h.app, l, extra);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('ingress_rejected');
      expect(h.nats.requests).toHaveLength(0);
      expect(h.usage.used()).toBe(0);
    });
  }

  it('rejects malformed JSON, oversized bodies and bad field values', async () => {
    const h = await makeHarness({ config: { bodyLimitBytes: 2000 } });
    const l = await login(h.app);
    const headers = { cookie: l.cookie, 'x-safi-csrf': l.csrf, 'content-type': 'application/json' };
    const broken = await h.app.inject({ method: 'POST', url: '/api/chat', headers, payload: '{nope' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.code).toBe('ingress_rejected');
    const big = await chat(h.app, l, { text: 'x'.repeat(3000) });
    expect(big.statusCode).toBe(413);
    expect((await chat(h.app, l, { request_id: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await chat(h.app, l, { text: '' })).statusCode).toBe(400);
    expect(h.nats.requests).toHaveLength(0);
    expect(h.usage.used()).toBe(0);
  });

  it('honours a lower MAX_INPUT_CHARS', async () => {
    const h = await makeHarness({ config: { maxInputChars: 10 } });
    const l = await login(h.app);
    expect((await chat(h.app, l, { text: 'x'.repeat(11) })).statusCode).toBe(400);
    expect(h.nats.requests).toHaveLength(0);
  });

  it('rejects unknown schema ids, mismatched digests and raw schemas with no NATS call', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    const unknown = await chat(h.app, l, { schema_id: 'safi.reply.evil' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('schema_rejected');
    const mism = await chat(h.app, l, { schema_sha256: 'f'.repeat(64) });
    expect(mism.statusCode).toBe(400);
    expect(mism.json().error.code).toBe('schema_rejected');
    const raw = await chat(h.app, l, { schema: { type: 'object' } });
    expect(raw.statusCode).toBe(400);
    expect(h.nats.requests).toHaveLength(0);
    expect(h.usage.used()).toBe(0);
  });

  it('rejects a conversation not owned by this session with 403', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    const res = await chat(h.app, l, { conversation_id: 'someone-elses-conversation' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('routing_rejected');
    expect(h.nats.requests).toHaveLength(0);
  });
});

describe('POST /api/chat success path', () => {
  it('binds identity, context and schema server-side and returns the contract shape', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    const requestId = randomUUID();
    h.nats.reply = (req) => h.nats.ok(req, { reply: 'two things', tasks: [{ task: 'a', priority: 'high' }], followup_needed: false });
    const ok = await chat(h.app, l, { request_id: requestId, schema_id: TASKS_ID });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body).toMatchObject({
      outcome: 'ok',
      validation: { envelope: 'pass', body: 'pass', validator: 'ajv-2020' },
      audit: 'persisted',
      api_calls_used: 1,
      api_call_cap: 40,
    });
    expect(body.envelope.kind).toBe('chat.result');
    const sent = h.nats.requests[0]!;
    expect(sent).toMatchObject({ from_guid: PILOT_SENDER_GUID, to_guid: OPENAI_SERVICE_GUID, kind: 'chat.request', in_reply_to: null });
    expect(sent.schema_ref.id).toBe(TASKS_ID);
    expect(sent.context.path).toHaveLength(2);
    expect(sent.message_id).not.toBe(requestId);
  });

  it('mints a fresh message_id per request_id', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    await chat(h.app, l);
    await chat(h.app, l);
    expect(new Set(h.nats.requests.map((r) => r.message_id)).size).toBe(2);
  });

  it('publishes a redacted audit receipt before responding', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    const res = await chat(h.app, l, { text: 'super secret prompt text' });
    expect(res.statusCode).toBe(200);
    expect(h.audit.receipts).toHaveLength(1);
    const r = h.audit.receipts[0]!;
    expect(r).toMatchObject({ receipt_version: '1', outcome: 'ok', error_code: null, model: 'test-model', openai_request_id: 'req_fake', usage: { input_tokens: 3, output_tokens: 4 } });
    expect(r.message_id).toBe(h.nats.requests[0]!.message_id);
    expect(r.conversation_id).toBe(l.conversation_id);
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    const dump = JSON.stringify(r);
    expect(dump).not.toContain('super secret prompt text');
    expect(dump).not.toContain('hello back');
  });

  it('flags audit:"failed" when the receipt cannot be published', async () => {
    const h = await makeHarness();
    h.audit.fail = true;
    const l = await login(h.app);
    const res = await chat(h.app, l);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'ok', audit: 'failed' });
  });

  it('bounds history to MAX_TURNS and sends it in the envelope', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    for (let i = 0; i < 10; i++) {
      h.nats.reply = (req) => h.nats.ok(req, { reply: `answer ${i}`, tone: 'neutral', followup_needed: false });
      const res = await chat(h.app, l, { text: `question ${i}` });
      expect(res.statusCode).toBe(200);
      h.clock.advance(61_000); // stay under the rate limit
    }
    const last = h.nats.requests[9]!;
    expect(last.body.history).toHaveLength(16);
    expect(last.body.history[0]).toEqual({ role: 'user', text: 'question 1' });
    expect(last.body.history[15]).toEqual({ role: 'assistant', text: 'answer 8' });
    expect(h.nats.requests[0]!.body.history).toEqual([]);
  });

  it('keeps history per conversation and never across sessions', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    await chat(h.app, l, { text: 'first' });
    const fresh = await h.app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: l.cookie, 'x-safi-csrf': l.csrf }, payload: {} });
    await chat(h.app, l, { conversation_id: fresh.json().conversation_id, text: 'other' });
    expect(h.nats.requests[1]!.body.history).toEqual([]);
    const l2 = await login(h.app);
    await chat(h.app, l2, { text: 'newcomer' });
    expect(h.nats.requests[2]!.body.history).toEqual([]);
  });
});

describe('reply verification (A08/A09)', () => {
  const mutate =
    (fn: (e: any) => void) =>
    (h: Awaited<ReturnType<typeof makeHarness>>) => {
      h.nats.reply = (req: RequestEnvelope) => {
        const e = JSON.parse(JSON.stringify(h.nats.ok(req)));
        fn(e);
        return e;
      };
    };

  const cases: Array<[string, (e: any) => void]> = [
    ['in_reply_to', (e) => (e.in_reply_to = 'other-message')],
    ['conversation_id (cross-conversation substitution)', (e) => (e.conversation_id = 'other-conversation')],
    ['from_guid', (e) => (e.from_guid = '5afe0020000000000000000000000009')],
    ['to_guid', (e) => (e.to_guid = '5afe0020000000000000000000000009')],
    ['context', (e) => (e.context.subject_guid = '5afe0020000000000000000000000009')],
    ['schema digest', (e) => (e.schema_sha256 = '0'.repeat(64))],
    ['schema version', (e) => (e.schema_ref.version = '9.9.9')],
    ['body extra field', (e) => (e.body.sneaky = true)],
    ['body wrong enum', (e) => (e.body.tone = 'angry')],
    ['envelope extra field', (e) => (e.extra = 1)],
  ];
  for (const [name, fn] of cases) {
    it(`502 invalid_model_output when reply has bad ${name}`, async () => {
      const h = await makeHarness();
      mutate(fn)(h);
      const l = await login(h.app);
      const res = await chat(h.app, l);
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.outcome).toBe('error');
      expect(body.error.code).toBe('invalid_model_output');
      expect(body.envelope).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('hello back');
      expect(h.audit.receipts[0]).toMatchObject({ outcome: 'error', error_code: 'invalid_model_output' });
    });
  }

  it('502 for non-JSON replies', async () => {
    const h = await makeHarness();
    h.nats.reply = () => 'not an envelope' as unknown as object; // JSON-encodes to a string
    const l = await login(h.app);
    expect((await chat(h.app, l)).statusCode).toBe(502);
  });

  it('does not add a failed reply to history', async () => {
    const h = await makeHarness();
    mutate((e) => (e.body.sneaky = 1))(h);
    const l = await login(h.app);
    await chat(h.app, l);
    h.nats.reply = (req) => h.nats.ok(req);
    await chat(h.app, l);
    expect(h.nats.requests[1]!.body.history).toEqual([]);
  });
});

describe('typed worker errors (A10)', () => {
  const expectations: Array<[ErrorCode, number]> = [
    ['refusal', 422],
    ['incomplete', 422],
    ['rate_limited', 503],
    ['upstream_timeout', 504],
    ['upstream_network', 502],
    ['upstream_error', 502],
    ['invalid_model_output', 502],
    ['schema_rejected', 400],
    ['routing_rejected', 403],
  ];
  for (const [code, status] of expectations) {
    it(`maps ${code} to HTTP ${status} with the code preserved`, async () => {
      const h = await makeHarness();
      h.nats.reply = (req) => h.nats.err(req, code, code === 'rate_limited');
      const l = await login(h.app);
      const res = await chat(h.app, l);
      expect(res.statusCode).toBe(status);
      const body = res.json();
      expect(body).toMatchObject({ outcome: 'error', audit: 'persisted' });
      expect(body.error.code).toBe(code);
      expect(body.envelope.kind).toBe('chat.error');
      expect(h.audit.receipts[0]).toMatchObject({ outcome: 'error', error_code: code });
    });
  }
});

describe('idempotency and ambiguity (A11/A12)', () => {
  it('no responders gives 504 worker_unavailable (retryable) and the same request_id may be retried', async () => {
    const h = await makeHarness();
    h.nats.failWith = new NoRespondersFailure();
    const l = await login(h.app);
    const request_id = randomUUID();
    const first = await chat(h.app, l, { request_id });
    expect(first.statusCode).toBe(504);
    expect(first.json().error).toMatchObject({ code: 'worker_unavailable', retryable: true });
    expect(h.audit.receipts[0]).toMatchObject({ outcome: 'error', error_code: 'worker_unavailable' });
    h.nats.failWith = null;
    const retry = await chat(h.app, l, { request_id }); // nothing was delivered, so a same-id retry is safe
    expect(retry.statusCode).toBe(200);
    expect(h.nats.requests).toHaveLength(2);
  });

  it('a timeout after delivery gives 504 upstream_ambiguous (not retryable), is never re-sent, and replays as 409', async () => {
    for (const err of [new Error('TIMEOUT'), Object.assign(new Error('timeout'), { name: 'TimeoutError' })]) {
      const h = await makeHarness();
      h.nats.failWith = err;
      const l = await login(h.app);
      const request_id = randomUUID();
      const first = await chat(h.app, l, { request_id });
      expect(first.statusCode).toBe(504);
      expect(first.json().error).toMatchObject({ code: 'upstream_ambiguous', retryable: false });
      expect(first.json().error.message).toContain('send a new message');
      expect(h.audit.receipts[0]).toMatchObject({ outcome: 'error', error_code: 'upstream_ambiguous' });
      expect(h.nats.requests).toHaveLength(1);
      h.nats.failWith = null;
      const retry = await chat(h.app, l, { request_id });
      expect(retry.statusCode).toBe(409);
      expect(retry.json().error.code).toBe('upstream_ambiguous');
      expect(retry.json().error.message).toContain('send a new message');
      expect(h.nats.requests).toHaveLength(1);
      // a brand-new request_id works again once the worker is back
      expect((await chat(h.app, l)).statusCode).toBe(200);
    }
  });

  it('an unexpected throw after dispatch marks the request ambiguous, returns 502 and never stays in flight (M1)', async () => {
    let calls = 0;
    const usage = {
      used: () => {
        calls += 1;
        if (calls >= 2) throw new Error('boom'); // 1 = cap check, 2 = building the ok response
        return 0;
      },
      increment: async () => 1,
      release: async () => 0,
    };
    const h = await makeHarness({ usage });
    const l = await login(h.app);
    const request_id = randomUUID();
    const res = await chat(h.app, l, { request_id });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'upstream_error', retryable: false });
    expect(h.nats.requests).toHaveLength(1);
    const replay = await chat(h.app, l, { request_id });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('upstream_ambiguous');
    expect(h.nats.requests).toHaveLength(1);
  });

  it('redacts secrets in a worker error message before it reaches the browser (M6)', async () => {
    const h = await makeHarness();
    h.nats.reply = (req) => {
      const e = h.nats.err(req, 'upstream_error');
      return { ...e, error: { ...e.error, message: 'bad key sk-test-ABCDEFGHIJKLMNOP and Bearer abc.def.ghi' } };
    };
    const l = await login(h.app);
    const res = await chat(h.app, l);
    const raw = res.body;
    expect(raw).not.toContain('sk-test-ABCDEFGHIJKLMNOP');
    expect(raw).not.toContain('abc.def.ghi');
    expect(res.json().error.message).toContain('sk-***');
    expect(res.json().envelope.error.message).not.toContain('ABCDEFGHIJKLMNOP');
  });

  it('a completed duplicate returns the cached response with no second NATS request', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    const request_id = randomUUID();
    const first = await chat(h.app, l, { request_id });
    const second = await chat(h.app, l, { request_id });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(h.nats.requests).toHaveLength(1);
    expect(h.usage.used()).toBe(1);
  });

  it('caches completed typed errors too', async () => {
    const h = await makeHarness();
    h.nats.reply = (req) => h.nats.err(req, 'refusal');
    const l = await login(h.app);
    const request_id = randomUUID();
    await chat(h.app, l, { request_id });
    const again = await chat(h.app, l, { request_id });
    expect(again.statusCode).toBe(422);
    expect(h.nats.requests).toHaveLength(1);
  });

  it('a concurrent duplicate is 409 duplicate_in_flight', async () => {
    const h = await makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.nats.reply = async (req) => {
      await gate;
      return h.nats.ok(req);
    };
    const l = await login(h.app);
    const request_id = randomUUID();
    const first = chat(h.app, l, { request_id });
    await new Promise((r) => setTimeout(r, 20));
    const dup = await chat(h.app, l, { request_id });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('duplicate_in_flight');
    release();
    expect((await first).statusCode).toBe(200);
    expect(h.nats.requests).toHaveLength(1);
  });
});

describe('limits', () => {
  it('the 11th request within a minute is 429 user_rate_limited before NATS', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    for (let i = 0; i < 10; i++) expect((await chat(h.app, l)).statusCode).toBe(200);
    const res = await chat(h.app, l);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('user_rate_limited');
    expect(h.nats.requests).toHaveLength(10);
    h.clock.advance(60_001);
    expect((await chat(h.app, l)).statusCode).toBe(200);
  });

  it('a request rejected by the rate limit can be retried with the same request_id', async () => {
    const h = await makeHarness({ config: { userRatePerMin: 1 } });
    const l = await login(h.app);
    await chat(h.app, l);
    const request_id = randomUUID();
    expect((await chat(h.app, l, { request_id })).statusCode).toBe(429);
    h.clock.advance(60_001);
    expect((await chat(h.app, l, { request_id })).statusCode).toBe(200);
  });

  it('cap reached is 429 cap_exceeded before NATS, and persists across buildApp re-creation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safi-usage-'));
    try {
      const h = await makeHarness({ config: { apiCallCap: 2 }, usage: new FileUsageStore(dir) });
      const l = await login(h.app);
      expect((await chat(h.app, l)).statusCode).toBe(200);
      expect((await chat(h.app, l)).statusCode).toBe(200);
      const capped = await chat(h.app, l);
      expect(capped.statusCode).toBe(429);
      expect(capped.json().error.code).toBe('cap_exceeded');
      expect(h.nats.requests).toHaveLength(2);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'))).toEqual({ api_calls_used: 2 });
      expect(fs.readdirSync(dir)).toEqual(['usage.json']); // no stray temp files

      const h2 = await makeHarness({ config: { apiCallCap: 2 }, usage: new FileUsageStore(dir) });
      const l2 = await login(h2.app);
      const again = await chat(h2.app, l2);
      expect(again.statusCode).toBe(429);
      expect(h2.nats.requests).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no responders refunds the call (used() back to its pre-request value, persisted); delivered-then-timeout still counts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safi-usage-'));
    try {
      const h = await makeHarness({ usage: new FileUsageStore(dir) });
      const l = await login(h.app);
      expect((await chat(h.app, l)).statusCode).toBe(200);
      const before = h.usage.used();
      h.nats.failWith = new NoRespondersFailure();
      const res = await chat(h.app, l);
      expect(res.json().error.code).toBe('worker_unavailable');
      expect(h.usage.used()).toBe(before);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'))).toEqual({ api_calls_used: before });
      h.nats.failWith = new Error('TIMEOUT');
      const amb = await chat(h.app, l);
      expect(amb.json().error.code).toBe('upstream_ambiguous');
      expect(h.usage.used()).toBe(before + 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed refund persist is logged and the original worker_unavailable outcome is returned unchanged', async () => {
    const usage = new MemoryUsageStore();
    const realRelease = usage.release.bind(usage);
    usage.release = async () => {
      await realRelease(); // in-memory count drops first, then the persist fails
      throw new Error('disk full');
    };
    const h = await makeHarness({ usage });
    h.nats.failWith = new NoRespondersFailure();
    const l = await login(h.app);
    const res = await chat(h.app, l);
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('worker_unavailable');
    expect(h.usage.used()).toBe(0);
  });

  it('FileUsageStore.release decrements, persists, floors at 0 and survives reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safi-usage-'));
    try {
      const store = new FileUsageStore(dir);
      await store.increment();
      await store.increment();
      expect(await store.release()).toBe(1);
      expect(store.used()).toBe(1);
      expect(new FileUsageStore(dir).used()).toBe(1);
      expect(await store.release()).toBe(0);
      expect(await store.release()).toBe(0); // floors at 0
      expect(store.used()).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'))).toEqual({ api_calls_used: 0 });
      expect(new FileUsageStore(dir).used()).toBe(0);
      expect(fs.readdirSync(dir)).toEqual(['usage.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a request that reached NATS counts toward the cap even when it fails', async () => {
    const h = await makeHarness();
    h.nats.failWith = new Error('no responders');
    const l = await login(h.app);
    await chat(h.app, l);
    expect(h.usage.used()).toBe(1);
  });

  it('refuses to start from a corrupt usage file instead of resetting the cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safi-usage-'));
    try {
      fs.writeFileSync(path.join(dir, 'usage.json'), '{"api_calls_used":"lots"}');
      expect(() => new FileUsageStore(dir)).toThrow(/corrupt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
