import { CHAT_REQUEST_SUBJECT, WORKER_QUEUE_GROUP, loadRegistry, type Registry } from '@safi/shared';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import pino, { type Logger } from 'pino';
import { createHandler, type Handler } from './handler.js';
import { createAnthropicCaller, createAnthropicClient, type AnthropicLike } from './anthropic-client.js';
import type { ModelCaller } from './model-caller.js';
import { createOpenAICaller, createOpenAIClient } from './openai-client.js';

export interface WorkerOptions {
  natsUrl: string;
  natsUser?: string;
  natsPass?: string;
  /** Defaults to "openai". */
  provider?: 'openai' | 'anthropic';
  openaiApiKey?: string;
  /** Optional OpenAI base URL override (tests use a fake server). */
  openaiBaseURL?: string;
  openaiTimeoutMs?: number;
  anthropicApiKey?: string;
  anthropicBaseURL?: string;
  anthropicTimeoutMs?: number;
  /** Test seam: a fake Anthropic client (no network). */
  anthropicClient?: AnthropicLike;
  model: string;
  maxOutputTokens: number;
  /** Defaults to loading and verifying <repo>/schemas; throws on any registry error. */
  registry?: Registry;
  logger?: Logger;
}

export interface RunningWorker {
  handler: Handler;
  /** Stops accepting requests, finishes in-flight ones, closes the connection. */
  stop(): Promise<void>;
}

const encoder = new TextEncoder();

export async function startWorker(opts: WorkerOptions): Promise<RunningWorker> {
  const provider = opts.provider ?? 'openai';
  let caller: ModelCaller;
  if (provider === 'anthropic') {
    if (!opts.anthropicApiKey && !opts.anthropicClient) throw new Error('anthropicApiKey is required when provider=anthropic');
    const client =
      opts.anthropicClient ??
      createAnthropicClient({ apiKey: opts.anthropicApiKey!, baseURL: opts.anthropicBaseURL, timeoutMs: opts.anthropicTimeoutMs ?? 25_000 });
    caller = createAnthropicCaller(client, opts.model);
  } else {
    if (!opts.openaiApiKey) throw new Error('openaiApiKey is required when provider=openai');
    caller = createOpenAICaller(
      createOpenAIClient({ apiKey: opts.openaiApiKey, baseURL: opts.openaiBaseURL, timeoutMs: opts.openaiTimeoutMs ?? 25_000 }),
      opts.model,
    );
  }
  const logger = opts.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['*.api_key', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] });
  const registry = opts.registry ?? loadRegistry();
  const handler = createHandler({
    registry,
    caller,
    maxOutputTokens: opts.maxOutputTokens,
    logger,
  });

  const nc: NatsConnection = await connect({
    servers: opts.natsUrl,
    name: 'safi-openai-worker',
    user: opts.natsUser,
    pass: opts.natsPass,
    reconnect: true,
    maxReconnectAttempts: -1,
  });
  void (async () => {
    for await (const s of nc.status()) logger.info({ nats_status: s.type }, 'nats connection status');
  })();

  const sub = nc.subscribe(CHAT_REQUEST_SUBJECT, { queue: WORKER_QUEUE_GROUP });
  await nc.flush(); // the server has registered the subscription before we report "started"
  const inflight = new Set<Promise<void>>();

  const serve = async (msg: { data: Uint8Array; reply?: string; respond: (d: Uint8Array) => boolean }) => {
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(msg.data));
    } catch {
      input = undefined; // handler answers with ingress_rejected
    }
    try {
      const reply = await handler.handle(input);
      if (msg.reply) msg.respond(encoder.encode(JSON.stringify(reply)));
    } catch (e) {
      // handler never throws by design; if it does, the requester sees a timeout, so log loudly
      logger.error({ err: e instanceof Error ? e.message : 'unknown' }, 'handler failed to produce a reply');
    }
  };

  void (async () => {
    for await (const msg of sub) {
      const p = serve(msg).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  })();

  logger.info({ subject: CHAT_REQUEST_SUBJECT, queue: WORKER_QUEUE_GROUP, model: opts.model, provider }, 'worker started');

  return {
    handler,
    async stop() {
      sub.unsubscribe();
      await Promise.allSettled([...inflight]);
      await nc.drain();
    },
  };
}
