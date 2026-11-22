import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { LoginScreen } from './components/LoginScreen';
import { getSession } from './lib/api';
import type { SessionInfo } from './lib/types';

// The chat screen pulls in assistant-ui; load it only after login so the login page stays small.
const ChatScreen = lazy(() => import('./components/ChatScreen').then((m) => ({ default: m.ChatScreen })));

type State = { phase: 'loading' } | { phase: 'login'; notice?: string } | { phase: 'chat'; session: SessionInfo };

export function App() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    getSession().then(
      (s) => setState(s.authenticated ? { phase: 'chat', session: s } : { phase: 'login' }),
      () => setState({ phase: 'login', notice: 'Could not reach the server.' }),
    );
  }, []);

  const signedOut = useCallback((notice?: string) => setState({ phase: 'login', ...(notice ? { notice } : {}) }), []);

  if (state.phase === 'loading') {
    return (
      <p role="status" className="p-6 text-sm text-muted">
        Loading…
      </p>
    );
  }
  if (state.phase === 'login') {
    return <LoginScreen notice={state.notice} onLoggedIn={(session) => setState({ phase: 'chat', session })} />;
  }
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-sm text-muted">
          Loading chat…
        </p>
      }
    >
      <ChatScreen session={state.session} onSignedOut={signedOut} />
    </Suspense>
  );
}
