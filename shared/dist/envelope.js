import { randomUUID } from 'node:crypto';
import { PROTOCOL, PROTOCOL_VERSION } from './constants.js';
import { OPENAI_SERVICE_GUID, PILOT_CONTEXT, PILOT_SENDER_GUID } from './guids.js';
import { redactSecrets } from './redact.js';
export function newMessageId() {
    return randomUUID();
}
/** Current UTC time as ISO-8601 with a trailing Z. */
export function utcNow() {
    return new Date().toISOString();
}
export function buildRequestEnvelope(p) {
    return {
        protocol: PROTOCOL,
        version: PROTOCOL_VERSION,
        kind: 'chat.request',
        message_id: p.message_id ?? newMessageId(),
        conversation_id: p.conversation_id,
        in_reply_to: null,
        from_guid: PILOT_SENDER_GUID,
        to_guid: OPENAI_SERVICE_GUID,
        context: { ...PILOT_CONTEXT, path: [...PILOT_CONTEXT.path] },
        schema_ref: { ...p.schema_ref },
        schema_sha256: p.schema_sha256,
        sent_at_utc: utcNow(),
        body: { text: p.text, history: p.history ?? [] },
    };
}
/** Fields shared by result/error replies: from/to reversed, in_reply_to = request message_id. */
function replyBase(req) {
    return {
        protocol: PROTOCOL,
        version: PROTOCOL_VERSION,
        message_id: newMessageId(),
        conversation_id: req.conversation_id,
        in_reply_to: req.message_id,
        from_guid: req.to_guid,
        to_guid: req.from_guid,
        context: { ...req.context, path: [...req.context.path] },
        schema_ref: { ...req.schema_ref },
        schema_sha256: req.schema_sha256,
        sent_at_utc: utcNow(),
    };
}
export function buildResultEnvelope(req, body, meta) {
    return {
        ...replyBase(req),
        kind: 'chat.result',
        status: 'ok',
        body,
        model: meta.model,
        openai_request_id: meta.openai_request_id,
        usage: { ...meta.usage },
    };
}
export function buildErrorEnvelope(req, code, message, retryable) {
    return {
        ...replyBase(req),
        kind: 'chat.error',
        status: 'error',
        error: { code, message: redactSecrets(message).slice(0, 500), retryable },
    };
}
