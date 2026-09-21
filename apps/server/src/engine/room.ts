import { randomBytes } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';
import {
  EV,
  rankParticipants,
  scoreSubmission,
  type GameSnapshot,
  type HostCommandRequest,
  type HostCommandResult,
  type PlayerAnswerRequest,
  type PlayerAnswerResult,
  type QuizSnapshot,
  type SessionSettings,
  type SessionState,
  type SocketRole,
} from '@ictquiz/shared';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type {
  GameSessionModel,
  ParticipantModel,
  QuestionAttemptModel,
  SubmissionModel,
} from '../generated/prisma/models.js';
import { hashToken } from '../lib/session.js';

export const COUNTDOWN_MS = 5000;
const COMMAND_CACHE_MAX = 200;
const COALESCE_MS = 300;

const REVEAL_STATES: ReadonlySet<SessionState> = new Set([
  'ANSWER_REVEAL',
  'LEADERBOARD',
  'FINISHED',
]);
const QUESTION_STATES: ReadonlySet<SessionState> = new Set([
  'COUNTDOWN',
  'QUESTION_OPEN',
  'QUESTION_CLOSED',
  'ANSWER_REVEAL',
  'LEADERBOARD',
  'RECOVERY',
]);

type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends' | '$use'
>;

type RoomParticipant = {
  id: string;
  nickname: string;
  nicknameKey: string;
  status: 'ACTIVE' | 'REMOVED';
  score: number;
  streak: number;
  correctCount: number;
  totalResponseMs: number;
  joinedAt: Date;
  lastSeenAt: Date;
  sockets: Set<string>;
};

type RoomSubmission = {
  submissionId: string;
  optionIds: string[];
  receivedAt: Date;
  responseTimeMs: number;
  isCorrect: boolean;
  points: number;
};

type RoomAttempt = {
  id: string;
  questionIndex: number;
  attemptNo: number;
  openedAtMs: number;
  deadlineAtMs: number;
  status: 'OPEN' | 'CLOSED' | 'VOIDED';
  submissions: Map<string, RoomSubmission>;
};

export type RoomDeps = {
  prisma: PrismaClient;
  io: SocketIOServer;
  countdownMs: number;
  publicUrl: string;
  recordError: (err: unknown) => void;
  /** Called once when the room reaches FINISHED or CANCELLED. */
  onTerminal?: (sessionId: string) => void;
};

export type HydratedRoom = {
  session: GameSessionModel;
  participants: ParticipantModel[];
  /** Latest attempt for the session's current questionIndex, if any. */
  attempt: (QuestionAttemptModel & { submissions: SubmissionModel[] }) | null;
};

export type JoinOutcome =
  | { ok: true; participantId: string; resumeToken: string }
  | { ok: false; code: 'LOCKED' | 'FULL' | 'NICKNAME_TAKEN' | 'ENDED' };

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

const INVALID_STATE: HostCommandResult = { ok: false, code: 'INVALID_STATE' };

/**
 * Server-authoritative live room. Every mutation runs through `run`, a serial
 * promise queue, so the DB and the in-memory view never interleave.
 */
export class GameRoom {
  readonly sessionId: string;
  readonly pin: string;
  readonly displayKey: string;
  readonly organizerId: string;

  private quizSnapshot: QuizSnapshot;
  private settings: SessionSettings;
  private state: SessionState;
  private revision: number;
  private questionIndex: number | null;
  private locked: boolean;
  private startedAt: Date | null;
  private endedAt: Date | null;

  private participants = new Map<string, RoomParticipant>();
  private attempt: RoomAttempt | null = null;
  private leaderboard: Array<{
    participantId: string;
    nickname: string;
    score: number;
    rank: number;
    delta: number;
  }> = [];
  private previousRanks = new Map<string, number>();
  private commandAcks = new Map<string, HostCommandResult>();

  private queueTail: Promise<unknown> = Promise.resolve();
  private countdownTimer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private lobbyTimer: NodeJS.Timeout | null = null;
  private progressTimer: NodeJS.Timeout | null = null;

  constructor(
    private deps: RoomDeps,
    data: HydratedRoom,
  ) {
    const s = data.session;
    this.sessionId = s.id;
    this.pin = s.pin;
    this.displayKey = s.displayKey;
    this.organizerId = s.organizerId;
    this.quizSnapshot = s.quizSnapshot as QuizSnapshot;
    this.settings = s.settings as SessionSettings;
    this.state = s.state;
    this.revision = s.revision;
    this.questionIndex = s.questionIndex;
    this.locked = s.locked;
    this.startedAt = s.startedAt;
    this.endedAt = s.endedAt;
    for (const p of data.participants) {
      this.participants.set(p.id, {
        id: p.id,
        nickname: p.nickname,
        nicknameKey: p.nicknameKey,
        status: p.status,
        score: p.score,
        streak: p.streak,
        correctCount: p.correctCount,
        totalResponseMs: p.totalResponseMs,
        joinedAt: p.joinedAt,
        lastSeenAt: p.lastSeenAt,
        sockets: new Set(),
      });
    }
    if (data.attempt) {
      const subs = new Map<string, RoomSubmission>(
        data.attempt.submissions.map((sub) => [
          sub.participantId,
          {
            submissionId: sub.submissionId,
            optionIds: sub.optionIds,
            receivedAt: sub.receivedAt,
            responseTimeMs: sub.responseTimeMs,
            isCorrect: sub.isCorrect,
            points: sub.points,
          },
        ]),
      );
      this.attempt = {
        id: data.attempt.id,
        questionIndex: data.attempt.questionIndex,
        attemptNo: data.attempt.attemptNo,
        openedAtMs: data.attempt.openedAt.getTime(),
        deadlineAtMs: data.attempt.deadlineAt.getTime(),
        status: data.attempt.status,
        submissions: subs,
      };
    }
    // A hydrated LEADERBOARD/FINISHED room must serve its standings at once
    // (deltas are 0 — previous ranks are not persisted).
    if (this.state === 'LEADERBOARD' || this.state === 'FINISHED') {
      this.computeLeaderboard();
    }
  }

  // ------------------------------------------------------------------
  // Queue + lifecycle
  // ------------------------------------------------------------------

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.queueTail.then(fn, () => fn());
    this.queueTail = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  dispose(): void {
    for (const t of [
      this.countdownTimer,
      this.deadlineTimer,
      this.lobbyTimer,
      this.progressTimer,
    ]) {
      if (t) clearTimeout(t);
    }
  }

  attachSocket(participantId: string, socketId: string): void {
    this.participants.get(participantId)?.sockets.add(socketId);
  }

  detachSocket(participantId: string, socketId: string): void {
    this.participants.get(participantId)?.sockets.delete(socketId);
  }

  /** Boot recovery: interrupted mid-question states become RECOVERY. */
  async markRecovery(): Promise<void> {
    if (
      this.state !== 'COUNTDOWN' &&
      this.state !== 'QUESTION_OPEN' &&
      this.state !== 'QUESTION_CLOSED'
    ) {
      return;
    }
    await this.persist({
      state: 'RECOVERY',
      event: 'RECOVERY',
      eventPayload: { from: this.state },
    });
  }

  getState(): SessionState {
    return this.state;
  }

  /** ACTIVE participants (diagnostics). */
  participantCount(): number {
    return this.activeCount();
  }

  /** Live sockets attached to this session across all roles (diagnostics). */
  connectedSocketCount(): number {
    let n = 0;
    for (const p of this.participants.values()) n += p.sockets.size;
    const adapter = this.deps.io.of('/').adapter;
    n += adapter.rooms.get(`s:${this.sessionId}:host`)?.size ?? 0;
    n += adapter.rooms.get(`s:${this.sessionId}:display`)?.size ?? 0;
    return n;
  }

  getRevision(): number {
    return this.revision;
  }

  // ------------------------------------------------------------------
  // Participant join (called from the socket layer inside the queue)
  // ------------------------------------------------------------------

  join(nickname: { value: string; key: string }): Promise<JoinOutcome> {
    return this.run(async () => {
      if (this.state === 'FINISHED' || this.state === 'CANCELLED') {
        return { ok: false, code: 'ENDED' } as const;
      }
      if (this.locked) return { ok: false, code: 'LOCKED' } as const;
      if (this.activeCount() >= this.settings.maxParticipants) {
        return { ok: false, code: 'FULL' } as const;
      }
      const resumeToken = randomBytes(32).toString('base64url');
      let created: ParticipantModel | undefined;
      try {
        created = await this.persist({
          state: this.state,
          event: 'PLAYER_JOIN',
          emit: false,
          write: async (tx) =>
            tx.participant.create({
              data: {
                sessionId: this.sessionId,
                nickname: nickname.value,
                nicknameKey: nickname.key,
                resumeTokenHash: hashToken(resumeToken),
              },
            }),
        });
      } catch (e) {
        if (isUniqueViolation(e)) return { ok: false, code: 'NICKNAME_TAKEN' } as const;
        throw e;
      }
      if (!created) throw new Error('participant create returned nothing');
      this.participants.set(created.id, {
        id: created.id,
        nickname: created.nickname,
        nicknameKey: created.nicknameKey,
        status: 'ACTIVE',
        score: 0,
        streak: 0,
        correctCount: 0,
        totalResponseMs: 0,
        joinedAt: created.joinedAt,
        lastSeenAt: created.lastSeenAt,
        sockets: new Set(),
      });
      this.emitStateHostDisplay();
      this.scheduleLobby();
      return { ok: true, participantId: created.id, resumeToken } as const;
    });
  }

  // ------------------------------------------------------------------
  // Submission (steps 1–8 in DESIGN §5)
  // ------------------------------------------------------------------

  submit(
    participantId: string,
    req: PlayerAnswerRequest,
    receivedAt: Date,
  ): Promise<PlayerAnswerResult> {
    return this.run(async () => {
      const p = this.participants.get(participantId);
      if (!p || p.status !== 'ACTIVE') {
        return { status: 'rejected', reason: 'UNAUTHORIZED' } as const;
      }
      const attempt = this.attempt;
      // Idempotent retry wins over state/deadline checks (§5): a client that
      // retries after the attempt closed must get its original ack back.
      if (attempt && attempt.id === req.attemptId) {
        const prior = attempt.submissions.get(participantId);
        if (prior) {
          if (prior.submissionId === req.submissionId) {
            return {
              status: 'accepted',
              submissionId: prior.submissionId,
              receivedAt: prior.receivedAt.toISOString(),
            } as const;
          }
          return { status: 'duplicate', submissionId: prior.submissionId } as const;
        }
      }
      if (
        this.state !== 'QUESTION_OPEN' ||
        !attempt ||
        attempt.status !== 'OPEN' ||
        attempt.id !== req.attemptId
      ) {
        const closed =
          attempt != null && attempt.id === req.attemptId && attempt.status !== 'OPEN';
        return {
          status: 'rejected',
          reason: closed ? 'CLOSED' : 'STALE_ATTEMPT',
        } as const;
      }
      if (receivedAt.getTime() > attempt.deadlineAtMs) {
        return { status: 'rejected', reason: 'LATE' } as const;
      }
      if (p.joinedAt.getTime() >= attempt.openedAtMs) {
        return { status: 'rejected', reason: 'NOT_ELIGIBLE' } as const;
      }

      const question = this.quizSnapshot.questions[attempt.questionIndex];
      if (!question) return { status: 'rejected', reason: 'STALE_ATTEMPT' } as const;
      const known = new Set(question.options.map((o) => o.id));
      const ids = [...new Set(req.optionIds)];
      const valid =
        question.type === 'MULTI'
          ? ids.length >= 1 && ids.every((id) => known.has(id))
          : req.optionIds.length === 1 && ids.length === 1 && known.has(ids[0]!);
      if (!valid) return { status: 'rejected', reason: 'INVALID' } as const;

      const rt = Math.max(0, receivedAt.getTime() - attempt.openedAtMs);
      const { isCorrect, points } = scoreSubmission(question, ids, rt);

      try {
        await this.deps.prisma.submission.create({
          data: {
            attemptId: attempt.id,
            participantId,
            submissionId: req.submissionId,
            optionIds: ids,
            receivedAt,
            responseTimeMs: rt,
            isCorrect,
            points,
          },
        });
        attempt.submissions.set(participantId, {
          submissionId: req.submissionId,
          optionIds: ids,
          receivedAt,
          responseTimeMs: rt,
          isCorrect,
          points,
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        const existing = await this.deps.prisma.submission.findUniqueOrThrow({
          where: { attemptId_participantId: { attemptId: attempt.id, participantId } },
        });
        if (existing.submissionId === req.submissionId) {
          return {
            status: 'accepted',
            submissionId: existing.submissionId,
            receivedAt: existing.receivedAt.toISOString(),
          } as const;
        }
        return { status: 'duplicate', submissionId: existing.submissionId } as const;
      }

      this.deps.io
        .to(`p:${participantId}`)
        .emit(EV.PlayerSubmission, { attemptId: attempt.id, optionIds: ids });
      this.scheduleProgress();

      if (this.allEligibleAnswered()) {
        await this.closeQuestion('all-answered');
      }
      return {
        status: 'accepted',
        submissionId: req.submissionId,
        receivedAt: receivedAt.toISOString(),
      } as const;
    });
  }

  // ------------------------------------------------------------------
  // Host commands (idempotent on commandId)
  // ------------------------------------------------------------------

  handleCommand(req: HostCommandRequest): Promise<HostCommandResult> {
    return this.run(async () => {
      const cached = this.commandAcks.get(req.commandId);
      if (cached) return cached;
      const result = await this.execCommand(req.type, req.payload?.participantId);
      this.commandAcks.set(req.commandId, result);
      if (this.commandAcks.size > COMMAND_CACHE_MAX) {
        const oldest = this.commandAcks.keys().next().value;
        if (oldest !== undefined) this.commandAcks.delete(oldest);
      }
      return result;
    });
  }

  private async execCommand(
    type: HostCommandRequest['type'],
    participantId?: string,
  ): Promise<HostCommandResult> {
    switch (type) {
      case 'START':
        return this.start();
      case 'CLOSE_ANSWERS':
        return this.closeQuestion('host');
      case 'NEXT':
        return this.next();
      case 'LOCK_LOBBY':
        return this.setLocked(true);
      case 'UNLOCK_LOBBY':
        return this.setLocked(false);
      case 'REMOVE_PARTICIPANT':
        if (!participantId) return { ok: false, code: 'INVALID' };
        return this.removeParticipant(participantId);
      case 'END':
        return this.end();
      case 'REPLAY_QUESTION':
        return this.replayQuestion();
      default:
        return { ok: false, code: 'INVALID' };
    }
  }

  // ------------------------------------------------------------------
  // Transitions
  // ------------------------------------------------------------------

  private async start(): Promise<HostCommandResult> {
    if (this.state !== 'LOBBY') return INVALID_STATE;
    const locked = this.locked || !this.settings.allowLateJoin;
    const startedAt = new Date();
    await this.persist({
      state: 'COUNTDOWN',
      questionIndex: 0,
      set: { locked, startedAt },
      event: 'START',
      eventPayload: { locked },
    });
    this.locked = locked;
    this.startedAt = startedAt;
    this.armCountdown();
    return { ok: true, revision: this.revision };
  }

  private async openQuestion(): Promise<void> {
    if (this.state !== 'COUNTDOWN' || this.questionIndex === null) return;
    const qIndex = this.questionIndex;
    const question = this.quizSnapshot.questions[qIndex];
    if (!question) return;
    const now = Date.now();
    const deadlineAtMs = now + question.timeLimitSec * 1000;
    const max = await this.deps.prisma.questionAttempt.aggregate({
      _max: { attemptNo: true },
      where: { sessionId: this.sessionId, questionIndex: qIndex },
    });
    const attemptNo = (max._max.attemptNo ?? 0) + 1;
    await this.persist({
      state: 'QUESTION_OPEN',
      event: 'QUESTION_OPEN',
      eventPayload: { questionIndex: qIndex, attemptNo },
      write: async (tx) => {
        const att = await tx.questionAttempt.create({
          data: {
            sessionId: this.sessionId,
            questionIndex: qIndex,
            attemptNo,
            openedAt: new Date(now),
            deadlineAt: new Date(deadlineAtMs),
            status: 'OPEN',
          },
        });
        this.attempt = {
          id: att.id,
          questionIndex: qIndex,
          attemptNo,
          openedAtMs: now,
          deadlineAtMs,
          status: 'OPEN',
          submissions: new Map(),
        };
      },
    });
    this.armDeadline(deadlineAtMs - Date.now());
  }

  private async closeQuestion(
    trigger: 'deadline' | 'host' | 'all-answered',
  ): Promise<HostCommandResult> {
    if (this.state !== 'QUESTION_OPEN' || !this.attempt || this.attempt.status !== 'OPEN') {
      return trigger === 'host' ? INVALID_STATE : { ok: true, revision: this.revision };
    }
    const attempt = this.attempt;
    this.clearDeadline();

    // §4 per-question pass over ACTIVE participants.
    const active = [...this.participants.values()].filter((p) => p.status === 'ACTIVE');
    const updates = active.map((p) => {
      const sub = attempt.submissions.get(p.id);
      const next = {
        score: p.score,
        streak: 0,
        correctCount: p.correctCount,
        totalResponseMs: p.totalResponseMs,
      };
      if (sub?.isCorrect) {
        next.score += sub.points;
        next.streak = p.streak + 1;
        next.correctCount += 1;
        next.totalResponseMs += sub.responseTimeMs;
      } else if (sub && sub.points > 0) {
        next.score += sub.points;
      }
      // Rows with no submission and a zero streak would be written unchanged.
      return { id: p.id, dirty: sub != null || p.streak !== 0, ...next };
    });

    await this.persist({
      state: 'ANSWER_REVEAL',
      event: 'QUESTION_CLOSED',
      eventPayload: {
        attemptId: attempt.id,
        answered: attempt.submissions.size,
        eligible: this.eligibleCount(),
        trigger,
      },
      emit: false,
      write: async (tx) => {
        await tx.questionAttempt.update({
          where: { id: attempt.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        });
        for (const u of updates) {
          if (!u.dirty) continue;
          await tx.participant.update({
            where: { id: u.id },
            data: {
              score: u.score,
              streak: u.streak,
              correctCount: u.correctCount,
              totalResponseMs: u.totalResponseMs,
            },
          });
        }
      },
    });
    attempt.status = 'CLOSED';
    for (const u of updates) {
      const p = this.participants.get(u.id);
      if (!p) continue;
      p.score = u.score;
      p.streak = u.streak;
      p.correctCount = u.correctCount;
      p.totalResponseMs = u.totalResponseMs;
    }
    this.emitState();
    return { ok: true, revision: this.revision };
  }

  private async next(): Promise<HostCommandResult> {
    if (this.state === 'ANSWER_REVEAL') {
      const last = (this.questionIndex ?? 0) >= this.quizSnapshot.questions.length - 1;
      if (last) return this.finish();
      this.computeLeaderboard();
      await this.persist({ state: 'LEADERBOARD', event: 'LEADERBOARD' });
      return { ok: true, revision: this.revision };
    }
    if (this.state === 'LEADERBOARD') {
      const nextIndex = (this.questionIndex ?? -1) + 1;
      if (nextIndex >= this.quizSnapshot.questions.length) return INVALID_STATE;
      await this.persist({ state: 'COUNTDOWN', questionIndex: nextIndex, event: 'NEXT' });
      this.armCountdown();
      return { ok: true, revision: this.revision };
    }
    return INVALID_STATE;
  }

  private async finish(): Promise<HostCommandResult> {
    this.computeLeaderboard();
    await this.persist({
      state: 'FINISHED',
      set: { activePin: null, endedAt: new Date() },
      event: 'FINISHED',
    });
    this.endedAt = new Date();
    this.clearTimers();
    this.deps.onTerminal?.(this.sessionId);
    return { ok: true, revision: this.revision };
  }

  private async end(): Promise<HostCommandResult> {
    if (this.state === 'FINISHED' || this.state === 'CANCELLED') return INVALID_STATE;
    const final: SessionState = this.startedAt ? 'FINISHED' : 'CANCELLED';
    if (final === 'FINISHED') this.computeLeaderboard();
    await this.persist({
      state: final,
      set: { activePin: null, endedAt: new Date() },
      event: final === 'FINISHED' ? 'FINISHED' : 'CANCELLED',
    });
    this.endedAt = new Date();
    this.clearTimers();
    this.deps.onTerminal?.(this.sessionId);
    return { ok: true, revision: this.revision };
  }

  private async setLocked(locked: boolean): Promise<HostCommandResult> {
    if (this.state !== 'LOBBY') return INVALID_STATE;
    if (this.locked === locked) return { ok: true, revision: this.revision };
    await this.persist({
      state: this.state,
      set: { locked },
      event: locked ? 'LOCK_LOBBY' : 'UNLOCK_LOBBY',
      emit: false,
    });
    this.locked = locked;
    this.emitStateHostDisplay();
    return { ok: true, revision: this.revision };
  }

  private async removeParticipant(participantId: string): Promise<HostCommandResult> {
    const p = this.participants.get(participantId);
    if (!p || p.status !== 'ACTIVE') return { ok: false, code: 'INVALID' };
    await this.persist({
      state: this.state,
      event: 'REMOVE_PARTICIPANT',
      eventPayload: { participantId },
      emit: false,
      write: async (tx) => {
        await tx.participant.update({
          where: { id: participantId },
          // Rotating the hash kills the old resume token.
          data: { status: 'REMOVED', resumeTokenHash: randomBytes(32).toString('hex') },
        });
      },
    });
    p.status = 'REMOVED';
    this.emitState();
    this.deps.io.to(`p:${participantId}`).emit(EV.PlayerRemoved, {});
    this.deps.io.in(`p:${participantId}`).disconnectSockets(true);
    p.sockets.clear();
    this.scheduleLobby();
    return { ok: true, revision: this.revision };
  }

  private async replayQuestion(): Promise<HostCommandResult> {
    if (this.state !== 'RECOVERY') return INVALID_STATE;
    const attempt = this.attempt;
    await this.persist({
      state: 'COUNTDOWN',
      event: 'REPLAY_QUESTION',
      eventPayload: { questionIndex: this.questionIndex, voidedAttemptId: attempt?.id },
      write: async (tx) => {
        if (attempt && attempt.status === 'OPEN') {
          await tx.questionAttempt.update({
            where: { id: attempt.id },
            data: { status: 'VOIDED' },
          });
          attempt.status = 'VOIDED';
        }
      },
    });
    this.armCountdown();
    return { ok: true, revision: this.revision };
  }

  // ------------------------------------------------------------------
  // Persistence + broadcast
  // ------------------------------------------------------------------

  /**
   * One transaction: session state/revision (+extra fields), any extra writes
   * (attempt / participants), and a SessionEvent — then update memory and
   * broadcast role-filtered snapshots.
   */
  private async persist<T>(opts: {
    state: SessionState;
    questionIndex?: number | null;
    set?: Prisma.GameSessionUpdateInput;
    write?: (tx: Tx) => Promise<T>;
    event: string;
    eventPayload?: Record<string, unknown>;
    /** false = caller applies in-memory updates first, then emits itself. */
    emit?: boolean;
  }): Promise<T | undefined> {
    const written = await this.deps.prisma.$transaction(async (tx) => {
      await tx.gameSession.update({
        where: { id: this.sessionId },
        data: {
          state: opts.state,
          revision: { increment: 1 },
          ...(opts.questionIndex !== undefined ? { questionIndex: opts.questionIndex } : {}),
          ...(opts.set ?? {}),
        } as Prisma.GameSessionUpdateInput,
      });
      const t = opts.write ? await opts.write(tx) : undefined;
      await tx.sessionEvent.create({
        data: {
          sessionId: this.sessionId,
          type: opts.event,
          payload: JSON.parse(JSON.stringify(opts.eventPayload ?? {})),
        },
      });
      return t;
    });
    this.state = opts.state;
    if (opts.questionIndex !== undefined) this.questionIndex = opts.questionIndex;
    this.revision += 1;
    if (opts.emit !== false) this.emitState();
    return written;
  }

  private emitState(): void {
    const { io } = this.deps;
    const ranked = this.ranked();
    io.to(`s:${this.sessionId}:host`).emit(EV.State, this.buildSnapshot('host', undefined, ranked));
    io
      .to(`s:${this.sessionId}:display`)
      .emit(EV.State, this.buildSnapshot('display', undefined, ranked));
    for (const p of this.participants.values()) {
      if (p.status !== 'ACTIVE' || p.sockets.size === 0) continue;
      io.to(`p:${p.id}`).emit(EV.State, this.buildSnapshot('player', p.id, ranked));
    }
  }

  /** Host + display only — for changes players don't need pushed (joins, lock). */
  private emitStateHostDisplay(): void {
    const { io } = this.deps;
    const ranked = this.ranked();
    io.to(`s:${this.sessionId}:host`).emit(EV.State, this.buildSnapshot('host', undefined, ranked));
    io
      .to(`s:${this.sessionId}:display`)
      .emit(EV.State, this.buildSnapshot('display', undefined, ranked));
  }

  // ------------------------------------------------------------------
  // Timers + coalesced auxiliary emits
  // ------------------------------------------------------------------

  private armCountdown(): void {
    this.clearCountdown();
    this.countdownTimer = setTimeout(() => {
      this.run(() => this.openQuestion()).catch(this.deps.recordError);
    }, this.deps.countdownMs);
  }

  private armDeadline(ms: number): void {
    this.clearDeadline();
    this.deadlineTimer = setTimeout(
      () => {
        this.run(() => this.closeQuestion('deadline')).catch(this.deps.recordError);
      },
      Math.max(0, ms),
    );
  }

  private clearCountdown(): void {
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private clearTimers(): void {
    this.clearCountdown();
    this.clearDeadline();
  }

  /** Current lobby roster payload (sent on connect + on coalesced joins). */
  lobbyPayload(): { count: number; participants: Array<{ id: string; nickname: string }> } {
    const participants = this.activeParticipants().map((p) => ({
      id: p.id,
      nickname: p.nickname,
    }));
    return { count: participants.length, participants };
  }

  private scheduleLobby(): void {
    if (this.lobbyTimer) return;
    this.lobbyTimer = setTimeout(() => {
      this.lobbyTimer = null;
      const participants = [...this.participants.values()]
        .filter((p) => p.status === 'ACTIVE')
        .map((p) => ({ id: p.id, nickname: p.nickname }));
      this.deps.io
        .to(`s:${this.sessionId}:host`)
        .to(`s:${this.sessionId}:display`)
        .emit(EV.LobbyParticipants, { count: participants.length, participants });
    }, COALESCE_MS);
  }

  private scheduleProgress(): void {
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      if (!this.attempt) return;
      this.deps.io
        .to(`s:${this.sessionId}:host`)
        .to(`s:${this.sessionId}:display`)
        .emit(EV.AnswersProgress, {
          attemptId: this.attempt.id,
          answered: this.attempt.submissions.size,
          eligible: this.eligibleCount(),
        });
    }, COALESCE_MS);
  }

  // ------------------------------------------------------------------
  // Derived state
  // ------------------------------------------------------------------

  private activeParticipants(): RoomParticipant[] {
    return [...this.participants.values()].filter((p) => p.status === 'ACTIVE');
  }

  private activeCount(): number {
    let n = 0;
    for (const p of this.participants.values()) if (p.status === 'ACTIVE') n += 1;
    return n;
  }

  private ranked() {
    return rankParticipants(this.activeParticipants());
  }

  private eligibleCount(): number {
    const attempt = this.attempt;
    if (!attempt) return 0;
    return this.activeParticipants().filter((p) => p.joinedAt.getTime() < attempt.openedAtMs)
      .length;
  }

  private allEligibleAnswered(): boolean {
    const attempt = this.attempt;
    if (!attempt) return false;
    const eligible = this.activeParticipants().filter(
      (p) => p.joinedAt.getTime() < attempt.openedAtMs,
    );
    return eligible.length > 0 && eligible.every((p) => attempt.submissions.has(p.id));
  }

  private computeLeaderboard(): void {
    const ranked = this.ranked();
    this.leaderboard = ranked.map((p) => ({
      participantId: p.id,
      nickname: p.nickname,
      score: p.score,
      rank: p.rank,
      delta: (this.previousRanks.get(p.id) ?? p.rank) - p.rank,
    }));
    this.previousRanks = new Map(ranked.map((p) => [p.id, p.rank]));
  }

  // ------------------------------------------------------------------
  // Snapshot builder (§6 — role-filtered)
  // ------------------------------------------------------------------

  buildSnapshot(
    role: SocketRole,
    participantId?: string,
    rankedCache?: ReturnType<GameRoom['ranked']>,
  ): GameSnapshot {
    const reveal = REVEAL_STATES.has(this.state);
    const showSecrets = role === 'host' || reveal;
    const ranked = rankedCache ?? this.ranked();

    const snap: GameSnapshot = {
      sessionId: this.sessionId,
      revision: this.revision,
      state: this.state,
      serverTime: Date.now(),
      quiz: {
        title: this.quizSnapshot.title,
        questionCount: this.quizSnapshot.questions.length,
      },
      pin: this.pin,
      joinUrl: `${this.deps.publicUrl}/join/${this.pin}`,
      locked: this.locked,
      participantCount: this.activeCount(),
      questionIndex: this.questionIndex,
    };

    const qIndex = this.questionIndex;
    if (qIndex !== null && QUESTION_STATES.has(this.state)) {
      const q = this.quizSnapshot.questions[qIndex];
      if (q) {
        snap.question = {
          attemptId: this.attempt?.id ?? '',
          index: qIndex,
          type: q.type,
          text: q.text,
          media: q.media,
          timeLimitSec: q.timeLimitSec,
          pointsMode: q.pointsMode,
          showTextOnPlayer: this.settings.showQuestionOnPlayer,
          options: q.options.map((o) => ({
            id: o.id,
            index: o.index,
            text: o.text,
            media: o.media,
            ...(showSecrets ? { isCorrect: o.isCorrect } : {}),
          })),
          ...(showSecrets && q.explanation ? { explanation: q.explanation } : {}),
          ...(this.attempt
            ? {
                openedAt: new Date(this.attempt.openedAtMs).toISOString(),
                deadlineAt: new Date(this.attempt.deadlineAtMs).toISOString(),
              }
            : {}),
        };
      }
    }

    const attempt = this.attempt;
    if (reveal && attempt && attempt.status === 'CLOSED' && qIndex !== null) {
      const q = this.quizSnapshot.questions[attempt.questionIndex];
      if (!q) return snap;
      snap.results = {
        answered: attempt.submissions.size,
        eligible: this.eligibleCount(),
        distribution: q.options.map((o) => ({
          optionId: o.id,
          count: [...attempt.submissions.values()].filter((s) =>
            s.optionIds.includes(o.id),
          ).length,
        })),
        correctOptionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id),
      };
    }

    if (this.state === 'LEADERBOARD') {
      snap.leaderboard = this.leaderboard.slice(0, 5);
    } else if (this.state === 'FINISHED') {
      snap.leaderboard = this.leaderboard.slice(0, 3);
    }

    if (role === 'player' && participantId) {
      const p = this.participants.get(participantId);
      if (p) {
        const sub = attempt?.submissions.get(participantId);
        const closed = attempt?.status === 'CLOSED';
        const me: NonNullable<GameSnapshot['me']> = {
          participantId,
          nickname: p.nickname,
          score: p.score,
          rank: ranked.find((r) => r.id === participantId)?.rank ?? 0,
          streak: p.streak,
          canAnswer:
            this.state === 'QUESTION_OPEN' &&
            p.status === 'ACTIVE' &&
            !!attempt &&
            attempt.status === 'OPEN' &&
            p.joinedAt.getTime() < attempt.openedAtMs &&
            !attempt.submissions.has(participantId),
        };
        if (sub) {
          me.submission = { attemptId: attempt!.id, optionIds: sub.optionIds };
        }
        if (closed && reveal) {
          const r = attempt.submissions.get(participantId);
          me.lastResult = r
            ? { correct: r.isCorrect, points: r.points, streak: p.streak }
            : { correct: false, points: 0, streak: p.streak };
        }
        snap.me = me;
      }
    }

    if (role === 'host') {
      snap.host = {
        participants: ranked.map((p) => ({
          id: p.id,
          nickname: p.nickname,
          score: p.score,
          rank: p.rank,
          status: 'ACTIVE',
          connected: (this.participants.get(p.id)?.sockets.size ?? 0) > 0,
        })),
        answered: attempt?.submissions.size ?? 0,
        eligible: this.eligibleCount(),
        displayKey: this.displayKey,
      };
    }

    return snap;
  }
}
