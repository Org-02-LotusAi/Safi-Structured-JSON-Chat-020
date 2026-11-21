import { useState, type FormEvent } from 'react';
import { HttpError, login } from '../lib/api';
import type { SessionInfo } from '../lib/types';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';

export function LoginScreen({ onLoggedIn, notice }: { onLoggedIn: (s: SessionInfo) => void; notice?: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await login(username, password));
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) setError('Incorrect username or password.');
      else if (err instanceof HttpError && err.status === 429) setError('Too many failed attempts. Wait a few minutes and try again.');
      else if (err instanceof HttpError) setError(err.message);
      else setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-2xl font-semibold text-brand">SAFI Chat</h1>
        <p className="mt-1 text-sm text-muted">Sign in to the pilot.</p>
        {notice && (
          <p role="status" className="mt-4 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn">
            {notice}
          </p>
        )}
        <form onSubmit={submit} className="mt-5 space-y-4">
          <div className="space-y-1">
            <label htmlFor="username" className="text-sm font-medium">
              Username
            </label>
            <Input id="username" name="username" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-bad-bg px-3 py-2 text-sm text-bad" data-testid="login-error">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
