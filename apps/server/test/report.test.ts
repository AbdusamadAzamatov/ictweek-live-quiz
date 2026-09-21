import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HostCommandResult, PlayerAnswerResult } from '@ictquiz/shared';
import { createOrganizer } from './helpers.js';
import {
  createPlayableQuiz,
  createSession,
  emitAck,
  hostClient,
  joinPlayer,
  liveApp,
  loginAs,
  waitForState,
  type TrackedSocket,
} from './live-helpers.js';
import { prisma } from './setup.js';

const apps: FastifyInstance[] = [];
const sockets: TrackedSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.socket.close();
  for (const app of apps.splice(0)) await app.close();
});

function track<T extends TrackedSocket>(t: T): T {
  sockets.push(t);
  return t;
}

const cmd = (t: TrackedSocket, id: string, type: string) =>
  emitAck<HostCommandResult>(t.socket, 'host:command', { commandId: id, type });
const answer = (t: TrackedSocket, attemptId: string, sid: string, optionIds: string[]) =>
  emitAck<PlayerAnswerResult>(t.socket, 'player:answer', {
    attemptId,
    submissionId: sid,
    optionIds,
  });

type Report = {
  session: { id: string; pin: string; participantCount: number; questionCount: number };
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
    eligible: number;
    answered: number;
    correctCount: number;
    accuracyPct: number;
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
  }>;
};

describe('session report', () => {
  it('computes standings/questions/responses from durable rows and serves a safe CSV', async () => {
    const { app, url } = await liveApp({ countdownMs: 100 });
    apps.push(app);
    const org = await createOrganizer(`r-${randomUUID()}@example.com`, 'Password123!');
    const sid = await loginAs(app, org.email, 'Password123!');
    const quizId = await createPlayableQuiz(app, sid);
    const session = await createSession(app, sid, quizId);

    const host = track(await hostClient(url, sid, session.id));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    const p2 = track(await joinPlayer(url, session.pin, 'P2'));
    // Spreadsheet-hostile nickname must survive into the CSV escaped.
    const p3 = track(await joinPlayer(url, session.pin, '=HYPERLINK("x")'));

    await cmd(host, 'c1', 'START');
    const open1 = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att1 = open1.question!.attemptId;
    const opts1 = open1.question!.options;
    await answer(p1, att1, 'r-p1-q1', [opts1[0]!.id]); // correct
    await answer(p2, att1, 'r-p2-q1', [opts1[1]!.id]); // wrong
    // P3 never answers.
    await cmd(host, 'c2', 'CLOSE_ANSWERS');
    await waitForState(host.snaps, 'ANSWER_REVEAL');
    await cmd(host, 'c3', 'NEXT'); // → LEADERBOARD
    await waitForState(host.snaps, 'LEADERBOARD');
    await cmd(host, 'c4', 'NEXT'); // → COUNTDOWN → QUESTION_OPEN
    const open2 = await waitForState(host.snaps, 'QUESTION_OPEN', host.snaps.length - 1);
    const att2 = open2.question!.attemptId;
    const opts2 = open2.question!.options;
    await answer(p1, att2, 'r-p1-q2', [opts2[0]!.id, opts2[1]!.id]); // both correct (DOUBLE → 2000)
    await answer(p2, att2, 'r-p2-q2', [opts2[0]!.id]); // one correct (partial 1000, not correct)
    await cmd(host, 'c5', 'CLOSE_ANSWERS');
    await waitForState(host.snaps, 'ANSWER_REVEAL', host.snaps.length - 1);
    await cmd(host, 'c6', 'NEXT'); // → FINISHED
    const fin = await waitForState(host.snaps, 'FINISHED');
    const podium = fin.leaderboard!.map((l) => l.nickname);

    // A VOIDED attempt + submission must not affect the report at all.
    const voided = await prisma.questionAttempt.create({
      data: {
        sessionId: session.id,
        questionIndex: 0,
        attemptNo: 99,
        openedAt: new Date(Date.now() - 60_000),
        deadlineAt: new Date(Date.now() - 50_000),
        status: 'VOIDED',
      },
    });
    await prisma.submission.create({
      data: {
        attemptId: voided.id,
        participantId: p3.participantId,
        submissionId: 'voided-sub',
        optionIds: [opts1[0]!.id],
        receivedAt: new Date(Date.now() - 55_000),
        responseTimeMs: 1,
        isCorrect: true,
        points: 9999,
      },
    });

    // --- JSON report ---------------------------------------------------------
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/report`,
      headers: { cookie: `sid=${sid}` },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json() as Report;

    expect(report.session.id).toBe(session.id);
    expect(report.session.pin).toBe(session.pin);
    expect(report.session.participantCount).toBe(3);
    expect(report.session.questionCount).toBe(2);

    // Standings order equals the FINISHED leaderboard.
    expect(report.standings.map((s) => s.nickname)).toEqual(podium);
    // score == sum(points) on non-voided submissions, per participant.
    for (const s of report.standings) {
      const agg = await prisma.submission.aggregate({
        _sum: { points: true },
        where: { participantId: s.participantId, attempt: { status: { not: 'VOIDED' } } },
      });
      expect(s.score, s.nickname).toBe(agg._sum.points ?? 0);
    }
    const p3row = report.standings.find((s) => s.participantId === p3.participantId)!;
    expect(p3row.score).toBe(0);
    expect(p3row.answeredCount).toBe(0);
    expect(p3row.avgResponseMs).toBe(0);

    // Question 0: 2 of 3 eligible answered; distribution sums to answered.
    const q0 = report.questions.find((q) => q.index === 0)!;
    expect(q0.answered).toBe(2);
    expect(q0.eligible).toBe(3);
    expect(q0.distribution.reduce((n, d) => n + d.count, 0)).toBe(2);
    expect(q0.accuracyPct).toBe(33); // 1 correct of 3 eligible
    // The voided attempt is not the reported attemptId and its sub is absent.
    expect(q0.attemptId).not.toBe(voided.id);
    expect(report.responses.every((r) => r.optionIds[0] !== 'voided-sub')).toBe(true);
    expect(report.responses).toHaveLength(4); // 2 per question
    expect(
      report.responses.find((r) => r.participantId === p1.participantId && r.questionIndex === 0)
        ?.optionLabels,
    ).toEqual(['A']);

    // --- CSV -----------------------------------------------------------------
    const csv = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/report.csv`,
      headers: { cookie: `sid=${sid}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain(
      `filename="quiz-report-${session.pin}-`,
    );
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.body).toContain('\r\n');

    // --- foreign organizer ----------------------------------------------------
    const orgB = await createOrganizer(`rb-${randomUUID()}@example.com`, 'Password123!');
    const sidB = await loginAs(app, orgB.email, 'Password123!');
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/report`,
      headers: { cookie: `sid=${sidB}` },
    });
    expect(foreign.statusCode).toBe(404);
    const foreignCsv = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/report.csv`,
      headers: { cookie: `sid=${sidB}` },
    });
    expect(foreignCsv.statusCode).toBe(404);
  });

  it('voids the open attempt when the host ends mid-question', async () => {
    const { app, url } = await liveApp({ countdownMs: 100 });
    apps.push(app);
    const org = await createOrganizer(`r-${randomUUID()}@example.com`, 'Password123!');
    const sid = await loginAs(app, org.email, 'Password123!');
    const quizId = await createPlayableQuiz(app, sid);
    const session = await createSession(app, sid, quizId);

    const host = track(await hostClient(url, sid, session.id));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    track(await joinPlayer(url, session.pin, 'P2'));

    await cmd(host, 'c1', 'START');
    const open1 = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att1 = open1.question!.attemptId;
    await answer(p1, att1, 'end-p1-q1', [open1.question!.options[0]!.id]);
    const endAck = await cmd(host, 'c2', 'END');
    expect(endAck.ok).toBe(true);
    await waitForState(host.snaps, 'FINISHED');

    const attempt = await prisma.questionAttempt.findUniqueOrThrow({ where: { id: att1 } });
    expect(attempt.status).toBe('VOIDED');
    expect(attempt.closedAt).not.toBeNull();

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/report`,
      headers: { cookie: `sid=${sid}` },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json() as Report;
    expect(report.questions).toHaveLength(0);
    expect(report.responses).toHaveLength(0);
    for (const s of report.standings) {
      expect(s.score, s.nickname).toBe(0);
      const agg = await prisma.submission.aggregate({
        _sum: { points: true },
        where: { participantId: s.participantId, attempt: { status: { not: 'VOIDED' } } },
      });
      expect(s.score).toBe(agg._sum.points ?? 0);
    }
  });
});
