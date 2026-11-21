import { describe, expect, it } from 'vitest';
import { FailureThrottle, GlobalFailureCeiling } from '../server/src/limits.js';
import { ConfigError, loadServerConfig } from '../server/src/config.js';
import { readTls } from '../server/src/tls.js';
import { FakeClock, PILOT_PASS, PILOT_USER, chat, login, makeHarness } from './helpers/server-harness.js';

describe('auth and sessions', () => {
  it('requires auth for protected routes', async () => {
    const h = await makeHarness();
    for (const [method, url] of [['POST', '/api/chat'], ['POST', '/api/conversations'], ['POST', '/api/logout'], ['GET', '/api/status']] as const) {
      const res = await h.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe('unauthenticated');
    }
    expect(h.nats.requests).toHaveLength(0);
  });

  it('rejects bad logins and extra/missing fields', async () => {
    const h = await makeHarness();
    const bad = await h.app.inject({ method: 'POST', url: '/api/login', payload: { username: PILOT_USER, password: 'wrong-password-123' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();
    const extra = await h.app.inject({ method: 'POST', url: '/api/login', payload: { username: PILOT_USER, password: PILOT_PASS, role: 'admin' } });
    expect(extra.statusCode).toBe(400);
    const none = await h.app.inject({ method: 'POST', url: '/api/login' });
    expect(none.statusCode).toBe(400);
  });

  it('issues an httpOnly secure strict signed cookie and a session view without the role', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({ method: 'POST', url: '/api/login', payload: { username: PILOT_USER, password: PILOT_PASS } });
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/safi_session=/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).toMatch(/Max-Age=7200/);
    const l = await login(h.app);
    const s = await h.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: l.cookie } });
    const body = s.json();
    expect(body).toMatchObject({ authenticated: true, username: PILOT_USER, conversation_id: l.conversation_id, csrf_token: l.csrf });
    expect(JSON.stringify(body)).not.toMatch(/pilot_user|role/);
    const anon = await h.app.inject({ method: 'GET', url: '/api/session' });
    expect(anon.json()).toEqual({ authenticated: false });
  });

  it('rejects a tampered session cookie', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    const res = await chat(h.app, { ...l, cookie: l.cookie.slice(0, -2) + 'xx' });
    expect(res.statusCode).toBe(401);
  });

  it('a second login revokes the first session', async () => {
    const h = await makeHarness();
    const first = await login(h.app);
    const second = await login(h.app);
    expect((await chat(h.app, first)).statusCode).toBe(401);
    expect((await chat(h.app, second)).statusCode).toBe(200);
  });

  it('logout revokes the session', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    const out = await h.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: l.cookie, 'x-safi-csrf': l.csrf } });
    expect(out.statusCode).toBe(200);
    expect((await chat(h.app, l)).statusCode).toBe(401);
  });

  it('sessions expire after the TTL', async () => {
    const h = await makeHarness({ config: { sessionTtlMs: 60_000 } });
    const l = await login(h.app);
    h.clock.advance(61_000);
    expect((await chat(h.app, l)).statusCode).toBe(401);
  });

  it('throttles after 5 failed logins per IP and recovers after the window', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 5; i++) {
      const r = await h.app.inject({ method: 'POST', url: '/api/login', payload: { username: PILOT_USER, password: 'wrong-password-123' } });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await h.app.inject({ method: 'POST', url: '/api/login', payload: { username: PILOT_USER, password: PILOT_PASS } });
    expect(blocked.statusCode).toBe(429);
    h.clock.advance(5 * 60_000 + 1);
    const ok = await h.app.inject({ method: 'POST', url: '/api/login', payload: { username: PILOT_USER, password: PILOT_PASS } });
    expect(ok.statusCode).toBe(200);
  });

  it('requires the CSRF header on state-changing routes', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    for (const url of ['/api/chat', '/api/conversations', '/api/logout']) {
      const missing = await h.app.inject({ method: 'POST', url, headers: { cookie: l.cookie }, payload: {} });
      expect(missing.statusCode, url).toBe(403);
      const wrong = await h.app.inject({ method: 'POST', url, headers: { cookie: l.cookie, 'x-safi-csrf': 'nope' }, payload: {} });
      expect(wrong.statusCode, url).toBe(403);
    }
    expect(h.nats.requests).toHaveLength(0);
  });

  it('creates new server-generated conversations and sets security headers', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    const res = await h.app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: l.cookie, 'x-safi-csrf': l.csrf }, payload: {} });
    expect(res.statusCode).toBe(200);
    const id = res.json().conversation_id as string;
    expect(id).not.toBe(l.conversation_id);
    expect((await chat(h.app, l, { conversation_id: id })).statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBeDefined();
  });

  it('serves public healthz, schemas and the fallback page', async () => {
    const h = await makeHarness({ webDistDir: '/definitely/not/here' });
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const schemas = (await h.app.inject({ method: 'GET', url: '/api/schemas' })).json().schemas as Array<Record<string, unknown>>;
    expect(schemas.map((s) => s.id).sort()).toEqual(['safi.reply.summary', 'safi.reply.tasks']);
    expect(schemas[0]).toHaveProperty('sha256');
    expect(schemas[0]).toHaveProperty('schema');
    const page = await h.app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('npm run build');
  });

  it('reports status to an authenticated user', async () => {
    const h = await makeHarness();
    const l = await login(h.app);
    const res = await h.app.inject({ method: 'GET', url: '/api/status', headers: { cookie: l.cookie } });
    expect(res.json()).toMatchObject({ api_calls_used: 0, api_call_cap: 40, user_rate_per_min: 10, model: 'test-model', nats: 'connected', worker: { state: 'unknown' } });
    expect(res.json()).toMatchObject({ upstream: 'openai', openai_base_url_host: 'api.openai.com' });
  });

  it('reports a custom upstream when OPENAI_BASE_URL points elsewhere', async () => {
    const h = await makeHarness({ config: { openaiBaseUrlHost: '127.0.0.1:9999' } });
    const l = await login(h.app);
    const res = await h.app.inject({ method: 'GET', url: '/api/status', headers: { cookie: l.cookie } });
    expect(res.json()).toMatchObject({ upstream: 'custom', openai_base_url_host: '127.0.0.1:9999' });
  });
});

const BAD = { username: PILOT_USER, password: 'wrong-password-123' };
const GOOD = { username: PILOT_USER, password: PILOT_PASS };
const loginFrom = (h: Awaited<ReturnType<typeof makeHarness>>, xff: string, payload = BAD) =>
  h.app.inject({ method: 'POST', url: '/api/login', headers: { 'x-forwarded-for': xff }, payload });

describe('login throttling, proxy trust and bounded state (I2)', () => {
  it('with trustProxy 1, failures from one forwarded client do not block another', async () => {
    const h = await makeHarness({ config: { trustProxy: 1 } });
    for (let i = 0; i < 5; i++) expect((await loginFrom(h, '1.1.1.1')).statusCode).toBe(401);
    expect((await loginFrom(h, '1.1.1.1', GOOD)).statusCode).toBe(429);
    expect((await loginFrom(h, '2.2.2.2', GOOD)).statusCode).toBe(200);
  });

  it('with trustProxy 0, X-Forwarded-For is ignored (one shared bucket, no spoofing)', async () => {
    const h = await makeHarness({ config: { trustProxy: 0 } });
    for (let i = 0; i < 5; i++) expect((await loginFrom(h, `9.9.9.${i}`)).statusCode).toBe(401);
    expect((await loginFrom(h, '2.2.2.2', GOOD)).statusCode).toBe(429);
  });

  it('FailureThrottle stays bounded and evicts the oldest key', () => {
    const t = new FailureThrottle(5, 60_000, new FakeClock(), 100);
    for (let i = 0; i < 1000; i++) t.recordFailure(`ip-${i}`);
    expect(t.size).toBeLessThanOrEqual(100);
    expect(t.isBlocked('ip-999')).toBe(false);
  });

  it('GlobalFailureCeiling slows (never permanently locks) after the ceiling', () => {
    const clock = new FakeClock();
    const g = new GlobalFailureCeiling(3, 60_000, 10_000, clock);
    for (let i = 0; i < 3; i++) {
      expect(g.admit()).toBe(true);
      g.recordFailure();
    }
    expect(g.admit()).toBe(true); // first attempt over the ceiling is admitted ...
    expect(g.admit()).toBe(false); // ... then the rest are slowed
    clock.advance(10_001);
    expect(g.admit()).toBe(true);
    clock.advance(60_001); // failures age out: fully open again
    expect(g.admit()).toBe(true);
    expect(g.admit()).toBe(true);
  });

  it('a distributed guessing run is slowed account-wide but the real user still gets in', async () => {
    const h = await makeHarness({ config: { trustProxy: 1 } });
    let slowed = 0;
    for (let i = 0; i < 40; i++) {
      const r = await loginFrom(h, `10.0.${i}.1`);
      if (r.statusCode === 429) slowed += 1;
    }
    expect(slowed).toBeGreaterThan(0);
    expect((await loginFrom(h, '77.7.7.7', GOOD)).statusCode).toBe(429); // slowed right now
    h.clock.advance(10_001);
    expect((await loginFrom(h, '77.7.7.7', GOOD)).statusCode).toBe(200); // not permanently locked
  });
});

describe('proxy and TLS configuration (I2)', () => {
  const base = { PILOT_USERNAME: 'pilot', PILOT_PASSWORD: 'pilot-password-123', SESSION_SECRET: 'x'.repeat(40) };

  it('parses TRUST_PROXY_HOPS (default 0) and rejects the legacy boolean', () => {
    expect(loadServerConfig({ ...base }).trustProxy).toBe(0);
    expect(loadServerConfig({ ...base, TRUST_PROXY_HOPS: '1' }).trustProxy).toBe(1);
    expect(loadServerConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(0);
    expect(() => loadServerConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(ConfigError);
    expect(() => loadServerConfig({ ...base, TRUST_PROXY_HOPS: 'yes' })).toThrow(ConfigError);
    expect(() => loadServerConfig({ ...base, TRUST_PROXY_HOPS: '-1' })).toThrow(ConfigError);
  });

  it('plain HTTP is only allowed with ALLOW_PLAIN_HTTP_BEHIND_PROXY=true, independent of proxy trust', () => {
    expect(loadServerConfig({ ...base }).allowPlainHttp).toBe(false);
    expect(loadServerConfig({ ...base, ALLOW_PLAIN_HTTP_BEHIND_PROXY: 'true' }).allowPlainHttp).toBe(true);
    // trusting a proxy hop does not by itself switch TLS off
    expect(() => readTls({}, loadServerConfig({ ...base, TRUST_PROXY_HOPS: '1' }).allowPlainHttp)).toThrow(/TLS_CERT_FILE/);
    expect(readTls({}, true)).toBeUndefined();
    expect(() => readTls({ TLS_CERT_FILE: '/nope.crt', TLS_KEY_FILE: '/nope.key' }, true)).toThrow(/cannot read TLS files/);
  });
});
