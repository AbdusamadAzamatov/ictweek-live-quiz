// Phase 3 UI smoke: drives the quiz editor (3 question types + image upload +
// autosave), the preview page, session settings, and a live display at
// QUESTION_OPEN — capturing screenshots to artifacts/phase3-screens/.
// Usage: pnpm exec tsx scripts/shot-phase3.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';

const BASE = 'http://localhost:3000';
const WEB = 'http://localhost:5173';
const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = `${ROOT}artifacts/phase3-screens`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9334;
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
const { quiz } = await api('/quizzes', {
  method: 'POST',
  body: JSON.stringify({ title: 'Phase 3 smoke quiz' }),
});
console.log('[api] quiz', quiz.id);

// --- a small valid PNG (solid colour, real magic bytes) -----------------------
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
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const imgPath = `${ROOT}artifacts/tmp/smoke-img.png`;
fs.writeFileSync(imgPath, png(120, 80, [0x22, 0xc5, 0x5e]));

// --- chrome ------------------------------------------------------------------
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  '--user-data-dir=/tmp/ictquiz-p3-profile', '--window-size=1440,900',
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
  await send('DOM.enable', {}, sid);
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
const waitEl = async (s, selector, timeout = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJs(s, `!!document.querySelector(${JSON.stringify(selector)})`)) return;
    await sleep(300);
  }
  throw new Error(`timeout waiting element "${selector}"`);
};
const setFile = async (s, selectorIndex) => {
  const { root } = await send('DOM.getDocument', {}, s);
  const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' }, s);
  if (!nodeIds || nodeIds.length <= selectorIndex) throw new Error(`file input #${selectorIndex} not found (${nodeIds?.length} inputs)`);
  await send('DOM.setFileInputFiles', { nodeId: nodeIds[selectorIndex], files: [imgPath] }, s);
  // CDP does not always synthesize change/input events — fire them for React.
  await evalJs(s, `(() => {
    const el = document.querySelectorAll('input[type=file]')[${selectorIndex}];
    if (!el || !el.files.length) throw new Error('file not attached: ' + (el ? el.files.length : 'no input'));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.files[0].name;
  })()`);
};

// js helpers evaluated in page context
const HELPERS = `
  window.__set = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  window.__btn = (txt) => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === txt);
  window.__click = (txt) => { const b = window.__btn(txt); if (!b) throw new Error('no button ' + txt); b.click(); };
  window.__setPh = (ph, v) => { const el = document.querySelector('input[placeholder=' + JSON.stringify(ph) + ']'); if (!el) throw new Error('no input ' + ph); window.__set(el, v); };
`;

// --- editor ------------------------------------------------------------------
const ed = await newPage();
await send('Network.enable', {}, ed);
await send('Network.setCookie', { name: 'sid', value: sidCookie.split('=')[1], domain: 'localhost', path: '/' }, ed);
await nav(ed, `${WEB}/admin/quizzes/${quiz.id}`);
await waitBody(ed, 'Library');
await evalJs(ed, HELPERS);

// title + one SINGLE question
await evalJs(ed, `window.__setPh('Quiz title', 'ICTWEEK Phase 3 demo')`);
await evalJs(ed, `window.__click('+ Single choice')`);
await evalJs(ed, `window.__setPh('Ask something…', 'What does HTTP stand for?')`);
await evalJs(ed, `window.__setPh('Option A', 'HyperText Transfer Protocol')`);
await evalJs(ed, `window.__setPh('Option B', 'High Throughput Transfer Process')`);
await evalJs(ed, `document.querySelector('input[placeholder="Option A"]').closest('div').querySelector('button[title]').click()`);

// TRUE_FALSE
await evalJs(ed, `window.__click('+ True / False')`);
await evalJs(ed, `window.__setPh('Ask something…', 'The web runs on TCP/IP.')`);

// MULTI
await evalJs(ed, `window.__click('+ Multi-select')`);
await evalJs(ed, `window.__setPh('Ask something…', 'Which are programming languages?')`);
await evalJs(ed, `window.__setPh('Option A', 'Python')`);
await evalJs(ed, `window.__setPh('Option B', 'HTML')`);
await evalJs(ed, `document.querySelector('input[placeholder="Option A"]').closest('div').querySelector('button[title]').click()`);
await evalJs(ed, `document.querySelector('input[placeholder="Option B"]').closest('div').querySelector('button[title]').click()`);

// back to Q1 and attach the image to the QUESTION media field (input[type=file] index 1; index 0 is the cover)
await evalJs(ed, `[...document.querySelectorAll('button span')].find((s) => s.textContent.trim() === '1.').closest('button').click()`);
await sleep(400);
await setFile(ed, 1);
await waitEl(ed, 'input[placeholder="Alt text"]');
await evalJs(ed, `(() => { const el = document.querySelector('input[placeholder="Alt text"]'); window.__set(el, 'ICTWEEK demo image'); el.dispatchEvent(new Event('blur', { bubbles: true })); })()`);

// autosave pill
await waitBody(ed, 'Saved', 30000);
await sleep(500);
await shot(ed, '01-editor');
console.log('[ui] editor Saved');

// --- preview -----------------------------------------------------------------
await nav(ed, `${WEB}/admin/quizzes/${quiz.id}/preview`);
await waitBody(ed, 'What does HTTP stand for?', 25000);
await sleep(800);
await shot(ed, '02-preview');

// --- session settings -> host -------------------------------------------------
await nav(ed, `${WEB}/admin/sessions/new?quizId=${quiz.id}`);
await waitBody(ed, 'Host a session');
await evalJs(ed, HELPERS);
await evalJs(ed, `window.__click('Start session')`);
{
  const t0 = Date.now();
  let url = '';
  while (Date.now() - t0 < 20000) {
    url = await evalJs(ed, 'location.href');
    if (url.includes('/admin/host/')) break;
    await sleep(300);
  }
  if (!url.includes('/admin/host/')) throw new Error('did not navigate to host page: ' + url);
  var sessionId = url.split('/admin/host/')[1].split(/[?#]/)[0];
}
console.log('[ui] session', sessionId);
const session = await api(`/sessions/${sessionId}`);
console.log('[api] pin', session.session.pin, 'displayKey set:', !!session.session.displayKey);

// --- live display at QUESTION_OPEN --------------------------------------------
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

const driver = await connect({ role: 'host', sessionId }, { extraHeaders: { cookie: sidCookie } });
const ds = snaps(driver);
const pSock = await connect({ role: 'player' });
await new Promise((r) => pSock.emit('player:join', { pin: session.session.pin, nickname: 'ShotPlayer' }, r));

const disp = await newPage();
await nav(disp, `${WEB}/display/${session.session.displayKey}`);
await sleep(2500);

await cmd(driver, 'START');
await waitState(ds, 'QUESTION_OPEN');
await sleep(1500);
await shot(disp, '03-display-question-open');

console.log('PHASE3 SHOTS DONE');
chrome.kill();
process.exit(0);
