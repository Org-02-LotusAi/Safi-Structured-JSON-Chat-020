/** Masks OpenAI/Anthropic-style secret keys (sk-..., sk-ant-...) and Bearer tokens in a string. */
export function redactSecrets(input) {
    return input
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
}
