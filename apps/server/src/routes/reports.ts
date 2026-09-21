import type { FastifyInstance } from 'fastify';
import {
  rankParticipants,
  serializeCsv,
  type QuizSnapshot,
} from '@ictquiz/shared';
import { requireOrganizer } from '../plugins/auth.js';

const LETTERS = 'ABCDEF';

type ReportData = {
  session: {
    id: string;
    pin: string;
    title: string;
    state: string;
    createdAt: Date;
    startedAt: Date | null;
    endedAt: Date | null;
    participantCount: number;
    questionCount: number;
    /** SINGLE/TRUE_FALSE/MULTI slides — polls and content slides excluded. */
    scoredQuestionCount: number;
  };
  standings: Array<{
    rank: number;
    participantId: string;
    nickname: string;
    score: number;
    correctCount: number;
    answeredCount: number;
    totalResponseMs: number;
    avgResponseMs: number;
  }>;
  questions: Array<{
    index: number;
    attemptId: string;
    type: string;
    text: string;
    options: Array<{ id: string; index: number; text: string; isCorrect: boolean }>;
    correctOptionIds: string[];
    eligible: number;
    answered: number;
    /** null for POLL — there is no correct answer. */
    correctCount: number | null;
    /** null for POLL — there is no correct answer. */
    accuracyPct: number | null;
    avgResponseMs: number;
    distribution: Array<{ optionId: string; count: number }>;
  }>;
  responses: Array<{
    participantId: string;
    nickname: string;
    questionIndex: number;
    optionIds: string[];
    optionLabels: string[];
    isCorrect: boolean;
    points: number;
    responseTimeMs: number;
    receivedAt: Date;
  }>;
};

/**
 * The report is computed from durable rows only — ACTIVE participants and
 * non-VOIDED attempts (latest attemptNo per questionIndex).
 */
async function buildReport(
  app: FastifyInstance,
  sessionId: string,
  organizerId: string,
): Promise<ReportData | null> {
  const session = await app.prisma.gameSession.findFirst({
    where: { id: sessionId, organizerId },
    include: { quiz: { select: { title: true } } },
  });
  if (!session) return null;
  const snapshot = session.quizSnapshot as QuizSnapshot;

  const [participants, attempts] = await Promise.all([
    app.prisma.participant.findMany({ where: { sessionId, status: 'ACTIVE' } }),
    app.prisma.questionAttempt.findMany({
      where: { sessionId, status: { not: 'VOIDED' } },
      orderBy: { attemptNo: 'desc' },
      include: { submissions: true },
    }),
  ]);

  // Latest non-voided attempt per questionIndex.
  const byQuestion = new Map<number, (typeof attempts)[number]>();
  for (const a of attempts) {
    if (!byQuestion.has(a.questionIndex)) byQuestion.set(a.questionIndex, a);
  }
  const usedAttempts = [...byQuestion.values()].sort(
    (a, b) => a.questionIndex - b.questionIndex,
  );

  const nickById = new Map(participants.map((p) => [p.id, p.nickname]));
  const subsByParticipant = new Map<string, typeof attempts[number]['submissions']>();
  for (const a of usedAttempts) {
    for (const s of a.submissions) {
      const list = subsByParticipant.get(s.participantId) ?? [];
      list.push(s);
      subsByParticipant.set(s.participantId, list);
    }
  }

  const ranked = rankParticipants(
    participants.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score,
      correctCount: p.correctCount,
      totalResponseMs: p.totalResponseMs,
      joinedAt: p.joinedAt,
    })),
  );

  const standings = ranked.map((p) => {
    const subs = subsByParticipant.get(p.id) ?? [];
    const responseMs = subs.reduce((n, s) => n + s.responseTimeMs, 0);
    return {
      rank: p.rank,
      participantId: p.id,
      nickname: p.nickname,
      score: p.score,
      correctCount: p.correctCount,
      answeredCount: subs.length,
      totalResponseMs: p.totalResponseMs,
      avgResponseMs: subs.length ? Math.round(responseMs / subs.length) : 0,
    };
  });

  const questions = usedAttempts
    // Content slides never produce attempts, but guard anyway — they are
    // presentation, not questions.
    .filter((a) => snapshot.questions[a.questionIndex]?.type !== 'CONTENT')
    .map((a) => {
      const q = snapshot.questions[a.questionIndex];
      const isPoll = q?.type === 'POLL';
      const eligible = participants.filter((p) => p.joinedAt < a.openedAt).length;
      const subs = a.submissions;
      const correctCount = subs.filter((s) => s.isCorrect).length;
      const responseMs = subs.reduce((n, s) => n + s.responseTimeMs, 0);
      const options = (q?.options ?? []).map((o) => ({
        id: o.id,
        index: o.index,
        text: o.text,
        isCorrect: o.isCorrect,
      }));
      const correctOptionIds = options.filter((o) => o.isCorrect).map((o) => o.id);
      return {
        index: a.questionIndex,
        attemptId: a.id,
        type: q?.type ?? 'SINGLE',
        text: q?.text ?? '',
        options,
        correctOptionIds,
        eligible,
        answered: subs.length,
        correctCount: isPoll ? null : correctCount,
        accuracyPct: isPoll ? null : eligible ? Math.round((100 * correctCount) / eligible) : 0,
        avgResponseMs: subs.length ? Math.round(responseMs / subs.length) : 0,
        distribution: options.map((o) => ({
          optionId: o.id,
          count: subs.filter((s) => s.optionIds.includes(o.id)).length,
        })),
      };
    });

  const letterByOptionId = new Map<string, string>();
  for (const q of snapshot.questions) {
    for (const o of q.options) letterByOptionId.set(o.id, LETTERS[o.index] ?? '?');
  }
  const responses = usedAttempts.flatMap((a) =>
    a.submissions.map((s) => ({
      participantId: s.participantId,
      nickname: nickById.get(s.participantId) ?? '(removed)',
      questionIndex: a.questionIndex,
      optionIds: s.optionIds,
      optionLabels: s.optionIds.map((id) => letterByOptionId.get(id) ?? '?'),
      isCorrect: s.isCorrect,
      points: s.points,
      responseTimeMs: s.responseTimeMs,
      receivedAt: s.receivedAt,
    })),
  );

  return {
    session: {
      id: session.id,
      pin: session.pin,
      title: snapshot.title || session.quiz?.title || '',
      state: session.state,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      participantCount: participants.length,
      questionCount: snapshot.questions.length,
      scoredQuestionCount: snapshot.questions.filter(
        (q) => q.type === 'SINGLE' || q.type === 'TRUE_FALSE' || q.type === 'MULTI',
      ).length,
    },
    standings,
    questions,
    responses,
  };
}

export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOrganizer);

  app.get('/sessions/:id/report', async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = await buildReport(app, id, req.organizerId!);
    if (!report) return reply.code(404).send({ error: 'Session not found' });
    return report;
  });

  app.get('/sessions/:id/report.csv', async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = await buildReport(app, id, req.organizerId!);
    if (!report) return reply.code(404).send({ error: 'Session not found' });

    const questionText = new Map(report.questions.map((q) => [q.index, q.text]));
    const pollIndexes = new Set(
      report.questions.filter((q) => q.type === 'POLL').map((q) => q.index),
    );
    const rows: Array<Array<string | number>> = [
      ['Standings'],
      ['Rank', 'Nickname', 'Score', 'Correct', 'Answered', 'Avg response ms'],
      ...report.standings.map((s) => [
        s.rank,
        s.nickname,
        s.score,
        s.correctCount,
        s.answeredCount,
        s.avgResponseMs,
      ]),
      [''],
      ['Responses'],
      [
        'Nickname',
        'Question #',
        'Question',
        'Answer(s)',
        'Correct',
        'Points',
        'Response ms',
        'Received at',
      ],
      ...report.responses.map((r) => [
        r.nickname,
        r.questionIndex + 1,
        questionText.get(r.questionIndex) ?? '',
        r.optionLabels.join('; '),
        pollIndexes.has(r.questionIndex) ? 'n/a' : r.isCorrect ? 'yes' : 'no',
        r.points,
        r.responseTimeMs,
        r.receivedAt.toISOString(),
      ]),
    ];

    const d = report.session.createdAt;
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="quiz-report-${report.session.pin}-${stamp}.csv"`,
      )
      // Leading U+FEFF so Excel detects UTF-8.
      .send(String.fromCharCode(0xFEFF) + serializeCsv(rows));
  });
}
