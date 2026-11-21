import { stopStack } from './stack.js';

// Runs in the same process as global-setup, so the module-level stack handle is shared.
export default async function globalTeardown(): Promise<void> {
  await stopStack();
}
