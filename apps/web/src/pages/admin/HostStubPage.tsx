import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Panel } from '../../components/Panel';
import { PinDisplay } from '../../components/PinDisplay';

type SessionDetail = {
  session: {
    id: string;
    pin: string;
    state: string;
    locked: boolean;
    title: string;
    displayKey: string;
    participantCount: number;
  };
};

export function HostStubPage() {
  const { id = '' } = useParams();
  const session = useQuery({
    queryKey: ['session', id],
    queryFn: () => api<SessionDetail>(`/sessions/${id}`),
  });

  if (session.isLoading) return <p className="text-white/60">Loading…</p>;
  if (session.error || !session.data) return <p className="text-danger">Session not found.</p>;
  const s = session.data.session;
  const joinUrl = `${window.location.origin}/join/${s.pin}`;
  const displayUrl = `${window.location.origin}/display/${s.displayKey}`;

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div>
        <h1 className="text-3xl font-black">{s.title || 'Live session'}</h1>
        <p className="text-white/60">
          State: {s.state} · {s.participantCount} players · lobby {s.locked ? 'locked' : 'open'}
        </p>
      </div>
      <Panel className="w-full max-w-lg">
        <p className="mb-3 text-sm tracking-widest text-white/50 uppercase">Join with PIN</p>
        <PinDisplay pin={s.pin} />
        <p className="mt-4 break-all text-cyan">{joinUrl}</p>
        <p className="mt-2 break-all text-sm text-white/50">
          Projector: <span className="text-white/70">{displayUrl}</span>
        </p>
        <p className="mt-6 text-white/50">
          The live host console arrives in the next build phase — the lobby is already live.
        </p>
      </Panel>
    </div>
  );
}
