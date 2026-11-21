import type { SchemaChoice, SessionInfo } from './types';

export const CSRF_HEADER = 'x-safi-csrf';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorMessage(body: any, fallback: string): string {
  return typeof body?.error?.message === 'string' ? body.error.message : fallback;
}

export async function getSession(): Promise<SessionInfo> {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  if (!res.ok) throw new HttpError(res.status, 'Could not check your session.');
  return (await res.json()) as SessionInfo;
}

export async function login(username: string, password: string): Promise<SessionInfo> {
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new HttpError(res.status, errorMessage(body, 'Sign-in failed.'));
  return body as SessionInfo;
}

export async function logout(csrf: string): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { [CSRF_HEADER]: csrf } });
}

export async function newConversation(csrf: string): Promise<string> {
  const res = await fetch('/api/conversations', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { [CSRF_HEADER]: csrf },
  });
  const body = await readJson(res);
  if (!res.ok) throw new HttpError(res.status, errorMessage(body, 'Could not start a new conversation.'));
  return body.conversation_id as string;
}

export async function getSchemas(): Promise<SchemaChoice[]> {
  const res = await fetch('/api/schemas', { credentials: 'same-origin' });
  const body = await readJson(res);
  if (!res.ok) throw new HttpError(res.status, 'Could not load reply formats.');
  return (body.schemas as SchemaChoice[]).map(({ id, version, sha256, label }) => ({ id, version, sha256, label }));
}

export interface Status {
  api_calls_used: number;
  api_call_cap: number;
}

export async function getStatus(): Promise<Status> {
  const res = await fetch('/api/status', { credentials: 'same-origin' });
  const body = await readJson(res);
  if (!res.ok) throw new HttpError(res.status, 'Could not load usage.');
  return { api_calls_used: body.api_calls_used, api_call_cap: body.api_call_cap };
}
