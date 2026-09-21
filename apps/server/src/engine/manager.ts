import { GameRoom, type RoomDeps } from './room.js';

/**
 * Owns the live rooms: lazy hydration from the DB, boot recovery, and the
 * diagnostics view used by GET /api/diagnostics.
 */
export class RoomManager {
  private rooms = new Map<string, GameRoom>();
  /** Serializes hydration so two sockets can't race-create a room. */
  private loading = new Map<string, Promise<GameRoom>>();

  constructor(private deps: RoomDeps) {}

  get(sessionId: string): GameRoom | undefined {
    return this.rooms.get(sessionId);
  }

  async getOrLoad(sessionId: string): Promise<GameRoom> {
    const existing = this.rooms.get(sessionId);
    if (existing) return existing;
    const pending = this.loading.get(sessionId);
    if (pending) return pending;
    const load = this.load(sessionId);
    this.loading.set(sessionId, load);
    try {
      return await load;
    } finally {
      this.loading.delete(sessionId);
    }
  }

  /** For tests/diagnostics. */
  has(sessionId: string): boolean {
    return this.rooms.has(sessionId);
  }

  private async load(sessionId: string): Promise<GameRoom> {
    const session = await this.deps.prisma.gameSession.findUnique({
      where: { id: sessionId },
      include: { participants: true },
    });
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    let attempt = null;
    if (session.questionIndex !== null) {
      attempt = await this.deps.prisma.questionAttempt.findFirst({
        where: { sessionId, questionIndex: session.questionIndex },
        orderBy: { attemptNo: 'desc' },
        include: { submissions: true },
      });
    }
    const room = new GameRoom(this.deps, {
      session,
      participants: session.participants,
      attempt,
    });
    this.rooms.set(sessionId, room);
    return room;
  }

  /**
   * Boot recovery (DESIGN §5): every session with an active PIN is rehydrated.
   * Mid-question states become RECOVERY; stable states resume as-is.
   */
  async restore(): Promise<void> {
    const sessions = await this.deps.prisma.gameSession.findMany({
      where: { activePin: { not: null } },
      select: { id: true },
    });
    for (const s of sessions) {
      try {
        const room = await this.getOrLoad(s.id);
        await room.markRecovery();
      } catch (e) {
        this.deps.recordError(e);
      }
    }
  }

  diagnostics(): {
    active: number;
    list: Array<{ sessionId: string; pin: string; state: string; participants: number }>;
  } {
    return {
      active: this.rooms.size,
      list: [...this.rooms.values()].map((r) => ({
        sessionId: r.sessionId,
        pin: r.pin,
        state: r.getState(),
        participants: r.participantCount(),
      })),
    };
  }

  dispose(): void {
    for (const room of this.rooms.values()) room.dispose();
  }
}
