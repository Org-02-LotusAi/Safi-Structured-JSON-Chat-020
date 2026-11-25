import { type ErrorEnvelope, type Registry, type ResultEnvelope } from '@safi/shared';
import type OpenAI from 'openai';
import type { Logger } from 'pino';
import { type ModelCaller } from './model-caller.js';
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
export declare function createHandler(opts: HandlerOptions): Handler;
