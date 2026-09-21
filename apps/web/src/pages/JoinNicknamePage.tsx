import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { EV, type PlayerJoinResult } from '@ictquiz/shared';
import { api, ApiError } from '../lib/api';
import { connectLive, emitAck, storePlayer } from '../live/socket';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';

type JoinInfo = { sessionId: string; title: string; locked: boolean; state: string };

const JOIN_ERRORS: Record<string, string> = {
  NOT_FOUND: 'This game is no longer live.',
  LOCKED: 'This game is locked by the host.',
  FULL: 'This game is full.',
  NICKNAME_TAKEN: 'That nickname is taken — try another one.',
  NICKNAME_INVALID: 'That nickname is not allowed.',
  ENDED: 'This game has already ended.',
  RATE_LIMITED: 'Too many attempts — wait a moment and try again.',
};

export function JoinNicknamePage() {
  const { pin = '' } = useParams();
  const navigate = useNavigate();
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const info = useQuery({
    queryKey: ['join', pin],
    queryFn: () => api<JoinInfo>(`/join/${pin}`),
    retry: false,
  });

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim() || busy) return;
    setBusy(true);
    setJoinError(null);
    try {
      connectLive({ role: 'player' });
      const res = await emitAck<PlayerJoinResult>(EV.PlayerJoin, { pin, nickname });
      if (res.ok) {
        storePlayer({
          sessionId: res.sessionId,
          participantId: res.participantId,
          resumeToken: res.resumeToken,
        });
        navigate('/play');
        return;
      }
      setJoinError(JOIN_ERRORS[res.code] ?? 'Could not join this game.');
    } catch {
      setJoinError('Could not reach the game server.');
    } finally {
      setBusy(false);
    }
  };

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
        <form onSubmit={join} className="flex flex-col gap-4">
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={20}
            autoComplete="off"
            placeholder="Nickname"
            className="rounded-xl border border-white/15 bg-navy/70 px-4 py-4 text-center text-2xl font-bold outline-none placeholder:text-white/25 focus:border-cyan"
          />
          {joinError && <p className="text-danger">{joinError}</p>}
          <Button type="submit" disabled={!nickname.trim() || busy}>
            {busy ? 'Joining…' : 'Enter lobby'}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
