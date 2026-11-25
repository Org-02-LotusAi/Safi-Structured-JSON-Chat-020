import { CHAT_REQUEST_SUBJECT, buildRequestEnvelope, formatAjvErrors, newMessageId, redactSecrets, validateBrowserChatRequest, validateRequestEnvelope, } from '@safi/shared';
import { requireCsrf, requireSession, sendError } from './auth.js';
import { NoRespondersFailure } from './deps.js';
import { SlidingWindowLimiter } from './limits.js';
import { verifyReply } from './reply-check.js';
import { appendTurn, historyMessages, setRequestState } from './sessions.js';
/** HTTP status for typed worker errors (anything unlisted is a bad-gateway). */
const HTTP_BY_CODE = {
    refusal: 422,
    incomplete: 422,
    rate_limited: 503,
    upstream_timeout: 504,
    upstream_network: 502,
    upstream_error: 502,
    invalid_model_output: 502,
    schema_rejected: 400,
    routing_rejected: 403,
};
const MAX_HISTORY_TEXT = 8000;
export function registerChatRoute(app, ctx) {
    const { deps, config, clock } = ctx;
    const userLimiter = new SlidingWindowLimiter(config.userRatePerMin, 60_000, clock);
    const auth = requireSession(ctx);
    const nowIso = () => new Date(clock.now()).toISOString();
    async function publishReceipt(receipt) {
        try {
            await deps.auditPublisher.publish(receipt);
            return 'persisted';
        }
        catch (e) {
            app.log.error({ code: 'audit_failed', err: redactSecrets(e instanceof Error ? e.message : 'unknown') }, 'audit receipt was not persisted');
            return 'failed';
        }
    }
    /** Refund a call that was provably never delivered. A failed persist is logged; over-counting is the safe direction. */
    async function refundUndelivered() {
        try {
            await deps.usage.release();
        }
        catch (e) {
            app.log.error({ err: redactSecrets(e instanceof Error ? e.message : 'unknown') }, 'usage refund could not be persisted');
        }
    }
    function failure(requestId, code, message, retryable, audit, envelope) {
        const error = { code, message, retryable };
        return {
            status: HTTP_BY_CODE[code] ?? 502,
            body: { outcome: 'error', request_id: requestId, error, ...(envelope ? { envelope } : {}), audit },
        };
    }
    /** Pre-NATS rejection: nothing reached the worker, so there is no receipt and no `audit` field. */
    function reject(reply, status, code, message, requestId, retryable = false) {
        return sendError(reply, status, code, message, retryable, requestId ? { request_id: requestId } : {});
    }
    app.post('/api/chat', { preHandler: [auth, requireCsrf] }, async (req, reply) => {
        const session = req.safiSession;
        const raw = req.body;
        const maybeId = raw?.request_id;
        const echoId = typeof maybeId === 'string' && maybeId.length <= 64 ? maybeId : null;
        // 1. strict browser body
        if (!validateBrowserChatRequest(raw)) {
            return reject(reply, 400, 'ingress_rejected', formatAjvErrors(validateBrowserChatRequest.errors), echoId);
        }
        const body = raw;
        if (body.text.length > config.maxInputChars) {
            return reject(reply, 400, 'ingress_rejected', `text exceeds ${config.maxInputChars} characters`, body.request_id);
        }
        // 2. conversation ownership
        const turns = session.conversations.get(body.conversation_id);
        if (!turns)
            return reject(reply, 403, 'routing_rejected', 'Unknown conversation.', body.request_id);
        // 3. schema must be a registered, UI-selectable entry; optional digest must match
        const entry = deps.registry.get(body.schema_id);
        if (!entry || !entry.ui_choice || (body.schema_sha256 !== undefined && body.schema_sha256 !== entry.sha256)) {
            return reject(reply, 400, 'schema_rejected', 'Unknown or mismatched schema.', body.request_id);
        }
        // 4. idempotency by (session, request_id)
        const prior = session.requests.get(body.request_id);
        if (prior?.state === 'done')
            return reply.code(prior.status).send(prior.body);
        if (prior?.state === 'inflight') {
            return reject(reply, 409, 'duplicate_in_flight', 'This request is already being processed.', body.request_id);
        }
        if (prior?.state === 'ambiguous') {
            return reject(reply, 409, 'upstream_ambiguous', 'Outcome unknown; send a new message.', body.request_id);
        }
        // 5. per-user rate, 6. global call cap (both before any NATS publish)
        if (!userLimiter.tryHit()) {
            return reject(reply, 429, 'user_rate_limited', 'Too many requests; slow down.', body.request_id, true);
        }
        if (deps.usage.used() >= config.apiCallCap) {
            return reject(reply, 429, 'cap_exceeded', 'The pilot API call cap has been reached.', body.request_id);
        }
        // 7. server-built envelope: identity, context, schema binding and message_id are never browser-supplied
        const envelope = buildRequestEnvelope({
            conversation_id: body.conversation_id,
            text: body.text,
            history: historyMessages(turns, config.maxTurns),
            schema_ref: { id: entry.id, version: entry.version },
            schema_sha256: entry.sha256,
            message_id: newMessageId(), // fresh per request_id: the worker caches replies by message_id
        });
        if (!validateRequestEnvelope(envelope)) {
            app.log.error({ detail: formatAjvErrors(validateRequestEnvelope.errors) }, 'server built an invalid request envelope');
            return reject(reply, 500, 'upstream_error', 'Internal error building the request.', body.request_id);
        }
        // Mark in-flight synchronously (no await since the idempotency check), then count the call.
        setRequestState(session, body.request_id, { state: 'inflight' });
        try {
            await deps.usage.increment();
        }
        catch (e) {
            session.requests.delete(body.request_id);
            app.log.error({ err: redactSecrets(e instanceof Error ? e.message : 'unknown') }, 'usage counter could not be persisted');
            return reject(reply, 500, 'upstream_error', 'Internal error recording usage; request not sent.', body.request_id);
        }
        const startedAt = clock.now();
        const receiptBase = {
            receipt_version: '1',
            conversation_id: envelope.conversation_id,
            message_id: envelope.message_id,
            request_id: body.request_id,
            schema_ref: envelope.schema_ref,
            schema_sha256: envelope.schema_sha256,
        };
        const finish = async (status, response, fields, cache) => {
            const audit = await publishReceipt({
                ...receiptBase,
                ...fields,
                at_utc: nowIso(),
                latency_ms: Math.max(0, clock.now() - startedAt),
            });
            const final = { ...response, audit };
            if (cache)
                setRequestState(session, body.request_id, { state: 'done', status, body: final });
            return reply.code(status).send(final);
        };
        // 8. NATS request. Everything from here on is guarded: an unexpected throw must never leave the
        // request_id stuck "inflight" (M1).
        let sent = false;
        try {
            let rawReply;
            try {
                sent = true;
                rawReply = await deps.natsRequester.request(CHAT_REQUEST_SUBJECT, new TextEncoder().encode(JSON.stringify(envelope)), config.natsTimeoutMs);
            }
            catch (e) {
                ctx.worker.state = 'unavailable';
                if (e instanceof NoRespondersFailure) {
                    // Nothing was delivered, so a same-id retry is safe: forget the request state.
                    session.requests.delete(body.request_id);
                    await refundUndelivered();
                    app.log.warn({ code: 'worker_unavailable', request_id: body.request_id }, 'no responders; request was not delivered');
                    const f = failure(body.request_id, 'worker_unavailable', 'The AI worker is not running (no responders). Nothing was sent; try again shortly.', true, 'failed');
                    return await finish(504, f.body, { outcome: 'error', error_code: 'worker_unavailable', model: null, openai_request_id: null, usage: null, in_reply_to: null }, false);
                }
                // Timeout or disconnect after delivery: the worker may have called OpenAI. Never re-sent.
                setRequestState(session, body.request_id, { state: 'ambiguous' });
                app.log.warn({ code: 'upstream_ambiguous', request_id: body.request_id, message_id: envelope.message_id, conversation_id: envelope.conversation_id, err: e instanceof Error ? e.name : 'unknown' }, 'ambiguous outcome; not retried');
                const f = failure(body.request_id, 'upstream_ambiguous', `Outcome unknown: the request reached the worker but no reply arrived within ${Math.round(config.natsTimeoutMs / 1000)} s. It was not retried; send a new message.`, false, 'failed');
                return await finish(504, f.body, { outcome: 'error', error_code: 'upstream_ambiguous', model: null, openai_request_id: null, usage: null, in_reply_to: null }, false);
            }
            ctx.worker.state = 'responding';
            ctx.worker.last_seen_at = nowIso();
            // 9. verify reply
            const verdict = verifyReply(rawReply, envelope, entry);
            if (verdict.kind === 'invalid') {
                app.log.warn({ reason: verdict.reason }, 'worker reply rejected');
                const f = failure(body.request_id, 'invalid_model_output', 'The worker reply failed validation and was discarded.', false, 'failed');
                return await finish(f.status, f.body, { outcome: 'error', error_code: 'invalid_model_output', model: null, openai_request_id: null, usage: null, in_reply_to: null }, true);
            }
            if (verdict.kind === 'error') {
                const e = verdict.envelope;
                // M6: the browser-facing message is redacted and capped; the schema-checked envelope is passed through with the same redaction.
                const safeMessage = redactSecrets(e.error.message).slice(0, 500);
                const safeEnvelope = { ...e, error: { ...e.error, message: safeMessage } };
                const f = failure(body.request_id, e.error.code, safeMessage, e.error.retryable, 'failed', safeEnvelope);
                return await finish(f.status, f.body, { outcome: 'error', error_code: e.error.code, model: null, openai_request_id: null, usage: null, in_reply_to: e.in_reply_to }, true);
            }
            const result = verdict.envelope;
            const reply_text = typeof result.body.reply === 'string' && result.body.reply.length > 0 ? result.body.reply : '(empty reply)';
            appendTurn(turns, { user: body.text, assistant: reply_text.slice(0, MAX_HISTORY_TEXT) }, config.maxTurns);
            const ok = {
                outcome: 'ok',
                request_id: body.request_id,
                envelope: result,
                validation: { envelope: 'pass', body: 'pass', validator: 'ajv-2020' },
                audit: 'failed',
                api_calls_used: deps.usage.used(),
                api_call_cap: config.apiCallCap,
            };
            return await finish(200, ok, { outcome: 'ok', error_code: null, model: result.model, openai_request_id: result.openai_request_id, usage: result.usage, in_reply_to: result.in_reply_to }, true);
        }
        catch (e) {
            app.log.error({ code: 'chat_route_unexpected', request_id: body.request_id, err: e instanceof Error ? e.name : 'unknown' }, 'unexpected error handling chat request');
            if (reply.sent)
                throw e;
            const current = session.requests.get(body.request_id);
            if (current?.state === 'inflight') {
                if (sent)
                    setRequestState(session, body.request_id, { state: 'ambiguous' });
                else
                    session.requests.delete(body.request_id);
            }
            if (!sent)
                await refundUndelivered();
            const f = failure(body.request_id, 'upstream_error', sent ? 'Internal error after the request was sent; outcome unknown. Send a new message.' : 'Internal error; request not sent.', false, 'failed');
            try {
                return await finish(502, f.body, { outcome: 'error', error_code: 'upstream_error', model: null, openai_request_id: null, usage: null, in_reply_to: null }, false);
            }
            catch {
                return reply.code(502).send(f.body);
            }
        }
    });
}
