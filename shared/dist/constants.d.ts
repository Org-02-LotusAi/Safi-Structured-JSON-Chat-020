export declare const PROTOCOL: "safi.chat";
export declare const PROTOCOL_VERSION: "0.1.0";
export declare const CHAT_REQUEST_SUBJECT = "safi.chat.request.v1";
export declare const AUDIT_SUBJECT = "safi.chat.audit.v1";
export declare const AUDIT_STREAM = "SAFI_CHAT_AUDIT";
export declare const WORKER_QUEUE_GROUP = "safi-openai-worker";
export declare const REQUEST_DEADLINE_MS = 30000;
export declare const AUDIT_STREAM_MAX_AGE_NS: number;
export declare const AUDIT_STREAM_MAX_BYTES: number;
export declare const LIMIT_DEFAULTS: {
    readonly SESSION_TTL_MIN: 120;
    readonly USER_RATE_PER_MIN: 10;
    readonly PILOT_API_CALL_CAP: 40;
    readonly MAX_INPUT_CHARS: 4000;
    readonly MAX_TURNS: 8;
    readonly MAX_OUTPUT_TOKENS: 512;
    readonly BODY_LIMIT_BYTES: 16384;
    readonly OPENAI_TIMEOUT_MS: 25000;
};
export declare const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
export declare const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
export declare const ANTHROPIC_TIMEOUT_MS_DEFAULT = 25000;
export declare const LLM_PROVIDERS: readonly ["openai", "anthropic"];
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
/** Parses LLM_PROVIDER (default "openai"). Throws on any other value; never echoes secrets. */
export declare function parseLlmProvider(raw: string | undefined): LlmProvider;
export declare const ERROR_CODES: readonly ["ingress_rejected", "schema_rejected", "routing_rejected", "refusal", "incomplete", "rate_limited", "upstream_timeout", "upstream_network", "upstream_error", "invalid_model_output", "worker_unavailable", "duplicate_in_flight", "upstream_ambiguous", "cap_exceeded", "user_rate_limited", "audit_failed", "unauthenticated"];
export type ErrorCode = (typeof ERROR_CODES)[number];
