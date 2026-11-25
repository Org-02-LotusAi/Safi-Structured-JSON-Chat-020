import OpenAI from 'openai';
import { type ModelCaller } from './model-caller.js';
export interface OpenAIClientOptions {
    apiKey: string;
    /** Optional override (tests point this at a fake server). */
    baseURL?: string;
    timeoutMs: number;
}
/** The single place the SDK is constructed: never auto-retry, hard per-call timeout. */
export declare function createOpenAIClient(opts: OpenAIClientOptions): OpenAI;
export declare function createOpenAICaller(openai: OpenAI, model: string): ModelCaller;
