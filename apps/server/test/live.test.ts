import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  GameSnapshot,
  HostCommandResult,
  PlayerAnswerResult,
  PlayerJoinResult,
} from '@ictquiz/shared';
import { createOrganizer } from './helpers.js';
import {
  connectClient,
  createPlayableQuiz,
  createSession,
  displayClient,
  emitAck,
  hostClient,
  joinPlayer,
  latest,
  liveApp,
  loginAs,
  waitForState,
  waitSnap,
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
      // already closed mid-test (restart-recovery case)
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
  const quizId = await createPlayableQuiz(app, sid);
  const session = await createSession(app, sid, quizId);
  return { app, url, org, sid, quizId, session };
}

function cmd(id: string, type: string, participantId?: string) {
  return {
    commandId: id,
    type,
    payload: participantId ? { participantId } : undefined,
  };
}

function hostCmd(t: TrackedSocket, id: string, type: string, participantId?: string) {
  return emitAck<HostCommandResult>(t.socket, 'host:command', cmd(id, type, participantId));
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

function deepHasKey(obj: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(obj)) return obj.some((v) => deepHasKey(v, keys));
  if (typeof obj === 'object' && obj !== null) {
    for (const [k, v] of Object.entries(obj)) {
      if (keys.has(k) || deepHasKey(v, keys)) return true;
    }
  }
  return false;
}

describe('live game engine', () => {
  it('rejects unauthorized sockets (host without cookie, wrong organizer, bad display key)', async () => {
    const { url, sid, session } = await setup();

    await expect(
      connectClient(url, { role: 'host', sessionId: session.id }),
    ).rejects.toThrow('UNAUTHORIZED');

    const orgB = await createOrganizer(`b-${randomUUID()}@example.com`, 'Password123!');
    const { app, url: urlB } = await liveApp();
    apps.push(app);
    const sidB = await loginAs(app, orgB.email, 'Password123!');
    await expect(
      connectClient(urlB, { role: 'host', sessionId: session.id }, { cookie: `sid=${sidB}` }),
    ).rejects.toThrow('UNAUTHORIZED');

    await expect(
      connectClient(url, { role: 'display', displayKey: 'not-a-key' }),
    ).rejects.toThrow('UNAUTHORIZED');

    const host = track(await hostClient(url, sid, session.id));
    expect((await waitSnap(host.snaps)).state).toBe('LOBBY');
  });

  it('runs a full 2-question game with 3 players to the podium', async () => {
    const { url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    const display = track(await displayClient(url, session.displayKey));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    const p2 = track(await joinPlayer(url, session.pin, 'P2'));
    const p3 = track(await joinPlayer(url, session.pin, 'P3'));

    expect(await hostCmd(host, 'c-start', 'START')).toMatchObject({ ok: true });
    await waitForState(host.snaps, 'COUNTDOWN');
    const open1 = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att1 = open1.question!.attemptId;
    const opts1 = open1.question!.options;

    // P1 fast correct (rt < 500 ms → 1000), P2 wrong, P3 silent.
    expect(
      await answer(p1, att1, 'p1-q1', [opts1[0]!.id]),
    ).toMatchObject({ status: 'accepted' });
    expect(
      await answer(p2, att1, 'p2-q1', [opts1[1]!.id]),
    ).toMatchObject({ status: 'accepted' });

    const reveal1 = await waitForState(p1.snaps, 'ANSWER_REVEAL', 0, 9000);
    expect(reveal1.me?.lastResult).toMatchObject({ correct: true, points: 1000 });
    const reveal1p2 = await waitForState(p2.snaps, 'ANSWER_REVEAL');
    expect(reveal1p2.me?.lastResult).toMatchObject({ correct: false, points: 0 });
    const reveal1p3 = await waitForState(p3.snaps, 'ANSWER_REVEAL');
    expect(reveal1p3.me?.lastResult).toMatchObject({ correct: false, points: 0 });

    const hostReveal = latest(host.snaps);
    expect(hostReveal.results?.answered).toBe(2);
    expect(hostReveal.results?.eligible).toBe(3);
    expect(
      hostReveal.results?.distribution.find((d) => d.optionId === opts1[0]!.id)?.count,
    ).toBe(1);
    expect(
      hostReveal.results?.distribution.find((d) => d.optionId === opts1[1]!.id)?.count,
    ).toBe(1);

    // Leaderboard: P1 first; P2 beats P3 on joinedAt tie-break.
    await hostCmd(host, 'c-lb', 'NEXT');
    const lb = await waitForState(host.snaps, 'LEADERBOARD');
    expect(lb.leaderboard?.map((l) => l.nickname)).toEqual(['P1', 'P2', 'P3']);
    expect(lb.leaderboard?.map((l) => l.rank)).toEqual([1, 2, 3]);

    // Q2: MULTI DOUBLE — P1 both correct (2000), P2 partial (1000, not
    // correct, streak 0), P3 one right + one wrong (0).
    await hostCmd(host, 'c-q2', 'NEXT');
    const q2from = host.snaps.length;
    const open2 = await waitForState(host.snaps, 'QUESTION_OPEN', q2from);
    const att2 = open2.question!.attemptId;
    const opts2 = open2.question!.options;

    const f1 = p1.snaps.length;
    const f2 = p2.snaps.length;
    const f3 = p3.snaps.length;
    await answer(p1, att2, 'p1-q2', [opts2[0]!.id, opts2[1]!.id]);
    await answer(p2, att2, 'p2-q2', [opts2[0]!.id]);
    await answer(p3, att2, 'p3-q2', [opts2[0]!.id, opts2[2]!.id]);
    await hostCmd(host, 'c-close2', 'CLOSE_ANSWERS');

    const reveal2 = await waitForState(p1.snaps, 'ANSWER_REVEAL', f1, 9000);
    expect(reveal2.me?.lastResult).toMatchObject({ correct: true, points: 2000 });
    const reveal2p2 = await waitForState(p2.snaps, 'ANSWER_REVEAL', f2);
    expect(reveal2p2.me?.lastResult).toMatchObject({
      correct: false,
      points: 1000,
      streak: 0,
    });
    const reveal2p3 = await waitForState(p3.snaps, 'ANSWER_REVEAL', f3);
    expect(reveal2p3.me?.lastResult).toMatchObject({ correct: false, points: 0 });

    await hostCmd(host, 'c-fin', 'NEXT');
    const fin = await waitForState(host.snaps, 'FINISHED');
    expect(fin.leaderboard?.map((l) => l.nickname)).toEqual(['P1', 'P2', 'P3']);
    expect(fin.leaderboard?.map((l) => l.score)).toEqual([3000, 1000, 0]);

    // Persisted scores == sum of points on non-voided submissions.
    const participants = await prisma.participant.findMany({
      where: { sessionId: session.id },
    });
    for (const p of participants) {
      const agg = await prisma.submission.aggregate({
        _sum: { points: true },
        where: { participantId: p.id, attempt: { status: { not: 'VOIDED' } } },
      });
      expect(p.score, p.nickname).toBe(agg._sum.points ?? 0);
    }
    const row = await prisma.gameSession.findUnique({ where: { id: session.id } });
    expect(row?.state).toBe('FINISHED');
    expect(row?.activePin).toBeNull();
    expect(display.snaps.length).toBeGreaterThan(0);
  });

  it('dedupes submissions on (attemptId, participantId)', async () => {
    const { url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    // Second silent player keeps the question open (no early all-answered close).
    track(await joinPlayer(url, session.pin, 'P2'));
    await hostCmd(host, 'c-s', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att = open.question!.attemptId;
    const opt = open.question!.options[0]!.id;

    const a1 = await answer(p1, att, 'dup-1', [opt]);
    const a2 = await answer(p1, att, 'dup-1', [opt]);
    expect(a1.status).toBe('accepted');
    expect(a2).toEqual(a1);

    const a3 = await answer(p1, att, 'dup-2', [opt]);
    expect(a3).toEqual({ status: 'duplicate', submissionId: 'dup-1' });

    const count = await prisma.submission.count({
      where: { attemptId: att, participantId: p1.participantId },
    });
    expect(count).toBe(1);
  });

  it('returns the original ack when a retry lands after the question closed', async () => {
    const { url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    track(await joinPlayer(url, session.pin, 'P2'));
    await hostCmd(host, 'c-s', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att = open.question!.attemptId;
    const opt = open.question!.options[0]!.id;

    const a1 = await answer(p1, att, 'retry-1', [opt]);
    expect(a1.status).toBe('accepted');

    await hostCmd(host, 'c-close', 'CLOSE_ANSWERS');
    await waitForState(host.snaps, 'ANSWER_REVEAL');

    // Same payload after close → the original accepted ack, not CLOSED.
    expect(await answer(p1, att, 'retry-1', [opt])).toEqual(a1);
    // Different submissionId after close → duplicate, not CLOSED.
    expect(await answer(p1, att, 'retry-2', [opt])).toEqual({
      status: 'duplicate',
      submissionId: 'retry-1',
    });
  });

  it('rejects stale, closed and malformed answers', async () => {
    const { url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    await hostCmd(host, 'c-s', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att = open.question!.attemptId;
    const opts = open.question!.options;

    // Malformed: 2 ids on SINGLE; unknown option id.
    expect(
      await answer(p1, att, 'm1', [opts[0]!.id, opts[1]!.id]),
    ).toMatchObject({ status: 'rejected', reason: 'INVALID' });
    expect(await answer(p1, att, 'm2', ['unknown-id'])).toMatchObject({
      status: 'rejected',
      reason: 'INVALID',
    });
    // Stale: attempt id from another question.
    expect(await answer(p1, 'no-such-attempt', 'm3', [opts[0]!.id])).toMatchObject({
      status: 'rejected',
      reason: 'STALE_ATTEMPT',
    });

    await hostCmd(host, 'c-close', 'CLOSE_ANSWERS');
    await waitForState(host.snaps, 'ANSWER_REVEAL');
    expect(await answer(p1, att, 'm4', [opts[0]!.id])).toMatchObject({
      status: 'rejected',
      reason: 'CLOSED',
    });
  });

  it('never leaks the answer key to player or display snapshots', async () => {
    const { url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    const display = track(await displayClient(url, session.displayKey));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    const FORBIDDEN = new Set(['isCorrect', 'explanation', 'correctOptionIds']);

    await hostCmd(host, 'c-s', 'START');
    await waitForState(p1.snaps, 'QUESTION_OPEN');
    await waitForState(display.snaps, 'QUESTION_OPEN');

    const preReveal = (list: GameSnapshot[]) =>
      list.filter((s) => s.state === 'COUNTDOWN' || s.state === 'QUESTION_OPEN');
    for (const s of preReveal(p1.snaps)) expect(deepHasKey(s, FORBIDDEN)).toBe(false);
    for (const s of preReveal(display.snaps)) expect(deepHasKey(s, FORBIDDEN)).toBe(false);

    const hostOpen = host.snaps.find((s) => s.state === 'QUESTION_OPEN')!;
    expect(hostOpen.question?.options.some((o) => 'isCorrect' in o)).toBe(true);

    const p1Open = p1.snaps.find((s) => s.state === 'QUESTION_OPEN')!;
    await answer(p1, p1Open.question!.attemptId, 'leak-1', [
      p1Open.question!.options[0]!.id,
    ]);
    await hostCmd(host, 'c-c', 'CLOSE_ANSWERS');
    const reveal = await waitForState(p1.snaps, 'ANSWER_REVEAL');
    expect(reveal.question?.options.some((o) => 'isCorrect' in o)).toBe(true);
    expect(reveal.results?.correctOptionIds.length).toBeGreaterThan(0);
  });

  it('locks the lobby, removes participants and kills their tokens', async () => {
    const { url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));

    await hostCmd(host, 'c-lock', 'LOCK_LOBBY');
    const j1 = track(await connectClient(url, { role: 'player' }));
    expect(
      await emitAck<PlayerJoinResult>(j1.socket, 'player:join', {
        pin: session.pin,
        nickname: 'Locked Out',
      }),
    ).toMatchObject({ ok: false, code: 'LOCKED' });

    await hostCmd(host, 'c-unlock', 'UNLOCK_LOBBY');
    const p = track(await joinPlayer(url, session.pin, 'Taken'));

    const removed = new Promise((r) => p.socket.once('player:removed', r));
    const gone = new Promise((r) => p.socket.once('disconnect', r));
    await hostCmd(host, 'c-rm', 'REMOVE_PARTICIPANT', p.participantId);
    await removed;
    await gone;

    await expect(
      connectClient(url, {
        role: 'player',
        participantId: p.participantId,
        resumeToken: p.resumeToken,
      }),
    ).rejects.toThrow('UNAUTHORIZED');

    const j2 = track(await connectClient(url, { role: 'player' }));
    expect(
      await emitAck<PlayerJoinResult>(j2.socket, 'player:join', {
        pin: session.pin,
        nickname: 'Taken',
      }),
    ).toMatchObject({ ok: false, code: 'NICKNAME_TAKEN' });

    const hostSnap = latest(host.snaps);
    expect(hostSnap.host?.participants.some((x) => x.id === p.participantId)).toBe(false);
  });

  it('resumes a player after disconnect and syncs duplicate tabs', async () => {
    const { url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    const tab1 = track(await joinPlayer(url, session.pin, 'P1'));
    const tab2 = track(
      await connectClient(url, {
        role: 'player',
        participantId: tab1.participantId,
        resumeToken: tab1.resumeToken,
      }),
    );

    await hostCmd(host, 'c-s', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att = open.question!.attemptId;
    const opt = open.question!.options[0]!.id;

    const subEvt = new Promise<{ attemptId: string; optionIds: string[] }>((r) =>
      tab2.socket.once('player:submission', r),
    );
    await answer(tab1, att, 'tab-1', [opt]);
    expect((await subEvt).optionIds).toEqual([opt]);

    tab1.socket.disconnect();
    const back = track(
      await connectClient(url, {
        role: 'player',
        participantId: tab1.participantId,
        resumeToken: tab1.resumeToken,
      }),
    );
    const snap = await waitSnap(back.snaps);
    expect(snap.me?.submission?.optionIds).toEqual([opt]);
    expect(snap.me?.canAnswer).toBe(false);
  });

  it('marks late joiners ineligible until the next question', async () => {
    const { url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    track(await joinPlayer(url, session.pin, 'Early'));

    await hostCmd(host, 'c-s', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att1 = open.question!.attemptId;
    const opts1 = open.question!.options;

    const late = track(await joinPlayer(url, session.pin, 'Late'));
    // The join ack snapshot is authoritative (no `state` push reaches the new
    // socket on join).
    expect(late.snapshot.me?.canAnswer).toBe(false);
    expect(await answer(late, att1, 'late-1', [opts1[0]!.id])).toMatchObject({
      status: 'rejected',
      reason: 'NOT_ELIGIBLE',
    });

    await hostCmd(host, 'c-1', 'CLOSE_ANSWERS');
    await hostCmd(host, 'c-2', 'NEXT');
    const from = host.snaps.length;
    await hostCmd(host, 'c-3', 'NEXT');
    const open2 = await waitForState(host.snaps, 'QUESTION_OPEN', from);
    const att2 = open2.question!.attemptId;
    const opts2 = open2.question!.options;
    const lateSnap = await waitForState(late.snaps, 'QUESTION_OPEN');
    expect(lateSnap.me?.canAnswer).toBe(true);
    expect(await answer(late, att2, 'late-2', [opts2[0]!.id])).toMatchObject({
      status: 'accepted',
    });
  });

  it('recovers to RECOVERY on restart; REPLAY voids and never double-scores', async () => {
    const { app, url, sid, session } = await setup();
    const host = track(await hostClient(url, sid, session.id));
    const p1 = track(await joinPlayer(url, session.pin, 'P1'));
    // Silent player keeps the question OPEN at restart (no early close).
    track(await joinPlayer(url, session.pin, 'P2'));
    await hostCmd(host, 'c-s', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    await answer(p1, open.question!.attemptId, 'r-1', [open.question!.options[0]!.id]);

    await app.close();
    const { app: app2, url: url2 } = await liveApp();
    apps.push(app2);

    const row = await prisma.gameSession.findUnique({ where: { id: session.id } });
    expect(row?.state).toBe('RECOVERY');

    const host2 = track(await hostClient(url2, sid, session.id));
    await waitForState(host2.snaps, 'RECOVERY');
    await hostCmd(host2, 'c-rp', 'REPLAY_QUESTION');
    const from = host2.snaps.length;
    const open2 = await waitForState(host2.snaps, 'QUESTION_OPEN', from);

    const attempts = await prisma.questionAttempt.findMany({
      where: { sessionId: session.id, questionIndex: 0 },
      orderBy: { attemptNo: 'asc' },
    });
    expect(attempts[0]?.status).toBe('VOIDED');
    expect(attempts[1]?.attemptNo).toBe(2);
    expect(attempts[1]?.id).toBe(open2.question!.attemptId);

    const p1b = track(
      await connectClient(url2, {
        role: 'player',
        participantId: p1.participantId,
        resumeToken: p1.resumeToken,
      }),
    );
    const att2 = open2.question!.attemptId;
    const opts2 = open2.question!.options;
    expect(await answer(p1b, att2, 'r-2', [opts2[0]!.id])).toMatchObject({
      status: 'accepted',
    });
    await hostCmd(host2, 'c-close', 'CLOSE_ANSWERS');
    await waitForState(host2.snaps, 'ANSWER_REVEAL');

    const me = await prisma.participant.findUnique({ where: { id: p1.participantId } });
    // Only the replayed attempt counts (voided submission ignored): 1000.
    expect(me?.score).toBe(1000);

    // END works from a recovered session (now at ANSWER_REVEAL → still fine).
    expect(await hostCmd(host2, 'c-end', 'END')).toMatchObject({ ok: true });
    const ended = await prisma.gameSession.findUnique({ where: { id: session.id } });
    expect(ended?.state).toBe('FINISHED');
    expect(ended?.activePin).toBeNull();
  });

  it('rate-limits player:join per socket', async () => {
    const { url } = await setup();
    const t = track(await connectClient(url, { role: 'player' }));
    for (let i = 0; i < 5; i++) {
      const r = await emitAck<PlayerJoinResult>(t.socket, 'player:join', {
        pin: '000000',
        nickname: `n${i}`,
      });
      expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    }
    const r6 = await emitAck<PlayerJoinResult>(t.socket, 'player:join', {
      pin: '000000',
      nickname: 'n6',
    });
    expect(r6).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  });

  it('reports rooms and socket roles in /api/diagnostics', async () => {
    const { app, url, sid, session } = await setup();
    track(await hostClient(url, sid, session.id));
    track(await displayClient(url, session.displayKey));
    track(await joinPlayer(url, session.pin, 'P1'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/diagnostics',
      headers: { cookie: `sid=${sid}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json() as {
      rooms: { active: number; list: unknown[] };
      sockets: { total: number; byRole: Record<string, number> };
    };
    expect(d.rooms.active).toBeGreaterThanOrEqual(1);
    expect(d.sockets.byRole.host).toBeGreaterThanOrEqual(1);
    expect(d.sockets.byRole.display).toBeGreaterThanOrEqual(1);
    expect(d.sockets.byRole.player).toBeGreaterThanOrEqual(1);
  });
});
