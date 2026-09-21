import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type {
  AnswersProgressPayload,
  GameSnapshot,
  LobbyParticipantsPayload,
} from '@ictquiz/shared';

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

type LiveState = {
  status: LiveStatus;
  snapshot: GameSnapshot | null;
  /** serverTime − client clock, recomputed on every `state` push. */
  serverOffsetMs: number;
  /** Latest coalesced lobby roster (host/display rooms). */
  lobby: LobbyParticipantsPayload | null;
  /** Latest coalesced answer progress (host/display rooms). */
  progress: AnswersProgressPayload | null;
  removed: boolean;
  error: string | null;
  set: (partial: Partial<Omit<LiveState, 'set' | 'reset'>>) => void;
  reset: () => void;
};

const initial = {
  status: 'connecting' as LiveStatus,
  snapshot: null,
  serverOffsetMs: 0,
  lobby: null,
  progress: null,
  removed: false,
  error: null,
};

export const useLive = create<LiveState>((set) => ({
  ...initial,
  set: (partial) => set(partial),
  reset: () => set({ ...initial }),
}));

/** Current server-clock time; re-renders on `intervalMs` ticks. */
export function useServerNow(intervalMs = 200): number {
  const offset = useLive((s) => s.serverOffsetMs);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    setNow(Date.now() + offset);
    const t = setInterval(() => setNow(Date.now() + offset), intervalMs);
    return () => clearInterval(t);
  }, [offset, intervalMs]);
  return now;
}
