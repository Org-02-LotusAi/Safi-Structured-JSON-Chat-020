import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, parseLlmProvider, LIMIT_DEFAULTS, REQUEST_DEADLINE_MS } from '@safi/shared';
export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}
function intEnv(env, name, dflt, max) {
    const raw = env[name];
    if (raw === undefined || raw === '')
        return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0)
        throw new ConfigError(`${name} must be a positive integer`);
    if (max !== undefined && n > max)
        throw new ConfigError(`${name} must be <= ${max}`);
    return n;
}
function trustProxyHops(env) {
    const legacy = env.TRUST_PROXY;
    if (legacy !== undefined && legacy !== '' && legacy !== 'false') {
        throw new ConfigError('TRUST_PROXY is no longer supported; set TRUST_PROXY_HOPS to the number of trusted proxy hops (0 = none)');
    }
    const raw = env.TRUST_PROXY_HOPS;
    if (raw === undefined || raw === '')
        return 0;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 10)
        throw new ConfigError('TRUST_PROXY_HOPS must be an integer between 0 and 10');
    return n;
}
function baseUrlHost(raw, name) {
    if (!raw)
        return undefined;
    try {
        return new URL(raw).host;
    }
    catch {
        throw new ConfigError(`${name} must be a valid URL`);
    }
}
/** Parses and validates the environment. Throws ConfigError; never echoes secret values. */
export function loadServerConfig(env = process.env) {
    const pilotUsername = env.PILOT_USERNAME ?? '';
    const pilotPassword = env.PILOT_PASSWORD ?? '';
    const sessionSecret = env.SESSION_SECRET ?? '';
    if (!pilotUsername)
        throw new ConfigError('PILOT_USERNAME is required');
    if (pilotPassword.length < 12)
        throw new ConfigError('PILOT_PASSWORD is required and must be at least 12 characters');
    if (sessionSecret.length < 32)
        throw new ConfigError('SESSION_SECRET is required and must be at least 32 characters');
    let provider;
    try {
        provider = parseLlmProvider(env.LLM_PROVIDER);
    }
    catch (e) {
        throw new ConfigError(e.message);
    }
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
        provider,
        model: provider === 'anthropic' ? env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL : env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
        natsTimeoutMs: REQUEST_DEADLINE_MS,
        trustProxy: trustProxyHops(env),
        allowPlainHttp: env.ALLOW_PLAIN_HTTP_BEHIND_PROXY === 'true',
        openaiBaseUrlHost: baseUrlHost(env.OPENAI_BASE_URL, 'OPENAI_BASE_URL'),
        anthropicBaseUrlHost: baseUrlHost(env.ANTHROPIC_BASE_URL, 'ANTHROPIC_BASE_URL'),
    };
}
