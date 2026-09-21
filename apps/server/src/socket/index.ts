import { Server, type Socket } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import {
  EV,
  HostCommandRequestSchema,
  PlayerAnswerRequestSchema,
  PlayerJoinRequestSchema,
  SocketAuthSchema,
  normalizeNickname,
  type HostCommandResult,
  type PlayerAnswerResult,
  type PlayerJoinResult,
  type SocketRole,
  type StateSyncResult,
} from '@ictquiz/shared';
import { RoomManager } from '../engine/manager.js';
import { recordError } from '../lib/errors.js';
import { socketClientIp } from '../lib/join-limiter.js';
import { SESSION_COOKIE, hashToken } from '../lib/session.js';

type SocketData = {
  role: SocketRole;
  sessionId?: string;
  participantId?: string;
};

/** Per-socket token buckets: join ≤ 5/min, answer ≤ 30/min (DESIGN §7). */
const JOIN_LIMIT = 5;
const ANSWER_LIMIT = 30;
const WINDOW_MS = 60_000;

type Buckets = { join: number[]; answer: number[] };

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAck(fn: unknown): fn is (arg: unknown) => void {
  return typeof fn === 'function';
}

export function attachSockets(app: FastifyInstance): void {
  const io = new Server(app.server, {
    cors: { origin: false },
    serveClient: false,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 64 * 1024,
  });

  const managerRef: { current?: RoomManager } = {};
  const rooms = new RoomManager({
    prisma: app.prisma,
    io,
    countdownMs: app.config.countdownMs,
    publicUrl: app.config.publicUrl,
    recordError: (e: unknown) => recordError(e, 'engine'),
    onTerminal: (sessionId) => managerRef.current?.scheduleEvict(sessionId),
  });
  managerRef.current = rooms;

  app.decorate('io', io);
  app.decorate('rooms', rooms);

  const buckets = new Map<string, Buckets>();
  const rateOk = (socketId: string, kind: 'join' | 'answer'): boolean => {
    const limit = kind === 'join' ? JOIN_LIMIT : ANSWER_LIMIT;
    const now = Date.now();
    let b = buckets.get(socketId);
    if (!b) {
      b = { join: [], answer: [] };
      buckets.set(socketId, b);
    }
    const stamps = b[kind].filter((t) => now - t < WINDOW_MS);
    b[kind] = stamps;
    if (stamps.length >= limit) return false;
    stamps.push(now);
    return true;
  };

  // ------------------------------------------------------------------
  // Handshake auth (DESIGN §6)
  // ------------------------------------------------------------------
  io.use(async (socket, next) => {
    try {
      const parsed = SocketAuthSchema.safeParse(socket.handshake.auth);
      if (!parsed.success) return next(new Error('UNAUTHORIZED'));
      const auth = parsed.data;

      if (auth.role === 'player') {
        if (auth.participantId && auth.resumeToken) {
          const p = await app.prisma.participant.findUnique({
            where: { id: auth.participantId },
          });
          if (
            !p ||
            p.resumeTokenHash !== hashToken(auth.resumeToken) ||
            p.status !== 'ACTIVE'
          ) {
            return next(new Error('UNAUTHORIZED'));
          }
          const data: SocketData = {
            role: 'player',
            sessionId: p.sessionId,
            participantId: p.id,
          };
          socket.data = data;
          return next();
        }
        // Bare player: may only call player:join.
        socket.data = { role: 'player' } satisfies SocketData;
        return next();
      }

      if (auth.role === 'host') {
        const token = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
        if (!token) return next(new Error('UNAUTHORIZED'));
        const orgSession = await app.prisma.organizerSession.findUnique({
          where: { id: hashToken(token) },
        });
        if (!orgSession || orgSession.expiresAt.getTime() <= Date.now()) {
          return next(new Error('UNAUTHORIZED'));
        }
        const session = await app.prisma.gameSession.findUnique({
          where: { id: auth.sessionId },
          select: { organizerId: true },
        });
        if (!session || session.organizerId !== orgSession.organizerId) {
          return next(new Error('UNAUTHORIZED'));
        }
        socket.data = { role: 'host', sessionId: auth.sessionId } satisfies SocketData;
        return next();
      }

      // display
      const session = await app.prisma.gameSession.findUnique({
        where: { displayKey: auth.displayKey },
        select: { id: true },
      });
      if (!session) return next(new Error('UNAUTHORIZED'));
      socket.data = { role: 'display', sessionId: session.id } satisfies SocketData;
      return next();
    } catch (e) {
      recordError(e, 'socket');
      next(new Error('UNAUTHORIZED'));
    }
  });

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------
  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;

    void (async () => {
      try {
        if (!data.sessionId) return;
        const room = await rooms.getOrLoad(data.sessionId);
        await socket.join(`s:${data.sessionId}:${data.role}`);
        if (data.role === 'player' && data.participantId) {
          await socket.join(`p:${data.participantId}`);
          room.attachSocket(data.participantId, socket.id);
          app.prisma.participant
            .update({ where: { id: data.participantId }, data: { lastSeenAt: new Date() } })
            .catch((e) => recordError(e, 'socket'));
          socket.emit(EV.State, room.buildSnapshot('player', data.participantId));
        } else {
          socket.emit(EV.State, room.buildSnapshot(data.role));
          // Host/display also get the current lobby roster immediately.
          socket.emit(EV.LobbyParticipants, room.lobbyPayload());
        }
      } catch (e) {
        recordError(e, 'socket');
      }
    })();

    socket.on('player:join', async (payload: unknown, ack: unknown) => {
      try {
        if (!isAck(ack)) return;
        // Shared per-IP limiter first: a limited IP must learn nothing about
        // PIN validity, so the check runs before any lookup or parsing.
        const ip = socketClientIp(socket, app.config.trustProxy);
        if (app.joinLimiter.check(ip) === 'limited') {
          return ack({ ok: false, code: 'RATE_LIMITED' } satisfies PlayerJoinResult);
        }
        if (!rateOk(socket.id, 'join')) {
          return ack({ ok: false, code: 'RATE_LIMITED' } satisfies PlayerJoinResult);
        }
        const parsed = PlayerJoinRequestSchema.safeParse(payload);
        if (!parsed.success) {
          return ack({ ok: false, code: 'NICKNAME_INVALID' } satisfies PlayerJoinResult);
        }
        if (!/^\d{6}$/.test(parsed.data.pin)) {
          app.joinLimiter.recordFailure(ip);
          return ack({ ok: false, code: 'NOT_FOUND' } satisfies PlayerJoinResult);
        }
        const nn = normalizeNickname(parsed.data.nickname);
        if (!nn.ok) {
          return ack({ ok: false, code: 'NICKNAME_INVALID' } satisfies PlayerJoinResult);
        }
        const session = await app.prisma.gameSession.findUnique({
          where: { activePin: parsed.data.pin },
        });
        if (!session) {
          app.joinLimiter.recordFailure(ip);
          return ack({ ok: false, code: 'NOT_FOUND' } satisfies PlayerJoinResult);
        }
        if (session.state === 'FINISHED' || session.state === 'CANCELLED') {
          return ack({ ok: false, code: 'ENDED' } satisfies PlayerJoinResult);
        }
        const room = await rooms.getOrLoad(session.id);
        const result = await room.join(nn);
        if (!result.ok) return ack(result satisfies PlayerJoinResult);

        // One socket = one participant: shed a previous join first.
        const prev = socket.data as SocketData;
        if (prev.participantId && prev.sessionId) {
          socket.leave(`p:${prev.participantId}`);
          socket.leave(`s:${prev.sessionId}:players`);
          rooms.get(prev.sessionId)?.detachSocket(prev.participantId, socket.id);
        }

        app.joinLimiter.recordSuccess(ip);
        socket.data = {
          role: 'player',
          sessionId: session.id,
          participantId: result.participantId,
        } satisfies SocketData;
        await socket.join(`s:${session.id}:players`);
        await socket.join(`p:${result.participantId}`);
        room.attachSocket(result.participantId, socket.id);
        app.prisma.participant
          .update({
            where: { id: result.participantId },
            data: { lastSeenAt: new Date() },
          })
          .catch((e) => recordError(e, 'socket'));
        ack({
          ok: true,
          participantId: result.participantId,
          resumeToken: result.resumeToken,
          sessionId: session.id,
          snapshot: room.buildSnapshot('player', result.participantId),
        } satisfies PlayerJoinResult);
      } catch (e) {
        recordError(e, 'socket');
        if (isAck(ack)) ack({ ok: false, code: 'ENDED' } satisfies PlayerJoinResult);
      }
    });

    socket.on('player:answer', async (payload: unknown, ack: unknown) => {
      try {
        if (!isAck(ack)) return;
        if (!rateOk(socket.id, 'answer')) {
          return ack({
            status: 'rejected',
            reason: 'RATE_LIMITED',
          } satisfies PlayerAnswerResult);
        }
        const parsed = PlayerAnswerRequestSchema.safeParse(payload);
        if (!parsed.success) {
          return ack({ status: 'rejected', reason: 'INVALID' } satisfies PlayerAnswerResult);
        }
        const d = socket.data as SocketData;
        if (d.role !== 'player' || !d.sessionId || !d.participantId) {
          return ack({
            status: 'rejected',
            reason: 'UNAUTHORIZED',
          } satisfies PlayerAnswerResult);
        }
        const room = rooms.get(d.sessionId) ?? (await rooms.getOrLoad(d.sessionId));
        const receivedAt = new Date();
        const result = await room.submit(d.participantId, parsed.data, receivedAt);
        ack(result);
      } catch (e) {
        recordError(e, 'socket');
        if (isAck(ack)) {
          ack({ status: 'rejected', reason: 'INVALID' } satisfies PlayerAnswerResult);
        }
      }
    });

    socket.on('host:command', async (payload: unknown, ack: unknown) => {
      try {
        if (!isAck(ack)) return;
        const d = socket.data as SocketData;
        if (d.role !== 'host' || !d.sessionId) {
          return ack({ ok: false, code: 'UNAUTHORIZED' } satisfies HostCommandResult);
        }
        const parsed = HostCommandRequestSchema.safeParse(payload);
        if (!parsed.success) {
          return ack({ ok: false, code: 'INVALID' } satisfies HostCommandResult);
        }
        const room = await rooms.getOrLoad(d.sessionId);
        ack(await room.handleCommand(parsed.data));
      } catch (e) {
        recordError(e, 'socket');
        if (isAck(ack)) ack({ ok: false, code: 'INVALID' } satisfies HostCommandResult);
      }
    });

    socket.on('state:sync', async (_payload: unknown, ack: unknown) => {
      try {
        if (!isAck(ack)) return;
        const d = socket.data as SocketData;
        if (!d.sessionId) {
          return ack({ ok: false, code: 'UNAUTHORIZED' } satisfies StateSyncResult);
        }
        const room = await rooms.getOrLoad(d.sessionId);
        ack({
          ok: true,
          snapshot: room.buildSnapshot(d.role, d.participantId),
        } satisfies StateSyncResult);
      } catch (e) {
        recordError(e, 'socket');
        if (isAck(ack)) ack({ ok: false, code: 'INVALID' } satisfies StateSyncResult);
      }
    });

    socket.on('disconnect', () => {
      buckets.delete(socket.id);
      const d = socket.data as SocketData;
      if (d.participantId && d.sessionId) {
        rooms.get(d.sessionId)?.detachSocket(d.participantId, socket.id);
      }
    });
  });

  // preClose (not onClose): socket.io's long-polls would otherwise keep the
  // HTTP server busy forever and block the close.
  app.addHook('preClose', async () => {
    rooms.dispose();
    io.disconnectSockets(true);
    io.engine.close();
  });
}
