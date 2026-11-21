export interface SessionInfo {
  authenticated: boolean;
  username?: string;
  conversation_id?: string;
  expires_at?: string;
  csrf_token?: string;
}

export interface SchemaChoice {
  id: string;
  version: string;
  sha256: string;
  label: string;
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface TaskItem {
  task: string;
  priority: 'high' | 'normal' | 'low';
}

export interface ReplyBody {
  reply: string;
  tone?: string;
  tasks?: TaskItem[];
  followup_needed?: boolean;
  [k: string]: unknown;
}

export interface ResultEnvelope {
  schema_ref: { id: string; version: string };
  schema_sha256: string;
  body: ReplyBody;
  model: string;
  openai_request_id: string | null;
  usage: { input_tokens: number; output_tokens: number };
  [k: string]: unknown;
}

export interface Validation {
  envelope: string;
  body: string;
  validator: string;
}

/** Audit status as shown to the user. "n/a" = failure happened before an audit receipt existed. */
export type AuditStatus = 'persisted' | 'failed' | 'n/a';

export interface SafiOk {
  kind: 'ok';
  request_id: string;
  schema_id: string;
  envelope: ResultEnvelope;
  validation: Validation;
  audit: AuditStatus;
}

export interface SafiError {
  kind: 'error';
  request_id: string | null;
  schema_id: string;
  http_status: number | null;
  error: ApiError;
  audit: AuditStatus;
  /** True when the failure was produced on the client (network down). */
  client_side: boolean;
}

export type SafiPayload = SafiOk | SafiError;
