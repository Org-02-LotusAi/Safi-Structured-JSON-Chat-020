import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// Real browser -> real HTTPS Fastify -> real NATS -> real worker process -> fake OpenAI (TEST-ONLY).
// The pilot rate limit is 10 req/min; this file sends 9 chat requests in total, so keep it that way.

const CONTROL = process.env.E2E_CONTROL_URL;
const USER = process.env.E2E_USERNAME ?? process.env.PILOT_USERNAME ?? 'pilot';
const PASS = process.env.E2E_PASSWORD ?? process.env.PILOT_PASSWORD ?? '';
const shots = path.resolve('evidence', 'e2e');

async function ctl(method: 'GET' | 'POST', route: string, body?: unknown): Promise<any> {
  if (!CONTROL) throw new Error('E2E_CONTROL_URL not set (this spec needs E2E_START_STACK=1)');
  const res = await fetch(`${CONTROL}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control ${route} -> ${res.status}`);
  return res.json();
}

const summary = (reply: string) => ({ kind: 'json' as const, body: { reply, tone: 'friendly', followup_needed: false } });

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password').fill(PASS);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  // Reply formats load asynchronously; the composer is disabled until one is selected.
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeEnabled();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

test.describe.configure({ mode: 'serial' });

test.describe('SAFI Chat over real HTTPS and NATS', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext()).newPage();
    await ctl('POST', '/reset');
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  test('login, then a three-turn summary conversation uses prior turns', async () => {
    await signIn(page);
    await ctl('POST', '/script', [summary('Reply one'), summary('Reply two'), summary('Reply three')]);

    await send(page, 'My name is Ada.');
    await expect(page.getByTestId('assistant-ok')).toHaveCount(1);
    await send(page, 'I like compilers.');
    await expect(page.getByTestId('assistant-ok')).toHaveCount(2);
    await send(page, 'What did I say my name was?');
    await expect(page.getByTestId('assistant-ok')).toHaveCount(3);

    const ok = page.getByTestId('assistant-ok').last();
    await expect(ok).toContainText('Reply three');
    await expect(ok).toContainText('safi.reply.summary');
    await expect(ok).toContainText('1.0.0');
    await expect(ok.getByTestId('validation-badge')).toContainText('PASS');

    const reqs = await ctl('GET', '/requests');
    expect(reqs).toHaveLength(3);
    // Request 3 must carry both earlier turns (user + assistant) as history.
    const flat = JSON.stringify(reqs[2].input);
    expect(flat).toContain('My name is Ada.');
    expect(flat).toContain('I like compilers.');
    expect(flat).toContain('Reply one');
    expect(flat).toContain('Reply two');
    // Request 1 had no prior turns.
    expect(JSON.stringify(reqs[0].input)).not.toContain('Reply one');
    // store=false and strict json_schema are sent to the upstream.
    expect(reqs[2].store).toBe(false);
    expect(reqs[2].text.format.type).toBe('json_schema');
    expect(reqs[2].text.format.strict).toBe(true);

    await page.screenshot({ path: path.join(shots, '01-three-turn-summary.png'), fullPage: true });
  });

  test('switching to the tasks schema shows a task list and metadata', async () => {
    await page.getByLabel('Reply format').selectOption('safi.reply.tasks');
    await ctl('POST', '/script', [
      {
        kind: 'json',
        body: {
          reply: 'Here is your plan.',
          tasks: [
            { task: 'Write the report', priority: 'high' },
            { task: 'Tidy the desk', priority: 'low' },
          ],
          followup_needed: true,
        },
      },
    ]);
    await send(page, 'Plan my day.');
    await expect(page.getByTestId('assistant-ok')).toHaveCount(4);
    const ok = page.getByTestId('assistant-ok').last();
    const tasks = ok.getByRole('list', { name: 'Tasks' });
    await expect(tasks).toContainText('Write the report');
    await expect(tasks).toContainText('Tidy the desk');
    await expect(ok).toContainText('safi.reply.tasks');
    await expect(ok).toContainText('1.0.0');
    await expect(ok.getByTestId('validation-badge')).toContainText('PASS');
    await expect(ok).toContainText(/[0-9a-f]{12}…/); // schema digest prefix
    await expect(ok).toContainText('Audit');
    await expect(ok.getByText('persisted')).toBeVisible();
    await page.screenshot({ path: path.join(shots, '02-tasks.png'), fullPage: true });
  });

  test('a malformed model reply is visibly REJECTED', async () => {
    await ctl('POST', '/script', [{ kind: 'json', body: { reply: 'x', tasks: [], followup_needed: false, smuggled: 'extra' } }]);
    await send(page, 'Give me bad data.');
    const err = page.getByTestId('assistant-error').last();
    await expect(err).toContainText('REJECTED');
    await expect(err).toContainText('invalid_model_output');
    await expect(page.getByTestId('assistant-ok')).toHaveCount(4); // no new success card
    await page.screenshot({ path: path.join(shots, '03-rejected.png'), fullPage: true });
  });

  test('a model refusal is shown as a refusal error', async () => {
    await ctl('POST', '/script', [{ kind: 'refusal' }]);
    await send(page, 'Do something forbidden.');
    const err = page.getByTestId('assistant-error').last();
    await expect(err).toContainText('refusal');
    await expect(err).toContainText('declined');
    await expect(page.getByTestId('assistant-ok')).toHaveCount(4);
    await page.screenshot({ path: path.join(shots, '04-refusal.png'), fullPage: true });
  });

  test('worker stopped gives an offline error; restart recovers', async () => {
    await ctl('POST', '/worker/stop');
    const before = (await ctl('GET', '/requests')).length;
    await send(page, 'Anyone there?');
    const err = page.getByTestId('assistant-error').last();
    await expect(err).toContainText('worker_unavailable');
    await expect(err).toContainText('offline');
    expect((await ctl('GET', '/requests')).length).toBe(before); // no upstream call, no fake success
    await page.screenshot({ path: path.join(shots, '05-worker-offline.png'), fullPage: true });

    await ctl('POST', '/worker/start');
    await ctl('POST', '/script', [{ kind: 'json', body: { reply: 'Back online', tasks: [], followup_needed: false } }]);
    await send(page, 'Try again.');
    await expect(page.getByTestId('assistant-ok')).toHaveCount(5);
    await expect(page.getByTestId('assistant-ok').last()).toContainText('Back online');
    await page.screenshot({ path: path.join(shots, '06-worker-recovered.png'), fullPage: true });
  });

  test('reload keeps the session', async () => {
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible(); // no login screen
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeEnabled();
    await ctl('POST', '/script', [summary('After reload')]);
    await send(page, 'Still me.');
    await expect(page.getByTestId('assistant-ok').last()).toContainText('After reload');
    await expect(page.getByTestId('usage-meter')).toContainText('/ 40');
    await page.screenshot({ path: path.join(shots, '07-after-reload.png'), fullPage: true });
  });
});
