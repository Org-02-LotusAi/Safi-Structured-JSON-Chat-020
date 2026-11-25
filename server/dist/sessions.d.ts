import type { BrowserChatResponse, HistoryMessage } from '@safi/shared';
import type { Clock } from './deps.js';
export declare const SESSION_COOKIE = "safi_session";
export declare const CSRF_HEADER = "x-safi-csrf";
export interface Turn {
    user: string;
    assistant: string;
}
export type RequestState = {
    state: 'inflight';
} | {
    state: 'ambiguous';
} | {
    state: 'done';
    status: number;
    body: BrowserChatResponse;
};
export interface Session {
    id: string;
    username: string;
    /** Role is held server-side only and never sent to the browser. */
    role: 'pilot_user';
    csrf: string;
    expiresAt: number;
    currentConversation: string;
    conversations: Map<string, Turn[]>;
    requests: Map<string, RequestState>;
}
/** Constant-time string compare over SHA-256 digests (equal length, no length leak). */
export declare function safeEqual(a: string, b: string): boolean;
export declare class SessionStore {
    private readonly clock;
    private readonly ttlMs;
    private sessions;
    constructor(clock: Clock, ttlMs: number);
    /** Creates a session and revokes every prior one (one pilot user at a time). */
    create(username: string): Session;
    get(id: string | undefined): Session | undefined;
    revoke(id: string): void;
    /** New server-generated conversation id with empty history; the oldest is evicted past the cap. */
    newConversation(session: Session): string;
}
/** History as envelope messages (user/assistant alternating), bounded to maxTurns turns. */
export declare function historyMessages(turns: Turn[], maxTurns: number): HistoryMessage[];
export declare function appendTurn(turns: Turn[], turn: Turn, maxTurns: number): void;
/** Records the request state, dropping the oldest finished entries when the cache is full. */
export declare function setRequestState(session: Session, requestId: string, state: RequestState): void;
