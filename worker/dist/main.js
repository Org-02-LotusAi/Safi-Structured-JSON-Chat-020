import { LIMIT_DEFAULTS, RegistryError, loadRegistry } from '@safi/shared';
import pino from 'pino';
import { intEnv, loadProviderConfig } from './config.js';
import { startWorker } from './service.js';
async function main() {
    const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['*.api_key', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] });
    const providerConfig = loadProviderConfig(process.env);
    const maxOutputTokens = intEnv(process.env, 'MAX_OUTPUT_TOKENS', LIMIT_DEFAULTS.MAX_OUTPUT_TOKENS);
    if (maxOutputTokens > 512)
        throw new Error('MAX_OUTPUT_TOKENS must be <= 512');
    let registry;
    try {
        registry = loadRegistry();
    }
    catch (e) {
        if (e instanceof RegistryError)
            throw new Error(`schema registry invalid: ${e.message}`);
        throw e;
    }
    const worker = await startWorker({
        natsUrl: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',
        natsUser: process.env.NATS_USER || undefined,
        natsPass: process.env.NATS_PASS || undefined,
        ...providerConfig,
        maxOutputTokens,
        registry,
        logger,
    });
    let stopping = false;
    const shutdown = (signal) => {
        if (stopping)
            return;
        stopping = true;
        logger.info({ signal }, 'shutting down');
        worker.stop().then(() => process.exit(0), (e) => {
            logger.error({ err: e instanceof Error ? e.message : 'unknown' }, 'shutdown failed');
            process.exit(1);
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}
main().catch((e) => {
    console.error(`worker failed to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
