import fs from 'node:fs';
import { ConfigError } from './config.js';

/** TLS is decided independently of proxy trust: cert+key => HTTPS; plain HTTP only when explicitly allowed. */
export function readTls(env: NodeJS.ProcessEnv, allowPlainHttp: boolean): { key: Buffer; cert: Buffer } | undefined {
  const certFile = env.TLS_CERT_FILE;
  const keyFile = env.TLS_KEY_FILE;
  if (!certFile || !keyFile) {
    if (allowPlainHttp) return undefined;
    throw new ConfigError('TLS_CERT_FILE and TLS_KEY_FILE are required; plain HTTP needs explicit ALLOW_PLAIN_HTTP_BEHIND_PROXY=true behind a TLS-terminating proxy');
  }
  try {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  } catch (e) {
    throw new ConfigError(`cannot read TLS files (run "npm run certs:dev" for a dev certificate): ${(e as Error).message}`);
  }
}
