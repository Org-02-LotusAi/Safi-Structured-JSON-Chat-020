import { type ErrorCode } from './constants.js';
import type { ErrorEnvelope, HistoryMessage, RequestEnvelope, ResultEnvelope, SchemaRef, Usage } from './types.js';
export declare function newMessageId(): string;
/** Current UTC time as ISO-8601 with a trailing Z. */
export declare function utcNow(): string;
export interface BuildRequestParams {
    conversation_id: string;
    text: string;
    history?: HistoryMessage[];
    schema_ref: SchemaRef;
    schema_sha256: string;
    message_id?: string;
}
export declare function buildRequestEnvelope(p: BuildRequestParams): RequestEnvelope;
export interface ResultMeta {
    model: string;
    openai_request_id: string | null;
    usage: Usage;
}
export declare function buildResultEnvelope(req: RequestEnvelope, body: Record<string, unknown>, meta: ResultMeta): ResultEnvelope;
export declare function buildErrorEnvelope(req: RequestEnvelope, code: ErrorCode, message: string, retryable: boolean): ErrorEnvelope;
