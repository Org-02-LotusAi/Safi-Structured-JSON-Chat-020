import { connect, type NatsConnection } from '@nats-io/transport-node';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHAT_REQUEST_SUBJECT,
  buildRequestEnvelope,
  loadRegistry,
  validateErrorEnvelope,
  validateResultEnvelope,
} from '../shared/src/index.js';
import { startWorker, type RunningWorker } from '../worker/src/service.js';
import { startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.js';
import { startNatsServer, type TestNats } from './helpers/nats-server.js';

const registry = loadRegistry();
const summary = registry.get('safi.reply.summary', '1.0.0')!;

describe('worker over real NATS', () => {
  let nats: TestNats;
  let fake: FakeOpenAI;
  let worker: RunningWorker;
  let nc: NatsConnection;

  beforeAll(async () => {
    nats = await startNatsServer();
    fake = await startFakeOpenAI();
    worker = await startWorker({
      natsUrl: nats.url,
      openaiApiKey: 'sk-test-dummy-key',
      openaiBaseURL: fake.baseURL,
      openaiTimeoutMs: 1000,
      model: 'test-model',
      maxOutputTokens: 512,
      logger: pino({ level: 'silent' }),
    });
    nc = await connect({ servers: nats.url });
  });

  afterAll(async () => {
    await nc?.drain();
    await worker?.stop();
    await fake?.close();
    await nats?.stop();
  });

  const ask = async (payload: Uint8Array) => {
    const m = await nc.request(CHAT_REQUEST_SUBJECT, payload, { timeout: 5000 });
    return JSON.parse(m.string());
  };
  const request = () =>
    buildRequestEnvelope({
      conversation_id: 'conv-nats',
      text: 'hi',
      schema_ref: { id: summary.id, version: summary.version },
      schema_sha256: summary.sha256,
    });

  it('answers a chat.request with a validated chat.result', async () => {
    fake.script({ kind: 'json', body: { reply: 'hi back', tone: 'neutral', followup_needed: false } });
    const rq = request();
    const out = await ask(new TextEncoder().encode(JSON.stringify(rq)));
    expect(validateResultEnvelope(out)).toBe(true);
    expect(out.in_reply_to).toBe(rq.message_id);
    expect(out.body.reply).toBe('hi back');
  });

  it('answers a typed chat.error for a failing upstream', async () => {
    fake.script({ kind: 'http', status: 429 });
    const out = await ask(new TextEncoder().encode(JSON.stringify(request())));
    expect(validateErrorEnvelope(out)).toBe(true);
    expect(out.error.code).toBe('rate_limited');
  });

  it('answers non-JSON payloads with ingress_rejected instead of staying silent', async () => {
    const before = fake.requests.length;
    const out = await ask(new TextEncoder().encode('this is not json'));
    expect(validateErrorEnvelope(out)).toBe(true);
    expect(out.error.code).toBe('ingress_rejected');
    expect(fake.requests.length).toBe(before);
  });
});
