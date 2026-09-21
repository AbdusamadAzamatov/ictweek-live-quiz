import type { FastifyInstance } from 'fastify';
import type { QuizSnapshot } from '@ictquiz/shared';
import { requireOrganizer } from '../plugins/auth.js';
import { recentErrors } from '../lib/errors.js';

async function dbPing(app: FastifyInstance): Promise<{ ok: boolean; latencyMs: number }> {
  const start = performance.now();
  try {
    await app.prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - start) };
  }
}

export async function publicRoutes(app: FastifyInstance) {
  app.get('/join/:pin', async (req, reply) => {
    const ip = req.ip;
    if (app.joinLimiter.check(ip) === 'limited') {
      return reply
        .code(429)
        .send({ error: 'Too many attempts — wait a minute and try again' });
    }
    const { pin } = req.params as { pin: string };
    if (!/^\d{6}$/.test(pin)) {
      app.joinLimiter.recordFailure(ip);
      return reply.code(404).send({ error: 'Not found' });
    }
    const session = await app.prisma.gameSession.findUnique({ where: { activePin: pin } });
    if (!session) {
      app.joinLimiter.recordFailure(ip);
      return reply.code(404).send({ error: 'Not found' });
    }
    app.joinLimiter.recordSuccess(ip);
    return {
      sessionId: session.id,
      title: (session.quizSnapshot as QuizSnapshot | null)?.title ?? '',
      locked: session.locked,
      state: session.state,
    };
  });

  app.get('/health', async (req, reply) => {
    const db = await dbPing(app);
    if (!db.ok) return reply.code(503).send({ ok: false, db });
    return { ok: true, db };
  });

  app.get('/diagnostics', { preHandler: requireOrganizer }, async () => {
    const byRole: Record<string, number> = {};
    let total = 0;
    for (const socket of app.io.of('/').sockets.values()) {
      total += 1;
      const role = (socket.data as { role?: string }).role ?? 'unknown';
      byRole[role] = (byRole[role] ?? 0) + 1;
    }
    return {
      uptimeSec: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      db: await dbPing(app),
      sockets: { total, byRole },
      rooms: app.rooms.diagnostics(),
      joinLimiter: app.joinLimiter.stats(),
      recentErrors: recentErrors(),
    };
  });
}
