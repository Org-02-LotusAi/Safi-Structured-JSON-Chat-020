import type { ErrorCode } from '@safi/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import type { Clock } from './deps.js';
import { type Session, type SessionStore } from './sessions.js';
declare module 'fastify' {
    interface FastifyRequest {
        safiSession?: Session;
    }
}
/** Sends the standard `{outcome:"error", error}` body used by every failing /api route. */
export declare function sendError(reply: FastifyReply, status: number, code: ErrorCode, message: string, retryable?: boolean, extra?: Record<string, unknown>): FastifyReply;
export interface AuthContext {
    config: ServerConfig;
    clock: Clock;
    sessions: SessionStore;
}
/** preHandler: requires a valid signed session cookie (401 `unauthenticated` otherwise). */
export declare function requireSession(ctx: AuthContext): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;
/** preHandler (after requireSession): requires x-safi-csrf to equal the session token. */
export declare function requireCsrf(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined>;
export declare function registerAuthRoutes(app: FastifyInstance, ctx: AuthContext): void;
