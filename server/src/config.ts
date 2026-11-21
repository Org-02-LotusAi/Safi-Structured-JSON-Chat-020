import { DEFAULT_OPENAI_MODEL, LIMIT_DEFAULTS, REQUEST_DEADLINE_MS } from '@safi/shared';

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
  model: string;
  /** NATS request deadline; injectable so tests do not wait 30 s. */
  natsTimeoutMs: number;
  trustProxy: boolean;
  /** Host of OPENAI_BASE_URL when set (informational; used by verify:live to refuse fake upstreams). */
  openaiBaseUrlHost?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function intEnv(env: Env, name: string, dflt: number, max?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  if (max !== undefined && n > max) throw new ConfigError(`${name} must be <= ${max}`);
  return n;
}

function baseUrlHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).host;
  } catch {
    throw new ConfigError('OPENAI_BASE_URL must be a valid URL');
  }
}

/** Parses and validates the environment. Throws ConfigError; never echoes secret values. */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  const pilotUsername = env.PILOT_USERNAME ?? '';
  const pilotPassword = env.PILOT_PASSWORD ?? '';
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (!pilotUsername) throw new ConfigError('PILOT_USERNAME is required');
  if (pilotPassword.length < 12) throw new ConfigError('PILOT_PASSWORD is required and must be at least 12 characters');
  if (sessionSecret.length < 32) throw new ConfigError('SESSION_SECRET is required and must be at least 32 characters');
  return {
    pilotUsername,
    pilotPassword,
    sessionSecret,
    sessionTtlMs: intEnv(env, 'SESSION_TTL_MIN', LIMIT_DEFAULTS.SESSION_TTL_MIN) * 60_000,
    userRatePerMin: intEnv(env, 'USER_RATE_PER_MIN', LIMIT_DEFAULTS.USER_RATE_PER_MIN, 10),
    apiCallCap: intEnv(env, 'PILOT_API_CALL_CAP', LIMIT_DEFAULTS.PILOT_API_CALL_CAP),
    maxInputChars: intEnv(env, 'MAX_INPUT_CHARS', LIMIT_DEFAULTS.MAX_INPUT_CHARS, 4000),
    maxTurns: intEnv(env, 'MAX_TURNS', LIMIT_DEFAULTS.MAX_TURNS, 8),
    bodyLimitBytes: intEnv(env, 'BODY_LIMIT_BYTES', LIMIT_DEFAULTS.BODY_LIMIT_BYTES),
    model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    natsTimeoutMs: REQUEST_DEADLINE_MS,
    trustProxy: env.TRUST_PROXY === 'true',
    openaiBaseUrlHost: baseUrlHost(env.OPENAI_BASE_URL),
  };
}
