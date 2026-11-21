import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OPENAI_SERVICE_GUID,
  buildRequestEnvelope,
  loadRegistry,
  validateErrorEnvelope,
  validateResultEnvelope,
  type RequestEnvelope,
} from '../shared/src/index.js';
import { createHandler, type Handler } from '../worker/src/handler.js';
import { createOpenAIClient } from '../worker/src/openai-client.js';
import { startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.js';

const registry = loadRegistry();
const summary = registry.get('safi.reply.summary', '1.0.0')!;
const tasks = registry.get('safi.reply.tasks', '1.0.0')!;
const logLines: string[] = [];
const logger = pino({ level: 'info' }, { write: (s: string) => void logLines.push(s) });

const validSummary = { reply: 'hello there', tone: 'friendly', followup_needed: false };
const validTasks = { reply: 'two things', tasks: [{ task: 'a', priority: 'high' }], followup_needed: true };

function req(over: Partial<RequestEnvelope> = {}, entry = summary, text = 'secret prompt text', history: RequestEnvelope['body']['history'] = []): RequestEnvelope {
  return {
    ...buildRequestEnvelope({
      conversation_id: 'conv-1',
      text,
      history,
      schema_ref: { id: entry.id, version: entry.version },
      schema_sha256: entry.sha256,
    }),
    ...over,
  };
}

describe('worker handler', () => {
  let fake: FakeOpenAI;
  let handler: Handler;

  beforeAll(async () => {
    fake = await startFakeOpenAI();
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    fake.requests.length = 0;
    logLines.length = 0;
    handler = createHandler({
      registry,
      openai: createOpenAIClient({ apiKey: 'sk-test-dummy-key', baseURL: fake.baseURL, timeoutMs: 400 }),
      model: 'test-model',
      maxOutputTokens: 512,
      logger,
    });
  });

  async function expectError(r: unknown, code: string, retryable: boolean) {
    const e = (await r) as any;
    expect(e.kind).toBe('chat.error');
    expect(validateErrorEnvelope(e)).toBe(true);
    expect(e.error.code).toBe(code);
    expect(e.error.retryable).toBe(retryable);
    return e;
  }

  it('returns a validated result for the summary schema and sends a strict request', async () => {
    fake.script({ kind: 'json', body: validSummary });
    const history = [
      { role: 'user' as const, text: 'earlier question' },
      { role: 'assistant' as const, text: 'earlier answer' },
    ];
    const rq = req({}, summary, 'current question', history);
    const out = (await handler.handle(rq)) as any;
    expect(out.kind).toBe('chat.result');
    expect(validateResultEnvelope(out)).toBe(true);
    expect(out.body).toEqual(validSummary);
    expect(out.model).toBe('fake-model-1');
    expect(out.openai_request_id).toBe('req_fake_123');
    expect(out.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
    expect(out.in_reply_to).toBe(rq.message_id);
    expect(out.from_guid).toBe(OPENAI_SERVICE_GUID);

    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0]!;
    expect(sent.model).toBe('test-model');
    expect(sent.store).toBe(false);
    expect(sent.max_output_tokens).toBeLessThanOrEqual(512);
    expect(sent.tools).toBeUndefined();
    expect(sent.stream).toBeFalsy();
    expect(sent.text.format.type).toBe('json_schema');
    expect(sent.text.format.strict).toBe(true);
    expect(sent.text.format.name).toBe('safi_reply_summary');
    expect(sent.text.format.schema).toEqual(summary.schema);
    const roles = sent.input.map((i: any) => `${i.role}:${i.content}`);
    expect(roles[0]).toMatch(/^system:/);
    expect(roles.slice(1)).toEqual(['user:earlier question', 'assistant:earlier answer', 'user:current question']);
  });

  it('returns a validated result for the tasks schema', async () => {
    fake.script({ kind: 'json', body: validTasks });
    const out = (await handler.handle(req({}, tasks))) as any;
    expect(out.kind).toBe('chat.result');
    expect(out.body).toEqual(validTasks);
    expect(fake.requests[0]!.text.format.name).toBe('safi_reply_tasks');
  });

  it('rejects a malformed envelope with ingress_rejected and no upstream call', async () => {
    await expectError(handler.handle({ nope: true }), 'ingress_rejected', false);
    await expectError(handler.handle('not an object'), 'ingress_rejected', false);
    await expectError(handler.handle(undefined), 'ingress_rejected', false);
    await expectError(handler.handle(req({ extra: 1 } as any)), 'ingress_rejected', false);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ['to_guid', { to_guid: '5afe00200000000000000000000000ff' }],
    ['from_guid', { from_guid: '5afe00200000000000000000000000ff' }],
    ['context thread', { context: { thread_guid: '5afe00200000000000000000000000ff', subject_guid: '5afe0020000000000000000000000004', path: ['5afe0020000000000000000000000003', '5afe0020000000000000000000000004'] } }],
    ['context path order', { context: { thread_guid: '5afe0020000000000000000000000003', subject_guid: '5afe0020000000000000000000000004', path: ['5afe0020000000000000000000000004', '5afe0020000000000000000000000003'] } }],
  ])('rejects bad routing (%s) with routing_rejected and no upstream call', async (_n, over) => {
    await expectError(handler.handle(req(over as Partial<RequestEnvelope>)), 'routing_rejected', false);
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects unknown schema, wrong version and wrong digest with schema_rejected', async () => {
    await expectError(handler.handle(req({ schema_ref: { id: 'safi.reply.nope', version: '1.0.0' } })), 'schema_rejected', false);
    await expectError(handler.handle(req({ schema_ref: { id: summary.id, version: '9.9.9' } })), 'schema_rejected', false);
    await expectError(handler.handle(req({ schema_sha256: 'a'.repeat(64) })), 'schema_rejected', false);
    expect(fake.requests).toHaveLength(0);
    expect(handler.openaiCalls).toBe(0);
  });

  it('maps extra-field JSON to invalid_model_output naming the path, not the content', async () => {
    fake.script({ kind: 'json', body: { ...validSummary, sneaky: 'LEAKED-CONTENT' } });
    const e = await expectError(handler.handle(req()), 'invalid_model_output', false);
    expect(e.error.message).toContain('sneaky');
    expect(e.error.message).not.toContain('LEAKED-CONTENT');
  });

  it('maps a schema-type violation to invalid_model_output', async () => {
    fake.script({ kind: 'json', body: { ...validSummary, tone: 'angry' } });
    const e = await expectError(handler.handle(req()), 'invalid_model_output', false);
    expect(e.error.message).toContain('/tone');
  });

  it('maps malformed JSON text and non-object JSON to invalid_model_output', async () => {
    fake.script({ kind: 'text', text: '{"reply": ' }, { kind: 'text', text: '[1,2]' });
    await expectError(handler.handle(req()), 'invalid_model_output', false);
    await expectError(handler.handle(req()), 'invalid_model_output', false);
  });

  it('maps a refusal item to refusal', async () => {
    fake.script({ kind: 'refusal' });
    await expectError(handler.handle(req()), 'refusal', false);
  });

  it('maps status incomplete to incomplete (not retryable)', async () => {
    fake.script({ kind: 'incomplete' });
    const e = await expectError(handler.handle(req()), 'incomplete', false);
    expect(e.error.message).toContain('max_output_tokens');
  });

  it('maps HTTP 429 to rate_limited (retryable) and does not auto-retry', async () => {
    fake.script({ kind: 'http', status: 429 });
    await expectError(handler.handle(req()), 'rate_limited', true);
    expect(fake.requests).toHaveLength(1);
  });

  it('maps HTTP 500 to upstream_error (retryable) and 400 to upstream_error (not retryable)', async () => {
    fake.script({ kind: 'http', status: 500 }, { kind: 'http', status: 400 });
    await expectError(handler.handle(req()), 'upstream_error', true);
    await expectError(handler.handle(req()), 'upstream_error', false);
    expect(fake.requests).toHaveLength(2);
  });

  it('maps a hang beyond the timeout to upstream_timeout', async () => {
    fake.script({ kind: 'hang' });
    await expectError(handler.handle(req()), 'upstream_timeout', true);
    expect(fake.requests).toHaveLength(1);
  });

  it('maps a destroyed socket to upstream_network', async () => {
    fake.script({ kind: 'destroy' });
    await expectError(handler.handle(req()), 'upstream_network', true);
    expect(fake.requests).toHaveLength(1);
  });

  it('serves a sequential duplicate message_id from cache with one upstream call', async () => {
    fake.script({ kind: 'json', body: validSummary });
    const rq = req();
    const a = await handler.handle(rq);
    const b = await handler.handle(rq);
    expect(b).toEqual(a);
    expect(handler.openaiCalls).toBe(1);
    expect(fake.requests).toHaveLength(1);
  });

  it('shares one in-flight call between concurrent duplicates', async () => {
    fake.script({ kind: 'json', body: validSummary, delayMs: 100 });
    const rq = req();
    const [a, b, c] = await Promise.all([handler.handle(rq), handler.handle(rq), handler.handle(rq)]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(handler.openaiCalls).toBe(1);
    expect(fake.requests).toHaveLength(1);
  });

  it('caches failures too (duplicate of a failed message_id does not call OpenAI again)', async () => {
    fake.script({ kind: 'http', status: 429 });
    const rq = req();
    await handler.handle(rq);
    const again = (await handler.handle(rq)) as any;
    expect(again.error.code).toBe('rate_limited');
    expect(handler.openaiCalls).toBe(1);
  });

  it('expires cache entries after the TTL and evicts beyond 500 entries', async () => {
    let t = 1_000_000;
    const h = createHandler({
      registry,
      openai: createOpenAIClient({ apiKey: 'sk-test-dummy-key', baseURL: fake.baseURL, timeoutMs: 400 }),
      model: 'test-model',
      maxOutputTokens: 512,
      logger,
      now: () => t,
    });
    fake.script({ kind: 'json', body: validSummary }, { kind: 'json', body: validSummary });
    const rq = req();
    await h.handle(rq);
    t += 14 * 60 * 1000;
    await h.handle(rq);
    expect(h.openaiCalls).toBe(1);
    t += 2 * 60 * 1000; // past the 15 min TTL measured from the first insert
    await h.handle(rq);
    expect(h.openaiCalls).toBe(2);
  });

  it('evicts the oldest entry when more than 500 distinct ids are cached', async () => {
    // schema rejections are not cached, so use real (failing-fast) upstream errors via 400s
    const total = 502;
    fake.script(...Array.from({ length: total + 1 }, () => ({ kind: 'http', status: 400 }) as const));
    const first = req({ message_id: 'first' });
    await handler.handle(first);
    for (let i = 0; i < total - 1; i++) await handler.handle(req({ message_id: `m${i}` }));
    expect(handler.openaiCalls).toBe(total);
    await handler.handle(first); // evicted -> new upstream call
    expect(handler.openaiCalls).toBe(total + 1);
  });

  it('rejects maxOutputTokens above 512', () => {
    expect(() =>
      createHandler({ registry, openai: createOpenAIClient({ apiKey: 'sk-x', baseURL: fake.baseURL, timeoutMs: 100 }), model: 'm', maxOutputTokens: 513, logger }),
    ).toThrow(/maxOutputTokens/);
  });

  it('logs ids and outcome but never prompt text, history or reply content', async () => {
    fake.script({ kind: 'json', body: { ...validSummary, reply: 'REPLY-CONTENT-XYZ' } });
    const rq = req({}, summary, 'PROMPT-TEXT-ABC', [{ role: 'user', text: 'HISTORY-TEXT-DEF' }]);
    await handler.handle(rq);
    const logs = logLines.join('\n');
    expect(logs).toContain(rq.message_id);
    expect(logs).toContain('"outcome":"ok"');
    expect(logs).not.toContain('PROMPT-TEXT-ABC');
    expect(logs).not.toContain('HISTORY-TEXT-DEF');
    expect(logs).not.toContain('REPLY-CONTENT-XYZ');
  });
});
