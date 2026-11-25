import { type Registry } from '@safi/shared';
import { type Logger } from 'pino';
import { type Handler } from './handler.js';
import { type AnthropicLike } from './anthropic-client.js';
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
export declare function startWorker(opts: WorkerOptions): Promise<RunningWorker>;
