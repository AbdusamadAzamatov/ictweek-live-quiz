/**
 * Socket.IO load test: N simulated participants play a full game hosted by an
 * automated host driver. Measures join / answer-ack latency, verifies that no
 * acknowledged answer is lost, that retried submissions are never scored twice,
 * and that reconnecting clients resynchronise. Records memory from /api/diagnostics.
 *
 * Usage (server must be running, e.g. `pnpm dev` or the production build):
 *   pnpm --filter @ictquiz/server load-test -- --players 100 [--url http://localhost:3000]
 *     [--origin http://localhost:5173] [--email admin@example.com] [--password ChangeMe123!]
 *     [--questions 5] [--time-limit 10] [--burst-ms 2000] [--retry-rate 0.1] [--storm 0.3]
 *     [--join-rate 50] [--out load-results/<n>.json]
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { GameSnapshot } from '@ictquiz/shared';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def;
};
const num = (name: string, def: number) => Number(arg(name, String(def)));

const URL_ = arg('url', 'http://localhost:3000').replace(/\/$/, '');
const ORIGIN = arg('origin', 'http://localhost:5173');
const EMAIL = arg('email', 'admin@example.com');
const PASSWORD = arg('password', 'ChangeMe123!');
const PLAYERS = num('players', 50);
const QUESTIONS = num('questions', 5);
const TIME_LIMIT = num('time-limit', 10);
const BURST_MS = num('burst-ms', 2000);
const RETRY_RATE = num('retry-rate', 0.1);
const STORM = num('storm', 0.3);
const JOIN_RATE = num('join-rate', 50); // joins per second
const OUT = arg('out', `load-results/${PLAYERS}p-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const stats = (xs: number[]) => ({
  n: xs.length,
  p50: pct(xs, 50),
  p95: pct(xs, 95),
  p99: pct(xs, 99),
  max: xs.length ? Math.max(...xs) : null,
  mean: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null,
});
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

function emitAck<T>(socket: Socket, ev: string, payload: unknown, timeoutMs = 15000): Promise<{ ack: T; ms: number }> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout: ${ev}`)), timeoutMs);
    socket.emit(ev, payload, (ack: T) => {
      clearTimeout(timer);
      resolve({ ack, ms: Math.round(performance.now() - t0) });
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP (organizer)
// ---------------------------------------------------------------------------
let cookie = '';
async function api<T>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(URL_ + p, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), origin: ORIGIN, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}

function makeQuizDraft() {
  const questions = Array.from({ length: QUESTIONS }, (_, i) => {
    const kind = i % 3;
    if (kind === 1) {
      return {
        type: 'TRUE_FALSE', text: `Load question ${i + 1}: true or false?`, timeLimitSec: TIME_LIMIT,
        pointsMode: 'STANDARD', explanation: '',
        options: [{ text: 'True', isCorrect: true }, { text: 'False', isCorrect: false }],
      };
    }
    if (kind === 2) {
      return {
        type: 'MULTI', text: `Load question ${i + 1}: pick all that apply`, timeLimitSec: TIME_LIMIT,
        pointsMode: 'DOUBLE', explanation: 'Two of these were correct.',
        options: [
          { text: 'Alpha', isCorrect: true }, { text: 'Beta', isCorrect: false },
          { text: 'Gamma', isCorrect: true }, { text: 'Delta', isCorrect: false },
        ],
      };
    }
    return {
      type: 'SINGLE', text: `Load question ${i + 1}: which one?`, timeLimitSec: TIME_LIMIT,
      pointsMode: 'STANDARD', explanation: '',
      options: [
        { text: 'One', isCorrect: false }, { text: 'Two', isCorrect: true },
        { text: 'Three', isCorrect: false }, { text: 'Four', isCorrect: false },
      ],
    };
  });
  return { title: `Load test ${PLAYERS}p ${new Date().toISOString()}`, description: '', questions };
}

// ---------------------------------------------------------------------------
// player model
// ---------------------------------------------------------------------------
type AnswerRecord = {
  status: string; reason?: string; ms: number;
  retry?: { status: string; identical: boolean; ms: number };
};
type Player = {
  i: number; nickname: string; socket: Socket | null;
  participantId?: string; resumeToken?: string;
  joinMs?: number; joinError?: string;
  answers: Map<number, AnswerRecord>;          // questionIndex → record
  results: Map<number, number>;                // questionIndex → me.lastResult.points (from ANSWER_REVEAL)
  finalScore?: number; finalRank?: number;
  storm?: { resyncMs: number | null; error?: string };
  answeredAttempt: Set<string>;
  errors: string[];
};

const players: Player[] = Array.from({ length: PLAYERS }, (_, i) => ({
  i, nickname: `lt${String(i + 1).padStart(4, '0')}`, socket: null,
  answers: new Map(), results: new Map(), answeredAttempt: new Set(), errors: [],
}));

function pickAnswer(q: NonNullable<GameSnapshot['question']>): string[] {
  const ids = q.options.map((o) => o.id);
  if (q.type === 'MULTI') {
    const n = 1 + Math.floor(Math.random() * 2);
    return [...ids].sort(() => Math.random() - 0.5).slice(0, n);
  }
  return [ids[Math.floor(Math.random() * ids.length)]!];
}

function attachPlayerHandlers(p: Player, socket: Socket) {
  socket.on('state', (snap: GameSnapshot) => {
    if (snap.state === 'QUESTION_OPEN' && snap.question && snap.me?.canAnswer && !p.answeredAttempt.has(snap.question.attemptId)) {
      p.answeredAttempt.add(snap.question.attemptId);
      const q = snap.question;
      const delay = Math.random() * BURST_MS;
      setTimeout(async () => {
        const payload = { attemptId: q.attemptId, submissionId: randomUUID(), optionIds: pickAnswer(q) };
        try {
          const { ack, ms } = await emitAck<{ status: string; reason?: string; receivedAt?: string; submissionId?: string }>(socket, 'player:answer', payload);
          const rec: AnswerRecord = { status: ack.status, reason: ack.reason, ms };
          p.answers.set(q.index, rec);
          if (ack.status === 'accepted' && Math.random() < RETRY_RATE) {
            const r = await emitAck<typeof ack>(socket, 'player:answer', payload);
            rec.retry = { status: r.ack.status, ms: r.ms, identical: JSON.stringify(r.ack) === JSON.stringify(ack) };
          }
        } catch (e) {
          p.answers.set(q.index, { status: 'error', reason: String(e), ms: -1 });
        }
      }, delay);
    }
    if (snap.state === 'ANSWER_REVEAL' && snap.me?.lastResult && snap.questionIndex !== null) {
      p.results.set(snap.questionIndex, snap.me.lastResult.points);
    }
    if (snap.state === 'FINISHED' && snap.me) {
      p.finalScore = snap.me.score;
      p.finalRank = snap.me.rank;
    }
  });
  socket.on('player:removed', () => p.errors.push('removed'));
  socket.on('connect_error', (e) => p.errors.push(`connect_error: ${e.message}`));
}

/** engine.io `ws` does not honour NODE_TLS_REJECT_UNAUTHORIZED — pass it through. */
const REJECT_UNAUTH = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';

function newPlayerSocket(auth: Record<string, unknown>): Socket {
  return io(URL_, { transports: ['websocket'], auth, reconnection: false, timeout: 20000, forceNew: true, rejectUnauthorized: REJECT_UNAUTH });
}

async function joinPlayer(p: Player, pin: string): Promise<void> {
  const socket = newPlayerSocket({ role: 'player' });
  p.socket = socket;
  attachPlayerHandlers(p, socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (e) => reject(e));
  });
  const { ack, ms } = await emitAck<{ ok: boolean; code?: string; participantId?: string; resumeToken?: string }>(socket, 'player:join', { pin, nickname: p.nickname });
  p.joinMs = ms;
  if (!ack.ok) {
    p.joinError = ack.code;
    return;
  }
  p.participantId = ack.participantId;
  p.resumeToken = ack.resumeToken;
}

/** Disconnect and reconnect with resume credentials; measure time until the first `state` arrives with the expected revision or later. */
async function stormReconnect(p: Player, minRevision: number): Promise<void> {
  if (!p.socket || !p.resumeToken) return;
  p.socket.removeAllListeners();
  p.socket.disconnect();
  const t0 = performance.now();
  const socket = newPlayerSocket({ role: 'player', participantId: p.participantId, resumeToken: p.resumeToken });
  p.socket = socket;
  attachPlayerHandlers(p, socket);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('resync timeout')), 20000);
      socket.on('state', (snap: GameSnapshot) => {
        if (snap.revision >= minRevision) {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.once('connect_error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    p.storm = { resyncMs: Math.round(performance.now() - t0) };
  } catch (e) {
    p.storm = { resyncMs: null, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// host driver
// ---------------------------------------------------------------------------
class Host {
  socket: Socket;
  snapshot: GameSnapshot | null = null;
  private waiters: Array<{ pred: (s: GameSnapshot) => boolean; resolve: (s: GameSnapshot) => void }> = [];
  constructor(sessionId: string) {
    this.socket = io(URL_, {
      transports: ['websocket'], auth: { role: 'host', sessionId }, extraHeaders: { cookie, origin: ORIGIN },
      reconnection: true, forceNew: true, rejectUnauthorized: REJECT_UNAUTH,
    });
    this.socket.on('state', (s: GameSnapshot) => {
      this.snapshot = s;
      this.waiters = this.waiters.filter((w) => (w.pred(s) ? (w.resolve(s), false) : true));
    });
    this.socket.on('connect_error', (e) => log('host connect_error', e.message));
  }
  waitFor(pred: (s: GameSnapshot) => boolean, timeoutMs: number, label: string): Promise<GameSnapshot> {
    if (this.snapshot && pred(this.snapshot)) return Promise.resolve(this.snapshot);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label} (state=${this.snapshot?.state} q=${this.snapshot?.questionIndex})`)), timeoutMs);
      this.waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
    });
  }
  async cmd(type: string, payload?: unknown) {
    const { ack, ms } = await emitAck<{ ok: boolean; code?: string; revision?: number }>(this.socket, 'host:command', { commandId: randomUUID(), type, payload });
    if (!ack.ok) throw new Error(`host command ${type} failed: ${ack.code}`);
    return { ...ack, ms };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function diagnostics() {
  const { status, json } = await api<{ memory?: { rss: number; heapUsed: number }; sockets?: unknown }>('GET', '/api/diagnostics');
  return status === 200 ? { at: new Date().toISOString(), rssMb: Math.round((json.memory?.rss ?? 0) / 1048576), heapMb: Math.round((json.memory?.heapUsed ?? 0) / 1048576), sockets: json.sockets } : { at: new Date().toISOString(), error: status };
}

async function main() {
  log(`load test: ${PLAYERS} players, ${QUESTIONS} questions x ${TIME_LIMIT}s, burst ${BURST_MS} ms, retry ${RETRY_RATE}, storm ${STORM}, url ${URL_}`);
  const login = await api<{ error?: string }>('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.json)}`);

  const created = await api<{ quiz: { id: string } }>('POST', '/api/quizzes');
  const quizId = created.json.quiz.id;
  const put = await api<{ playIssues: unknown[] }>('PUT', `/api/quizzes/${quizId}`, makeQuizDraft());
  if (put.status !== 200 || put.json.playIssues.length) throw new Error(`quiz not playable: ${JSON.stringify(put.json)}`);
  const sess = await api<{ id: string; pin: string }>('POST', '/api/sessions', { quizId, settings: { maxParticipants: Math.max(PLAYERS + 10, 500) } });
  if (sess.status !== 201) throw new Error(`session create failed: ${sess.status} ${JSON.stringify(sess.json)}`);
  const { id: sessionId, pin } = sess.json;
  log(`session ${sessionId} pin ${pin}`);

  const memory: unknown[] = [await diagnostics()];
  const host = new Host(sessionId);
  await host.waitFor((s) => s.state === 'LOBBY', 15000, 'LOBBY');

  // Join at JOIN_RATE/s
  const tJoin0 = performance.now();
  const joinPromises: Promise<void>[] = [];
  for (const p of players) {
    joinPromises.push(joinPlayer(p, pin).catch((e) => { p.joinError = String(e); }));
    await sleep(1000 / JOIN_RATE);
  }
  await Promise.all(joinPromises);
  const joined = players.filter((p) => p.participantId);
  log(`joined ${joined.length}/${PLAYERS} in ${Math.round(performance.now() - tJoin0)} ms; failures: ${players.filter((p) => p.joinError).length}`);
  await host.waitFor((s) => s.participantCount >= joined.length, 15000, 'participantCount');
  memory.push(await diagnostics());

  const perQuestion: unknown[] = [];
  const stormResults: Player['storm'][] = [];
  await host.cmd('START');
  for (let q = 0; q < QUESTIONS; q++) {
    const open = await host.waitFor((s) => s.state === 'QUESTION_OPEN' && s.questionIndex === q, 30000, `QUESTION_OPEN ${q}`);
    const eligible = open.host?.eligible ?? joined.length;
    const reveal = await host.waitFor((s) => s.state === 'ANSWER_REVEAL' && s.questionIndex === q, (TIME_LIMIT + 15) * 1000, `ANSWER_REVEAL ${q}`);
    // let per-player ANSWER_REVEAL snapshots land (up to 5 s)
    const tReveal = performance.now();
    while (joined.some((p) => !p.results.has(q)) && performance.now() - tReveal < 5000) await sleep(100);
    const revealFanoutMs = Math.round(performance.now() - tReveal);
    const recs = joined.map((p) => p.answers.get(q)).filter((r): r is AnswerRecord => !!r);
    const accepted = recs.filter((r) => r.status === 'accepted');
    const byStatus: Record<string, number> = {};
    for (const r of recs) byStatus[r.reason ? `${r.status}:${r.reason}` : r.status] = (byStatus[r.reason ? `${r.status}:${r.reason}` : r.status] ?? 0) + 1;
    const retries = accepted.filter((r) => r.retry);
    const row = {
      q, type: open.question?.type, eligible, answeredPerServer: reveal.results?.answered ?? null,
      acceptedPerClient: accepted.length, lost: accepted.length - (reveal.results?.answered ?? 0),
      byStatus, ack: stats(accepted.map((r) => r.ms)),
      retries: { n: retries.length, identical: retries.filter((r) => r.retry!.identical).length },
      resultsReceived: joined.filter((p) => p.results.has(q)).length,
      revealFanoutMs,
    };
    perQuestion.push(row);
    log(`q${q} ${row.type}: eligible ${eligible}, server answered ${row.answeredPerServer}, client accepted ${row.acceptedPerClient}, lost ${row.lost}, ack p50/p95/p99 ${row.ack.p50}/${row.ack.p95}/${row.ack.p99} ms, retries identical ${row.retries.identical}/${row.retries.n}, reveal fan-out ${revealFanoutMs} ms (${row.resultsReceived}/${joined.length})`);
    memory.push(await diagnostics());

    if (q === QUESTIONS - 1) {
      await host.cmd('NEXT');
      break;
    }
    await host.cmd('NEXT');
    const lb = await host.waitFor((s) => s.state === 'LEADERBOARD' && s.questionIndex === q, 15000, `LEADERBOARD ${q}`);
    if (q === 1 && STORM > 0) {
      const victims = joined.filter(() => Math.random() < STORM);
      log(`reconnect storm: ${victims.length} players`);
      const t0 = performance.now();
      await Promise.all(victims.map((p) => stormReconnect(p, lb.revision)));
      for (const p of victims) stormResults.push(p.storm);
      log(`storm done in ${Math.round(performance.now() - t0)} ms; resync ok ${victims.filter((p) => p.storm?.resyncMs !== null).length}/${victims.length}`);
      memory.push(await diagnostics());
    }
    await host.cmd('NEXT');
  }
  const fin = await host.waitFor((s) => s.state === 'FINISHED', 15000, 'FINISHED');
  await sleep(1000);
  memory.push(await diagnostics());

  // Consistency: server final score == sum of per-question points the player was told; one result per question
  const serverScores = new Map((fin.host?.participants ?? []).map((p) => [p.id, p.score]));
  let scoreMismatch = 0;
  let missingResults = 0;
  for (const p of joined) {
    const sum = [...p.results.values()].reduce((a, b) => a + b, 0);
    const server = serverScores.get(p.participantId!);
    if (server !== sum) scoreMismatch++;
    if (p.results.size !== QUESTIONS) missingResults++;
  }
  const allAccepted = perQuestion as Array<{ lost: number; ack: { p95: number | null }; retries: { n: number; identical: number } }>;
  const totalLost = allAccepted.reduce((a, r) => a + Math.max(0, r.lost), 0);
  const retryMismatch = allAccepted.reduce((a, r) => a + (r.retries.n - r.retries.identical), 0);
  const allAcks = joined.flatMap((p) => [...p.answers.values()].filter((r) => r.status === 'accepted').map((r) => r.ms));
  const summary = {
    config: { url: URL_, players: PLAYERS, questions: QUESTIONS, timeLimitSec: TIME_LIMIT, burstMs: BURST_MS, retryRate: RETRY_RATE, storm: STORM, joinRate: JOIN_RATE },
    sessionId, pin,
    join: { ok: joined.length, failed: players.filter((p) => p.joinError).length, failures: Object.entries(players.reduce<Record<string, number>>((m, p) => (p.joinError ? ((m[p.joinError] = (m[p.joinError] ?? 0) + 1), m) : m), {})), latency: stats(joined.map((p) => p.joinMs!)) },
    perQuestion,
    answerAckAll: stats(allAcks),
    storm: { n: stormResults.length, ok: stormResults.filter((s) => s?.resyncMs !== null).length, resync: stats(stormResults.map((s) => s?.resyncMs).filter((x): x is number => typeof x === 'number')) },
    consistency: { totalLost, retryMismatch, scoreMismatch, missingResults, playersFinished: joined.filter((p) => p.finalScore !== undefined).length },
    memory,
    targets: {
      p95AckUnder500ms: (stats(allAcks).p95 ?? Infinity) < 500,
      zeroLost: totalLost === 0,
      zeroDuplicateScoring: scoreMismatch === 0 && missingResults === 0,
      idempotentRetries: retryMismatch === 0,
      allResynced: stormResults.every((s) => s?.resyncMs !== null),
    },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  log('SUMMARY', JSON.stringify({ join: summary.join.latency, ack: summary.answerAckAll, storm: summary.storm, consistency: summary.consistency, targets: summary.targets }, null, 2));
  log(`written ${OUT}`);

  for (const p of players) p.socket?.disconnect();
  host.socket.disconnect();
  const pass = Object.values(summary.targets).every(Boolean);
  process.exit(pass ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
