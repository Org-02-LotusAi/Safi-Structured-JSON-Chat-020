import Anthropic from '@anthropic-ai/sdk';
import { fail } from './model-caller.js';
/** The single place the SDK is constructed: never auto-retry, hard per-call timeout. */
export function createAnthropicClient(opts) {
    return new Anthropic({
        apiKey: opts.apiKey,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        maxRetries: 0,
        timeout: opts.timeoutMs,
    });
}
function mapSdkError(e) {
    if (e instanceof Anthropic.RateLimitError)
        return fail('rate_limited', 'Anthropic rate limit (HTTP 429)', true);
    if (e instanceof Anthropic.APIConnectionTimeoutError)
        return fail('upstream_timeout', 'Anthropic request timed out', true);
    if (e instanceof Anthropic.APIConnectionError)
        return fail('upstream_network', 'Anthropic connection failed', true);
    if (e instanceof Anthropic.APIError) {
        const status = e.status ?? 0;
        return fail('upstream_error', `Anthropic error (HTTP ${status})`, status >= 500);
    }
    return fail('upstream_error', 'unexpected error calling Anthropic', false);
}
export function createAnthropicCaller(client, model) {
    return {
        provider: 'anthropic',
        async call(input) {
            // Anthropic structured output rejects the top-level $schema/$id/title keywords.
            const { $schema: _s, $id: _i, title: _t, ...schema } = input.schema;
            let res;
            try {
                res = await client.messages.create({
                    model,
                    max_tokens: input.maxOutputTokens,
                    system: input.system,
                    messages: [
                        ...input.history.map((h) => ({ role: h.role, content: h.text })),
                        { role: 'user', content: input.text },
                    ],
                    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
                });
            }
            catch (e) {
                return mapSdkError(e);
            }
            if (res.stop_reason === 'refusal')
                return fail('refusal', 'model refused to answer', false);
            if (res.stop_reason === 'max_tokens')
                return fail('incomplete', 'model output incomplete (max_tokens)', false);
            if (res.stop_reason !== 'end_turn') {
                return fail('invalid_model_output', `unexpected stop reason ${String(res.stop_reason)}`, false);
            }
            const block = res.content.find((c) => c.type === 'text');
            if (!block || block.type !== 'text')
                return fail('invalid_model_output', 'model output has no text block', false);
            return {
                ok: true,
                text: block.text,
                model: res.model,
                requestId: res._request_id ?? null,
                usage: res.usage ? { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } : null,
            };
        },
    };
}
