import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SessionSettingsSchema,
  buildQuizSnapshot,
  validateQuizForPlay,
  type QuizSnapshot,
  type SessionSettings,
} from '@ictquiz/shared';
import { parse } from '../lib/validate.js';
import { requireOrganizer } from '../plugins/auth.js';
import { quizDto } from './quizzes.js';

const CreateSessionSchema = z.object({
  quizId: z.string().min(1),
  settings: SessionSettingsSchema,
});

const quizInclude = {
  questions: { include: { options: true }, orderBy: { order: 'asc' } },
} as const;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

function sessionSummary(s: {
  id: string;
  pin: string;
  state: string;
  locked: boolean;
  createdAt: Date;
  quizSnapshot: unknown;
  quiz: { title: string } | null;
  _count?: { participants: number };
}) {
  return {
    id: s.id,
    pin: s.pin,
    state: s.state,
    locked: s.locked,
    createdAt: s.createdAt,
    participantCount: s._count?.participants ?? 0,
    title: (s.quizSnapshot as QuizSnapshot | null)?.title ?? s.quiz?.title ?? '',
  };
}

export async function sessionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrganizer);

  app.post('/sessions', async (req, reply) => {
    const body = parse(CreateSessionSchema, req.body);
    const quiz = await app.prisma.quiz.findFirst({
      where: { id: body.quizId, organizerId: req.organizerId },
      include: quizInclude,
    });
    if (!quiz) return reply.code(404).send({ error: 'Quiz not found' });

    const dto = quizDto(quiz);
    const playIssues = validateQuizForPlay(dto);
    if (playIssues.length > 0) {
      return reply.code(400).send({ error: 'Quiz is not playable', playIssues });
    }

    const settings: SessionSettings = body.settings;
    const snapshot = buildQuizSnapshot(quiz, settings);
    const displayKey = randomBytes(16).toString('base64url');

    for (let attempt = 0; ; attempt++) {
      const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        const session = await app.prisma.gameSession.create({
          data: {
            organizerId: req.organizerId!,
            quizId: quiz.id,
            pin,
            activePin: pin,
            displayKey,
            quizSnapshot: JSON.parse(JSON.stringify(snapshot)),
            settings: JSON.parse(JSON.stringify(settings)),
            state: 'LOBBY',
          },
        });
        return reply.code(201).send({ id: session.id, pin, displayKey });
      } catch (e) {
        if (isUniqueViolation(e) && attempt < 9) continue;
        throw e;
      }
    }
  });

  app.get('/sessions', async (req) => {
    const sessions = await app.prisma.gameSession.findMany({
      where: { organizerId: req.organizerId },
      orderBy: { createdAt: 'desc' },
      include: { quiz: { select: { title: true } }, _count: { select: { participants: true } } },
    });
    return { sessions: sessions.map(sessionSummary) };
  });

  app.get('/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await app.prisma.gameSession.findFirst({
      where: { id, organizerId: req.organizerId },
      include: { quiz: { select: { title: true } }, _count: { select: { participants: true } } },
    });
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return {
      session: {
        ...sessionSummary(session),
        displayKey: session.displayKey,
        quizId: session.quizId,
        revision: session.revision,
        questionIndex: session.questionIndex,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        settings: session.settings,
        quizSnapshot: session.quizSnapshot,
      },
    };
  });
}
