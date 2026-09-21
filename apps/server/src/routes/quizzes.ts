import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { QuizDraftSchema, validateQuizForPlay, type QuizDraft } from '@ictquiz/shared';
import { parse } from '../lib/validate.js';
import { requireOrganizer } from '../plugins/auth.js';
import type { Db } from '../lib/db.js';
import type { AnswerOptionModel, QuestionModel, QuizModel } from '../generated/prisma/models.js';

type QuizWithQuestions = QuizModel & {
  questions: Array<QuestionModel & { options: AnswerOptionModel[] }>;
};

const quizInclude = {
  questions: { include: { options: true }, orderBy: { order: 'asc' } },
} as const;

export function quizDto(q: QuizWithQuestions) {
  return {
    id: q.id,
    title: q.title,
    description: q.description,
    coverMediaId: q.coverMediaId,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    questions: [...q.questions]
      .sort((a, b) => a.order - b.order)
      .map((qq) => ({
        id: qq.id,
        order: qq.order,
        type: qq.type,
        text: qq.text,
        mediaId: qq.mediaId,
        timeLimitSec: qq.timeLimitSec,
        pointsMode: qq.pointsMode,
        explanation: qq.explanation,
        options: [...qq.options]
          .sort((a, b) => a.order - b.order)
          .map((o) => ({
            id: o.id,
            order: o.order,
            text: o.text,
            mediaId: o.mediaId,
            isCorrect: o.isCorrect,
          })),
      })),
  };
}

/** Fields written from a draft into create/update calls (ids are regenerated). */
function questionCreates(draft: QuizDraft) {
  return draft.questions.map((q, i) => ({
    order: i,
    type: q.type,
    text: q.text,
    mediaId: q.mediaId ?? null,
    timeLimitSec: q.timeLimitSec,
    pointsMode: q.pointsMode,
    explanation: q.explanation,
    options: {
      create: q.options.map((o, oi) => ({
        order: oi,
        text: o.text,
        mediaId: o.mediaId ?? null,
        isCorrect: o.isCorrect,
      })),
    },
  }));
}

async function findOwnedQuiz(db: Db, id: string, organizerId: string) {
  return db.quiz.findFirst({ where: { id, organizerId }, include: quizInclude });
}

const ImportSchema = z.object({
  format: z.literal('ictquiz-v1'),
  quiz: QuizDraftSchema,
});

export async function quizRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrganizer);

  app.get('/quizzes', async (req) => {
    const quizzes = await app.prisma.quiz.findMany({
      where: { organizerId: req.organizerId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { questions: true } } },
    });
    return {
      quizzes: quizzes.map((q) => ({
        id: q.id,
        title: q.title,
        description: q.description,
        questionCount: q._count.questions,
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
      })),
    };
  });

  app.post('/quizzes', async (req, reply) => {
    const quiz = await app.prisma.quiz.create({
      data: { organizerId: req.organizerId!, title: 'Untitled quiz' },
      include: quizInclude,
    });
    return reply.code(201).send({ quiz: quizDto(quiz) });
  });

  app.get('/quizzes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const quiz = await findOwnedQuiz(app.prisma, id, req.organizerId!);
    if (!quiz) return reply.code(404).send({ error: 'Quiz not found' });
    return { quiz: quizDto(quiz) };
  });

  app.put('/quizzes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const draft = parse(QuizDraftSchema, req.body);
    const existing = await app.prisma.quiz.findFirst({
      where: { id, organizerId: req.organizerId },
    });
    if (!existing) return reply.code(404).send({ error: 'Quiz not found' });

    await app.prisma.$transaction(async (tx) => {
      await tx.question.deleteMany({ where: { quizId: id } });
      await tx.quiz.update({
        where: { id },
        data: {
          title: draft.title,
          description: draft.description,
          coverMediaId: draft.coverMediaId ?? null,
          questions: { create: questionCreates(draft) },
        },
      });
    });

    const saved = await app.prisma.quiz.findUniqueOrThrow({
      where: { id },
      include: quizInclude,
    });
    const dto = quizDto(saved);
    return { quiz: dto, playIssues: validateQuizForPlay(dto) };
  });

  app.delete('/quizzes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { count } = await app.prisma.quiz.deleteMany({
      where: { id, organizerId: req.organizerId },
    });
    if (count === 0) return reply.code(404).send({ error: 'Quiz not found' });
    return reply.code(204).send();
  });

  app.post('/quizzes/:id/duplicate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const src = await findOwnedQuiz(app.prisma, id, req.organizerId!);
    if (!src) return reply.code(404).send({ error: 'Quiz not found' });
    const copy = await app.prisma.quiz.create({
      data: {
        organizerId: req.organizerId!,
        title: `${src.title} (copy)`,
        description: src.description,
        coverMediaId: src.coverMediaId,
        questions: { create: questionCreates(quizDto(src) as QuizDraft) },
      },
      include: quizInclude,
    });
    return reply.code(201).send({ quiz: quizDto(copy) });
  });

  app.get('/quizzes/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const quiz = await findOwnedQuiz(app.prisma, id, req.organizerId!);
    if (!quiz) return reply.code(404).send({ error: 'Quiz not found' });
    const dto = quizDto(quiz);
    reply.header('content-disposition', `attachment; filename="ictquiz-${quiz.id}.json"`);
    return {
      format: 'ictquiz-v1',
      quiz: {
        title: dto.title,
        description: dto.description,
        coverMediaId: dto.coverMediaId,
        questions: dto.questions.map((q) => ({
          type: q.type,
          text: q.text,
          mediaId: q.mediaId,
          timeLimitSec: q.timeLimitSec,
          pointsMode: q.pointsMode,
          explanation: q.explanation,
          options: q.options.map((o) => ({
            text: o.text,
            mediaId: o.mediaId,
            isCorrect: o.isCorrect,
          })),
        })),
      },
    };
  });

  app.post('/quizzes/import', async (req, reply) => {
    const body = parse(ImportSchema, req.body);
    const quiz = await app.prisma.quiz.create({
      data: {
        organizerId: req.organizerId!,
        title: body.quiz.title || 'Imported quiz',
        description: body.quiz.description,
        coverMediaId: body.quiz.coverMediaId ?? null,
        questions: { create: questionCreates(body.quiz) },
      },
      include: quizInclude,
    });
    return reply.code(201).send({ quiz: quizDto(quiz) });
  });
}
