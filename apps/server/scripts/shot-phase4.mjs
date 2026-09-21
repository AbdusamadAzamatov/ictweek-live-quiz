// Phase 4 UI smoke: finished-game report page, host lobby + confirm dialog,
// display QUESTION_OPEN with a large image, and (separate mode) host RECOVERY.
// Usage:
//   pnpm exec tsx scripts/shot-phase4.mjs            → shots 01-03, prints recovery session id
//   pnpm exec tsx scripts/shot-phase4.mjs recovery <sessionId> → shot 04 (after API restart)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:3000';
const WEB = 'http://localhost:5173';
const MODE = process.argv[2] ?? 'main';
const RECOVERY_SESSION = process.argv[3] ?? '';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = `${ROOT}artifacts/phase4-screens`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9335;
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
    headers: { 'content-type': 'application/json', cookie: sidCookie, origin: 'http://localhost:5173' },
    ...opts,
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// --- small valid PNG (real magic bytes) ---------------------------------------
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
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const imgPath = `${ROOT}artifacts/tmp/p4-img.png`;
fs.writeFileSync(imgPath, png(640, 360, [0x00, 0x84, 0xff]));

// --- chrome ------------------------------------------------------------------
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  '--user-data-dir=/tmp/ictquiz-p4-profile', '--window-size=1440,900',
  '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());
await new Promise((r) => setTimeout(r, 1500));

const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++seq;
    const to = setTimeout(() => { pending.delete(id); rej(new Error(`${method}: no response`)); }, 20000);
    pending.set(id, (m) => {
      clearTimeout(to);
      if (m.error) rej(new Error(`${method}: ${m.error.message}`));
      else res(m.result);
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
ws.onclose = () => { console.error('chrome ws closed'); process.exit(2); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function newPage() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  return sid;
}
const nav = (s, url) => send('Page.navigate', { url }, s);
const evalJs = async (s, expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)}`);
  return r.result?.value;
};
const shot = async (s, name) => {
  for (let i = 0; i < 4; i++) {
    try {
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
    if (await evalJs(s, `document.body.innerText.includes(${JSON.stringify(text)})`)) return;
    await sleep(300);
  }
  throw new Error(`timeout waiting text "${text}"`);
};

const HELPERS = `
  window.__btn = (txt) => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === txt);
  window.__click = (txt) => { const b = window.__btn(txt); if (!b) throw new Error('no button ' + txt); b.click(); };
`;

const hostPage = async () => {
  const p = await newPage();
  await send('Network.enable', {}, p);
  await send('Network.setCookie', { name: 'sid', value: sidCookie.split('=')[1], domain: 'localhost', path: '/' }, p);
  return p;
};

// --- game driver --------------------------------------------------------------
const { io } = await import('socket.io-client');
const connect = (auth, extra = {}) =>
  new Promise((res, rej) => {
    const s = io(BASE, { auth, reconnection: false, transports: ['websocket'], ...extra });
    s.on('connect', () => res(s)); s.on('connect_error', rej);
  });
const snaps = (s) => { const a = []; s.on('state', (x) => a.push(x)); return a; };
const waitState = (arr, state, from = 0) =>
  new Promise((res, rej) => {
    const t = setInterval(() => {
      const i = arr.findIndex((x, j) => j >= from && x.state === state);
      if (i >= 0) { clearInterval(t); res(arr[i]); }
    }, 25);
    setTimeout(() => { clearInterval(t); rej(new Error('timeout ' + state)); }, 20000);
  });
const cmd = (s, type) => new Promise((r) => s.emit('host:command', { commandId: crypto.randomUUID(), type }, r));
const answer = (s, attemptId, submissionId, optionIds) =>
  new Promise((r) => s.emit('player:answer', { attemptId, submissionId, optionIds }, r));
const join = (s, pin, nickname) => new Promise((r) => s.emit('player:join', { pin, nickname }, r));

if (MODE === 'recovery') {
  // --- host page on a session that boot-recovered to RECOVERY -----------------
  const host = await hostPage();
  await nav(host, `${WEB}/admin/host/${RECOVERY_SESSION}`);
  await waitBody(host, 'RECOVERY', 30000);
  await sleep(1200);
  await shot(host, '04-host-recovery');
  console.log('RECOVERY SHOT DONE');
  chrome.kill();
  process.exit(0);
}

// --- main flow ----------------------------------------------------------------
// media upload → quiz with a big question image
const imgForm = new FormData();
imgForm.append('file', new Blob([fs.readFileSync(imgPath)], { type: 'image/png' }), 'p4.png');
const up = await fetch(`${BASE}/api/media`, {
  method: 'POST',
  headers: { cookie: sidCookie, origin: 'http://localhost:5173' },
  body: imgForm,
});
if (!up.ok) throw new Error(`upload ${up.status} ${await up.text()}`);
const media = await up.json();
console.log('[api] media', media.id);

const { quiz } = await api('/quizzes', { method: 'POST', body: JSON.stringify({ title: 'Phase 4 report demo' }) });
await api(`/quizzes/${quiz.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    title: 'Phase 4 report demo',
    description: '',
    coverMediaId: null,
    questions: [
      {
        type: 'SINGLE',
        text: 'What does ICTWEEK celebrate?',
        mediaId: media.id,
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
        type: 'MULTI',
        text: 'Which are web technologies?',
        mediaId: null,
        timeLimitSec: 20,
        pointsMode: 'DOUBLE',
        explanation: 'HTML and CSS are web technologies.',
        options: [
          { text: 'HTML', isCorrect: true, mediaId: null },
          { text: 'CSS', isCorrect: true, mediaId: null },
          { text: 'JPEG', isCorrect: false, mediaId: null },
          { text: 'MP4', isCorrect: false, mediaId: null },
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

// second session for the RECOVERY shot (driven later, after API restart)
const session2 = await api('/sessions', {
  method: 'POST',
  body: JSON.stringify({ quizId: quiz.id, settings: {} }),
});
console.log('[api] recovery session', session2.id, 'pin', session2.pin);

// pages
const host = await hostPage();
await nav(host, `${WEB}/admin/host/${session.id}`);
await evalJs(host, HELPERS);
const disp = await newPage();
await nav(disp, `${WEB}/display/${session.displayKey}`);

// driver: 3 players (one spreadsheet-hostile nickname for the CSV demo)
const driver = await connect({ role: 'host', sessionId: session.id }, { extraHeaders: { cookie: sidCookie } });
const ds = snaps(driver);
const p1 = await connect({ role: 'player' }); await join(p1, session.pin, 'Nodira');
const p2 = await connect({ role: 'player' }); await join(p2, session.pin, 'Bekzod');
const p3 = await connect({ role: 'player' }); await join(p3, session.pin, '=HYPERLINK("x")');
console.log('[driver] 3 players joined');

await waitBody(host, 'PIN');
await sleep(2500);
// open the End-session confirm dialog for the lobby screenshot
await evalJs(host, `window.__click('End session')`);
await sleep(500);
await shot(host, '01-host-lobby-confirm');
await evalJs(host, `window.__click('Cancel')`);

// play through
await cmd(driver, 'START');
const open1 = await waitState(ds, 'QUESTION_OPEN');
await sleep(1800);
await shot(disp, '02-display-question-open');
const att1 = open1.question.attemptId;
const o1 = open1.question.options;
await answer(p1, att1, 'a1', [o1[0].id]); // correct
await answer(p2, att1, 'a2', [o1[1].id]); // wrong
await waitState(ds, 'ANSWER_REVEAL');
await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD');
await cmd(driver, 'NEXT');
const open2 = await waitState(ds, 'QUESTION_OPEN', ds.length);
const att2 = open2.question.attemptId;
const o2 = open2.question.options;
await answer(p1, att2, 'a3', [o2[0].id, o2[1].id]); // both correct
await answer(p3, att2, 'a4', [o2[0].id]); // partial
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);
await cmd(driver, 'NEXT');
await waitState(ds, 'FINISHED');
console.log('[driver] FINISHED');

// report page
await nav(host, `${WEB}/admin/sessions/${session.id}/report`);
await waitBody(host, 'Standings');
await sleep(1000);
await shot(host, '03-report');

// CSV download for the report
const csvRes = await fetch(`${BASE}/api/sessions/${session.id}/report.csv`, {
  headers: { cookie: sidCookie },
});
const csvText = await csvRes.text();
fs.writeFileSync(`${OUT}/report.csv`, csvText);
console.log('[csv] first 12 lines:\n' + csvText.split('\r\n').slice(0, 12).join('\n'));

// drive session2 to QUESTION_OPEN so a restart drops it into RECOVERY
const driver2 = await connect({ role: 'host', sessionId: session2.id }, { extraHeaders: { cookie: sidCookie } });
const ds2 = snaps(driver2);
const lp = await connect({ role: 'player' }); await join(lp, session2.pin, 'Solo');
await cmd(driver2, 'START');
await waitState(ds2, 'QUESTION_OPEN');
console.log('[driver] session2 at QUESTION_OPEN — restart the API, then run:');
console.log(`  pnpm exec tsx scripts/shot-phase4.mjs recovery ${session2.id}`);
chrome.kill();
process.exit(0);
