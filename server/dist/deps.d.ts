import type { AuditReceipt, Registry } from '@safi/shared';
import type { ServerConfig } from './config.js';
import type { UsageStore } from './limits.js';
/** Thrown by a NatsRequester when no subscriber was listening: the request was never delivered. */
export declare class NoRespondersFailure extends Error {
    constructor(message?: string);
}
export interface NatsRequester {
    /** Resolves with the raw reply payload; rejects with NoRespondersFailure when nothing was delivered; any other rejection (timeout, disconnect) means the outcome is unknown. */
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
export declare const systemClock: Clock;
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
    https?: {
        key: Buffer;
        cert: Buffer;
    };
}
