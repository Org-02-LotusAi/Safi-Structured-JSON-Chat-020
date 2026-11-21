// Verifies schemas/registry.json: SHA-256 digests, strict keyword allowlist, Ajv compile.
// Uses the shared loader (build first: `tsc -b shared`, done by `npm run schemas:check`).
import { loadRegistry, RegistryError } from '../shared/dist/index.js';

try {
  const registry = loadRegistry();
  for (const e of registry.list()) console.log(`ok  ${e.id}@${e.version}  sha256=${e.sha256}`);
  console.log(`schemas:check passed (${registry.list().length} reply schemas)`);
} catch (err) {
  if (err instanceof RegistryError) {
    console.error(`schemas:check FAILED: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
