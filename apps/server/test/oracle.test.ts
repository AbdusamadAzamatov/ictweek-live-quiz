import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  HostCommandResult,
  PlayerAnswerResult,
} from '@ictquiz/shared';
import { createOrganizer } from './helpers.js';
import {
  connectClient,
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
  for (const app of apps.splice(0)) {
    try {
      await app.close();
    } catch {
      // already closed mid-test (restart case)
    }
  }
});

function track<T extends TrackedSocket>(t: T): T {
  sockets.push(t);
  return t;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(countdownMs = 200) {
  const { app, url } = await liveApp({ countdownMs });
  apps.push(app);
  const org = await createOrganizer(`org-${randomUUID()}@example.com`, 'Password123!');
  const sid = await loginAs(app, org.email, 'Password123!');
  const quizId = await createPlayableQuiz(app, sid);
  const session = await createSession(app, sid, quizId);
  return { app, url, org, sid, quizId, session };
}

function hostCmd(t: TrackedSocket, id: string, type: string) {
  return emitAck<HostCommandResult>(t.socket, 'host:command', { commandId: id, type });
}

function answer(t: TrackedSocket, attemptId: string, submissionId: string, optionIds: string[]) {
  return emitAck<PlayerAnswerResult>(t.socket, 'player:answer', {
    attemptId,
    submissionId,
    optionIds,
  });
}

// ---------------------------------------------------------------------------
// Independent scoring oracle — written inline here, NOT imported from
// scoring.ts, so the test recomputes expected points from the durable rows.
// ---------------------------------------------------------------------------

type OracleQuestion = {
  type: string;
  pointsMode: string;
  timeLimitSec: number;
  options: Array<{ id: string; isCorrect: boolean }>;
};

function oracleScore(
  q: OracleQuestion,
  optionIds: string[],
  rtMs: number,
): { isCorrect: boolean; points: number } {
  const limit = q.timeLimitSec * 1000;
  const factor = rtMs < 500 ? 1 : 1 - Math.min(rtMs, limit) / limit / 2;
  const max = q.pointsMode === 'DOUBLE' ? 2000 : q.pointsMode === 'STANDARD' ? 1000 : 0;
  const perCorrect =
    q.pointsMode === 'DOUBLE' ? 1000 : q.pointsMode === 'STANDARD' ? 500 : 0;
  const byId = new Map(q.options.map((o) => [o.id, o.isCorrect]));
  const selected = [...new Set(optionIds)];

  if (q.type === 'MULTI') {
    if (selected.some((id) => !byId.get(id))) return { isCorrect: false, points: 0 };
    const correctTotal = q.options.filter((o) => o.isCorrect).length;
    const isCorrect = selected.length === correctTotal;
    return {
      isCorrect,
      points: Math.round(selected.length * perCorrect * factor),
    };
  }
  const isCorrect = optionIds.length === 1 && byId.get(optionIds[0]!) === true;
  return { isCorrect, points: isCorrect ? Math.round(max * factor) : 0 };
}

/** Recompute every submission's expected score straight from the DB + snapshot. */
async function assertOracle(sessionId: string) {
  const session = await prisma.gameSession.findUniqueOrThrow({
    where: { id: sessionId },
  });
  const snapshot = session.quizSnapshot as { questions: OracleQuestion[] };
  const subs = await prisma.submission.findMany({
    where: { attempt: { sessionId, status: { not: 'VOIDED' } } },
    include: { attempt: true },
  });
  const sumBy = new Map<string, number>();
  for (const s of subs) {
    const q = snapshot.questions[s.attempt.questionIndex]!;
    const expected = oracleScore(q, s.optionIds, s.responseTimeMs);
    expect(s.points, `points for ${s.submissionId}`).toBe(expected.points);
    expect(s.isCorrect, `isCorrect for ${s.submissionId}`).toBe(expected.isCorrect);
    sumBy.set(s.participantId, (sumBy.get(s.participantId) ?? 0) + s.points);
  }
  const participants = await prisma.participant.findMany({ where: { sessionId } });
  for (const p of participants) {
    expect(p.score, `score for ${p.nickname}`).toBe(sumBy.get(p.id) ?? 0);
  }
  return { subs, participants };
}

describe('scoring oracle', () => {
  it('recomputes every submission independently, including the decay path', async () => {
    const { url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    const p2 = track(await joinPlayer(url, session.pin, 'P2'));
    track(await joinPlayer(url, session.pin, 'P3'));

    await hostCmd(host, 'c-s', 'START');
    const open1 = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att1 = open1.question!.attemptId;
    const opts1 = open1.question!.options;

    // P1 answers late (decay path), P2 fast but wrong, P3 silent.
    await answer(p2, att1, 'p2-q1', [opts1[1]!.id]);
    await sleep(1500);
    const p1Ack = await answer(p1, att1, 'p1-q1', [opts1[0]!.id]);
    expect(p1Ack.status).toBe('accepted');

    await waitForState(host.snaps, 'ANSWER_REVEAL');

    // Retry after the reveal: identical ack, still one row.
    const retry = await answer(p1, att1, 'p1-q1', [opts1[0]!.id]);
    expect(retry).toEqual(p1Ack);
    expect(
      await prisma.submission.count({
        where: { attemptId: att1, participantId: p1.participantId },
      }),
    ).toBe(1);

    await hostCmd(host, 'c-lb', 'NEXT');
    await waitForState(host.snaps, 'LEADERBOARD');
    await hostCmd(host, 'c-n', 'NEXT');
    const from = host.snaps.length;
    const open2 = await waitForState(host.snaps, 'QUESTION_OPEN', from);
    const att2 = open2.question!.attemptId;
    const opts2 = open2.question!.options;

    // P1 fast with both correct; P2 delayed with only one correct option.
    await answer(p1, att2, 'p1-q2', [opts2[0]!.id, opts2[1]!.id]);
    await sleep(1000);
    const p2Ack = await answer(p2, att2, 'p2-q2', [opts2[0]!.id]);
    expect(p2Ack.status).toBe('accepted');
    await hostCmd(host, 'c-close', 'CLOSE_ANSWERS');
    await waitForState(host.snaps, 'ANSWER_REVEAL', from);
    await hostCmd(host, 'c-fin', 'NEXT');
    const fin = await waitForState(host.snaps, 'FINISHED');

    const { subs, participants } = await assertOracle(session.id);
    expect(subs).toHaveLength(4); // p1-q1, p2-q1, p1-q2, p2-q2 — P3 silent

    // The delayed rows prove the speed-decay path ran.
    const delayed = subs.filter(
      (s) => s.submissionId === 'p1-q1' || s.submissionId === 'p2-q2',
    );
    expect(delayed).toHaveLength(2);
    for (const s of delayed) {
      expect(s.responseTimeMs).toBeGreaterThanOrEqual(
        s.submissionId === 'p1-q1' ? 1500 : 1000,
      );
      expect(s.responseTimeMs).toBeLessThanOrEqual(3000);
      expect(s.points).toBeLessThan(s.submissionId === 'p1-q1' ? 1000 : 2000);
      expect(s.points).toBeGreaterThan(0);
    }

    // Leaderboard order matches an inline recomputation.
    const expectedOrder = [...participants].sort(
      (a, b) =>
        b.score - a.score ||
        b.correctCount - a.correctCount ||
        a.totalResponseMs - b.totalResponseMs ||
        a.joinedAt.getTime() - b.joinedAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    expect(fin.leaderboard?.map((l) => l.participantId)).toEqual(
      expectedOrder.slice(0, 3).map((p) => p.id),
    );
  });

  it('oracle over non-voided rows only after a restart + replay', async () => {
    const { app, url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    // A second silent player keeps the question open across the restart.
    track(await joinPlayer(url, session.pin, 'P2'));

    await hostCmd(host, 'c-s', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    await answer(p1, open.question!.attemptId, 'o-1', [open.question!.options[0]!.id]);

    await app.close();
    const { app: app2, url: url2 } = await liveApp();
    apps.push(app2);
    const host2 = track(await hostClient(url2, sid, session.id));
    await waitForState(host2.snaps, 'RECOVERY');

    await hostCmd(host2, 'c-rp', 'REPLAY_QUESTION');
    const open2 = await waitForState(host2.snaps, 'QUESTION_OPEN');
    const p1b = track(
      await connectClient(url2, {
        role: 'player',
        participantId: p1.participantId,
        resumeToken: p1.resumeToken,
      }),
    );
    await answer(p1b, open2.question!.attemptId, 'o-2', [
      open2.question!.options[0]!.id,
    ]);
    await hostCmd(host2, 'c-c', 'CLOSE_ANSWERS');
    await waitForState(host2.snaps, 'ANSWER_REVEAL');

    // The voided attempt's submission stays in the DB but earns nothing.
    const allSubs = await prisma.submission.findMany({
      where: { attempt: { sessionId: session.id } },
    });
    expect(allSubs).toHaveLength(2);
    await assertOracle(session.id);
    const me = await prisma.participant.findUnique({ where: { id: p1.participantId } });
    expect(me?.score).toBe(1000);
  });
});
