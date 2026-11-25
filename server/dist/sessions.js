import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
export const SESSION_COOKIE = 'safi_session';
export const CSRF_HEADER = 'x-safi-csrf';
const MAX_CONVERSATIONS = 50;
const MAX_CACHED_REQUESTS = 200;
/** Constant-time string compare over SHA-256 digests (equal length, no length leak). */
export function safeEqual(a, b) {
    const da = createHash('sha256').update(a, 'utf8').digest();
    const db = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(da, db);
}
export class SessionStore {
    clock;
    ttlMs;
    sessions = new Map();
    constructor(clock, ttlMs) {
        this.clock = clock;
        this.ttlMs = ttlMs;
    }
    /** Creates a session and revokes every prior one (one pilot user at a time). */
    create(username) {
        this.sessions.clear();
        const conversation = randomUUID();
        const session = {
            id: randomBytes(32).toString('hex'),
            username,
            role: 'pilot_user',
            csrf: randomBytes(24).toString('hex'),
            expiresAt: this.clock.now() + this.ttlMs,
            currentConversation: conversation,
            conversations: new Map([[conversation, []]]),
            requests: new Map(),
        };
        this.sessions.set(session.id, session);
        return session;
    }
    get(id) {
        if (!id)
            return undefined;
        const s = this.sessions.get(id);
        if (!s)
            return undefined;
        if (s.expiresAt <= this.clock.now()) {
            this.sessions.delete(id);
            return undefined;
        }
        return s;
    }
    revoke(id) {
        this.sessions.delete(id);
    }
    /** New server-generated conversation id with empty history; the oldest is evicted past the cap. */
    newConversation(session) {
        const id = randomUUID();
        session.conversations.set(id, []);
        session.currentConversation = id;
        while (session.conversations.size > MAX_CONVERSATIONS) {
            const oldest = session.conversations.keys().next().value;
            session.conversations.delete(oldest);
        }
        return id;
    }
}
/** History as envelope messages (user/assistant alternating), bounded to maxTurns turns. */
export function historyMessages(turns, maxTurns) {
    const out = [];
    for (const t of turns.slice(-maxTurns)) {
        out.push({ role: 'user', text: t.user });
        out.push({ role: 'assistant', text: t.assistant });
    }
    return out;
}
export function appendTurn(turns, turn, maxTurns) {
    turns.push(turn);
    if (turns.length > maxTurns)
        turns.splice(0, turns.length - maxTurns);
}
/** Records the request state, dropping the oldest finished entries when the cache is full. */
export function setRequestState(session, requestId, state) {
    session.requests.set(requestId, state);
    if (session.requests.size <= MAX_CACHED_REQUESTS)
        return;
    for (const [k, v] of session.requests) {
        if (session.requests.size <= MAX_CACHED_REQUESTS)
            break;
        if (v.state !== 'inflight')
            session.requests.delete(k);
    }
}
