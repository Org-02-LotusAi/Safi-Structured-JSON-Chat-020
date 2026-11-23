import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ANTHROPIC_MODEL, buildRequestEnvelope, loadRegistry, validateErrorEnvelope, validateResultEnvelope, type RequestEnvelope } from '../shared/src/index.js';
import { createAnthropicCaller } from '../worker/src/anthropic-client.js';
import { loadProviderConfig } from '../worker/src/config.js';
import { createHandler } from '../worker/src/handler.js';
import { loadServerConfig } from '../server/src/config.js';

const registry = loadRegistry();
const summary = registry.get('safi.reply.summary', '1.0.0')!;
const tasks = registry.get('safi.reply.tasks', '1.0.0')!;
const logger = pino({ level: 'silent' });

const validSummary = { reply: 'hello there', tone: 'friendly', followup_needed: false };
const validTasks = { reply: 'two things', tasks: [{ task: 'a', priority: 'high' }], followup_needed: true };

function req(entry = summary, text = 'current question', history: RequestEnvelope['body']['history'] = []): RequestEnvelope {
  return buildRequestEnvelope({
    conversation_id: 'conv-a',
    text,
    history,
    schema_ref: { id: entry.id, version: entry.version },
    schema_sha256: entry.sha256,
  });
}

function response(over: Record<string, unknown> = {}, text: string | null = JSON.stringify(validSummary)) {
  const r: Record<string, unknown> = {
    model: 'claude-sonnet-5-5-20260101',
    stop_reason: 'end_turn',
    content: text === null ? [] : [{ type: 'text', text }],
    usage: { input_tokens: 11, output_tokens: 7 },
    ...over,
  };
  Object.defineProperty(r, '_request_id', { value: 'req_011ant', enumerable: false });
  return r;
}

function setup(outcome: () => unknown) {
  const create = vi.fn(async (_params: unknown) => {
    const o = outcome();
    if (o instanceof Error) throw o;
    return o;
  });
  const handler = createHandler({
    registry,
    caller: createAnthropicCaller({ messages: { create } } as never, 'claude-sonnet-5-5'),
    maxOutputTokens: 512,
    logger,
  });
  return { create, handler };
}

async function expectError(p: Promise<unknown>, code: string, retryable: boolean) {
  const e = (await p) as any;
  expect(e.kind).toBe('chat.error');
  expect(validateErrorEnvelope(e)).toBe(true);
  expect(e.error.code).toBe(code);
  expect(e.error.retryable).toBe(retryable);
  return e;
}

describe('worker handler with the Anthropic provider (fake client, no network)', () => {
  it('returns a validated result for the summary schema and sends the verified request shape', async () => {
    const { create, handler } = setup(() => response());
    const history = [
      { role: 'user' as const, text: 'earlier question' },
      { role: 'assistant' as const, text: 'earlier answer' },
    ];
    const out = (await handler.handle(req(summary, 'current question', history))) as any;
    expect(out.kind).toBe('chat.result');
    expect(validateResultEnvelope(out)).toBe(true);
    expect(out.body).toEqual(validSummary);
    expect(out.model).toBe('claude-sonnet-5-5-20260101');
    expect(out.openai_request_id).toBe('req_011ant');
    expect(out.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
    expect(handler.modelCalls).toBe(1);

    const sent = create.mock.calls[0]![0] as any;
    expect(sent.model).toBe('claude-sonnet-5-5');
    expect(sent.max_tokens).toBe(512);
    expect(sent.system).toContain('guest chat service');
    expect(sent.messages).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'current question' },
    ]);
    expect(sent.output_config.effort).toBe('low');
    expect(sent.output_config.format.type).toBe('json_schema');
    expect(sent.output_config.format.schema).not.toHaveProperty('$schema');
    expect(sent.output_config.format.schema).not.toHaveProperty('$id');
    expect(sent.output_config.format.schema).not.toHaveProperty('title');
    expect(sent.output_config.format.schema.properties).toHaveProperty('reply');
    for (const forbidden of ['thinking', 'temperature', 'tool_choice']) expect(sent).not.toHaveProperty(forbidden);
  });

  it('returns a validated result for the tasks schema', async () => {
    const { handler } = setup(() => response({}, JSON.stringify(validTasks)));
    const out = (await handler.handle(req(tasks))) as any;
    expect(out.kind).toBe('chat.result');
    expect(out.body).toEqual(validTasks);
  });

  it('maps stop_reason refusal to refusal', async () => {
    const { handler } = setup(() => response({ stop_reason: 'refusal' }, null));
    await expectError(handler.handle(req()), 'refusal', false);
  });

  it('maps stop_reason max_tokens to incomplete', async () => {
    const { handler } = setup(() => response({ stop_reason: 'max_tokens' }, '{"reply":"cut'));
    await expectError(handler.handle(req()), 'incomplete', false);
  });

  it('maps an unexpected stop_reason to invalid_model_output', async () => {
    const { handler } = setup(() => response({ stop_reason: 'pause_turn' }));
    await expectError(handler.handle(req()), 'invalid_model_output', false);
  });

  it('maps a missing text block, non-JSON text and schema-invalid JSON to invalid_model_output', async () => {
    for (const r of [response({}, null), response({}, 'not json at all'), response({}, '[1]'), response({}, JSON.stringify({ reply: 'x' }))]) {
      const { handler } = setup(() => r);
      await expectError(handler.handle(req()), 'invalid_model_output', false);
    }
  });

  it('maps SDK errors by class, never auto-retrying', async () => {
    const h = new Headers();
    const cases: [Error, string, boolean][] = [
      [new Anthropic.RateLimitError(429, {}, 'rate', h), 'rate_limited', true],
      [new Anthropic.APIConnectionTimeoutError(), 'upstream_timeout', true],
      [new Anthropic.APIConnectionError({ message: 'down' }), 'upstream_network', true],
      [new Anthropic.InternalServerError(500, {}, 'boom', h), 'upstream_error', true],
      [new Anthropic.BadRequestError(400, {}, 'bad', h), 'upstream_error', false],
      [new Error('weird'), 'upstream_error', false],
    ];
    for (const [err, code, retryable] of cases) {
      const { create, handler } = setup(() => err);
      await expectError(handler.handle(req()), code, retryable);
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it('serves a duplicate message_id from cache with one upstream call', async () => {
    const { create, handler } = setup(() => response());
    const rq = req();
    const a = await handler.handle(rq);
    expect(await handler.handle(rq)).toEqual(a);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('provider configuration', () => {
  it('worker: anthropic without a key refuses to start; with a key it uses the defaults', () => {
    expect(() => loadProviderConfig({ LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY is required/);
    const c = loadProviderConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k-fake-test' });
    expect(c).toMatchObject({ provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL, anthropicTimeoutMs: 25000 });
    expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-sonnet-5-5');
  });

  it('worker: openai is the default and still needs OPENAI_API_KEY', () => {
    expect(() => loadProviderConfig({})).toThrow(/OPENAI_API_KEY is required/);
    expect(() => loadProviderConfig({ ANTHROPIC_API_KEY: 'k-fake-test' })).toThrow(/OPENAI_API_KEY is required/);
    expect(loadProviderConfig({ OPENAI_API_KEY: 'k-fake-test' })).toMatchObject({ provider: 'openai', model: 'gpt-6-luna' });
  });

  it('worker and server: an unknown LLM_PROVIDER refuses', () => {
    expect(() => loadProviderConfig({ LLM_PROVIDER: 'gemini', OPENAI_API_KEY: 'k-fake-test' })).toThrow(/LLM_PROVIDER/);
    const base = { PILOT_USERNAME: 'pilot', PILOT_PASSWORD: 'pilot-password-123', SESSION_SECRET: 'x'.repeat(40) };
    expect(() => loadServerConfig({ ...base, LLM_PROVIDER: 'gemini' })).toThrow(/LLM_PROVIDER/);
  });

  it('server: provider and model follow LLM_PROVIDER', () => {
    const base = { PILOT_USERNAME: 'pilot', PILOT_PASSWORD: 'pilot-password-123', SESSION_SECRET: 'x'.repeat(40) };
    expect(loadServerConfig(base)).toMatchObject({ provider: 'openai', model: 'gpt-6-luna' });
    expect(loadServerConfig({ ...base, LLM_PROVIDER: 'anthropic' })).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(loadServerConfig({ ...base, LLM_PROVIDER: 'anthropic', ANTHROPIC_MODEL: 'm-x', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' })).toMatchObject({
      model: 'm-x',
      anthropicBaseUrlHost: '127.0.0.1:9',
    });
  });
});
