import type { ChatModelAdapter } from '@assistant-ui/react';
import { CSRF_HEADER } from './lib/api';
import type { AuditStatus, SafiPayload } from './lib/types';

export interface ChatContext {
  schemaId: string;
  schemaSha256: string;
  conversationId: string;
  csrf: string;
}

export interface AdapterHooks {
  getContext(): ChatContext;
  onUnauthorized(): void;
  onUsage(used: number, cap: number): void;
  /** Called after every server response (ok or error) so the usage meter can refresh. */
  onSettled(): void;
}

function lastUserText(messages: Parameters<ChatModelAdapter['run']>[0]['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    return m.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
      .trim();
  }
  return '';
}

function auditOf(value: unknown): AuditStatus {
  return value === 'persisted' || value === 'failed' ? value : 'n/a';
}

function result(text: string, payload: SafiPayload) {
  // The assistant message text is the reply (or error message); everything else
  // travels in metadata.custom.safi and is read by the message component.
  return {
    content: [{ type: 'text' as const, text }],
    status: { type: 'complete' as const, reason: 'stop' as const },
    metadata: { custom: { safi: payload } },
  };
}

export function createAdapter(hooks: AdapterHooks): ChatModelAdapter {
  return {
    async run({ messages, abortSignal }) {
      const ctx = hooks.getContext();
      const text = lastUserText(messages);
      const requestId = crypto.randomUUID();
      let res: Response;
      try {
        res = await fetch('/api/chat', {
          method: 'POST',
          credentials: 'same-origin',
          signal: abortSignal,
          headers: { 'content-type': 'application/json', [CSRF_HEADER]: ctx.csrf },
          body: JSON.stringify({
            request_id: requestId,
            conversation_id: ctx.conversationId,
            schema_id: ctx.schemaId,
            schema_sha256: ctx.schemaSha256,
            text,
          }),
        });
      } catch (e) {
        if (abortSignal.aborted) throw e;
        const message = 'The server could not be reached.';
        return result(message, {
          kind: 'error',
          request_id: requestId,
          schema_id: ctx.schemaId,
          http_status: null,
          error: { code: 'network', message, retryable: true },
          audit: 'n/a',
          client_side: true,
        });
      }

      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (res.status === 401) hooks.onUnauthorized();
      else hooks.onSettled();
      if (typeof body?.api_calls_used === 'number' && typeof body?.api_call_cap === 'number') {
        hooks.onUsage(body.api_calls_used, body.api_call_cap);
      }

      if (res.ok && body?.outcome === 'ok' && body.envelope?.body) {
        const reply = String(body.envelope.body.reply ?? '');
        return result(reply, {
          kind: 'ok',
          request_id: String(body.request_id ?? requestId),
          schema_id: ctx.schemaId,
          envelope: body.envelope,
          validation: body.validation,
          audit: auditOf(body.audit),
        });
      }

      const err = body?.error;
      const code = typeof err?.code === 'string' ? err.code : 'upstream_error';
      const message = typeof err?.message === 'string' ? err.message : `Request failed (HTTP ${res.status}).`;
      return result(message, {
        kind: 'error',
        request_id: typeof body?.request_id === 'string' ? body.request_id : requestId,
        schema_id: ctx.schemaId,
        http_status: res.status,
        error: { code, message, retryable: Boolean(err?.retryable) },
        audit: auditOf(body?.audit), // missing on pre-envelope failures => "n/a", not "failed"
        client_side: false,
      });
    },
  };
}
