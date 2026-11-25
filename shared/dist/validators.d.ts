import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { BrowserChatRequest, ErrorEnvelope, RequestEnvelope, ResultEnvelope } from './types.js';
/** Default schemas directory: <repo>/schemas, resolved from shared/src or shared/dist. */
export declare const DEFAULT_SCHEMAS_DIR: string;
/** The single Ajv factory: draft 2020-12, strict, all errors, standard formats. */
export declare function createAjv(): Ajv2020;
export declare const validateRequestEnvelope: ValidateFunction<RequestEnvelope>;
export declare const validateResultEnvelope: ValidateFunction<ResultEnvelope>;
export declare const validateErrorEnvelope: ValidateFunction<ErrorEnvelope>;
/** Strict body schema for POST /api/chat; unknown fields are rejected. */
export declare const BROWSER_CHAT_REQUEST_SCHEMA: {
    readonly $schema: "https://json-schema.org/draft/2020-12/schema";
    readonly $id: "https://safi.local/schemas/browser-chat-request";
    readonly type: "object";
    readonly properties: {
        readonly request_id: {
            readonly type: "string";
            readonly pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
        };
        readonly conversation_id: {
            readonly type: "string";
            readonly minLength: 1;
            readonly maxLength: 64;
            readonly pattern: "^[A-Za-z0-9_-]+$";
        };
        readonly schema_id: {
            readonly type: "string";
            readonly minLength: 1;
            readonly maxLength: 128;
        };
        readonly schema_sha256: {
            readonly type: "string";
            readonly pattern: "^[0-9a-f]{64}$";
        };
        readonly text: {
            readonly type: "string";
            readonly minLength: 1;
            readonly maxLength: 4000;
        };
    };
    readonly required: readonly ["request_id", "conversation_id", "schema_id", "text"];
    readonly additionalProperties: false;
};
export declare const validateBrowserChatRequest: ValidateFunction<BrowserChatRequest>;
/** Short, non-leaky summary of Ajv errors: paths and messages only, never instance data. */
export declare function formatAjvErrors(errors: ErrorObject[] | null | undefined, max?: number): string;
