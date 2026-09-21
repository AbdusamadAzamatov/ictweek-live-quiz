// Manual smoke: plays a full 2-player, 2-question game against a running dev server.
// Usage: pnpm exec tsx --conditions=development scripts/smoke-live.mjs [baseUrl]
const BASE = process.argv[2] ?? 'http://localhost:3000';

async function api(path, opts = {}, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:5173',
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), setCookie };
}

const log = (...a) => console.log('[smoke]', ...a);

// 1. login
const login = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'admin@example.com', password: 'ChangeMe123!' }),
});
if (login.status !== 200) throw new Error(`login failed ${login.status} ${JSON.stringify(login.body)}`);
const cookie = login.setCookie.split(';')[0];
log('logged in');

// 2. quiz
const quiz = await api('/api/quizzes', {
  method: 'POST',
  body: JSON.stringify({ title: `Smoke ${Date.now()}` }),
}, cookie);
const quizId = quiz.body.quiz?.id ?? quiz.body.id;
const draft = {
  title: 'Smoke quiz',
  description: '',
  questions: [
    {
      type: 'SINGLE', text: '2 + 2 = ?', timeLimitSec: 10, points: 'STANDARD', order: 0,
      options: [
        { text: '4', isCorrect: true, order: 0 },
        { text: '3', isCorrect: false, order: 1 },
        { text: '5', isCorrect: false, order: 2 },
        { text: '22', isCorrect: false, order: 3 },
      ],
    },
    {
      type: 'MULTI', text: 'Pick the even numbers', timeLimitSec: 10, points: 'DOUBLE', order: 1,
      options: [
        { text: '2', isCorrect: true, order: 0 },
        { text: '4', isCorrect: true, order: 1 },
        { text: '3', isCorrect: false, order: 2 },
        { text: '7', isCorrect: false, order: 3 },
      ],
    },
  ],
};
const put = await api(`/api/quizzes/${quizId}`, { method: 'PUT', body: JSON.stringify(draft) }, cookie);
if (put.status !== 200) throw new Error(`put failed ${JSON.stringify(put.body)}`);
log('quiz ready, playIssues:', JSON.stringify(put.body.playIssues));

// 3. session
const ses = await api('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({ quizId, settings: {} }),
}, cookie);
const session = ses.body.session ?? ses.body;
const { id: sessionId, pin, displayKey } = session;
log(`session ${sessionId} pin=${pin} display=/display/${displayKey}`);

const { io } = await import('socket.io-client');
const snaps = (s) => { const a = []; s.on('state', (x) => a.push(x)); return a; };
const connect = (auth, extra = {}) =>
  new Promise((res, rej) => {
    const s = io(BASE, { auth, reconnection: false, transports: ['websocket'], ...extra });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 8000);
  });
const waitState = (arr, state, from = 0) =>
  new Promise((res, rej) => {
    const t = setInterval(() => {
      const i = arr.findIndex((x, j) => j >= from && x.state === state);
      if (i >= 0) { clearInterval(t); res(arr[i]); }
    }, 25);
    setTimeout(() => { clearInterval(t); rej(new Error(`timeout waiting ${state}; saw ${arr.map(x=>x.state).join(',')}`)); }, 15000);
  });
const cmd = (s, type) =>
  new Promise((res) => s.emit('host:command', { commandId: crypto.randomUUID(), type }, res));
const join = (s, nickname) =>
  new Promise((res) => s.emit('player:join', { pin, nickname }, res));
const send = (s, attemptId, submissionId, optionIds) =>
  new Promise((res) => s.emit('player:answer', { attemptId, submissionId, optionIds }, res));

// 4. host + players
const host = await connect({ role: 'host', sessionId }, { extraHeaders: { cookie } });
const hs = snaps(host);
const p1s = await connect({ role: 'player' }); const p1snaps = snaps(p1s);
const p2s = await connect({ role: 'player' }); const p2snaps = snaps(p2s);
const j1 = await join(p1s, 'Alice'); const j2 = await join(p2s, 'Bob');
log('join acks:', j1.status ?? 'ok', j2.status ?? 'ok', '| players:', j1.participantId?.slice(0,8), j2.participantId?.slice(0,8));

// display check
const disp = await connect({ role: 'display', displayKey });
const dsnaps = snaps(disp);
await waitState(dsnaps, 'LOBBY');
log('display connected, sees LOBBY');

// 5. play Q1
log('cmd START:', JSON.stringify(await cmd(host, 'START')));
await waitState(hs, 'COUNTDOWN');
const q1 = await waitState(hs, 'QUESTION_OPEN', hs.length);
log('Q1 open:', q1.question.text);
const a1 = await send(p1s, q1.question.attemptId, 'sm-q1-a', [q1.question.options[0].id]);
const a2 = await send(p2s, q1.question.attemptId, 'sm-q1-b', [q1.question.options[1].id]);
log('Q1 acks:', a1.status, a2.status);
const r1 = await waitState(hs, 'ANSWER_REVEAL');
log('Q1 reveal distribution:', JSON.stringify(r1.results?.distribution), 'correct:', JSON.stringify(r1.results?.correctOptionIds));
log('cmd NEXT:', JSON.stringify(await cmd(host, 'NEXT')));
const lb = await waitState(hs, 'LEADERBOARD');
log('leaderboard:', lb.leaderboard?.map((x) => `#${x.rank} ${x.nickname}=${x.score}`).join(' '));

// 6. play Q2
log('cmd NEXT:', JSON.stringify(await cmd(host, 'NEXT')));
const q2 = await waitState(hs, 'QUESTION_OPEN', hs.length);
log('Q2 open:', q2.question.text);
const revFrom = hs.length;
const b1 = await send(p1s, q2.question.attemptId, 'sm-q2-a', [q2.question.options[0].id, q2.question.options[1].id]);
const b2 = await send(p2s, q2.question.attemptId, 'sm-q2-b', [q2.question.options[2].id]);
log('Q2 acks:', b1.status, b2.status);
await waitState(hs, 'ANSWER_REVEAL', revFrom);
const finFrom = hs.length;
log('cmd NEXT:', JSON.stringify(await cmd(host, 'NEXT')));
const fin = await waitState(hs, 'FINISHED', finFrom);
log('FINISHED podium:', fin.leaderboard?.slice(0, 3).map((x) => `#${x.rank} ${x.nickname}=${x.score}`).join(' '));

// player-side check
const pf = p2snaps.at(-1);
log('Bob final snapshot state:', pf.state, '| me.score:', pf.me?.score, 'rank:', pf.me?.rank);

host.close(); p1s.close(); p2s.close(); disp.close();
log('SMOKE PASS');
process.exit(0);
