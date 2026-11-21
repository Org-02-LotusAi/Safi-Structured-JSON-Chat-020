import { jetstream, jetstreamManager, RetentionPolicy, StorageType } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_STREAM,
  AUDIT_STREAM_MAX_AGE_NS,
  AUDIT_STREAM_MAX_BYTES,
  AUDIT_SUBJECT,
  CHAT_REQUEST_SUBJECT,
  WORKER_QUEUE_GROUP,
} from '../shared/src/index.js';
import { startNatsServer, type TestNats } from './helpers/nats-server.js';

describe('nats tooling smoke test', () => {
  let server: TestNats;
  let nc: NatsConnection;

  beforeAll(async () => {
    server = await startNatsServer();
    nc = await connect({ servers: server.url });
  });

  afterAll(async () => {
    await nc?.drain();
    await server?.stop();
  });

  it('does a queue-group request/reply', async () => {
    const sub = nc.subscribe(CHAT_REQUEST_SUBJECT, { queue: WORKER_QUEUE_GROUP });
    (async () => {
      for await (const m of sub) m.respond(new TextEncoder().encode(`echo:${m.string()}`));
    })();
    const reply = await nc.request(CHAT_REQUEST_SUBJECT, new TextEncoder().encode('ping'), { timeout: 2000 });
    expect(reply.string()).toBe('echo:ping');
  });

  it('creates the audit stream and publishes one acked message', async () => {
    const jsm = await jetstreamManager(nc);
    const info = await jsm.streams.add({
      name: AUDIT_STREAM,
      subjects: [AUDIT_SUBJECT],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: AUDIT_STREAM_MAX_AGE_NS,
      max_bytes: AUDIT_STREAM_MAX_BYTES,
    });
    expect(info.config.name).toBe(AUDIT_STREAM);

    const ack = await jetstream(nc).publish(AUDIT_SUBJECT, new TextEncoder().encode('{"receipt_version":"1"}'));
    expect(ack.stream).toBe(AUDIT_STREAM);
    expect(ack.seq).toBe(1);
  });
});
