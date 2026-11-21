import { ComposerPrimitive, ThreadPrimitive, useAuiState } from '@assistant-ui/react';
import { SendHorizontal, Square } from 'lucide-react';
import { AssistantMessage } from './AssistantMessage';
import { Button } from './ui/button';

function UserMessage() {
  const text = useAuiState((s) =>
    s.message.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
  );
  return (
    <div className="flex justify-end px-1 py-2">
      <div
        data-testid="user-message"
        className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-brand px-4 py-2 text-base text-brand-ink"
      >
        {text}
      </div>
    </div>
  );
}

function Composer({ maxChars, sendDisabled }: { maxChars: number; sendDisabled: boolean }) {
  return (
    <ComposerPrimitive.Root className="flex items-end gap-2 rounded-lg border border-line bg-surface p-2 shadow-sm focus-within:border-brand">
      <ComposerPrimitive.Input
        aria-label="Message"
        placeholder="Ask SAFI something…"
        rows={1}
        maxLength={maxChars}
        disabled={sendDisabled}
        className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60"
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send asChild disabled={sendDisabled}>
          <Button aria-label="Send message">
            <SendHorizontal size={16} aria-hidden /> <span className="hidden sm:inline">Send</span>
          </Button>
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel asChild>
          <Button variant="outline" aria-label="Stop waiting">
            <Square size={16} aria-hidden /> <span className="hidden sm:inline">Stop</span>
          </Button>
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  );
}

export function Thread({
  maxChars = 4000,
  sendDisabled = false,
  notice = null,
}: {
  maxChars?: number;
  sendDisabled?: boolean;
  notice?: string | null;
}) {
  return (
    <ThreadPrimitive.Root className="mx-auto flex h-full w-full max-w-3xl flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-2 py-4" aria-live="polite">
        <ThreadPrimitive.Empty>
          <div className="mx-auto mt-16 max-w-md text-center text-muted">
            <p className="text-lg font-semibold text-ink">How can SAFI help?</p>
            <p className="mt-2 text-sm">
              Pick a reply format above, then send a message. Every answer is checked against its JSON schema before
              you see it.
            </p>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>
          {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <div className="px-2 pb-4 pt-2">
        {notice && (
          <p role="status" className="px-2 pb-1 text-xs text-muted">
            {notice}
          </p>
        )}
        <Composer maxChars={maxChars} sendDisabled={sendDisabled} />
      </div>
    </ThreadPrimitive.Root>
  );
}
