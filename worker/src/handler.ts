import {
  OPENAI_SERVICE_GUID,
  PILOT_CONTEXT,
  PILOT_SENDER_GUID,
  buildErrorEnvelope,
  buildResultEnvelope,
  formatAjvErrors,
  redactSecrets,
  validateErrorEnvelope,
  validateRequestEnvelope,
  validateResultEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
  type Registry,
  type RegistryEntry,
  type RequestEnvelope,
  type ResultEnvelope,
} from '@safi/shared';
import type OpenAI from 'openai';
import type { Logger } from 'pino';
import { SYSTEM_INSTRUCTION, type ModelCaller } from './model-caller.js';
import { createOpenAICaller } from './openai-client.js';

export type Reply = ResultEnvelope | ErrorEnvelope;

export interface HandlerOptions {
  registry: Registry;
  /** The provider seam. Either pass `caller`, or the legacy `openai` client + `model` (wrapped as an OpenAI caller). */
  caller?: ModelCaller;
  openai?: OpenAI;
  model?: string;
  maxOutputTokens: number;
  logger: Logger;
  /** Clock in ms (injectable for tests). */
  now?: () => number;
}

export interface Handler {
  handle(envelopeJson: unknown): Promise<Reply>;
  /** Number of calls actually sent to the model provider (for tests). */
  readonly modelCalls: number;
  /** Alias of modelCalls (kept for existing callers). */
  readonly openaiCalls: number;
}

const CACHE_MAX = 500;
const CACHE_TTL_MS = 15 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class Failure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Best-effort request shell used to reply to input that failed envelope validation. */
function fallbackRequest(input: unknown, registry: Registry): RequestEnvelope {
  const o = isObj(input) ? input : {};
  const str = (v: unknown, re: RegExp, dflt: string) => (typeof v === 'string' && re.test(v) ? v : dflt);
  const first = registry.list()[0];
  return {
    protocol: 'safi.chat',
    version: '0.1.0',
    kind: 'chat.request',
    message_id: str(o.message_id, ID_RE, 'unknown'),
    conversation_id: str(o.conversation_id, ID_RE, 'unknown'),
    in_reply_to: null,
    from_guid: PILOT_SENDER_GUID,
    to_guid: OPENAI_SERVICE_GUID,
    context: { ...PILOT_CONTEXT, path: [...PILOT_CONTEXT.path] },
    schema_ref: { id: first?.id ?? 'unknown', version: first?.version ?? '0.0.0' },
    schema_sha256: str(o.schema_sha256, /^[0-9a-f]{64}$/, '0'.repeat(64)),
    sent_at_utc: new Date().toISOString(),
    body: { text: 'x', history: [] },
  };
}

export function createHandler(opts: HandlerOptions): Handler {
  const { registry, maxOutputTokens, logger } = opts;
  let caller = opts.caller;
  if (!caller) {
    if (!opts.openai || !opts.model) throw new Error('createHandler needs either caller, or openai and model');
    caller = createOpenAICaller(opts.openai, opts.model);
  }
  const modelCaller: ModelCaller = caller;
  const now = opts.now ?? Date.now;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 512) {
    throw new Error('maxOutputTokens must be an integer between 1 and 512');
  }

  // message_id -> reply promise (in-flight or completed). Map insertion order doubles as LRU order.
  const cache = new Map<string, { expires: number; promise: Promise<Reply> }>();
  let modelCalls = 0;

  function cacheGet(id: string): Promise<Reply> | undefined {
    const hit = cache.get(id);
    if (!hit) return undefined;
    cache.delete(id);
    if (hit.expires <= now()) return undefined;
    cache.set(id, hit); // refresh recency
    return hit.promise;
  }

  function cacheSet(id: string, promise: Promise<Reply>): void {
    cache.set(id, { expires: now() + CACHE_TTL_MS, promise });
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function errorReply(req: RequestEnvelope, code: ErrorCode, message: string, retryable: boolean): ErrorEnvelope {
    let env = buildErrorEnvelope(req, code, message, retryable);
    if (!validateErrorEnvelope(env)) {
      logger.error({ message_id: req.message_id, detail: formatAjvErrors(validateErrorEnvelope.errors) }, 'error envelope failed validation');
      env = buildErrorEnvelope(req, code, 'error detail unavailable', retryable);
      if (!validateErrorEnvelope(env)) throw new Error('cannot build a valid chat.error envelope');
    }
    return env;
  }

  async function produce(req: RequestEnvelope, entry: RegistryEntry): Promise<Reply> {
    try {
      modelCalls++;
      const outcome = await modelCaller.call({
        system: SYSTEM_INSTRUCTION,
        history: req.body.history,
        text: req.body.text,
        schemaId: entry.id,
        schema: entry.schema as Record<string, unknown>,
        maxOutputTokens,
      });
      if (!outcome.ok) throw new Failure(outcome.failure.code, outcome.failure.message, outcome.failure.retryable);

      let parsed: unknown;
      try {
        parsed = JSON.parse(outcome.text);
      } catch {
        throw new Failure('invalid_model_output', 'model output is not valid JSON', false);
      }
      if (!isObj(parsed)) throw new Failure('invalid_model_output', 'model output is not a JSON object', false);
      if (!entry.validate(parsed)) {
        throw new Failure('invalid_model_output', `model output violates reply schema: ${formatAjvErrors(entry.validate.errors)}`, false);
      }
      const usage = outcome.usage;
      if (!usage) throw new Failure('upstream_error', 'model response has no usage', false);

      const result = buildResultEnvelope(req, parsed, {
        model: outcome.model,
        openai_request_id: outcome.requestId,
        usage,
      });
      if (!validateResultEnvelope(result)) {
        throw new Failure('invalid_model_output', `result envelope invalid: ${formatAjvErrors(validateResultEnvelope.errors)}`, false);
      }
      return result;
    } catch (e) {
      const f = e instanceof Failure ? e : new Failure('upstream_error', 'unexpected worker error', false);
      if (!(e instanceof Failure)) logger.error({ message_id: req.message_id, err: e instanceof Error ? e.name : 'unknown' }, 'unexpected worker error');
      return errorReply(req, f.code, redactSecrets(f.message), f.retryable);
    }
  }

  async function handle(envelopeJson: unknown): Promise<Reply> {
    const started = now();
    const done = (req: RequestEnvelope, reply: Reply, extra: Record<string, unknown> = {}): Reply => {
      logger.info(
        {
          message_id: req.message_id,
          conversation_id: req.conversation_id,
          schema: `${req.schema_ref.id}@${req.schema_ref.version}`,
          outcome: reply.kind === 'chat.error' ? 'error' : 'ok',
          error_code: reply.kind === 'chat.error' ? reply.error.code : null,
          openai_request_id: reply.kind === 'chat.result' ? reply.openai_request_id : null,
          latency_ms: now() - started,
          ...extra,
        },
        'chat request handled',
      );
      return reply;
    };

    // 1. envelope validation
    if (!validateRequestEnvelope(envelopeJson)) {
      const shell = fallbackRequest(envelopeJson, registry);
      const detail = formatAjvErrors(validateRequestEnvelope.errors);
      return done(shell, errorReply(shell, 'ingress_rejected', `request envelope invalid: ${detail}`, false));
    }
    const req = envelopeJson;

    // 2. routing
    const c = req.context;
    const routingOk =
      req.to_guid === OPENAI_SERVICE_GUID &&
      req.from_guid === PILOT_SENDER_GUID &&
      c.thread_guid === PILOT_CONTEXT.thread_guid &&
      c.subject_guid === PILOT_CONTEXT.subject_guid &&
      c.path.length === PILOT_CONTEXT.path.length &&
      c.path.every((g, i) => g === PILOT_CONTEXT.path[i]);
    if (!routingOk) {
      return done(req, errorReply(req, 'routing_rejected', 'routing or context not permitted for this service', false));
    }

    // 3. schema
    const entry = registry.get(req.schema_ref.id, req.schema_ref.version);
    if (!entry || entry.sha256 !== req.schema_sha256) {
      return done(req, errorReply(req, 'schema_rejected', 'unknown schema, version or digest', false));
    }

    // 4. idempotency: a duplicate message_id shares the in-flight or completed reply
    const cached = cacheGet(req.message_id);
    if (cached) return done(req, await cached, { duplicate: true });
    const promise = produce(req, entry);
    cacheSet(req.message_id, promise);
    return done(req, await promise);
  }

  return {
    handle,
    get modelCalls() {
      return modelCalls;
    },
    get openaiCalls() {
      return modelCalls;
    },
  };
}
