import type { FastifyInstance } from 'fastify';
import { type AuthContext } from './auth.js';
import { type AppDeps } from './deps.js';
export interface WorkerState {
    state: 'unknown' | 'responding' | 'unavailable';
    last_seen_at: string | null;
}
export interface ChatContext extends AuthContext {
    deps: AppDeps;
    worker: WorkerState;
}
export declare function registerChatRoute(app: FastifyInstance, ctx: ChatContext): void;
