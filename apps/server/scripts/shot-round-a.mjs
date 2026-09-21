// Round A UI smoke: content slides + polls + cover image.
// Screenshots → artifacts/round-a-screens/
// Usage: pnpm exec tsx scripts/shot-round-a.mjs   (dev API :3000 + vite :5173 up)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:3000';
const WEB = 'http://localhost:5173';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = `${ROOT}artifacts/round-a-screens`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9341;
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(`${ROOT}artifacts/tmp`, { recursive: true });

// --- api helpers -------------------------------------------------------------
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
  body: JSON.stringify({ email: 'admin@example.com', password: 'ChangeMe123!' }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const sidCookie = login.headers.get('set-cookie').split(';')[0];
console.log('[api] logged in');

const api = async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, {
    headers: {
      'content-type': 'application/json',
      cookie: sidCookie,
      origin: 'http://localhost:5173',
    },
    ...opts,
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// --- small valid PNG (real magic bytes) --------------------------------------
function png(w, h, rgb) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const idat = zlib.deflateSync(
    Buffer.concat(Array.from({ length: h }, () => row)),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const imgPath = `${ROOT}artifacts/tmp/ra-img.png`;
fs.writeFileSync(imgPath, png(640, 360, [0x7b, 0x2f, 0xbe]));

// --- chrome ------------------------------------------------------------------
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--user-data-dir=/tmp/ictquiz-ra-profile',
    '--window-size=1440,900',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => chrome.kill());
await new Promise((r) => setTimeout(r, 1500));

const version = await (
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++seq;
    const to = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`${method}: no response`));
    }, 20000);
    pending.set(id, (m) => {
      clearTimeout(to);
      if (m.error) rej(new Error(`${method}: ${m.error.message}`));
      else res(m.result);
    });
    ws.send(
      JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
    );
  });
ws.onclose = () => {
  console.error('chrome ws closed');
  process.exit(2);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function newPage(width = 1440, height = 900, mobile = false) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile },
    sid,
  );
  return sid;
}
const nav = (s, url) => send('Page.navigate', { url }, s);
const evalJs = async (s, expr) => {
  const r = await send(
    'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true },
    s,
  );
  if (r.exceptionDetails)
    throw new Error(
      `eval failed: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)}`,
    );
  return r.result?.value;
};
const shot = async (s, name) => {
  for (let i = 0; i < 4; i++) {
    try {
      await send('Page.bringToFront', {}, s);
      await sleep(250);
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, s);
      fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
      console.log('[shot]', name);
      return;
    } catch (e) {
      if (i === 3) throw e;
      await sleep(700);
    }
  }
};
const waitBody = async (s, text, timeout = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJs(s, `document.body.innerText.includes(${JSON.stringify(text)})`))
      return;
    await sleep(300);
  }
  throw new Error(`timeout waiting text "${text}"`);
};

const hostPage = async () => {
  const p = await newPage();
  await send('Network.enable', {}, p);
  await send(
    'Network.setCookie',
    {
      name: 'sid',
      value: sidCookie.split('=')[1],
      domain: 'localhost',
      path: '/',
    },
    p,
  );
  return p;
};

// --- game driver --------------------------------------------------------------
const { io } = await import('socket.io-client');
const connect = (auth, extra = {}) =>
  new Promise((res, rej) => {
    const s = io(BASE, {
      auth,
      reconnection: false,
      transports: ['websocket'],
      ...extra,
    });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
const snaps = (s) => {
  const a = [];
  s.on('state', (x) => a.push(x));
  return a;
};
const waitState = (arr, state, from = 0) =>
  new Promise((res, rej) => {
    const t = setInterval(() => {
      const i = arr.findIndex((x, j) => j >= from && x.state === state);
      if (i >= 0) {
        clearInterval(t);
        res(arr[i]);
      }
    }, 25);
    setTimeout(() => {
      clearInterval(t);
      rej(new Error(`timeout ${state} (seen ${arr.map((x) => x.state).join('>')})`));
    }, 20000);
  });
const cmd = (s, type) =>
  new Promise((r) =>
    s.emit('host:command', { commandId: crypto.randomUUID(), type }, r),
  );
const answer = (s, attemptId, submissionId, optionIds) =>
  new Promise((r) =>
    s.emit('player:answer', { attemptId, submissionId, optionIds }, r),
  );
const join = (s, pin, nickname) =>
  new Promise((r) => s.emit('player:join', { pin, nickname }, r));

// --- build the deck -----------------------------------------------------------
const imgForm = new FormData();
imgForm.append(
  'file',
  new Blob([fs.readFileSync(imgPath)], { type: 'image/png' }),
  'cover.png',
);
const up = await fetch(`${BASE}/api/media`, {
  method: 'POST',
  headers: { cookie: sidCookie, origin: 'http://localhost:5173' },
  body: imgForm,
});
if (!up.ok) throw new Error(`upload ${up.status} ${await up.text()}`);
const media = await up.json();
console.log('[api] media', media.id);

const { quiz } = await api('/quizzes', {
  method: 'POST',
  body: JSON.stringify({ title: 'Round A demo' }),
});
await api(`/quizzes/${quiz.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    title: 'Round A demo',
    description: '',
    coverMediaId: media.id,
    questions: [
      {
        type: 'CONTENT',
        text: 'Welcome to ICTWEEK!',
        mediaId: media.id,
        explanation: 'Get your phones ready — the first question is coming up.',
        options: [],
      },
      {
        type: 'SINGLE',
        text: 'What does ICTWEEK celebrate?',
        timeLimitSec: 20,
        pointsMode: 'STANDARD',
        explanation: '',
        options: [
          { text: 'ICT in Uzbekistan', isCorrect: true, mediaId: null },
          { text: 'Cooking shows', isCorrect: false, mediaId: null },
          { text: 'Car racing', isCorrect: false, mediaId: null },
          { text: 'Gardening', isCorrect: false, mediaId: null },
        ],
      },
      {
        type: 'POLL',
        text: 'Which workshop should we run next?',
        timeLimitSec: 20,
        options: [
          { text: 'Networking', isCorrect: false, mediaId: null },
          { text: 'Cybersecurity', isCorrect: false, mediaId: null },
          { text: 'Databases', isCorrect: false, mediaId: null },
        ],
      },
      {
        type: 'CONTENT',
        text: 'Thanks for playing!',
        explanation: 'The podium is next.',
        options: [],
      },
    ],
  }),
});
const session = await api('/sessions', {
  method: 'POST',
  body: JSON.stringify({ quizId: quiz.id, settings: { showQuestionOnPlayer: true } }),
});
console.log('[api] session', session.id, 'pin', session.pin);

// --- pages --------------------------------------------------------------------
const host = await hostPage();
const disp = await newPage();
const phone = await newPage(390, 844, false);

// join one player over a raw socket (drives answers); the phone page reuses
// the same credentials through localStorage.
const pSock = await connect({ role: 'player' });
const joinRes = await join(pSock, session.pin, 'Aziza');
if (!joinRes.ok) throw new Error(`join: ${JSON.stringify(joinRes)}`);

await nav(host, `${WEB}/admin`);
await waitBody(host, 'Round A demo');
await sleep(800);
await shot(host, '08-library-cover');

await nav(host, `${WEB}/admin/host/${session.id}`);
await nav(disp, `${WEB}/display/${session.displayKey}`);

const driver = await connect(
  { role: 'host', sessionId: session.id },
  { extraHeaders: { cookie: sidCookie } },
);
const ds = snaps(driver);

await waitBody(disp, 'JOIN WITH PIN');
await sleep(1500);
await shot(disp, '09-lobby-cover');

// phone page joins as the same player
await nav(phone, `${WEB}/`);
await evalJs(
  phone,
  `localStorage.setItem('ictquiz.player', ${JSON.stringify(
    JSON.stringify({
      sessionId: session.id,
      participantId: joinRes.participantId,
      resumeToken: joinRes.resumeToken,
    }),
  )})`,
);
await nav(phone, `${WEB}/play`);
await waitBody(phone, "You're in!");

// editor shots — CONTENT slide is auto-selected (first question)
const editor = await hostPage();
await nav(editor, `${WEB}/admin/quizzes/${quiz.id}`);
await waitBody(editor, 'Content slides have no answers');
await sleep(600);
await shot(editor, '01-editor-content');
await evalJs(
  editor,
  `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Which workshop'))?.click()`,
);
await sleep(600);
await shot(editor, '02-editor-poll');

// play: START → CONTENT_SLIDE
await cmd(driver, 'START');
await waitState(ds, 'CONTENT_SLIDE');
await sleep(900);
await shot(disp, '03-display-content-slide');
await waitBody(host, 'Welcome to ICTWEEK!');
await shot(host, '07-host-content-slide');

// NEXT → countdown → Q1 open
await cmd(driver, 'NEXT');
const open1 = await waitState(ds, 'QUESTION_OPEN');
await answer(pSock, open1.question.attemptId, 'a1', [open1.question.options[0].id]);
await waitState(ds, 'ANSWER_REVEAL');
await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD');
await cmd(driver, 'NEXT');
const openPoll = await waitState(ds, 'QUESTION_OPEN', ds.length);
if (openPoll.question.type !== 'POLL') throw new Error('expected POLL');
await waitBody(phone, 'Which workshop');
await sleep(600);
await shot(phone, '05-player-poll-open');
await answer(pSock, openPoll.question.attemptId, 'v1', [openPoll.question.options[1].id]);
await cmd(driver, 'CLOSE_ANSWERS');
const from = ds.length;
await waitState(ds, 'ANSWER_REVEAL', from - 1);
await sleep(800);
await shot(disp, '04-display-poll-reveal');
await waitBody(phone, 'Thanks for voting!');
await shot(phone, '06-player-poll-thanks');

// sanity: NEXT after the poll goes straight to the closing slide
await cmd(driver, 'NEXT');
await waitState(ds, 'CONTENT_SLIDE', ds.length - 1);
console.log('[driver] closing CONTENT_SLIDE reached — done');
chrome.kill();
process.exit(0);
