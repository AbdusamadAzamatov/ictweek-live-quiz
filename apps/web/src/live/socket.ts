import { io, type Socket } from 'socket.io-client';
import {
  EV,
  type AnswersProgressPayload,
  type GameSnapshot,
  type LobbyParticipantsPayload,
  type SocketAuth,
  type StateSyncResult,
} from '@ictquiz/shared';
import { useLive } from './store';

let socket: Socket | null = null;

const PLAYER_STORAGE_KEY = 'ictquiz.player';

export type StoredPlayer = {
  sessionId: string;
  participantId: string;
  resumeToken: string;
};

export function loadStoredPlayer(): StoredPlayer | null {
  try {
    const raw = localStorage.getItem(PLAYER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPlayer>;
    if (!parsed.sessionId || !parsed.participantId || !parsed.resumeToken) return null;
    return parsed as StoredPlayer;
  } catch {
    return null;
  }
}

export function storePlayer(p: StoredPlayer): void {
  localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(p));
}

export function clearStoredPlayer(): void {
  localStorage.removeItem(PLAYER_STORAGE_KEY);
}

function applySnapshot(snapshot: GameSnapshot): void {
  useLive.setState({
    snapshot,
    serverOffsetMs: snapshot.serverTime - Date.now(),
  });
}

function resync(s: Socket): void {
  s.emit(EV.StateSync, {}, (res: StateSyncResult) => {
    if (res.ok) applySnapshot(res.snapshot);
  });
}

/** Single app-wide live socket; one role at a time per page. */
export function connectLive(auth: SocketAuth): Socket {
  socket?.removeAllListeners();
  socket?.disconnect();
  useLive.getState().reset();

  const s = io('/', { auth, autoConnect: false });

  s.on('connect', () => {
    useLive.setState({ status: 'connected', error: null });
    resync(s);
  });
  s.on('disconnect', () => {
    if (!useLive.getState().removed) useLive.setState({ status: 'reconnecting' });
  });
  s.on('connect_error', (err) => {
    if (err.message === 'UNAUTHORIZED') {
      s.disconnect();
      useLive.setState({ status: 'disconnected', error: 'UNAUTHORIZED' });
    } else {
      useLive.setState({ status: 'reconnecting', error: err.message });
    }
  });
  s.io.on('reconnect_attempt', () => {
    if (!useLive.getState().removed) useLive.setState({ status: 'reconnecting' });
  });
  s.on(EV.State, applySnapshot);
  s.on(EV.LobbyParticipants, (p: LobbyParticipantsPayload) => {
    useLive.setState({ lobby: p });
  });
  s.on(EV.AnswersProgress, (p: AnswersProgressPayload) => {
    useLive.setState({ progress: p });
  });
  s.on(EV.PlayerSubmission, () => {
    // Another tab answered — pull the authoritative snapshot.
    resync(s);
  });
  s.on(EV.PlayerRemoved, () => {
    clearStoredPlayer();
    useLive.setState({ removed: true, status: 'disconnected' });
  });

  s.connect();
  socket = s;
  return s;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectLive(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}

export function emitAck<T>(event: string, payload: unknown): Promise<T> {
  const s = socket;
  if (!s) return Promise.reject(new Error('not connected'));
  return s.emitWithAck(event, payload) as Promise<T>;
}
