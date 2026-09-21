import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/Button';
import { Panel } from '../../components/Panel';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/admin');
    } catch (err) {
      setError(err instanceof ApiError ? 'Invalid email or password' : 'Server unreachable');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell flex items-center justify-center p-4">
      <Panel className="w-full max-w-md">
        <h1 className="mb-1 text-3xl font-black">Organizer sign in</h1>
        <p className="mb-6 text-white/60">ICTWEEK Live Quiz</p>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            className="rounded-xl border border-white/15 bg-navy/70 px-4 py-3 text-lg outline-none placeholder:text-white/25 focus:border-cyan"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            className="rounded-xl border border-white/15 bg-navy/70 px-4 py-3 text-lg outline-none placeholder:text-white/25 focus:border-cyan"
          />
          {error && <p className="text-danger">{error}</p>}
          <Button type="submit" disabled={!email || !password || busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
