import { useAuiState } from '@assistant-ui/react';
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { errorTitle, explainError } from '../lib/errors';
import type { AuditStatus, SafiError, SafiOk, SafiPayload, TaskItem } from '../lib/types';
import { Badge } from './ui/badge';
import { Card } from './ui/card';

function ShortHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(hash).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };
  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-mono" title={hash}>
        {hash.slice(0, 12)}…
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'SHA-256 copied' : 'Copy full SHA-256'}
        title={hash}
        className="rounded p-0.5 text-muted hover:bg-bg hover:text-ink"
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </span>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-xs text-ink">{children}</dd>
    </div>
  );
}

function auditBadge(audit: AuditStatus) {
  if (audit === 'persisted') return <Badge tone="ok">persisted</Badge>;
  if (audit === 'failed') return <Badge tone="warn">audit failed</Badge>;
  return <Badge>n/a</Badge>;
}

const PRIORITY_TONE: Record<TaskItem['priority'], 'bad' | 'warn' | 'neutral'> = {
  high: 'bad',
  normal: 'warn',
  low: 'neutral',
};

function TaskList({ tasks }: { tasks: TaskItem[] }) {
  if (tasks.length === 0) return <p className="text-sm text-muted">No tasks identified.</p>;
  return (
    <ul className="mt-3 space-y-2" aria-label="Tasks">
      {tasks.map((t, i) => (
        <li key={i} className="flex items-start gap-2 rounded-md border border-line bg-bg px-3 py-2 text-sm">
          <Badge tone={PRIORITY_TONE[t.priority]} className="mt-0.5 shrink-0 uppercase">
            {t.priority}
          </Badge>
          <span className="min-w-0 break-words">{t.task}</span>
        </li>
      ))}
    </ul>
  );
}

function OkMessage({ p }: { p: SafiOk }) {
  const env = p.envelope;
  const body = env.body;
  const pass = p.validation?.envelope === 'pass' && p.validation?.body === 'pass';
  return (
    <Card className="w-full max-w-[46rem] p-4" data-testid="assistant-ok">
      <p className="whitespace-pre-wrap break-words text-base leading-relaxed">{body.reply}</p>
      {Array.isArray(body.tasks) && <TaskList tasks={body.tasks} />}
      {body.followup_needed === true && (
        <p className="mt-3">
          <Badge tone="warn">Follow-up needed</Badge>
        </p>
      )}

      <details className="mt-4 rounded-md border border-line">
        <summary className="flex cursor-pointer items-center gap-1 px-3 py-2 text-sm font-medium text-muted hover:text-ink">
          <ChevronDown size={16} aria-hidden /> Structured data
        </summary>
        <pre className="max-h-72 overflow-auto border-t border-line bg-bg p-3 font-mono text-xs" data-testid="structured-json">
          {JSON.stringify(body, null, 2)}
        </pre>
      </details>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {pass ? (
          <Badge tone="ok" className="gap-1" data-testid="validation-badge">
            <CheckCircle2 size={14} aria-hidden /> Ajv 2020: PASS
          </Badge>
        ) : (
          <Badge tone="bad" data-testid="validation-badge">
            Ajv 2020: NOT CONFIRMED
          </Badge>
        )}
        <span className="text-xs text-muted">envelope + body validated</span>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        <MetaRow label="Schema ID">{env.schema_ref.id}</MetaRow>
        <MetaRow label="Version">{env.schema_ref.version}</MetaRow>
        <MetaRow label="SHA-256">
          <ShortHash hash={env.schema_sha256} />
        </MetaRow>
        <MetaRow label="Model">{env.model}</MetaRow>
        <MetaRow label="OpenAI request ID">{env.openai_request_id ?? 'n/a'}</MetaRow>
        <MetaRow label="Audit">{auditBadge(p.audit)}</MetaRow>
      </dl>
    </Card>
  );
}

function ErrorMessage({ p }: { p: SafiError }) {
  const rejected = p.error.code === 'invalid_model_output';
  return (
    <div
      role="alert"
      data-testid="assistant-error"
      className="w-full max-w-[46rem] rounded-lg border border-bad bg-bad-bg p-4 text-bad"
    >
      <div className="flex items-center gap-2 font-semibold">
        <AlertTriangle size={18} aria-hidden />
        <span>{errorTitle(p.error.code)}</span>
        <Badge tone="bad" className="ml-auto bg-white font-mono">
          {p.error.code}
        </Badge>
      </div>
      <p className="mt-2 text-sm text-ink">{explainError(p.error.code)}</p>
      {!rejected && p.error.message && p.error.message !== explainError(p.error.code) && (
        <p className="mt-1 text-xs text-muted">Server said: {p.error.message}</p>
      )}
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
        <MetaRow label="HTTP status">{p.http_status ?? 'n/a'}</MetaRow>
        <MetaRow label="Audit">{auditBadge(p.audit)}</MetaRow>
        <MetaRow label="Can retry">{p.error.retryable ? 'Yes' : 'No'}</MetaRow>
      </dl>
    </div>
  );
}

export function AssistantMessage() {
  const message = useAuiState((s) => s.message);
  const payload = message.metadata?.custom?.safi as SafiPayload | undefined;
  const running = message.status?.type === 'running' || (message.status?.type === 'requires-action');

  let inner: React.ReactNode;
  if (payload?.kind === 'ok') inner = <OkMessage p={payload} />;
  else if (payload?.kind === 'error') inner = <ErrorMessage p={payload} />;
  else if (running || !payload) {
    inner = (
      <Card className="px-4 py-3 text-sm text-muted" role="status" data-testid="assistant-pending">
        Thinking…
      </Card>
    );
  }
  return <div className="flex justify-start px-1 py-2">{inner}</div>;
}
