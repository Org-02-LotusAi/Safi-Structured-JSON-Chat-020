import { CHAT_REQUEST_SUBJECT, WORKER_QUEUE_GROUP, loadRegistry } from '@safi/shared';
import { connect } from '@nats-io/transport-node';
import pino from 'pino';
import { createHandler } from './handler.js';
import { createAnthropicCaller, createAnthropicClient } from './anthropic-client.js';
import { createOpenAICaller, createOpenAIClient } from './openai-client.js';
const encoder = new TextEncoder();
export async function startWorker(opts) {
    const provider = opts.provider ?? 'openai';
    let caller;
    if (provider === 'anthropic') {
        if (!opts.anthropicApiKey && !opts.anthropicClient)
            throw new Error('anthropicApiKey is required when provider=anthropic');
        const client = opts.anthropicClient ??
            createAnthropicClient({ apiKey: opts.anthropicApiKey, baseURL: opts.anthropicBaseURL, timeoutMs: opts.anthropicTimeoutMs ?? 25_000 });
        caller = createAnthropicCaller(client, opts.model);
    }
    else {
        if (!opts.openaiApiKey)
            throw new Error('openaiApiKey is required when provider=openai');
        caller = createOpenAICaller(createOpenAIClient({ apiKey: opts.openaiApiKey, baseURL: opts.openaiBaseURL, timeoutMs: opts.openaiTimeoutMs ?? 25_000 }), opts.model);
    }
    const logger = opts.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['*.api_key', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] });
    const registry = opts.registry ?? loadRegistry();
    const handler = createHandler({
        registry,
        caller,
        maxOutputTokens: opts.maxOutputTokens,
        logger,
    });
    const nc = await connect({
        servers: opts.natsUrl,
        name: 'safi-openai-worker',
        user: opts.natsUser,
        pass: opts.natsPass,
        reconnect: true,
        maxReconnectAttempts: -1,
    });
    void (async () => {
        for await (const s of nc.status())
            logger.info({ nats_status: s.type }, 'nats connection status');
    })();
    const sub = nc.subscribe(CHAT_REQUEST_SUBJECT, { queue: WORKER_QUEUE_GROUP });
    await nc.flush(); // the server has registered the subscription before we report "started"
    const inflight = new Set();
    const serve = async (msg) => {
        let input;
        try {
            input = JSON.parse(new TextDecoder().decode(msg.data));
        }
        catch {
            input = undefined; // handler answers with ingress_rejected
        }
        try {
            const reply = await handler.handle(input);
            if (msg.reply)
                msg.respond(encoder.encode(JSON.stringify(reply)));
        }
        catch (e) {
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
