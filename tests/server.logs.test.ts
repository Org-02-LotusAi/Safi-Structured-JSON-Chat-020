import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildErrorEnvelope, buildResultEnvelope, loadRegistry } from '../shared/src/index.js';
import { LOG_REDACT_PATHS, buildApp } from '../server/src/app.js';
import { NoRespondersFailure, type AppDeps } from '../server/src/deps.js';
import { MemoryUsageStore } from '../server/src/limits.js';
import { FakeAudit, FakeClock, FakeNats, PILOT_PASS, SUMMARY_ID, chat, testConfig } from './helpers/server-harness.js';

// A13: nothing sensitive may reach the server's log output, on success or on any error path.
const PROMPT = 'PROMPT-SECRET-ABC please remember this';
const REPLY = 'REPLY-SECRET-XYZ here is the answer';
const KEY = 'sk-test-ABCDEFGHIJKLMNOP';
const WRONG_PASS = 'wrong-password-SECRET-123';

describe('server log output never contains secrets or content (A13)', () => {
  it('captures debug-level logs across login, chat, worker errors and NATS failures', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const nats = new FakeNats();
    const deps: AppDeps = {
      config: testConfig({ natsTimeoutMs: 200 }),
      registry: loadRegistry(),
      natsRequester: nats,
      auditPublisher: new FakeAudit(),
      clock: new FakeClock(),
      usage: new MemoryUsageStore(),
      logger: { level: 'debug', redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' }, stream },
    };
    const app = await buildApp(deps);

    // wrong login, then right login
    await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'pilot', password: WRONG_PASS } });
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'pilot', password: PILOT_PASS } });
    const c = res.cookies.find((x) => x.name === 'safi_session')!;
    const body = res.json();
    const l = { cookie: `safi_session=${c.value}`, csrf: body.csrf_token as string, conversation_id: body.conversation_id as string };

    // ok chat
    nats.reply = (req) => buildResultEnvelope(req, { reply: REPLY, tone: 'neutral', followup_needed: false }, { model: 'm', openai_request_id: 'req_fake', usage: { input_tokens: 1, output_tokens: 1 } });
    expect((await chat(app, l, { text: PROMPT })).statusCode).toBe(200);

    // worker error whose message carries a key
    nats.reply = (req) => {
      const e = buildErrorEnvelope(req, 'upstream_error', 'x', false);
      return { ...e, error: { ...e.error, message: `upstream said bad key ${KEY}` } };
    };
    const errRes = await chat(app, l, { text: PROMPT, schema_id: SUMMARY_ID });
    expect(errRes.statusCode).toBe(502);
    expect(errRes.body).not.toContain(KEY);

    // NATS failures: ambiguous and no-responders
    nats.failWith = new Error(`TIMEOUT ${KEY}`);
    await chat(app, l, { text: PROMPT });
    nats.failWith = new NoRespondersFailure();
    await chat(app, l, { text: PROMPT });
    nats.failWith = null;
    nats.reply = () => ({ not: 'an envelope', echo: PROMPT });
    await chat(app, l, { text: PROMPT });
    await chat(app, l, { text: PROMPT, request_id: 'not-a-uuid' }); // ingress rejection
    await app.close();

    const logs = lines.join('');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [PILOT_PASS, WRONG_PASS, c.value, l.csrf, 'PROMPT-SECRET', 'REPLY-SECRET', KEY, 'ABCDEFGHIJKLMNOP']) {
      expect(logs, `log leaked ${secret.slice(0, 8)}...`).not.toContain(secret);
    }
  });
});
