import { z } from 'zod';
import type { GameSnapshot } from './types.js';

/** Socket.IO event names (client→server events all expect an ack callback). */
export const EV = {
  // client → server
  PlayerJoin: 'player:join',
  PlayerAnswer: 'player:answer',
  StateSync: 'state:sync',
  HostCommand: 'host:command',
  // server → client
  State: 'state',
  LobbyParticipants: 'lobby:participants',
  AnswersProgress: 'answers:progress',
  PlayerSubmission: 'player:submission',
  PlayerRemoved: 'player:removed',
} as const;

// ---------------------------------------------------------------------------
// Handshake auth
// ---------------------------------------------------------------------------

export type SocketAuth =
  | { role: 'player'; participantId?: string; resumeToken?: string }
  | { role: 'host'; sessionId: string }
  | { role: 'display'; displayKey: string };

export type SocketRole = SocketAuth['role'];

// ---------------------------------------------------------------------------
// Wire validation (server validates every inbound payload; ack codes below)
// ---------------------------------------------------------------------------

export const SocketAuthSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('player'),
    participantId: z.string().min(1).optional(),
    resumeToken: z.string().min(1).optional(),
  }),
  z.object({ role: z.literal('host'), sessionId: z.string().min(1) }),
  z.object({ role: z.literal('display'), displayKey: z.string().min(1) }),
]);

export const PlayerJoinRequestSchema = z.object({
  pin: z.string().max(16),
  nickname: z.string().max(64),
});

export const PlayerAnswerRequestSchema = z.object({
  attemptId: z.string().min(1).max(100),
  submissionId: z.string().min(1).max(100),
  optionIds: z.array(z.string().min(1).max(100)).max(12),
});

export const HostCommandRequestSchema = z.object({
  commandId: z.string().min(1).max(100),
  type: z.enum([
    'START',
    'CLOSE_ANSWERS',
    'NEXT',
    'LOCK_LOBBY',
    'UNLOCK_LOBBY',
    'REMOVE_PARTICIPANT',
    'END',
    'REPLAY_QUESTION',
  ]),
  payload: z.object({ participantId: z.string().min(1).optional() }).optional(),
});

// ---------------------------------------------------------------------------
// Client → Server payloads + acks
// ---------------------------------------------------------------------------

export type PlayerJoinRequest = { pin: string; nickname: string };

export type PlayerJoinResult =
  | {
      ok: true;
      participantId: string;
      resumeToken: string;
      sessionId: string;
      snapshot: GameSnapshot;
    }
  | {
      ok: false;
      code:
        | 'NOT_FOUND'
        | 'LOCKED'
        | 'FULL'
        | 'NICKNAME_TAKEN'
        | 'NICKNAME_INVALID'
        | 'ENDED'
        | 'RATE_LIMITED';
    };

export type PlayerAnswerRequest = {
  attemptId: string;
  /** Client-generated idempotency key (uuid). */
  submissionId: string;
  optionIds: string[];
};

export type PlayerAnswerResult =
  | { status: 'accepted'; submissionId: string; receivedAt: string }
  | { status: 'duplicate'; submissionId: string }
  | {
      status: 'rejected';
      reason:
        | 'UNAUTHORIZED'
        | 'STALE_ATTEMPT'
        | 'CLOSED'
        | 'LATE'
        | 'NOT_ELIGIBLE'
        | 'INVALID'
        | 'RATE_LIMITED'
        | 'TEMPORARY';
    };

export type StateSyncRequest = Record<string, never>;
export type StateSyncResult =
  | { ok: true; snapshot: GameSnapshot }
  | { ok: false; code: 'UNAUTHORIZED' | 'INVALID' };

export type HostCommandType =
  | 'START'
  | 'CLOSE_ANSWERS'
  | 'NEXT'
  | 'LOCK_LOBBY'
  | 'UNLOCK_LOBBY'
  | 'REMOVE_PARTICIPANT'
  | 'END'
  | 'REPLAY_QUESTION';

export type HostCommandRequest = {
  /** Idempotency key; the room keeps the last 200 ids. */
  commandId: string;
  type: HostCommandType;
  payload?: { participantId?: string };
};

export type HostCommandResult =
  | { ok: true; revision: number }
  | { ok: false; code: 'INVALID_STATE' | 'UNAUTHORIZED' | 'INVALID' };

// ---------------------------------------------------------------------------
// Server → Client payloads
// ---------------------------------------------------------------------------

export type LobbyParticipantsPayload = {
  count: number;
  participants: Array<{ id: string; nickname: string }>;
};

export type AnswersProgressPayload = {
  attemptId: string;
  answered: number;
  eligible: number;
};

export type PlayerSubmissionPayload = {
  attemptId: string;
  optionIds: string[];
};

/** Payload of the `player:join` ack `snapshot` field reuses GameSnapshot. */
export type JoinSnapshot = GameSnapshot;
