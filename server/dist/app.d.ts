import { type FastifyInstance } from 'fastify';
import type { AppDeps } from './deps.js';
export declare const LOG_REDACT_PATHS: string[];
export declare function defaultLoggerOptions(): object;
export declare function buildApp(deps: AppDeps): Promise<FastifyInstance>;
