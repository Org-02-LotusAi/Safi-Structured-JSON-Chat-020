import { type LlmProvider } from '@safi/shared';
export interface ServerConfig {
    pilotUsername: string;
    pilotPassword: string;
    sessionSecret: string;
    sessionTtlMs: number;
    userRatePerMin: number;
    apiCallCap: number;
    maxInputChars: number;
    maxTurns: number;
    bodyLimitBytes: number;
    /** Active model provider (LLM_PROVIDER). */
    provider: LlmProvider;
    model: string;
    /** NATS request deadline; injectable so tests do not wait 30 s. */
    natsTimeoutMs: number;
    /** Number of trusted reverse-proxy hops (0 = trust none: X-Forwarded-For is ignored). */
    trustProxy: number;
    /** Plain HTTP is allowed only with explicit ALLOW_PLAIN_HTTP_BEHIND_PROXY=true (a TLS proxy must front it). */
    allowPlainHttp: boolean;
    /** Host of OPENAI_BASE_URL when set (informational; used by verify:live to refuse fake upstreams). */
    openaiBaseUrlHost?: string;
    /** Host of ANTHROPIC_BASE_URL when set (same purpose). */
    anthropicBaseUrlHost?: string;
}
export declare class ConfigError extends Error {
    constructor(message: string);
}
type Env = Record<string, string | undefined>;
/** Parses and validates the environment. Throws ConfigError; never echoes secret values. */
export declare function loadServerConfig(env?: Env): ServerConfig;
export {};
