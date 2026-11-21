import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { BrowserChatRequest, ErrorEnvelope, RequestEnvelope, ResultEnvelope } from './types.js';

/** Default schemas directory: <repo>/schemas, resolved from shared/src or shared/dist. */
export const DEFAULT_SCHEMAS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');

/** The single Ajv factory: draft 2020-12, strict, all errors, standard formats. */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  (addFormats as unknown as (a: Ajv2020) => Ajv2020)(ajv);
  return ajv;
}

function readSchema(file: string): object {
  return JSON.parse(fs.readFileSync(path.join(DEFAULT_SCHEMAS_DIR, file), 'utf8')) as object;
}

const ajv = createAjv();

export const validateRequestEnvelope = ajv.compile<RequestEnvelope>(readSchema('chat-request.schema.json'));
export const validateResultEnvelope = ajv.compile<ResultEnvelope>(readSchema('chat-result.schema.json'));
export const validateErrorEnvelope = ajv.compile<ErrorEnvelope>(readSchema('chat-error.schema.json'));

/** Strict body schema for POST /api/chat; unknown fields are rejected. */
export const BROWSER_CHAT_REQUEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://safi.local/schemas/browser-chat-request',
  type: 'object',
  properties: {
    request_id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' },
    conversation_id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
    schema_id: { type: 'string', minLength: 1, maxLength: 128 },
    schema_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    text: { type: 'string', minLength: 1, maxLength: 4000 },
  },
  required: ['request_id', 'conversation_id', 'schema_id', 'text'],
  additionalProperties: false,
} as const;

export const validateBrowserChatRequest: ValidateFunction<BrowserChatRequest> = ajv.compile<BrowserChatRequest>(
  BROWSER_CHAT_REQUEST_SCHEMA,
);

/** Short, non-leaky summary of Ajv errors: paths and messages only, never instance data. */
export function formatAjvErrors(errors: ErrorObject[] | null | undefined, max = 5): string {
  if (!errors || errors.length === 0) return 'validation failed';
  const parts = errors.slice(0, max).map((e) => {
    const where = e.instancePath || '/';
    const extra =
      e.keyword === 'additionalProperties' && typeof e.params.additionalProperty === 'string'
        ? ` (${e.params.additionalProperty.slice(0, 40)})`
        : '';
    return `${where} ${e.message ?? 'invalid'}${extra}`;
  });
  const more = errors.length > max ? `; +${errors.length - max} more` : '';
  return parts.join('; ') + more;
}
