import type { AuditReceipt, Registry } from '@safi/shared';
import type { ServerConfig } from './config.js';
import type { UsageStore } from './limits.js';

export interface NatsRequester {
  /** Resolves with the raw reply payload; rejects on no-responders, timeout or connection failure. */
  request(subject: string, data: Uint8Array, timeoutMs: number): Promise<Uint8Array>;
}

export interface AuditPublisher {
  /** Resolves only after the receipt is durably acknowledged (JetStream ack). */
  publish(receipt: AuditReceipt): Promise<void>;
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface AppDeps {
  config: ServerConfig;
  registry: Registry;
  natsRequester: NatsRequester;
  auditPublisher: AuditPublisher;
  clock: Clock;
  usage: UsageStore;
  /** Fastify logger option: pino options, or false to silence. Defaults to redacting pino options. */
  logger?: object | false;
  /** Reports transport state for GET /api/status. Defaults to "connected". */
  natsStatus?: () => 'connected' | 'disconnected';
  /** Built SPA directory; when absent or missing a fallback page is served. */
  webDistDir?: string;
  /** TLS material; omit when running behind a TLS-terminating proxy or in tests. */
  https?: { key: Buffer; cert: Buffer };
}
