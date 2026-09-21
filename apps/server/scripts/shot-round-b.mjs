// Round B UI pass: 390x844 phone journey + 1920x1080 projector + account page.
// Screenshots → artifacts/round-b-screens/
// Usage: pnpm exec tsx scripts/shot-round-b.mjs   (dev API :3000 + vite :5173 up)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:3000';
const WEB = 'http://localhost:5173';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = `${ROOT}artifacts/round-b-screens`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9346;
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(`${ROOT}artifacts/tmp`, { recursive: true });

// --- api ----------------------------------------------------------------------
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

// --- PNG ----------------------------------------------------------------------
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
const imgPath = `${ROOT}artifacts/tmp/rb-img.png`;
fs.writeFileSync(imgPath, png(800, 450, [0x00, 0xa0, 0x64]));

// --- chrome -------------------------------------------------------------------
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--user-data-dir=/tmp/ictquiz-rb-profile',
    '--window-size=1920,1080',
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
async function newPage(width = 1440, height = 900) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
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

const HELPERS = `
  window.__btn = (txt) => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === txt);
  window.__btnHas = (txt) => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.includes(txt));
  window.__click = (txt) => { const b = window.__btn(txt); if (!b) throw new Error('no button ' + txt); b.click(); };
  window.__clickHas = (txt) => { const b = window.__btnHas(txt); if (!b) throw new Error('no button ~' + txt); b.click(); };
  window.__set = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('no input ' + sel);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
`;

const adminPage = async () => {
  const p = await newPage();
  await send('Network.enable', {}, p);
  await send(
    'Network.setCookie',
    { name: 'sid', value: sidCookie.split('=')[1], domain: 'localhost', path: '/' },
    p,
  );
  return p;
};

// --- sockets ------------------------------------------------------------------
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
    }, 25000);
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

// --- deck ----------------------------------------------------------------------
const imgForm = new FormData();
imgForm.append(
  'file',
  new Blob([fs.readFileSync(imgPath)], { type: 'image/png' }),
  'qimg.png',
);
const up = await fetch(`${BASE}/api/media`, {
  method: 'POST',
  headers: { cookie: sidCookie, origin: 'http://localhost:5173' },
  body: imgForm,
});
if (!up.ok) throw new Error(`upload ${up.status}`);
const media = await up.json();

const { quiz } = await api('/quizzes', {
  method: 'POST',
  body: JSON.stringify({ title: 'Round B screens' }),
});
await api(`/quizzes/${quiz.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    title: 'Round B screens',
    description: '',
    questions: [
      {
        type: 'SINGLE',
        text: 'Which protocol secures web traffic?',
        mediaId: media.id,
        timeLimitSec: 20,
        pointsMode: 'STANDARD',
        options: [
          { text: 'HTTPS', isCorrect: true, mediaId: null },
          { text: 'FTP', isCorrect: false, mediaId: null },
          { text: 'SMTP', isCorrect: false, mediaId: null },
          { text: 'DHCP', isCorrect: false, mediaId: null },
        ],
      },
      {
        type: 'MULTI',
        text: 'Which of these are programming languages?',
        timeLimitSec: 20,
        pointsMode: 'DOUBLE',
        options: [
          { text: 'Python', isCorrect: true, mediaId: null },
          { text: 'HTML', isCorrect: false, mediaId: null },
          { text: 'Rust', isCorrect: true, mediaId: null },
          { text: 'HTTP', isCorrect: false, mediaId: null },
        ],
      },
      {
        type: 'SINGLE',
        text: 'What does VPN stand for?',
        timeLimitSec: 20,
        pointsMode: 'STANDARD',
        options: [
          { text: 'Virtual Private Network', isCorrect: true, mediaId: null },
          { text: 'Very Public Network', isCorrect: false, mediaId: null },
          { text: 'Virtual Port Number', isCorrect: false, mediaId: null },
          { text: 'Verified Personal Node', isCorrect: false, mediaId: null },
        ],
      },
    ],
  }),
});
const session = await api('/sessions', {
  method: 'POST',
  body: JSON.stringify({ quizId: quiz.id, settings: { showQuestionOnPlayer: true } }),
});
console.log('[api] session', session.id, 'pin', session.pin);

// --- pages ---------------------------------------------------------------------
const phone = await newPage(390, 844);
const disp = await newPage(1920, 1080);

// phone: join via the real UI flow
await nav(phone, `${WEB}/`);
await evalJs(phone, HELPERS);
await waitBody(phone, 'Enter the game PIN');
await shot(phone, '01-phone-join-pin');
await evalJs(phone, `window.__set('input', '${session.pin}')`);
await evalJs(phone, `window.__click('Join game')`);
await evalJs(phone, HELPERS);
await waitBody(phone, 'Enter lobby');
await shot(phone, '02-phone-nickname');
await evalJs(phone, `window.__set('input', 'Aziza')`);
await evalJs(phone, `window.__click('Enter lobby')`);
await evalJs(phone, HELPERS);
await waitBody(phone, "You're in!");
await sleep(400);
await shot(phone, '03-phone-lobby');

// 30 more players via sockets (lobby crowd + leaderboard)
const players = [];
for (let i = 1; i <= 30; i++) {
  const s = await connect({ role: 'player' });
  const r = await join(s, session.pin, `Player ${String(i).padStart(2, '0')}`);
  if (!r.ok) throw new Error(`join P${i}: ${JSON.stringify(r)}`);
  players.push(s);
}
console.log('[driver] 30 players joined');

await nav(disp, `${WEB}/display/${session.displayKey}`);
await waitBody(disp, 'JOIN WITH PIN');
await waitBody(disp, 'Player 30');
await sleep(1500);
await shot(disp, '10-display-lobby-1080p');

// admin: banner + account page
const admin = await adminPage();
await nav(admin, `${WEB}/admin`);
await evalJs(admin, HELPERS);
await waitBody(admin, 'Change it now');
await sleep(600);
await shot(admin, '15-admin-banner');
await nav(admin, `${WEB}/admin/account`);
await waitBody(admin, 'Confirm new password');
await sleep(500);
await shot(admin, '16-admin-account');

// --- play ----------------------------------------------------------------------
const driver = await connect(
  { role: 'host', sessionId: session.id },
  { extraHeaders: { cookie: sidCookie } },
);
const ds = snaps(driver);
await cmd(driver, 'START');
const open1 = await waitState(ds, 'QUESTION_OPEN');

// phone sees the question grid
await waitBody(phone, 'Which protocol');
await sleep(500);
await shot(phone, '04-phone-single-open');

// display: question open with image
await waitBody(disp, 'Which protocol');
await sleep(400);
await shot(disp, '11-display-question-open-1080p');

// phone answers Q1 correctly via UI tap; players 1-29 answer too, P30 stays silent
await evalJs(phone, `window.__clickHas('HTTPS')`);
await waitBody(phone, 'Answer sent');
await shot(phone, '06-phone-answer-sent');
const att1 = open1.question.attemptId;
const o1 = open1.question.options;
await Promise.all(
  players.slice(0, 29).map((s, i) =>
    answer(s, att1, `q1-${i}`, [o1[i % 2 === 0 ? 0 : 1].id]),
  ),
);
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL');
await sleep(900);
await shot(phone, '07-phone-reveal-points');
await shot(disp, '12-display-reveal-1080p');

await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD');
await sleep(900);
await shot(phone, '08-phone-leaderboard');
await shot(disp, '13-display-leaderboard-1080p');

// Q2 MULTI
await cmd(driver, 'NEXT');
const open2 = await waitState(ds, 'QUESTION_OPEN', ds.length);
await waitBody(phone, 'programming languages');
await sleep(500);
await evalJs(phone, `window.__clickHas('Python')`);
await evalJs(phone, `window.__clickHas('Rust')`);
await sleep(300);
await shot(phone, '05-phone-multi-submit');
await evalJs(phone, `window.__clickHas('Submit')`);
await waitBody(phone, 'Answer sent');
const att2 = open2.question.attemptId;
const o2 = open2.question.options;
const correct2 = o2.filter((o) => o.text === 'Python' || o.text === 'Rust').map((o) => o.id);
await Promise.all(
  players.slice(0, 29).map((s, i) =>
    answer(s, att2, `q2-${i}`, i % 3 === 0 ? correct2 : [o2[0].id]),
  ),
);
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);

await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD', ds.length - 1);
await cmd(driver, 'NEXT');
const open3 = await waitState(ds, 'QUESTION_OPEN', ds.length);
await waitBody(phone, 'VPN');
await evalJs(phone, `window.__clickHas('Virtual Private Network')`);
await waitBody(phone, 'Answer sent');
const att3 = open3.question.attemptId;
const o3 = open3.question.options;
await Promise.all(
  players.slice(0, 29).map((s, i) =>
    answer(s, att3, `q3-${i}`, [o3[i % 4].id]),
  ),
);
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);
await cmd(driver, 'NEXT');
await waitState(ds, 'FINISHED');
await sleep(1200);
await shot(phone, '09-phone-podium');
await shot(disp, '14-display-podium-1080p');
console.log('[driver] FINISHED');

// --- A4: change password through the real UI ------------------------------------
await nav(admin, `${WEB}/admin/account`);
await evalJs(admin, HELPERS);
await waitBody(admin, 'Confirm new password');
await evalJs(
  admin,
  `(() => {
    const inputs = [...document.querySelectorAll('input[type=password]')];
    const set = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(inputs[0], 'ChangeMe123!');
    set(inputs[1], 'RoundB-pass-456!');
    set(inputs[2], 'RoundB-pass-456!');
  })()`,
);
await evalJs(admin, `window.__click('Change password')`);
await waitBody(admin, 'Password changed — other devices were signed out');
await sleep(800);
await shot(admin, '17-account-changed');
const bannerGone = await evalJs(
  admin,
  `!document.body.innerText.includes('still using the initial password')`,
);
console.log('[a4] password changed via UI; banner gone:', bannerGone);

chrome.kill();
process.exit(0);
