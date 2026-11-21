import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// LIVE acceptance UI test against a deployed pilot backed by the REAL OpenAI API (SOW A04/A05 UI evidence).
// Runs only with E2E_LIVE=1 and E2E_START_STACK=0 (use `npm run test:e2e:live`, which also loads .env).
// It uses exactly two chat turns (two OpenAI calls). TLS errors are NOT ignored unless E2E_INSECURE_TLS=1.
// Screenshots go to evidence/live/<timestamp>/.

const LIVE = process.env.E2E_LIVE === '1' && process.env.E2E_START_STACK === '0';
const USER = process.env.PILOT_USERNAME ?? '';
const PASS = process.env.PILOT_PASSWORD ?? '';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const shots = path.resolve('evidence', 'live', stamp);

test.describe.configure({ mode: 'serial' });

test.describe('SAFI Chat live deployment (real OpenAI)', () => {
  test.skip(!LIVE, 'live only: set E2E_LIVE=1 and E2E_START_STACK=0 (npm run test:e2e:live)');

  let page: Page;
  test.beforeAll(async ({ browser }) => {
    if (!USER || !PASS) throw new Error('PILOT_USERNAME and PILOT_PASSWORD are required for the live spec');
    fs.mkdirSync(shots, { recursive: true });
    page = await (await browser.newContext()).newPage();
  });
  test.afterAll(async () => {
    await page?.context().close();
  });

  test('sign in, summary turn, tasks turn with schema metadata', async () => {
    await page.goto('/');
    await page.getByLabel('Username').fill(USER);
    await page.getByLabel('Password').fill(PASS);
    await page.getByRole('button', { name: /sign in/i }).click();
    const box = page.getByRole('textbox', { name: 'Message' });
    await expect(box).toBeEnabled({ timeout: 30_000 });
    await page.screenshot({ path: path.join(shots, '01-signed-in.png'), fullPage: true });

    // Turn 1: summary schema
    await box.fill('In two sentences, say hello and tell me which day comes after Monday.');
    await page.getByRole('button', { name: 'Send message' }).click();
    const first = page.getByTestId('assistant-ok').first();
    await expect(first).toBeVisible({ timeout: 60_000 });
    await expect(first).toContainText('safi.reply.summary');
    await expect(first).toContainText('1.0.0');
    await expect(first.getByTestId('validation-badge')).toContainText('PASS');
    await expect(first).toContainText(/[0-9a-f]{12}…/); // schema digest prefix
    await expect(first).toContainText(/req_[A-Za-z0-9]+/); // real OpenAI request id
    await first.getByText('Structured data').click();
    await expect(first.getByTestId('structured-json')).toContainText('"reply"');
    await page.screenshot({ path: path.join(shots, '02-summary.png'), fullPage: true });

    // Turn 2: tasks schema
    await page.getByLabel('Reply format').selectOption('safi.reply.tasks');
    await box.fill('Plan my morning: wake up, breakfast, write the weekly report.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByTestId('assistant-ok')).toHaveCount(2, { timeout: 60_000 });
    const second = page.getByTestId('assistant-ok').last();
    await expect(second).toContainText('safi.reply.tasks');
    await expect(second.getByTestId('validation-badge')).toContainText('PASS');
    await expect(second).toContainText(/req_[A-Za-z0-9]+/);
    await expect(second.getByRole('list', { name: 'Tasks' })).toBeVisible();
    await expect(second.getByText('persisted')).toBeVisible();
    await second.getByText('Structured data').click();
    await expect(second.getByTestId('structured-json')).toContainText('"tasks"');
    await page.screenshot({ path: path.join(shots, '03-tasks.png'), fullPage: true });
  });
});
