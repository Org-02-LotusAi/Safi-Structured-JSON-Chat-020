/** Human-readable explanation per server error code. */
const EXPLANATIONS: Record<string, string> = {
  refusal: 'The model declined to answer this request.',
  incomplete: 'The model ran out of room before finishing its answer. Try a shorter or simpler request.',
  invalid_model_output: 'The model returned data that did not match the required format, so it was discarded.',
  worker_unavailable: 'The AI worker is offline. Try again shortly.',
  upstream_ambiguous: 'We could not confirm whether the last request completed. Please send a new message.',
  upstream_timeout: 'The AI provider took too long to respond. Try again.',
  upstream_network: 'The AI provider could not be reached. Try again shortly.',
  upstream_error: 'The AI provider reported an error. Try again shortly.',
  rate_limited: 'The AI provider is rate limiting requests. Wait a moment and try again.',
  user_rate_limited: 'You are sending messages too quickly. Wait a moment and try again.',
  cap_exceeded: 'The pilot usage limit has been reached. No more AI calls are available.',
  duplicate_in_flight: 'That message is already being processed.',
  ingress_rejected: 'The server rejected the request as malformed or unauthorised.',
  schema_rejected: 'The selected reply format is not available. Reload the page and pick another.',
  routing_rejected: 'This conversation does not belong to your session. Start a new conversation.',
  audit_failed: 'The reply could not be recorded in the audit log.',
  unauthenticated: 'Your session has ended. Please sign in again.',
  network: 'The server could not be reached. Check your connection and try again.',
};

export function explainError(code: string): string {
  return EXPLANATIONS[code] ?? 'Something went wrong. Please try again.';
}

export function errorTitle(code: string): string {
  return code === 'invalid_model_output' ? 'REJECTED — not schema-compliant' : 'Request failed';
}
