import OpenAI from 'openai';

export interface OpenAIClientOptions {
  apiKey: string;
  /** Optional override (tests point this at a fake server). */
  baseURL?: string;
  timeoutMs: number;
}

/** The single place the SDK is constructed: never auto-retry, hard per-call timeout. */
export function createOpenAIClient(opts: OpenAIClientOptions): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    maxRetries: 0,
    timeout: opts.timeoutMs,
  });
}
