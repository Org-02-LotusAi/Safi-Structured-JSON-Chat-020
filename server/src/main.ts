import fs from 'node:fs';
import path from 'node:path';
import { RegistryError, loadRegistry } from '@safi/shared';
import { buildApp, defaultLoggerOptions } from './app.js';
import { ConfigError, loadServerConfig } from './config.js';
import { systemClock } from './deps.js';
import { FileUsageStore } from './limits.js';
import { connectNatsAdapters } from './nats-adapters.js';

function readTls(env: NodeJS.ProcessEnv): { key: Buffer; cert: Buffer } | undefined {
  if (env.TRUST_PROXY === 'true') return undefined;
  const certFile = env.TLS_CERT_FILE;
  const keyFile = env.TLS_KEY_FILE;
  if (!certFile || !keyFile) {
    throw new ConfigError('TLS_CERT_FILE and TLS_KEY_FILE are required (or set TRUST_PROXY=true behind a TLS proxy); refusing to serve plain HTTP');
  }
  try {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  } catch (e) {
    throw new ConfigError(`cannot read TLS files (run "npm run certs:dev" for a dev certificate): ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const config = loadServerConfig(env);
  const https = readTls(env);

  let registry;
  try {
    registry = loadRegistry();
  } catch (e) {
    if (e instanceof RegistryError) throw new ConfigError(`schema registry invalid: ${e.message}`);
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
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => nats.close())
      .then(
        () => process.exit(0),
        (e: unknown) => {
          app.log.error({ err: e instanceof Error ? e.name : 'unknown' }, 'shutdown failed');
          process.exit(1);
        },
      );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: env.HOST || '0.0.0.0', port: Number(env.PORT || 8443) });
  if (!https) app.log.warn('TRUST_PROXY=true: serving plain HTTP; a TLS-terminating proxy must front this port');
}

main().catch((e: unknown) => {
  console.error(`server failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
