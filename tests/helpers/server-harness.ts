// TEST-ONLY helpers for exercising buildApp with app.inject and a deterministic fake NATS requester.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  buildErrorEnvelope,
  buildResultEnvelope,
  loadRegistry,
  type AuditReceipt,
  type ErrorCode,
  type RequestEnvelope,
} from '../../shared/src/index.js';
import { buildApp } from '../../server/src/app.js';
import type { AppDeps, AuditPublisher, Clock, NatsRequester } from '../../server/src/deps.js';
import type { ServerConfig } from '../../server/src/config.js';
import { MemoryUsageStore, type UsageStore } from '../../server/src/limits.js';

export const PILOT_USER = 'pilot';
export const PILOT_PASS = 'pilot-password-123';

export const testConfig = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  pilotUsername: PILOT_USER,
  pilotPassword: PILOT_PASS,
  sessionSecret: 'test-session-secret-0123456789abcdef-xyz',
  sessionTtlMs: 120 * 60_000,
  userRatePerMin: 10,
  apiCallCap: 40,
  maxInputChars: 4000,
  maxTurns: 8,
  bodyLimitBytes: 16384,
  provider: 'openai',
  model: 'test-model',
  natsTimeoutMs: 200,
  trustProxy: 0,
  allowPlainHttp: false,
  ...over,
});

export class FakeClock implements Clock {
  constructor(public t = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export type ReplyFn = (req: RequestEnvelope) => unknown | Promise<unknown>;

/** Fake requester: records every request; replies via `reply` (default: a valid result). */
export class FakeNats implements NatsRequester {
  requests: RequestEnvelope[] = [];
  reply: ReplyFn = (req) => this.ok(req);
  failWith: Error | null = null;

  ok(req: RequestEnvelope, body: Record<string, unknown> = { reply: 'hello back', tone: 'neutral', followup_needed: false }) {
    return buildResultEnvelope(req, body, { model: 'test-model', openai_request_id: 'req_fake', usage: { input_tokens: 3, output_tokens: 4 } });
  }
  err(req: RequestEnvelope, code: ErrorCode, retryable = false) {
    return buildErrorEnvelope(req, code, `worker says ${code}`, retryable);
  }

  async request(_subject: string, data: Uint8Array): Promise<Uint8Array> {
    const req = JSON.parse(new TextDecoder().decode(data)) as RequestEnvelope;
    this.requests.push(req);
    if (this.failWith) throw this.failWith;
    return new TextEncoder().encode(JSON.stringify(await this.reply(req)));
  }
}

export class FakeAudit implements AuditPublisher {
  receipts: AuditReceipt[] = [];
  fail = false;
  async publish(r: AuditReceipt): Promise<void> {
    if (this.fail) throw new Error('jetstream down');
    this.receipts.push(r);
  }
}

export interface Harness {
  app: FastifyInstance;
  nats: FakeNats;
  audit: FakeAudit;
  clock: FakeClock;
  usage: UsageStore;
  config: ServerConfig;
}

export async function makeHarness(over: { config?: Partial<ServerConfig>; usage?: UsageStore; webDistDir?: string } = {}): Promise<Harness> {
  const nats = new FakeNats();
  const audit = new FakeAudit();
  const clock = new FakeClock();
  const usage = over.usage ?? new MemoryUsageStore();
  const config = testConfig(over.config);
  const deps: AppDeps = {
    config,
    registry: loadRegistry(),
    natsRequester: nats,
    auditPublisher: audit,
    clock,
    usage,
    logger: false,
    webDistDir: over.webDistDir,
  };
  const app = await buildApp(deps);
  return { app, nats, audit, clock, usage, config };
}

export interface Login {
  cookie: string;
  csrf: string;
  conversation_id: string;
}

export async function login(app: FastifyInstance, username = PILOT_USER, password = PILOT_PASS): Promise<Login> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === 'safi_session')!;
  const body = res.json();
  return { cookie: `safi_session=${c.value}`, csrf: body.csrf_token, conversation_id: body.conversation_id };
}

export const SUMMARY_ID = 'safi.reply.summary';
export const TASKS_ID = 'safi.reply.tasks';

export function chat(app: FastifyInstance, l: Login, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie: l.cookie, 'x-safi-csrf': l.csrf, ...headers },
    payload: { request_id: randomUUID(), conversation_id: l.conversation_id, schema_id: SUMMARY_ID, text: 'hello', ...body },
  });
}
