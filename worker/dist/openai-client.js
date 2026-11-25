import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, RateLimitError } from 'openai';
import { fail } from './model-caller.js';
/** The single place the SDK is constructed: never auto-retry, hard per-call timeout. */
export function createOpenAIClient(opts) {
    return new OpenAI({
        apiKey: opts.apiKey,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        maxRetries: 0,
        timeout: opts.timeoutMs,
    });
}
function mapSdkError(e) {
    if (e instanceof RateLimitError)
        return fail('rate_limited', 'OpenAI rate limit (HTTP 429)', true);
    if (e instanceof APIConnectionTimeoutError)
        return fail('upstream_timeout', 'OpenAI request timed out', true);
    if (e instanceof APIConnectionError)
        return fail('upstream_network', 'OpenAI connection failed', true);
    if (e instanceof APIError) {
        const status = e.status ?? 0;
        return fail('upstream_error', `OpenAI error (HTTP ${status})`, status >= 500);
    }
    return fail('upstream_error', 'unexpected error calling OpenAI', false);
}
export function createOpenAICaller(openai, model) {
    return {
        provider: 'openai',
        async call(input) {
            const messages = [
                { role: 'system', content: input.system },
                ...input.history.map((h) => ({ role: h.role, content: h.text })),
                { role: 'user', content: input.text },
            ];
            let response;
            try {
                response = await openai.responses.create({
                    model,
                    input: messages,
                    text: { format: { type: 'json_schema', name: input.schemaId.replace(/\./g, '_'), schema: input.schema, strict: true } },
                    store: false,
                    max_output_tokens: input.maxOutputTokens,
                });
            }
            catch (e) {
                return mapSdkError(e);
            }
            if (response.status === 'incomplete') {
                return fail('incomplete', `model output incomplete (${response.incomplete_details?.reason ?? 'unknown'})`, false);
            }
            if (response.status !== 'completed') {
                return fail('upstream_error', `OpenAI response status ${String(response.status)}`, false);
            }
            const refused = response.output.some((item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal'));
            if (refused)
                return fail('refusal', 'model refused to answer', false);
            return {
                ok: true,
                text: response.output_text,
                model: response.model,
                requestId: response._request_id ?? null,
                usage: response.usage ? { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens } : null,
            };
        },
    };
}
