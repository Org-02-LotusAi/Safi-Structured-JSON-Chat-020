import {
  AUDIT_STREAM,
  AUDIT_STREAM_MAX_AGE_NS,
  AUDIT_STREAM_MAX_BYTES,
  AUDIT_SUBJECT,
  type AuditReceipt,
} from '@safi/shared';
import { jetstream, jetstreamManager, StorageType, JetStreamApiCodes, JetStreamApiError, type JetStreamManager } from '@nats-io/jetstream';
import { NoRespondersError, RequestError, connect, type NatsConnection } from '@nats-io/transport-node';
import { NoRespondersFailure, type AuditPublisher, type NatsRequester } from './deps.js';

const AUDIT_ACK_TIMEOUT_MS = 5000;

export interface NatsConnectOptions {
  url: string;
  user?: string;
  pass?: string;
}

export interface NatsAdapters {
  requester: NatsRequester;
  audit: AuditPublisher;
  status(): 'connected' | 'disconnected';
  close(): Promise<void>;
}

const streamConfig = {
  name: AUDIT_STREAM,
  subjects: [AUDIT_SUBJECT],
  max_age: AUDIT_STREAM_MAX_AGE_NS,
  max_bytes: AUDIT_STREAM_MAX_BYTES,
  storage: StorageType.File,
};

/** Creates the audit stream if missing; otherwise updates it to the CONTRACTS config. */
export async function ensureAuditStream(jsm: JetStreamManager): Promise<void> {
  try {
    await jsm.streams.info(AUDIT_STREAM);
  } catch (e) {
    if (e instanceof JetStreamApiError && e.code === JetStreamApiCodes.StreamNotFound) {
      await jsm.streams.add(streamConfig);
      return;
    }
    throw e;
  }
  await jsm.streams.update(AUDIT_STREAM, {
    subjects: streamConfig.subjects,
    max_age: streamConfig.max_age,
    max_bytes: streamConfig.max_bytes,
  });
}

export async function connectNatsAdapters(opts: NatsConnectOptions): Promise<NatsAdapters> {
  const nc: NatsConnection = await connect({
    servers: opts.url,
    name: 'safi-chat-server',
    user: opts.user,
    pass: opts.pass,
    reconnect: true,
    maxReconnectAttempts: -1,
  });
  await ensureAuditStream(await jetstreamManager(nc));
  const js = jetstream(nc);
  const encoder = new TextEncoder();
  let connected = true;
  void (async () => {
    for await (const s of nc.status()) {
      if (s.type === 'disconnect') connected = false;
      else if (s.type === 'reconnect') connected = true;
    }
  })();

  return {
    requester: {
      async request(subject, data, timeoutMs) {
        try {
          const msg = await nc.request(subject, data, { timeout: timeoutMs });
          return msg.data;
        } catch (e) {
          if (e instanceof NoRespondersError || (e instanceof RequestError && e.isNoResponders())) {
            throw new NoRespondersFailure('no responders');
          }
          throw e;
        }
      },
    },
    audit: {
      async publish(receipt: AuditReceipt) {
        await js.publish(AUDIT_SUBJECT, encoder.encode(JSON.stringify(receipt)), { timeout: AUDIT_ACK_TIMEOUT_MS });
      },
    },
    status: () => (connected && !nc.isClosed() && !nc.isDraining() ? 'connected' : 'disconnected'),
    async close() {
      await nc.drain();
    },
  };
}
