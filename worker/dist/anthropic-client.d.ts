import Anthropic from '@anthropic-ai/sdk';
import { type ModelCaller } from './model-caller.js';
export interface AnthropicClientOptions {
    apiKey: string;
    /** Optional override (tests point this at a fake server). */
    baseURL?: string;
    timeoutMs: number;
}
/** The single place the SDK is constructed: never auto-retry, hard per-call timeout. */
export declare function createAnthropicClient(opts: AnthropicClientOptions): Anthropic;
/** Subset of the SDK client the caller uses (lets tests inject a fake object). */
export type AnthropicLike = Pick<Anthropic, 'messages'>;
export declare function createAnthropicCaller(client: AnthropicLike, model: string): ModelCaller;
