import { ANTHROPIC_TIMEOUT_MS_DEFAULT, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, LIMIT_DEFAULTS, parseLlmProvider, type LlmProvider } from '@safi/shared';

type Env = Record<string, string | undefined>;

export function intEnv(env: Env, name: string, dflt: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export type ProviderConfig =
  | { provider: 'openai'; openaiApiKey: string; openaiBaseURL?: string; openaiTimeoutMs: number; model: string }
  | { provider: 'anthropic'; anthropicApiKey: string; anthropicBaseURL?: string; anthropicTimeoutMs: number; model: string };

/** Reads LLM_PROVIDER and the matching key/model/base-url/timeout. Throws (never echoes key values) so the worker refuses to start. */
export function loadProviderConfig(env: Env = process.env): ProviderConfig {
  const provider: LlmProvider = parseLlmProvider(env.LLM_PROVIDER);
  if (provider === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic (set it in the environment); refusing to start');
    return {
      provider,
      anthropicApiKey: apiKey,
      anthropicBaseURL: env.ANTHROPIC_BASE_URL || undefined,
      anthropicTimeoutMs: intEnv(env, 'ANTHROPIC_TIMEOUT_MS', ANTHROPIC_TIMEOUT_MS_DEFAULT),
      model: env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
    };
  }
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai (set it in the environment); refusing to start');
  return {
    provider,
    openaiApiKey: apiKey,
    openaiBaseURL: env.OPENAI_BASE_URL || undefined,
    openaiTimeoutMs: intEnv(env, 'OPENAI_TIMEOUT_MS', LIMIT_DEFAULTS.OPENAI_TIMEOUT_MS),
    model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
  };
}
