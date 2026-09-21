import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  HostCommandResult,
  PlayerAnswerResult,
} from '@ictquiz/shared';
import { createOrganizer, ORIGIN } from './helpers.js';
import {
  createSession,
  createSlideQuiz,
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

async function setup(countdownMs = 200) {
  const { app, url } = await liveApp({ countdownMs });
  apps.push(app);
  const org = await createOrganizer(`org-${randomUUID()}@example.com`, 'Password123!');
  const sid = await loginAs(app, org.email, 'Password123!');
  const quizId = await createSlideQuiz(app, sid);
  const session = await createSession(app, sid, quizId);
  return { app, url, org, sid, quizId, session };
}

function hostCmd(t: TrackedSocket, id: string, type: string) {
  return emitAck<HostCommandResult>(t.socket, 'host:command', {
    commandId: id,
    type,
  });
}

function answer(
  t: TrackedSocket,
  attemptId: string,
  submissionId: string,
  optionIds: string[],
) {
  return emitAck<PlayerAnswerResult>(t.socket, 'player:answer', {
    attemptId,
    submissionId,
    optionIds,
  });
}

describe('content slides and polls', () => {
  it('runs a full slide deck: CONTENT → scored → POLL → scored → CONTENT', async () => {
    const { app, url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    const p2 = track(await joinPlayer(url, session.pin, 'P2'));
    const p3 = track(await joinPlayer(url, session.pin, 'P3'));

    // START lands on the intro slide — no countdown, no attempt row.
    expect(await hostCmd(host, 'c-start', 'START')).toMatchObject({ ok: true });
    const slide0 = await waitForState(host.snaps, 'CONTENT_SLIDE');
    expect(slide0.questionIndex).toBe(0);
    expect(slide0.question).toMatchObject({
      index: 0,
      type: 'CONTENT',
      text: 'Welcome to the quiz',
      explanation: 'An intro slide shown before the first question.',
      attemptId: '',
      options: [],
    });
    expect(
      await prisma.questionAttempt.count({ where: { sessionId: session.id } }),
    ).toBe(0);
    const slide0p = await waitForState(p1.snaps, 'CONTENT_SLIDE');
    expect(slide0p.question).toMatchObject({
      type: 'CONTENT',
      text: 'Welcome to the quiz',
      explanation: 'An intro slide shown before the first question.',
    });
    expect(slide0p.question?.options).toEqual([]);

    // NEXT → COUNTDOWN → QUESTION_OPEN on the first real question.
    await hostCmd(host, 'c-n1', 'NEXT');
    const open1 = await waitForState(host.snaps, 'QUESTION_OPEN');
    expect(open1.questionIndex).toBe(1);
    const att1 = open1.question!.attemptId;
    const opts1 = open1.question!.options;

    // P1 correct, P2 wrong, P3 silent.
    await answer(p1, att1, 'p1-q1', [opts1[0]!.id]);
    await answer(p2, att1, 'p2-q1', [opts1[1]!.id]);
    await waitForState(host.snaps, 'ANSWER_REVEAL');

    // Scored question → leaderboard, then the poll counts down.
    const f1 = host.snaps.length;
    await hostCmd(host, 'c-lb', 'NEXT');
    await waitForState(host.snaps, 'LEADERBOARD', f1);
    const f2 = host.snaps.length;
    await hostCmd(host, 'c-n2', 'NEXT');
    await waitForState(host.snaps, 'COUNTDOWN', f2);
    const openPoll = await waitForState(host.snaps, 'QUESTION_OPEN', f2);
    expect(openPoll.questionIndex).toBe(2);
    expect(openPoll.question!.type).toBe('POLL');
    const attPoll = openPoll.question!.attemptId;
    const pollOpts = openPoll.question!.options;

    // P1 votes option 0, P2 option 1, P3 silent. Two ids → INVALID.
    expect(
      await answer(p1, attPoll, 'p1-poll', [pollOpts[0]!.id]),
    ).toMatchObject({ status: 'accepted' });
    expect(
      await answer(p2, attPoll, 'p2-poll', [pollOpts[1]!.id]),
    ).toMatchObject({ status: 'accepted' });
    expect(
      await answer(p3, attPoll, 'p3-poll', [pollOpts[0]!.id, pollOpts[1]!.id]),
    ).toMatchObject({ status: 'rejected', reason: 'INVALID' });

    const fClose = host.snaps.length;
    const fp1 = p1.snaps.length;
    await hostCmd(host, 'c-close', 'CLOSE_ANSWERS');
    const revealPoll = await waitForState(host.snaps, 'ANSWER_REVEAL', fClose);
    expect(revealPoll.results?.correctOptionIds).toEqual([]);
    expect(
      pollOpts.map(
        (o) => revealPoll.results?.distribution.find((d) => d.optionId === o.id)?.count,
      ),
    ).toEqual([1, 1, 0]);

    // Player snapshots carry no lastResult for a poll.
    const pollRevealP1 = await waitForState(p1.snaps, 'ANSWER_REVEAL', fp1);
    expect(pollRevealP1.me?.lastResult).toBeUndefined();

    // Polls never touch score/streak/correctCount.
    const p1Row = await prisma.participant.findUnique({ where: { id: p1.participantId } });
    const p2Row = await prisma.participant.findUnique({ where: { id: p2.participantId } });
    expect(p1Row).toMatchObject({ score: 1000, streak: 1, correctCount: 1 });
    expect(p2Row).toMatchObject({ score: 0, streak: 0, correctCount: 0 });

    // NEXT after a poll skips the leaderboard entirely.
    const f3 = host.snaps.length;
    await hostCmd(host, 'c-n3', 'NEXT');
    const open3 = await waitForState(host.snaps, 'QUESTION_OPEN', f3);
    expect(open3.questionIndex).toBe(3);
    expect(host.snaps.slice(f3).some((s) => s.state === 'LEADERBOARD')).toBe(false);

    // Last scored question, then the closing slide, then FINISHED.
    const att3 = open3.question!.attemptId;
    const opts3 = open3.question!.options;
    const f4 = host.snaps.length;
    await answer(p1, att3, 'p1-q3', [opts3[0]!.id]);
    await waitForState(host.snaps, 'ANSWER_REVEAL', f4);
    const f5 = host.snaps.length;
    await hostCmd(host, 'c-lb2', 'NEXT');
    await waitForState(host.snaps, 'LEADERBOARD', f5);
    await hostCmd(host, 'c-n4', 'NEXT');
    const slide4 = await waitForState(host.snaps, 'CONTENT_SLIDE', f5);
    expect(slide4.questionIndex).toBe(4);
    await hostCmd(host, 'c-fin', 'NEXT');
    const fin = await waitForState(host.snaps, 'FINISHED');
    expect(fin.leaderboard?.map((l) => l.nickname)).toEqual(['P1', 'P2', 'P3']);
    const row = await prisma.gameSession.findUnique({ where: { id: session.id } });
    expect(row?.activePin).toBeNull();

    // Report: slides excluded, poll unscored, CSV shows n/a for votes.
    const report = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/report`,
      headers: { ...ORIGIN, cookie: `sid=${sid}` },
    });
    expect(report.statusCode).toBe(200);
    const body = report.json();
    expect(body.questions.map((q: { index: number }) => q.index)).toEqual([1, 2, 3]);
    const pollRow = body.questions.find((q: { index: number }) => q.index === 2);
    expect(pollRow).toMatchObject({
      type: 'POLL',
      correctOptionIds: [],
      correctCount: null,
      accuracyPct: null,
      answered: 2,
    });
    expect(body.session.scoredQuestionCount).toBe(2);

    const csv = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/report.csv`,
      headers: { ...ORIGIN, cookie: `sid=${sid}` },
    });
    const pollLines = csv.body.split('\r\n').filter((l: string) => l.includes('"n/a"'));
    expect(pollLines.length).toBe(2);
  });

  it('restart during CONTENT_SLIDE restores as CONTENT_SLIDE, and NEXT still works', async () => {
    const { app, url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    track(await joinPlayer(url, session.pin, 'P1'));
    await hostCmd(host, 'c-s', 'START');
    await waitForState(host.snaps, 'CONTENT_SLIDE');

    await app.close();
    const { app: app2, url: url2 } = await liveApp();
    apps.push(app2);

    const row = await prisma.gameSession.findUnique({ where: { id: session.id } });
    expect(row?.state).toBe('CONTENT_SLIDE');

    const host2 = track(await hostClient(url2, sid, session.id));
    const snap = await waitForState(host2.snaps, 'CONTENT_SLIDE');
    expect(snap.questionIndex).toBe(0);
    expect(await hostCmd(host2, 'c-n', 'NEXT')).toMatchObject({ ok: true });
    await waitForState(host2.snaps, 'QUESTION_OPEN');
  });
});
