import type { ErrorCode } from './constants.js';

export interface SchemaRef {
  id: string;
  version: string;
}

export interface EnvelopeContext {
  thread_guid: string;
  subject_guid: string;
  path: string[];
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

interface EnvelopeCommon {
  protocol: 'safi.chat';
  version: '0.1.0';
  message_id: string;
  conversation_id: string;
  from_guid: string;
  to_guid: string;
  context: EnvelopeContext;
  schema_ref: SchemaRef;
  schema_sha256: string;
  sent_at_utc: string;
}

export interface RequestEnvelope extends EnvelopeCommon {
  kind: 'chat.request';
  in_reply_to: null;
  body: { text: string; history: HistoryMessage[] };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface ResultEnvelope extends EnvelopeCommon {
  kind: 'chat.result';
  in_reply_to: string;
  status: 'ok';
  body: Record<string, unknown>;
  model: string;
  openai_request_id: string | null;
  usage: Usage;
}

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface ErrorEnvelope extends EnvelopeCommon {
  kind: 'chat.error';
  in_reply_to: string;
  status: 'error';
  error: ErrorInfo;
}

export interface AuditReceipt {
  receipt_version: '1';
  at_utc: string;
  conversation_id: string;
  message_id: string;
  in_reply_to: string | null;
  request_id: string;
  schema_ref: SchemaRef;
  schema_sha256: string;
  outcome: 'ok' | 'error';
  error_code: ErrorCode | null;
  model: string | null;
  openai_request_id: string | null;
  usage: Usage | null;
  latency_ms: number;
}

export interface BrowserChatRequest {
  request_id: string;
  conversation_id: string;
  schema_id: string;
  schema_sha256?: string;
  text: string;
}

export type AuditState = 'persisted' | 'failed';

export interface BrowserChatSuccess {
  outcome: 'ok';
  request_id: string;
  envelope: ResultEnvelope;
  validation: { envelope: 'pass'; body: 'pass'; validator: 'ajv-2020' };
  audit: AuditState;
  api_calls_used: number;
  api_call_cap: number;
}

export interface BrowserChatFailure {
  outcome: 'error';
  request_id: string;
  error: ErrorInfo;
  envelope?: ErrorEnvelope;
  audit: AuditState;
}

export type BrowserChatResponse = BrowserChatSuccess | BrowserChatFailure;
