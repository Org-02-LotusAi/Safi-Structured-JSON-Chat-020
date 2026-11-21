import { DEFAULT_OPENAI_MODEL, LIMIT_DEFAULTS, RegistryError, loadRegistry } from '@safi/shared';
import pino from 'pino';
import { startWorker } from './service.js';

function intEnv(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

async function main(): Promise<void> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['*.api_key', 'OPENAI_API_KEY'] });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required (set it in the environment); refusing to start');

  const maxOutputTokens = intEnv('MAX_OUTPUT_TOKENS', LIMIT_DEFAULTS.MAX_OUTPUT_TOKENS);
  if (maxOutputTokens > 512) throw new Error('MAX_OUTPUT_TOKENS must be <= 512');

  let registry;
  try {
    registry = loadRegistry();
  } catch (e) {
    if (e instanceof RegistryError) throw new Error(`schema registry invalid: ${e.message}`);
    throw e;
  }

  const worker = await startWorker({
    natsUrl: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
    natsUser: process.env.NATS_USER || undefined,
    natsPass: process.env.NATS_PASS || undefined,
    openaiApiKey: apiKey,
    openaiBaseURL: process.env.OPENAI_BASE_URL || undefined,
    openaiTimeoutMs: intEnv('OPENAI_TIMEOUT_MS', LIMIT_DEFAULTS.OPENAI_TIMEOUT_MS),
    model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    maxOutputTokens,
    registry,
    logger,
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    worker.stop().then(
      () => process.exit(0),
      (e: unknown) => {
        logger.error({ err: e instanceof Error ? e.message : 'unknown' }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  console.error(`worker failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
