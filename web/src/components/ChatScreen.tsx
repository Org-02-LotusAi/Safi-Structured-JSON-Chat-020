import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAdapter } from '../adapter';
import { getSchemas, getStatus, logout, newConversation } from '../lib/api';
import type { SchemaChoice, SessionInfo } from '../lib/types';
import { Thread } from './Thread';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Select } from './ui/select';

interface Props {
  session: SessionInfo;
  onSignedOut: (notice?: string) => void;
}

export function ChatScreen({ session, onSignedOut }: Props) {
  const csrf = session.csrf_token ?? '';
  const [conversationId, setConversationId] = useState(session.conversation_id ?? '');
  const [schemas, setSchemas] = useState<SchemaChoice[]>([]);
  const [schemaId, setSchemaId] = useState('');
  const [usage, setUsage] = useState<{ used: number; cap: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schemasLoading, setSchemasLoading] = useState(true);
  const [schemasError, setSchemasError] = useState<string | null>(null);

  // The adapter is created once and reads current values through this ref.
  const ctxRef = useRef({ schemas, schemaId, conversationId, csrf });
  ctxRef.current = { schemas, schemaId, conversationId, csrf };

  const adapter = useMemo(
    () =>
      createAdapter({
        getContext: () => {
          const c = ctxRef.current;
          const schema = c.schemas.find((s) => s.id === c.schemaId);
          return { schemaId: c.schemaId, schemaSha256: schema?.sha256 ?? '', conversationId: c.conversationId, csrf: c.csrf };
        },
        onUnauthorized: () => onSignedOut('Your session has ended. Please sign in again.'),
        onUsage: (used, cap) => setUsage({ used, cap }),
        // Typed failures carry no counter, but they may still have consumed a call: re-read it.
        onSettled: () => {
          getStatus().then(
            (s) => setUsage({ used: s.api_calls_used, cap: s.api_call_cap }),
            () => undefined,
          );
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const runtime = useLocalRuntime(adapter);

  useEffect(() => {
    getSchemas().then(
      (list) => {
        setSchemas(list);
        setSchemaId((cur) => cur || list[0]?.id || '');
        setSchemasLoading(false);
      },
      (e: unknown) => {
        setSchemasError(e instanceof Error ? e.message : 'Could not load reply formats.');
        setSchemasLoading(false);
      },
    );
    getStatus().then(
      (s) => setUsage({ used: s.api_calls_used, cap: s.api_call_cap }),
      () => undefined, // usage meter is informational; chat still works without it
    );
  }, []);

  const startNew = useCallback(async () => {
    try {
      setConversationId(await newConversation(csrf));
      runtime.thread.reset();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not start a new conversation.');
    }
  }, [csrf, runtime]);

  const signOut = useCallback(async () => {
    try {
      await logout(csrf);
    } finally {
      onSignedOut();
    }
  }, [csrf, onSignedOut]);

  const selected = schemas.find((s) => s.id === schemaId);
  const atCap = usage !== null && usage.used >= usage.cap;
  const schemaReady = schemaId !== '';
  const composerNotice = schemasLoading
    ? 'Loading reply formats…'
    : schemasError
      ? 'Reply formats could not be loaded, so sending is disabled. Reload the page to try again.'
      : schemaReady
        ? null
        : 'No reply formats are available, so sending is disabled.';

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3">
          <h1 className="text-lg font-semibold text-brand">SAFI Chat</h1>
          <div className="order-last flex w-full items-center gap-2 sm:order-none sm:w-auto sm:flex-1">
            <label htmlFor="schema" className="sr-only">
              Reply format
            </label>
            <Select id="schema" value={schemaId} onChange={(e) => setSchemaId(e.target.value)} disabled={schemas.length === 0} className="sm:max-w-xs">
              {schemas.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} ({s.id}@{s.version})
                </option>
              ))}
            </Select>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Badge tone={atCap ? 'bad' : 'neutral'} data-testid="usage-meter" title="AI calls used / pilot cap">
              {usage ? `${usage.used} / ${usage.cap} calls` : '— calls'}
            </Badge>
            <Button variant="outline" size="sm" onClick={startNew}>
              New conversation
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
        <p className="mx-auto max-w-3xl px-3 pb-2 text-xs text-muted">
          Context: last 8 turns kept on the server for this conversation.
          {selected && <span className="sr-only"> Reply format {selected.id} version {selected.version}.</span>}
        </p>
      </header>
      {loadError && (
        <p role="alert" className="mx-auto mt-2 w-full max-w-3xl rounded-md bg-bad-bg px-3 py-2 text-sm text-bad">
          {loadError}
        </p>
      )}
      {atCap && (
        <p role="status" className="mx-auto mt-2 w-full max-w-3xl rounded-md bg-warn-bg px-3 py-2 text-sm text-warn">
          The pilot usage limit has been reached; new messages will be refused.
        </p>
      )}
      <main className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread sendDisabled={!schemaReady} notice={composerNotice} />
        </AssistantRuntimeProvider>
      </main>
    </div>
  );
}
