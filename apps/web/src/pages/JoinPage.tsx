import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';

export function JoinPage() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api(`/join/${pin}`);
      navigate(`/join/${pin}`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'Game not found — check the PIN'
          : 'Could not reach the game server',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell flex items-center justify-center p-4">
      <Panel className="w-full max-w-md text-center">
        <h1 className="mb-1 text-3xl font-black">ICTWEEK Live Quiz</h1>
        <p className="mb-6 text-white/60">Enter the game PIN to join</p>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Game PIN"
            className="rounded-xl border border-white/15 bg-navy/70 px-4 py-4 text-center text-3xl font-black tracking-[0.3em] outline-none placeholder:text-white/25 focus:border-cyan"
          />
          {error && <p className="text-danger">{error}</p>}
          <Button type="submit" disabled={pin.length !== 6 || busy}>
            {busy ? 'Checking…' : 'Join game'}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
