import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  vi.restoreAllMocks();
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

async function setupGame(playerCount: number) {
  const { app, url } = await liveApp({ countdownMs: 100 });
  apps.push(app);
  const org = await createOrganizer(`b-${randomUUID()}@example.com`, 'Password123!');
  const sid = await loginAs(app, org.email, 'Password123!');
  const quizId = await createPlayableQuiz(app, sid);
  const session = await createSession(app, sid, quizId);
  const host = track(await hostClient(url, sid, session.id));
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push(track(await joinPlayer(url, session.pin, `B${i}`)));
  }
  return { app, url, host, players, session };
}

describe('micro-batched submissions', () => {
  it('commits a 150-answer burst in a single batch', async () => {
    const { host, players, session } = await setupGame(150);
    await cmd(host, 'c1', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att = open.question!.attemptId;
    const opt = open.question!.options[0]!.id; // correct option

    // Fire every answer in the same tick.
    const acks = await Promise.all(
      players.map((p, i) => answer(p, att, `burst-${i}`, [opt])),
    );
    expect(acks.every((a) => a.status === 'accepted')).toBe(true);

    await waitForState(host.snaps, 'ANSWER_REVEAL');
    const rows = await prisma.submission.count({ where: { attemptId: att } });
    expect(rows).toBe(150);

    const reveal = host.snaps[host.snaps.length - 1]!;
    const dist = reveal.results!.distribution.reduce((n, d) => n + d.count, 0);
    expect(dist).toBe(150);
    expect(reveal.results!.answered).toBe(150);

    const parts = await prisma.participant.findMany({
      where: { sessionId: session.id },
      select: { id: true, score: true },
    });
    for (const p of parts) {
      const agg = await prisma.submission.aggregate({
        _sum: { points: true },
        where: { participantId: p.id },
      });
      expect(p.score).toBe(agg._sum.points ?? 0);
    }
  }, 60_000);

  it('returns the identical ack for a retry that lands while the insert is pending', async () => {
    const { host, players } = await setupGame(2);
    await cmd(host, 'c1', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att = open.question!.attemptId;
    const opt = open.question!.options[0]!.id;

    // Same payload twice back-to-back — do not await the first.
    const payload = { attemptId: att, submissionId: 'retry-1', optionIds: [opt] };
    const [a1, a2] = await Promise.all([
      emitAck<PlayerAnswerResult>(players[0]!.socket, 'player:answer', payload),
      emitAck<PlayerAnswerResult>(players[0]!.socket, 'player:answer', payload),
    ]);
    expect(a1).toEqual(a2);
    expect(a1.status).toBe('accepted');

    await cmd(host, 'c2', 'CLOSE_ANSWERS');
    const rows = await prisma.submission.count({ where: { attemptId: att } });
    expect(rows).toBe(1);
  });

  it('drains the pending batch before a host close applies scores', async () => {
    const { host, players, session } = await setupGame(100);
    await cmd(host, 'c1', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att = open.question!.attemptId;
    const opt = open.question!.options[0]!.id;

    // 100 answers + CLOSE_ANSWERS in the same tick over 101 different sockets:
    // arrival order across sockets is not guaranteed, so an answer that reaches
    // the server after the close is legitimately rejected as CLOSED. The
    // invariant under test: every ACCEPTED ack is a committed row that the
    // close counted and scored — the close must drain the pending batch first.
    const answers = players.map((p, i) => answer(p, att, `close-${i}`, [opt]));
    const closeAck = cmd(host, 'c2', 'CLOSE_ANSWERS');
    const acks = await Promise.all(answers);
    for (const a of acks) {
      expect(a.status === 'accepted' || (a.status === 'rejected' && a.reason === 'CLOSED')).toBe(
        true,
      );
    }
    const accepted = acks.filter((a) => a.status === 'accepted').length;
    expect(accepted).toBeGreaterThan(0);
    expect((await closeAck).ok).toBe(true);

    const reveal = await waitForState(host.snaps, 'ANSWER_REVEAL');
    expect(reveal.results!.answered).toBe(accepted);
    expect(await prisma.submission.count({ where: { attemptId: att } })).toBe(accepted);

    // Every answer scored exactly once: score == sum(committed points).
    const parts = await prisma.participant.findMany({
      where: { sessionId: session.id },
      select: { id: true, score: true },
    });
    for (const p of parts) {
      const agg = await prisma.submission.aggregate({
        _sum: { points: true },
        where: { participantId: p.id },
      });
      expect(p.score).toBe(agg._sum.points ?? 0);
    }
  }, 60_000);

  it('rejects acks with TEMPORARY and rolls back the reservation when the batch fails', async () => {
    const { app, url } = await liveApp({ countdownMs: 100, prisma });
    apps.push(app);
    const org = await createOrganizer(`b-${randomUUID()}@example.com`, 'Password123!');
    const sid = await loginAs(app, org.email, 'Password123!');
    const quizId = await createPlayableQuiz(app, sid);
    const session = await createSession(app, sid, quizId);
    const host = track(await hostClient(url, sid, session.id));
    const p1 = track(await joinPlayer(url, session.pin, 'F1'));
    track(await joinPlayer(url, session.pin, 'F2'));

    await cmd(host, 'c1', 'START');
    const open = await waitForState(host.snaps, 'QUESTION_OPEN');
    const att = open.question!.attemptId;
    const opt = open.question!.options[0]!.id;

    vi.spyOn(prisma.submission, 'createMany').mockRejectedValueOnce(new Error('db down'));
    const bad = await answer(p1, att, 'fail-1', [opt]);
    expect(bad).toEqual({ status: 'rejected', reason: 'TEMPORARY' });
    expect(await prisma.submission.count({ where: { attemptId: att } })).toBe(0);

    // The reservation was rolled back — a fresh submissionId is accepted, not
    // reported as a duplicate of the failed one.
    const retry = await answer(p1, att, 'fail-2', [opt]);
    expect(retry.status).toBe('accepted');
    expect(await prisma.submission.count({ where: { attemptId: att } })).toBe(1);
  });
});
