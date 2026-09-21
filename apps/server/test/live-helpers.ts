import type { AddressInfo } from 'node:net';
import { io as ioc, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import type {
  GameSnapshot,
  PlayerJoinResult,
  SessionState,
  SocketAuth,
} from '@ictquiz/shared';
import { buildApp } from '../src/app.js';
import { ORIGIN } from './helpers.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LiveApp = { app: FastifyInstance; url: string };

export async function liveApp(opts?: {
  countdownMs?: number;
  prisma?: PrismaClient;
}): Promise<LiveApp> {
  const app = await buildApp({
    logger: false,
    prisma: opts?.prisma,
    config: { countdownMs: opts?.countdownMs ?? 200 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  return { app, url: `http://127.0.0.1:${port}` };
}

/** HTTP login → sid token value. */
export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: ORIGIN,
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const sid = res.cookies.find((c) => c.name === 'sid');
  if (!sid) throw new Error('no sid cookie');
  return sid.value;
}

/** 2 questions: Q1 SINGLE 4 options 5 s STANDARD; Q2 MULTI 4 options 2 correct 5 s DOUBLE. */
export async function createPlayableQuiz(
  app: FastifyInstance,
  sid: string,
): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/quizzes',
    headers: { ...ORIGIN, cookie: `sid=${sid}` },
  });
  const quizId = created.json().quiz.id as string;
  const res = await app.inject({
    method: 'PUT',
    url: `/api/quizzes/${quizId}`,
    headers: { ...ORIGIN, cookie: `sid=${sid}` },
    payload: {
      title: 'Live test quiz',
      description: '',
      questions: [
        {
          type: 'SINGLE',
          text: 'Q1 pick one',
          timeLimitSec: 5,
          pointsMode: 'STANDARD',
          explanation: '',
          options: [
            { text: 'right', isCorrect: true },
            { text: 'w1', isCorrect: false },
            { text: 'w2', isCorrect: false },
            { text: 'w3', isCorrect: false },
          ],
        },
        {
          type: 'MULTI',
          text: 'Q2 pick two',
          timeLimitSec: 5,
          pointsMode: 'DOUBLE',
          explanation: 'both correct options',
          options: [
            { text: 'a', isCorrect: true },
            { text: 'b', isCorrect: true },
            { text: 'c', isCorrect: false },
            { text: 'd', isCorrect: false },
          ],
        },
      ],
    },
  });
  if (res.statusCode !== 200) throw new Error(`quiz put failed: ${res.body}`);
  return quizId;
}

export async function createSession(
  app: FastifyInstance,
  sid: string,
  quizId: string,
): Promise<{ id: string; pin: string; displayKey: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { ...ORIGIN, cookie: `sid=${sid}` },
    payload: { quizId, settings: {} },
  });
  if (res.statusCode !== 201) throw new Error(`session create failed: ${res.body}`);
  return res.json();
}

export type TrackedSocket = {
  socket: Socket;
  /** Every `state` payload received since connect. */
  snaps: GameSnapshot[];
};

export function connectClient(
  url: string,
  auth: SocketAuth,
  extraHeaders?: Record<string, string>,
): Promise<TrackedSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioc(url, {
      auth: auth as Record<string, unknown>,
      extraHeaders,
      reconnection: false,
    });
    const snaps: GameSnapshot[] = [];
    socket.on('state', (s: GameSnapshot) => snaps.push(s));
    socket.once('connect', () => resolve({ socket, snaps }));
    socket.once('connect_error', (e) => {
      socket.close();
      reject(e);
    });
  });
}

export function hostClient(
  url: string,
  sid: string,
  sessionId: string,
): Promise<TrackedSocket> {
  return connectClient(url, { role: 'host', sessionId }, { cookie: `sid=${sid}` });
}

export function displayClient(url: string, displayKey: string): Promise<TrackedSocket> {
  return connectClient(url, { role: 'display', displayKey });
}

export async function joinPlayer(
  url: string,
  pin: string,
  nickname: string,
): Promise<
  TrackedSocket & { participantId: string; resumeToken: string; snapshot: GameSnapshot }
> {
  const t = await connectClient(url, { role: 'player' });
  const res = await emitAck<PlayerJoinResult>(t.socket, 'player:join', { pin, nickname });
  if (!res.ok) {
    t.socket.close();
    throw new Error(`join failed: ${JSON.stringify(res)}`);
  }
  return {
    ...t,
    participantId: res.participantId,
    resumeToken: res.resumeToken,
    snapshot: res.snapshot,
  };
}

export function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res: T) => resolve(res));
  });
}

/** Wait for the first snapshot with `state` recorded at index >= `from`. */
export async function waitForState(
  snaps: GameSnapshot[],
  state: SessionState,
  from = 0,
  timeoutMs = 12_000,
): Promise<GameSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = snaps.slice(from).find((s) => s.state === state);
    if (found) return found;
    await sleep(15);
  }
  throw new Error(
    `timeout waiting for ${state}; seen: ${snaps.map((s) => s.state).join(' → ') || '(none)'}`,
  );
}

export function latest(snaps: GameSnapshot[]): GameSnapshot {
  const s = snaps[snaps.length - 1];
  if (!s) throw new Error('no snapshots received');
  return s;
}

/** Wait for the first `state` push (the one emitted on connect). */
export async function waitSnap(
  snaps: GameSnapshot[],
  timeoutMs = 5_000,
): Promise<GameSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = snaps[snaps.length - 1];
    if (s) return s;
    await sleep(15);
  }
  throw new Error('no snapshot received');
}
