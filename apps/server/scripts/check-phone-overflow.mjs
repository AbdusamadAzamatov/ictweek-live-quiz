// 390x844 overflow check: drives a phone-width page through every player state
// and reports horizontal overflow + anything below the fold.
import { spawn } from 'node:child_process';

const BASE = 'http://localhost:3000';
const WEB = 'http://localhost:5173';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
  body: JSON.stringify({ email: 'admin@example.com', password: 'ChangeMe123!' }),
});
const sidCookie = login.headers.get('set-cookie').split(';')[0];
const api = async (p, o = {}) => {
  const r = await fetch(`${BASE}/api${p}`, {
    headers: { 'content-type': 'application/json', cookie: sidCookie, origin: 'http://localhost:5173' },
    ...o,
  });
  if (!r.ok) throw new Error(`${p} ${r.status}`);
  return r.json();
};

const { quiz } = await api('/quizzes', { method: 'POST', body: JSON.stringify({ title: 'overflow check' }) });
await api(`/quizzes/${quiz.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    title: 'overflow check',
    description: '',
    questions: [
      {
        type: 'SINGLE',
        text: 'A deliberately long question text to probe wrapping behaviour on a narrow phone screen — which of these is correct?',
        timeLimitSec: 20,
        pointsMode: 'STANDARD',
        options: [
          { text: 'A quite long option label that must wrap without breaking the grid layout', isCorrect: true },
          { text: 'Short', isCorrect: false },
          { text: 'Another long answer choice with plenty of words to stress the card', isCorrect: false },
          { text: 'Last', isCorrect: false },
        ],
      },
      {
        type: 'MULTI',
        text: 'Pick all correct',
        timeLimitSec: 20,
        pointsMode: 'STANDARD',
        options: [
          { text: 'One', isCorrect: true },
          { text: 'Two', isCorrect: false },
          { text: 'Three', isCorrect: true },
          { text: 'Four', isCorrect: false },
        ],
      },
      {
        type: 'POLL',
        text: 'Quick poll?',
        timeLimitSec: 20,
        options: [
          { text: 'Yes', isCorrect: false },
          { text: 'No', isCorrect: false },
        ],
      },
    ],
  }),
});
const session = await api('/sessions', {
  method: 'POST',
  body: JSON.stringify({ quizId: quiz.id, settings: { showQuestionOnPlayer: true } }),
});
console.log('session', session.id);

const { io } = await import('socket.io-client');
const connect = (auth, extra = {}) =>
  new Promise((res, rej) => {
    const s = io(BASE, { auth, reconnection: false, transports: ['websocket'], ...extra });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
const snaps = (s) => { const a = []; s.on('state', (x) => a.push(x)); return a; };
const waitState = (arr, st, from = 0) =>
  new Promise((res, rej) => {
    const t = setInterval(() => {
      const i = arr.findIndex((x, j) => j >= from && x.state === st);
      if (i >= 0) { clearInterval(t); res(arr[i]); }
    }, 25);
    setTimeout(() => { clearInterval(t); rej(new Error('timeout ' + st)); }, 25000);
  });
const cmd = (s, type) => new Promise((r) => s.emit('host:command', { commandId: crypto.randomUUID(), type }, r));
const join = (s, pin, nick) => new Promise((r) => s.emit('player:join', { pin, nickname: nick }, r));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/ictquiz-ovf-profile', '--window-size=390,844', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());
await new Promise((r) => setTimeout(r, 1500));
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}, s) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id, method: m, params: p, ...(s ? { sessionId: s } : {}) })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: ph } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, ph);
await send('Runtime.enable', {}, ph);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, ph);
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, ph);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
};
const waitT = async (txt) => {
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    if (await ev(`document.body.innerText.includes(${JSON.stringify(txt)})`)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timeout ' + txt);
};
const MEASURE = `JSON.stringify({
  w: document.documentElement.clientWidth,
  scrollW: document.documentElement.scrollWidth,
  bodyScrollW: document.body.scrollWidth,
  vh: window.innerHeight,
  docH: document.documentElement.scrollHeight,
  widestEl: (() => { let worst = null, ww = 0;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > ww) { ww = r.width; worst = el.tagName + '.' + String(el.className).slice(0, 60); }
    }
    return worst + ' @' + Math.round(ww);
  })(),
  clippedBtns: [...document.querySelectorAll('button')].filter(b => {
    const r = b.getBoundingClientRect();
    return r.bottom > window.innerHeight || r.right > window.innerWidth;
  }).map(b => b.textContent.trim().slice(0, 30)),
})`;
const check = async (label) => {
  await new Promise((r) => setTimeout(r, 500));
  const m = JSON.parse(await ev(MEASURE));
  const overflow = m.scrollW > m.w || m.bodyScrollW > m.w;
  console.log(`${overflow ? 'FAIL' : 'ok  '} ${label}: w=${m.w} scrollW=${m.scrollW} docH=${m.docH} vh=${m.vh} widest="${m.widestEl}" clipped=${JSON.stringify(m.clippedBtns)}`);
  return !overflow;
};

const pSock = await connect({ role: 'player' });
const jr = await join(pSock, session.pin, 'Check');
// a silent second player keeps questions from auto-closing on "all answered"
const silent = await connect({ role: 'player' });
await join(silent, session.pin, 'Silent');
await send('Page.navigate', { url: `${WEB}/` }, ph);
await check('join-pin');
await ev(`localStorage.setItem('ictquiz.player', ${JSON.stringify(JSON.stringify({ sessionId: session.id, participantId: jr.participantId, resumeToken: jr.resumeToken }))})`);
await send('Page.navigate', { url: `${WEB}/join/${session.pin}` }, ph);
await waitT('Enter lobby');
await check('join-nickname');
await send('Page.navigate', { url: `${WEB}/play` }, ph);
await waitT("You're in!");
await check('lobby');

const driver = await connect({ role: 'host', sessionId: session.id }, { extraHeaders: { cookie: sidCookie } });
const ds = snaps(driver);
await cmd(driver, 'START');
await waitState(ds, 'COUNTDOWN');
await check('countdown');
await waitState(ds, 'QUESTION_OPEN');
await waitT('deliberately long');
await check('single-open');
await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('quite long option'))?.click()`);
await waitT('Answer sent');
await check('answer-sent');
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL');
await new Promise((r) => setTimeout(r, 600));
await check('reveal');
await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD');
await new Promise((r) => setTimeout(r, 600));
await check('leaderboard');
await cmd(driver, 'NEXT');
await waitState(ds, 'QUESTION_OPEN', ds.length);
await waitT('Pick all');
await check('multi-open');
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);
await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD', ds.length - 1);
await cmd(driver, 'NEXT');
await waitState(ds, 'QUESTION_OPEN', ds.length);
await waitT('Quick poll');
await check('poll-open');
await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Yes'))?.click()`);
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);
await new Promise((r) => setTimeout(r, 600));
await check('poll-reveal');
await cmd(driver, 'NEXT');
await waitState(ds, 'FINISHED');
await new Promise((r) => setTimeout(r, 800));
await check('podium');
chrome.kill();
process.exit(0);
