import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildErrorEnvelope,
  buildRequestEnvelope,
  buildResultEnvelope,
  DEFAULT_SCHEMAS_DIR,
  ERROR_CODES,
  formatAjvErrors,
  loadRegistry,
  OPENAI_SERVICE_GUID,
  PILOT_SENDER_GUID,
  PILOT_SUBJECT_GUID,
  PILOT_THREAD_GUID,
  redactSecrets,
  RegistryError,
  validateBrowserChatRequest,
  validateErrorEnvelope,
  validateRequestEnvelope,
  validateResultEnvelope,
} from '../shared/src/index.js';

const registry = loadRegistry();
const summary = registry.getLatest('safi.reply.summary')!;
const tasks = registry.getLatest('safi.reply.tasks')!;

function makeRequest(over: { text?: string; history?: { role: 'user' | 'assistant'; text: string }[] } = {}) {
  return buildRequestEnvelope({
    conversation_id: 'conv-1',
    text: over.text ?? 'hello',
    history: over.history,
    schema_ref: { id: summary.id, version: summary.version },
    schema_sha256: summary.sha256,
  });
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function tmpSchemasCopy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safi-schemas-'));
  for (const f of fs.readdirSync(DEFAULT_SCHEMAS_DIR)) fs.copyFileSync(path.join(DEFAULT_SCHEMAS_DIR, f), path.join(dir, f));
  return dir;
}

/** Rewrites a copied reply schema and refreshes its registry digest so only the content check can fail. */
function mutateReplySchema(dir: string, file: string, mutate: (s: any) => void) {
  const p = path.join(dir, file);
  const schema = JSON.parse(fs.readFileSync(p, 'utf8'));
  mutate(schema);
  const text = JSON.stringify(schema, null, 2) + '\n';
  fs.writeFileSync(p, text);
  const reg = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
  reg.schemas.find((e: any) => e.file === file).sha256 = createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(reg));
}

describe('registry', () => {
  it('loads both reply schemas with digests matching file bytes', () => {
    expect(registry.list().map((e) => `${e.id}@${e.version}`).sort()).toEqual(['safi.reply.summary@1.0.0', 'safi.reply.tasks@1.0.0']);
    for (const e of registry.list()) {
      const file = JSON.parse(fs.readFileSync(path.join(DEFAULT_SCHEMAS_DIR, 'registry.json'), 'utf8')).schemas.find((s: any) => s.id === e.id).file;
      expect(createHash('sha256').update(fs.readFileSync(path.join(DEFAULT_SCHEMAS_DIR, file))).digest('hex')).toBe(e.sha256);
    }
    expect(registry.get('safi.reply.summary', '1.0.0')).toBe(summary);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.get('safi.reply.summary', '9.9.9')).toBeUndefined();
  });

  it('detects a tampered schema file', () => {
    const dir = tmpSchemasCopy();
    const p = path.join(dir, 'reply-summary.v1.0.0.schema.json');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('Summary reply', 'Summary replx'));
    expect(() => loadRegistry(dir)).toThrow(RegistryError);
    expect(() => loadRegistry(dir)).toThrow(/SHA-256 mismatch/);
  });

  it.each(['minLength', 'pattern', 'format', 'oneOf'])('rejects unsupported keyword %s in a reply schema', (kw) => {
    const dir = tmpSchemasCopy();
    mutateReplySchema(dir, 'reply-summary.v1.0.0.schema.json', (s) => {
      s.properties.reply[kw] = kw === 'oneOf' ? [{ type: 'string' }] : kw === 'minLength' ? 1 : 'x';
    });
    expect(() => loadRegistry(dir)).toThrow(RegistryError);
    expect(() => loadRegistry(dir)).toThrow(new RegExp(`unsupported keyword "${kw}"`));
  });

  it('rejects unsupported keywords nested in array items', () => {
    const dir = tmpSchemasCopy();
    mutateReplySchema(dir, 'reply-tasks.v1.0.0.schema.json', (s) => {
      s.properties.tasks.items.properties.task.minLength = 1;
    });
    expect(() => loadRegistry(dir)).toThrow(/unsupported keyword "minLength"/);
  });

  it('rejects an object schema that is not closed', () => {
    const dir = tmpSchemasCopy();
    mutateReplySchema(dir, 'reply-summary.v1.0.0.schema.json', (s) => { delete s.additionalProperties; });
    expect(() => loadRegistry(dir)).toThrow(/additionalProperties:false/);
  });

  it('throws RegistryError when registry.json is missing', () => {
    expect(() => loadRegistry(fs.mkdtempSync(path.join(os.tmpdir(), 'safi-empty-')))).toThrow(RegistryError);
  });
});

describe('reply validators', () => {
  const okSummary = { reply: 'hi', tone: 'friendly', followup_needed: false };
  const okTasks = { reply: 'hi', tasks: [{ task: 'do it', priority: 'high' }], followup_needed: true };

  it('accept valid samples (tasks may be empty)', () => {
    expect(summary.validate(okSummary)).toBe(true);
    expect(tasks.validate(okTasks)).toBe(true);
    expect(tasks.validate({ ...okTasks, tasks: [] })).toBe(true);
  });

  it('reject extra fields, missing fields, bad enums and wrong types', () => {
    expect(summary.validate({ ...okSummary, extra: 1 })).toBe(false);
    expect(summary.validate({ reply: 'hi', tone: 'friendly' })).toBe(false);
    expect(summary.validate({ ...okSummary, tone: 'angry' })).toBe(false);
    expect(summary.validate({ ...okSummary, followup_needed: 'no' })).toBe(false);
    expect(tasks.validate({ ...okTasks, tasks: [{ task: 'x', priority: 'urgent' }] })).toBe(false);
    expect(tasks.validate({ ...okTasks, tasks: [{ task: 'x', priority: 'low', extra: 1 }] })).toBe(false);
    expect(tasks.validate({ ...okTasks, tasks: [{ task: 'x' }] })).toBe(false);
    expect(tasks.validate({ ...okTasks, tasks: 'none' })).toBe(false);
  });
});

describe('envelopes', () => {
  const meta = { model: 'gpt-6-luna', openai_request_id: 'req_1', usage: { input_tokens: 3, output_tokens: 4 } };

  it('accept built request/result/error envelopes', () => {
    const req = makeRequest({ history: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] });
    expect(validateRequestEnvelope(req), formatAjvErrors(validateRequestEnvelope.errors)).toBe(true);
    const res = buildResultEnvelope(req, { reply: 'x', tone: 'neutral', followup_needed: false }, meta);
    expect(validateResultEnvelope(res), formatAjvErrors(validateResultEnvelope.errors)).toBe(true);
    const err = buildErrorEnvelope(req, 'refusal', 'model refused', false);
    expect(validateErrorEnvelope(err), formatAjvErrors(validateErrorEnvelope.errors)).toBe(true);
    expect(validateResultEnvelope({ ...res, openai_request_id: null })).toBe(true);
  });

  it('reject unknown top-level and nested fields', () => {
    const req = makeRequest();
    expect(validateRequestEnvelope({ ...req, extra: 1 })).toBe(false);
    const a = clone(req) as any; a.body.extra = 1;
    expect(validateRequestEnvelope(a)).toBe(false);
    const b = clone(req) as any; b.context.extra = 1;
    expect(validateRequestEnvelope(b)).toBe(false);
    const c = clone(req) as any; c.schema_ref.extra = 1;
    expect(validateRequestEnvelope(c)).toBe(false);
    const res = buildResultEnvelope(req, {}, meta);
    expect(validateResultEnvelope({ ...res, extra: 1 })).toBe(false);
    expect(validateResultEnvelope({ ...res, usage: { ...res.usage, extra: 1 } })).toBe(false);
    const err = buildErrorEnvelope(req, 'upstream_error', 'm', true);
    expect(validateErrorEnvelope({ ...err, extra: 1 })).toBe(false);
    expect(validateErrorEnvelope({ ...err, error: { ...err.error, extra: 1 } })).toBe(false);
    expect(validateErrorEnvelope({ ...err, error: { ...err.error, code: 'made_up' } })).toBe(false);
  });

  it('reject bad GUIDs, timestamps, text length and history length', () => {
    const req = makeRequest();
    expect(validateRequestEnvelope({ ...req, from_guid: PILOT_SENDER_GUID.toUpperCase() })).toBe(false);
    expect(validateRequestEnvelope({ ...req, to_guid: OPENAI_SERVICE_GUID.slice(0, 31) })).toBe(false);
    const g = clone(req); g.context.path = [];
    expect(validateRequestEnvelope(g)).toBe(false);
    expect(validateRequestEnvelope({ ...req, sent_at_utc: '2026-11-21T10:00:00' })).toBe(false);
    expect(validateRequestEnvelope({ ...req, sent_at_utc: '2026-11-21T10:00:00+00:00' })).toBe(false);
    expect(validateRequestEnvelope({ ...req, sent_at_utc: '2026-11-21T10:00:00Z' })).toBe(true);
    expect(validateRequestEnvelope(makeRequest({ text: 'x'.repeat(4000) }))).toBe(true);
    expect(validateRequestEnvelope(makeRequest({ text: 'x'.repeat(4001) }))).toBe(false);
    expect(validateRequestEnvelope(makeRequest({ text: '' }))).toBe(false);
    const hist = (n: number) => Array.from({ length: n }, () => ({ role: 'user' as const, text: 'h' }));
    expect(validateRequestEnvelope(makeRequest({ history: hist(16) }))).toBe(true);
    expect(validateRequestEnvelope(makeRequest({ history: hist(17) }))).toBe(false);
  });

  it('requests have in_reply_to null and result/error reverse from/to with in_reply_to set', () => {
    const req = makeRequest();
    expect(req.in_reply_to).toBeNull();
    expect(req.sent_at_utc.endsWith('Z')).toBe(true);
    const err = buildErrorEnvelope(req, 'cap_exceeded', 'cap', false);
    expect(err.from_guid).toBe(req.to_guid);
    expect(err.to_guid).toBe(req.from_guid);
    expect(err.in_reply_to).toBe(req.message_id);
    expect(err.message_id).not.toBe(req.message_id);
    expect(err.schema_ref).toEqual(req.schema_ref);
    const res = buildResultEnvelope(req, {}, meta);
    expect(res.from_guid).toBe(req.to_guid);
    expect(res.in_reply_to).toBe(req.message_id);
  });

  it('error envelope redacts secrets and caps the message at 500 chars', () => {
    const req = makeRequest();
    const err = buildErrorEnvelope(req, 'upstream_error', `bad key sk-abcdefghijklmnop1234 and Bearer abc.def-ghi ${'x'.repeat(600)}`, false);
    expect(err.error.message).not.toContain('sk-abcdefghijklmnop1234');
    expect(err.error.message).not.toContain('abc.def-ghi');
    expect(err.error.message.length).toBeLessThanOrEqual(500);
    expect(validateErrorEnvelope(err)).toBe(true);
  });
});

describe('browser chat request validator', () => {
  const ok = { request_id: '123e4567-e89b-42d3-a456-426614174000', conversation_id: 'conv-1', schema_id: 'safi.reply.summary', text: 'hi' };

  it('accepts the minimal and the full body', () => {
    expect(validateBrowserChatRequest(ok)).toBe(true);
    expect(validateBrowserChatRequest({ ...ok, schema_sha256: 'a'.repeat(64) })).toBe(true);
  });

  it.each([
    ['from_guid', PILOT_SENDER_GUID],
    ['context', { thread_guid: 'x' }],
    ['schema', { type: 'object' }],
    ['model', 'gpt-x'],
    ['subject', 'x'],
    ['role', 'system'],
  ])('rejects extra field %s', (key, value) => {
    expect(validateBrowserChatRequest({ ...ok, [key]: value })).toBe(false);
  });

  it('rejects bad values and missing fields', () => {
    expect(validateBrowserChatRequest({ ...ok, request_id: 'not-a-uuid' })).toBe(false);
    expect(validateBrowserChatRequest({ ...ok, text: '' })).toBe(false);
    expect(validateBrowserChatRequest({ ...ok, text: 'x'.repeat(4001) })).toBe(false);
    expect(validateBrowserChatRequest({ ...ok, schema_sha256: 'ABC' })).toBe(false);
    const { text: _t, ...missing } = ok;
    expect(validateBrowserChatRequest(missing)).toBe(false);
  });
});

describe('helpers', () => {
  it('formatAjvErrors is short and does not echo instance data', () => {
    const secret = 'sk-supersecretvalue1234';
    validateBrowserChatRequest({ request_id: secret, conversation_id: 'c', schema_id: 's', text: 't', evil: secret });
    const msg = formatAjvErrors(validateBrowserChatRequest.errors);
    expect(msg).not.toContain(secret);
    expect(msg).toContain('evil');
    expect(formatAjvErrors(null)).toBe('validation failed');
  });

  it('redactSecrets masks sk- keys and Bearer tokens', () => {
    expect(redactSecrets('key sk-proj-abcdefgh12345678 ok')).toBe('key sk-*** ok');
    expect(redactSecrets('Authorization: Bearer abc123.def')).toBe('Authorization: Bearer ***');
    expect(redactSecrets('nothing here')).toBe('nothing here');
  });
});

describe('contract pins', () => {
  it('ERROR_CODES equals the error.code enum in chat-error.schema.json, in order', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(DEFAULT_SCHEMAS_DIR, 'chat-error.schema.json'), 'utf8'));
    expect([...ERROR_CODES]).toEqual(schema.properties.error.properties.code.enum);
  });

  it('the four GUID constants are 32 lowercase hex characters', () => {
    for (const g of [PILOT_SENDER_GUID, OPENAI_SERVICE_GUID, PILOT_THREAD_GUID, PILOT_SUBJECT_GUID]) {
      expect(g).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});
