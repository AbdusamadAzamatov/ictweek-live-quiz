import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';

type JoinInfo = { sessionId: string; title: string; locked: boolean; state: string };

export function JoinNicknamePage() {
  const { pin = '' } = useParams();
  const [nickname, setNickname] = useState('');
  const info = useQuery({
    queryKey: ['join', pin],
    queryFn: () => api<JoinInfo>(`/join/${pin}`),
    retry: false,
  });

  if (info.isLoading) {
    return (
      <div className="app-shell flex items-center justify-center p-4">
        <Panel className="w-full max-w-md text-center text-white/70">Checking PIN…</Panel>
      </div>
    );
  }

  if (info.error || !info.data) {
    return (
      <div className="app-shell flex items-center justify-center p-4">
        <Panel className="w-full max-w-md text-center">
          <h1 className="mb-2 text-2xl font-black">Game not found</h1>
          <p className="mb-6 text-white/60">
            {info.error instanceof ApiError && info.error.status === 404
              ? 'No live game with that PIN.'
              : 'Could not reach the game server.'}
          </p>
          <Link to="/" className="text-cyan underline">
            Try another PIN
          </Link>
        </Panel>
      </div>
    );
  }

  return (
    <div className="app-shell flex items-center justify-center p-4">
      <Panel className="w-full max-w-md text-center">
        <p className="mb-1 text-sm tracking-widest text-white/50 uppercase">Joining</p>
        <h1 className="mb-6 text-3xl font-black">{info.data.title || 'Live quiz'}</h1>
        <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-4">
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={20}
            autoComplete="off"
            placeholder="Nickname"
            className="rounded-xl border border-white/15 bg-navy/70 px-4 py-4 text-center text-2xl font-bold outline-none placeholder:text-white/25 focus:border-cyan"
          />
          <Button type="submit" disabled>
            Enter lobby
          </Button>
          <p className="text-sm text-white/50">Connecting… live play unlocks shortly.</p>
        </form>
      </Panel>
    </div>
  );
}
