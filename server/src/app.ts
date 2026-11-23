import fs from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerAuthRoutes, requireSession, sendError } from './auth.js';
import { registerChatRoute, type WorkerState } from './chat-route.js';
import type { AppDeps } from './deps.js';
import { SessionStore } from './sessions.js';

export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'authorization',
  'cookie',
  'set-cookie',
  '*.api_key',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'body',
  '*.text',
  'history',
  '*.history',
  'reply',
  '*.reply',
];

export function defaultLoggerOptions(): object {
  return { level: process.env.LOG_LEVEL ?? 'info', redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' } };
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
  'cross-origin-opener-policy': 'same-origin',
};

const FALLBACK_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SAFI Chat 020</title></head>' +
  '<body><h1>SAFI Chat 020</h1><p>The web app has not been built. Run <code>npm run build</code> and restart.</p></body></html>';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const options = {
    logger: deps.logger === undefined ? defaultLoggerOptions() : deps.logger,
    bodyLimit: config.bodyLimitBytes,
    // 0 = trust none (XFF ignored); n > 0 = trust the n nearest hops. Fastify fails closed on a bare number,
    // so use an explicit hop function. The port must only be reachable via those proxies (see README).
    trustProxy: config.trustProxy === 0 ? false : (_addr: string, hop: number) => hop < config.trustProxy,
    ...(deps.https ? { https: deps.https } : {}),
  } as unknown as FastifyServerOptions;
  const app = Fastify(options) as unknown as FastifyInstance;

  await app.register(fastifyCookie, { secret: config.sessionSecret });

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // Uniform JSON errors; unknown 5xx details are never leaked to the client.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err: err.name }, 'unhandled error');
      return sendError(reply, 500, 'upstream_error', 'Internal server error.');
    }
    return sendError(reply, status, 'ingress_rejected', status === 413 ? 'Request body too large.' : 'Malformed request.');
  });

  const sessions = new SessionStore(deps.clock, config.sessionTtlMs);
  const authCtx = { config, clock: deps.clock, sessions };
  const worker: WorkerState = { state: 'unknown', last_seen_at: null };
  const auth = requireSession(authCtx);

  registerAuthRoutes(app, authCtx);
  registerChatRoute(app, { ...authCtx, deps, worker });

  app.get('/api/schemas', async () => ({
    schemas: deps.registry
      .list()
      .filter((e) => e.ui_choice)
      .map((e) => ({ id: e.id, version: e.version, sha256: e.sha256, label: e.label, schema: e.schema })),
  }));

  const anthropicActive = config.provider === 'anthropic';
  const realHost = anthropicActive ? 'api.anthropic.com' : 'api.openai.com';
  const customHost = anthropicActive ? config.anthropicBaseUrlHost : config.openaiBaseUrlHost;
  const upstreamHost = customHost ?? realHost;
  const upstreamName = !customHost || customHost === realHost ? config.provider : 'custom';

  app.get('/api/status', { preHandler: [auth] }, async () => ({
    api_calls_used: deps.usage.used(),
    api_call_cap: config.apiCallCap,
    user_rate_per_min: config.userRatePerMin,
    model: config.model,
    provider: config.provider,
    // The provider name ("openai" | "anthropic") unless its base URL points elsewhere ("custom").
    // Reflects the server's own environment: deploy server and worker with the same .env (compose does)
    // so this matches the worker.
    upstream: upstreamName,
    upstream_host: upstreamHost,
    openai_base_url_host: config.openaiBaseUrlHost ?? 'api.openai.com',
    nats: deps.natsStatus ? deps.natsStatus() : 'connected',
    worker: { ...worker },
  }));

  app.get('/healthz', async () => ({ ok: true }));

  app.all('/api/*', async (_req, reply) => sendError(reply, 404, 'routing_rejected', 'Unknown API route.'));

  const webDist = deps.webDistDir && fs.existsSync(path.join(deps.webDistDir, 'index.html')) ? deps.webDistDir : undefined;
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return sendError(reply, 404, 'routing_rejected', 'Not found.');
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(FALLBACK_PAGE));
  }

  return app;
}
