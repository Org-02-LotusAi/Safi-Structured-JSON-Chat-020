import { FailureThrottle, GlobalFailureCeiling } from './limits.js';
import { CSRF_HEADER, SESSION_COOKIE, safeEqual } from './sessions.js';
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_GLOBAL_MAX_FAILURES = 30;
const LOGIN_GLOBAL_SLOW_INTERVAL_MS = 10_000;
/** Sends the standard `{outcome:"error", error}` body used by every failing /api route. */
export function sendError(reply, status, code, message, retryable = false, extra = {}) {
    return reply.code(status).send({ outcome: 'error', error: { code, message, retryable }, ...extra });
}
function sessionView(session) {
    return {
        authenticated: true,
        username: session.username,
        conversation_id: session.currentConversation,
        expires_at: new Date(session.expiresAt).toISOString(),
        csrf_token: session.csrf,
    };
}
/** preHandler: requires a valid signed session cookie (401 `unauthenticated` otherwise). */
export function requireSession(ctx) {
    return async (req, reply) => {
        const raw = req.cookies[SESSION_COOKIE];
        const un = raw ? req.unsignCookie(raw) : undefined;
        const session = un?.valid ? ctx.sessions.get(un.value ?? undefined) : undefined;
        if (!session) {
            return sendError(reply, 401, 'unauthenticated', 'Authentication required.');
        }
        req.safiSession = session;
        return undefined;
    };
}
/** preHandler (after requireSession): requires x-safi-csrf to equal the session token. */
export async function requireCsrf(req, reply) {
    const header = req.headers[CSRF_HEADER];
    const token = typeof header === 'string' ? header : '';
    if (!req.safiSession || !token || !safeEqual(token, req.safiSession.csrf)) {
        return sendError(reply, 403, 'ingress_rejected', 'Missing or invalid CSRF token.');
    }
    return undefined;
}
export function registerAuthRoutes(app, ctx) {
    const throttle = new FailureThrottle(LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, ctx.clock);
    const globalCeiling = new GlobalFailureCeiling(LOGIN_GLOBAL_MAX_FAILURES, LOGIN_WINDOW_MS, LOGIN_GLOBAL_SLOW_INTERVAL_MS, ctx.clock);
    const auth = requireSession(ctx);
    app.post('/api/login', async (req, reply) => {
        const body = req.body;
        const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
        const b = body;
        if (keys.length !== 2 ||
            !keys.includes('username') ||
            !keys.includes('password') ||
            typeof b.username !== 'string' ||
            typeof b.password !== 'string' ||
            b.username.length > 256 ||
            b.password.length > 1024) {
            return sendError(reply, 400, 'ingress_rejected', 'Body must be exactly {username, password}.');
        }
        const ip = req.ip;
        if (throttle.isBlocked(ip)) {
            return sendError(reply, 429, 'user_rate_limited', 'Too many failed logins; try again later.', true);
        }
        if (!globalCeiling.admit()) {
            return sendError(reply, 429, 'user_rate_limited', 'Many failed logins across all clients; login is temporarily slowed. Try again in a few seconds.', true);
        }
        // Evaluate both comparisons so timing does not reveal which field was wrong.
        const userOk = safeEqual(b.username, ctx.config.pilotUsername);
        const passOk = safeEqual(b.password, ctx.config.pilotPassword);
        if (!(userOk && passOk)) {
            throttle.recordFailure(ip);
            globalCeiling.recordFailure();
            return sendError(reply, 401, 'unauthenticated', 'Invalid username or password.');
        }
        throttle.reset(ip);
        const session = ctx.sessions.create(ctx.config.pilotUsername);
        reply.setCookie(SESSION_COOKIE, session.id, {
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
            path: '/',
            maxAge: Math.floor(ctx.config.sessionTtlMs / 1000),
            signed: true,
        });
        return sessionView(session);
    });
    app.post('/api/logout', { preHandler: [auth, requireCsrf] }, async (req, reply) => {
        ctx.sessions.revoke(req.safiSession.id);
        reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
        return { authenticated: false };
    });
    app.get('/api/session', async (req) => {
        const raw = req.cookies[SESSION_COOKIE];
        const un = raw ? req.unsignCookie(raw) : undefined;
        const session = un?.valid ? ctx.sessions.get(un.value ?? undefined) : undefined;
        return session ? sessionView(session) : { authenticated: false };
    });
    app.post('/api/conversations', { preHandler: [auth, requireCsrf] }, async (req) => {
        const id = ctx.sessions.newConversation(req.safiSession);
        return { conversation_id: id };
    });
}
