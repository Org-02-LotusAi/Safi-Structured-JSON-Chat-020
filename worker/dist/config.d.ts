type Env = Record<string, string | undefined>;
export declare function intEnv(env: Env, name: string, dflt: number): number;
export type ProviderConfig = {
    provider: 'openai';
    openaiApiKey: string;
    openaiBaseURL?: string;
    openaiTimeoutMs: number;
    model: string;
} | {
    provider: 'anthropic';
    anthropicApiKey: string;
    anthropicBaseURL?: string;
    anthropicTimeoutMs: number;
    model: string;
};
/** Reads LLM_PROVIDER and the matching key/model/base-url/timeout. Throws (never echoes key values) so the worker refuses to start. */
export declare function loadProviderConfig(env?: Env): ProviderConfig;
export {};
