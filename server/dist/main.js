import path from 'node:path';
import { RegistryError, loadRegistry } from '@safi/shared';
import { buildApp, defaultLoggerOptions } from './app.js';
import { ConfigError, loadServerConfig } from './config.js';
import { readTls } from './tls.js';
import { systemClock } from './deps.js';
import { FileUsageStore } from './limits.js';
import { connectNatsAdapters } from './nats-adapters.js';
async function main() {
    const env = process.env;
    const config = loadServerConfig(env);
    const https = readTls(env, config.allowPlainHttp);
    let registry;
    try {
        registry = loadRegistry();
    }
    catch (e) {
        if (e instanceof RegistryError)
            throw new ConfigError(`schema registry invalid: ${e.message}`);
        throw e;
    }
    const usage = new FileUsageStore(path.resolve(env.DATA_DIR || './data'));
    const nats = await connectNatsAdapters({
        url: env.NATS_URL || 'nats://127.0.0.1:4222',
        user: env.NATS_USER || undefined,
        pass: env.NATS_PASS || undefined,
    });
    const app = await buildApp({
        config,
        registry,
        natsRequester: nats.requester,
        auditPublisher: nats.audit,
        clock: systemClock,
        usage,
        logger: defaultLoggerOptions(),
        natsStatus: nats.status,
        webDistDir: path.resolve(env.WEB_DIST_DIR || 'web/dist'),
        https,
    });
    let stopping = false;
    const shutdown = (signal) => {
        if (stopping)
            return;
        stopping = true;
        app.log.info({ signal }, 'shutting down');
        app
            .close()
            .then(() => nats.close())
            .then(() => process.exit(0), (e) => {
            app.log.error({ err: e instanceof Error ? e.name : 'unknown' }, 'shutdown failed');
            process.exit(1);
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    await app.listen({ host: env.HOST || '0.0.0.0', port: Number(env.PORT || 8443) });
    if (!https)
        app.log.warn('ALLOW_PLAIN_HTTP_BEHIND_PROXY=true: serving plain HTTP; a TLS-terminating proxy must front this port');
}
main().catch((e) => {
    console.error(`server failed to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
