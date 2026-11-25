import { OPENAI_SERVICE_GUID, PILOT_SENDER_GUID, formatAjvErrors, validateErrorEnvelope, validateResultEnvelope, } from '@safi/shared';
const decoder = new TextDecoder('utf-8', { fatal: false });
function sameStrings(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
/**
 * Independent double-check of a worker reply: JSON parse, envelope schema, correlation and identity
 * fields against the request we sent, and (for results) the body against the registry validator.
 */
export function verifyReply(raw, req, entry) {
    let parsed;
    try {
        parsed = JSON.parse(decoder.decode(raw));
    }
    catch {
        return { kind: 'invalid', reason: 'reply is not valid JSON' };
    }
    let envelope;
    let kind;
    if (validateResultEnvelope(parsed)) {
        envelope = parsed;
        kind = 'result';
    }
    else if (validateErrorEnvelope(parsed)) {
        envelope = parsed;
        kind = 'error';
    }
    else {
        return {
            kind: 'invalid',
            reason: `reply is neither a chat.result nor a chat.error envelope (${formatAjvErrors(validateResultEnvelope.errors)})`,
        };
    }
    const mismatches = [];
    if (envelope.in_reply_to !== req.message_id)
        mismatches.push('in_reply_to');
    if (envelope.conversation_id !== req.conversation_id)
        mismatches.push('conversation_id');
    if (envelope.from_guid !== OPENAI_SERVICE_GUID)
        mismatches.push('from_guid');
    if (envelope.to_guid !== PILOT_SENDER_GUID)
        mismatches.push('to_guid');
    if (envelope.context.thread_guid !== req.context.thread_guid ||
        envelope.context.subject_guid !== req.context.subject_guid ||
        !sameStrings(envelope.context.path, req.context.path)) {
        mismatches.push('context');
    }
    if (envelope.schema_ref.id !== req.schema_ref.id || envelope.schema_ref.version !== req.schema_ref.version) {
        mismatches.push('schema_ref');
    }
    if (envelope.schema_sha256 !== req.schema_sha256)
        mismatches.push('schema_sha256');
    if (mismatches.length > 0)
        return { kind: 'invalid', reason: `reply fields do not match the request: ${mismatches.join(', ')}` };
    if (kind === 'error')
        return { kind: 'error', envelope: envelope };
    const result = envelope;
    if (!entry.validate(result.body)) {
        return { kind: 'invalid', reason: `result body fails the registry validator (${formatAjvErrors(entry.validate.errors)})` };
    }
    return { kind: 'result', envelope: result };
}
