import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PlayerJoinResult } from '@ictquiz/shared';
import type { AppConfig } from '../src/env.js';
import { createOrganizer, ORIGIN } from './helpers.js';
import {
  connectClient,
  createPlayableQuiz,
  createSession,
  emitAck,
  liveApp,
  loginAs,
  type TrackedSocket,
} from './live-helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Real Postgres + real sockets; every client shares 127.0.0.1 (venue NAT). */
async function setup(config?: Partial<AppConfig>) {
  const { app, url } = await liveApp({ config });
  apps.push(app);
  const org = await createOrganizer(`org-${randomUUID()}@example.com`, 'Password123!');
  const sid = await loginAs(app, org.email, 'Password123!');
  const quizId = await createPlayableQuiz(app, sid);
  const session = await createSession(app, sid, quizId);
  return { app, url, sid, session };
}

/** One fresh socket → one player:join → returns the ack. */
async function freshJoin(
  url: string,
  pin: string,
  nickname: string,
): Promise<{ result: PlayerJoinResult; t: TrackedSocket }> {
  const t = track(await connectClient(url, { role: 'player' }));
  const result = await emitAck<PlayerJoinResult>(t.socket, 'player:join', {
    pin,
    nickname,
  });
  return { result, t };
}

const httpJoin = (app: FastifyInstance, pin: string) =>
  app.inject({ method: 'GET', url: `/api/join/${pin}` });

describe('join/PIN rate limiting (shared per-IP)', () => {
  it('blocks PIN enumeration across socket reconnects', async () => {
    const { app, url, session } = await setup({ joinFailPerMin: 20 });
    const wrongPin = (i: number) => String(900000 + i).slice(0, 6);

    for (let i = 0; i < 25; i++) {
      const { result, t } = await freshJoin(url, wrongPin(i), `probe-${i}`);
      t.socket.close();
      if (i < 20) expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      else expect(result).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    }

    // A limited IP learns nothing — a valid PIN gets the same RATE_LIMITED.
    const { result } = await freshJoin(url, session.pin, 'real-player');
    expect(result).toMatchObject({ ok: false, code: 'RATE_LIMITED' });

    const res = await httpJoin(app, session.pin);
    expect(res.statusCode).toBe(429);
  }, 30_000);

  it('shares the failure budget between HTTP and socket channels', async () => {
    const { app, url } = await setup({ joinFailPerMin: 20 });

    for (let i = 0; i < 10; i++) {
      const res = await httpJoin(app, `8000${String(10 + i)}`);
      expect(res.statusCode).toBe(404);
    }
    for (let i = 0; i < 10; i++) {
      const { result, t } = await freshJoin(url, `7000${String(10 + i)}`, `probe-${i}`);
      t.socket.close();
      expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    }

    // Attempt 21 on either channel is limited.
    expect((await httpJoin(app, '654321')).statusCode).toBe(429);
    const { result } = await freshJoin(url, '654321', 'probe-21');
    expect(result).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  }, 30_000);

  it('allows a legitimate mass join from one venue IP', async () => {
    const { app, url, session } = await setup(); // default limits

    // 300 fresh sockets, one valid PIN, unique nicknames — batches of 50.
    const results: PlayerJoinResult[] = [];
    for (let base = 0; base < 300; base += 50) {
      const batch = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          freshJoin(url, session.pin, `player-${base + i}`),
        ),
      );
      results.push(...batch.map((b) => b.result));
    }
    expect(results).toHaveLength(300);
    expect(results.every((r) => r.ok)).toBe(true);

    // Successes do not consume the failure budget.
    const { result } = await freshJoin(url, '000000', 'probe');
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect((await httpJoin(app, session.pin)).statusCode).toBe(200);
  }, 60_000);

  it('expires the failure window', async () => {
    const { url } = await setup({ joinFailPerMin: 3, joinFailWindowMs: 500 });

    for (let i = 0; i < 3; i++) {
      const { result, t } = await freshJoin(url, `50000${i}`, `probe-${i}`);
      t.socket.close();
      expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    }
    const { result: limited } = await freshJoin(url, '500003', 'probe-3');
    expect(limited).toMatchObject({ ok: false, code: 'RATE_LIMITED' });

    await sleep(600);
    const { result: after } = await freshJoin(url, '500004', 'probe-4');
    expect(after).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  }, 30_000);

  it('keeps the per-socket join bucket and reports limiter stats', async () => {
    const { app, url, sid } = await setup();
    const t = track(await connectClient(url, { role: 'player' }));
    for (let i = 0; i < 5; i++) {
      const r = await emitAck<PlayerJoinResult>(t.socket, 'player:join', {
        pin: `60000${i}`,
        nickname: `n${i}`,
      });
      expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    }
    const r6 = await emitAck<PlayerJoinResult>(t.socket, 'player:join', {
      pin: '600005',
      nickname: 'n6',
    });
    expect(r6).toMatchObject({ ok: false, code: 'RATE_LIMITED' });

    const diag = await app.inject({
      method: 'GET',
      url: '/api/diagnostics',
      headers: { ...ORIGIN, cookie: `sid=${sid}` },
    });
    expect(diag.statusCode).toBe(200);
    expect(diag.json().joinLimiter.trackedIps).toBeGreaterThanOrEqual(1);
  });
});
