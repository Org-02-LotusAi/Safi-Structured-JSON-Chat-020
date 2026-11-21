import { E2E_PASS, E2E_USER, startStack } from './stack.js';

export default async function globalSetup(): Promise<void> {
  if (process.env.E2E_START_STACK === '0') return;
  const base = new URL(process.env.E2E_BASE_URL ?? 'https://localhost:8443');
  const { controlUrl } = await startStack(Number(base.port || 443));
  process.env.E2E_CONTROL_URL = controlUrl;
  process.env.E2E_USERNAME = E2E_USER;
  process.env.E2E_PASSWORD = E2E_PASS;
}
