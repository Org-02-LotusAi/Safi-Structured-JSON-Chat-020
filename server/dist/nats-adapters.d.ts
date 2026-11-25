import { type JetStreamManager } from '@nats-io/jetstream';
import { type AuditPublisher, type NatsRequester } from './deps.js';
export interface NatsConnectOptions {
    url: string;
    user?: string;
    pass?: string;
}
export interface NatsAdapters {
    requester: NatsRequester;
    audit: AuditPublisher;
    status(): 'connected' | 'disconnected';
    close(): Promise<void>;
}
/** Creates the audit stream if missing; otherwise updates it to the CONTRACTS config. */
export declare function ensureAuditStream(jsm: JetStreamManager): Promise<void>;
export declare function connectNatsAdapters(opts: NatsConnectOptions): Promise<NatsAdapters>;
