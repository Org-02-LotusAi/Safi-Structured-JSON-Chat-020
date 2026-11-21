export const PROTOCOL = 'safi.chat' as const;
export const PROTOCOL_VERSION = '0.1.0' as const;

// NATS subjects are transport only; they are NOT SAFI Subject GUIDs.
export const CHAT_REQUEST_SUBJECT = 'safi.chat.request.v1';
export const AUDIT_SUBJECT = 'safi.chat.audit.v1';
export const AUDIT_STREAM = 'SAFI_CHAT_AUDIT';
export const WORKER_QUEUE_GROUP = 'safi-openai-worker';
export const REQUEST_DEADLINE_MS = 30_000;

export const AUDIT_STREAM_MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
export const AUDIT_STREAM_MAX_BYTES = 64 * 1024 * 1024;

export const LIMIT_DEFAULTS = {
  SESSION_TTL_MIN: 120,
  USER_RATE_PER_MIN: 10,
  PILOT_API_CALL_CAP: 40,
  MAX_INPUT_CHARS: 4000,
  MAX_TURNS: 8,
  MAX_OUTPUT_TOKENS: 512,
  BODY_LIMIT_BYTES: 16384,
  OPENAI_TIMEOUT_MS: 25_000,
} as const;

export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

export const ERROR_CODES = [
  'ingress_rejected',
  'schema_rejected',
  'routing_rejected',
  'refusal',
  'incomplete',
  'rate_limited',
  'upstream_timeout',
  'upstream_network',
  'upstream_error',
  'invalid_model_output',
  'worker_unavailable',
  'duplicate_in_flight',
  'upstream_ambiguous',
  'cap_exceeded',
  'user_rate_limited',
  'audit_failed',
  'unauthenticated',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
