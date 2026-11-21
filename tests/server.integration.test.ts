import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { jetstreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_STREAM, loadRegistry, type AuditReceipt } from '../shared/src/index.js';
import { buildApp } from '../server/src/app.js';
import { systemClock } from '../server/src/deps.js';
import { FileUsageStore } from '../server/src/limits.js';
import { connectNatsAdapters, type NatsAdapters } from '../server/src/nats-adapters.js';
import { startWorker, type RunningWorker } from '../worker/src/service.js';
import { startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.js';
import { startNatsServer, type TestNats } from './helpers/nats-server.js';
import { TASKS_ID, chat, login, testConfig } from './helpers/server-harness.js';

describe('server + real NATS + real worker + fake OpenAI', () => {
  let nats: TestNats;
  let fake: FakeOpenAI;
  let worker: RunningWorker | undefined;
  let adapters: NatsAdapters;
  let app: FastifyInstance;
  let inspector: NatsConnection;
  let dataDir: string;

  const startTestWorker = () =>
    startWorker({
      natsUrl: nats.url,
      openaiApiKey: 'sk-test-dummy-key',
      openaiBaseURL: fake.baseURL,
      openaiTimeoutMs: 2000,
      model: 'test-model',
      maxOutputTokens: 512,
      logger: pino({ level: 'silent' }),
    });

  beforeAll(async () => {
    nats = await startNatsServer();
    fake = await startFakeOpenAI();
    worker = await startTestWorker();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safi-int-'));
    adapters = await connectNatsAdapters({ url: nats.url });
    app = await buildApp({
      config: testConfig({ natsTimeoutMs: 3000 }),
      registry: loadRegistry(),
      natsRequester: adapters.requester,
      auditPublisher: adapters.audit,
      clock: systemClock,
      usage: new FileUsageStore(dataDir),
      logger: false,
      natsStatus: adapters.status,
    });
    inspector = await connect({ servers: nats.url });
  });

  afterAll(async () => {
    await app?.close();
    await adapters?.close();
    await inspector?.drain();
    await worker?.stop();
    await fake?.close();
    await nats?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function receipts(): Promise<AuditReceipt[]> {
    const jsm = await jetstreamManager(inspector);
    const info = await jsm.streams.info(AUDIT_STREAM);
    const out: AuditReceipt[] = [];
    for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq++) {
      const m = await jsm.streams.getMessage(AUDIT_STREAM, { seq });
      out.push(m.json<AuditReceipt>());
    }
    return out;
  }

  it('creates the audit stream with the CONTRACTS config', async () => {
    const jsm = await jetstreamManager(inspector);
    const { config } = await jsm.streams.info(AUDIT_STREAM);
    expect(config.subjects).toEqual(['safi.chat.audit.v1']);
    expect(config.max_age).toBe(7 * 24 * 60 * 60 * 1_000_000_000);
    expect(config.max_bytes).toBe(64 * 1024 * 1024);
    expect(config.storage).toBe('file');
  });

  it('updates an existing stream to the CONTRACTS config instead of failing', async () => {
    const jsm = await jetstreamManager(inspector);
    await jsm.streams.update(AUDIT_STREAM, { max_age: 3_600_000_000_000 });
    const again = await connectNatsAdapters({ url: nats.url });
    await again.close();
    expect((await jsm.streams.info(AUDIT_STREAM)).config.max_age).toBe(7 * 24 * 60 * 60 * 1_000_000_000);
  });

  it('login -> summary -> tasks, with receipts in JetStream; worker down gives 504; restart recovers', async () => {
    const l = await login(app);

    fake.script({ kind: 'json', body: { reply: 'Hi there', tone: 'friendly', followup_needed: false } });
    const first = await chat(app, l, { text: 'say hi' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ outcome: 'ok', audit: 'persisted', validation: { body: 'pass' } });
    expect(first.json().envelope.body.reply).toBe('Hi there');

    fake.script({ kind: 'json', body: { reply: 'Tasks', tasks: [{ task: 'write tests', priority: 'high' }], followup_needed: true } });
    const second = await chat(app, l, { schema_id: TASKS_ID, text: 'plan my day' });
    expect(second.statusCode).toBe(200);
    expect(second.json().envelope.body.tasks).toEqual([{ task: 'write tests', priority: 'high' }]);
    // the follow-up carried history to the model
    expect(JSON.stringify(fake.requests[1])).toContain('Hi there');

    const got = await receipts();
    expect(got).toHaveLength(2);
    expect(got.map((r) => r.outcome)).toEqual(['ok', 'ok']);
    expect(got[1]!.schema_ref.id).toBe(TASKS_ID);
    expect(JSON.stringify(got)).not.toContain('say hi');
    expect(JSON.stringify(got)).not.toContain('Hi there');

    await worker!.stop();
    worker = undefined;
    const down = await chat(app, l, { text: 'anyone there?' });
    expect(down.statusCode).toBe(504);
    expect(down.json().error.code).toBe('worker_unavailable');

    worker = await startTestWorker();
    fake.script({ kind: 'json', body: { reply: 'Back', tone: 'neutral', followup_needed: false } });
    const back = await chat(app, l, { text: 'again' });
    expect(back.statusCode).toBe(200);
    expect(back.json().envelope.body.reply).toBe('Back');

    expect((await receipts()).map((r) => r.error_code)).toEqual([null, null, 'worker_unavailable', null]);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'usage.json'), 'utf8'))).toEqual({ api_calls_used: 4 });
  });
});
