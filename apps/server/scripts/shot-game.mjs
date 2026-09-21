// Headless-Chrome screenshot run: drives a live game via sockets and captures
// host / display / player screens at LOBBY, QUESTION_OPEN and ANSWER_REVEAL.
// Usage: pnpm exec tsx scripts/shot-game.mjs <sessionId> <pin> <displayKey> <sidCookie> <outDir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [sessionId, pin, displayKey, sidCookie, outDir] = process.argv.slice(2);
const BASE = 'http://localhost:3000';
const WEB = 'http://localhost:5173';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9333;
fs.mkdirSync(outDir, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  '--user-data-dir=/tmp/ictquiz-shot-profile', '--window-size=1440,900',
  '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
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
    const to = setTimeout(() => { pending.delete(id); rej(new Error(`${method}: no response`)); }, 15000);
    pending.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result); });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
ws.onclose = () => { console.error('chrome ws closed'); process.exit(2); };

async function newPage() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  return sid;
}
const nav = (s, url) => send('Page.navigate', { url }, s);
const evalJs = async (s, expr) =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s)).result?.value;
const shot = async (s, name) => {
  for (let i = 0; i < 4; i++) {
    try {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, s);
      fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, 'base64'));
      console.log('[shot]', name);
      return;
    } catch (e) {
      if (i === 3) throw e;
      await sleep(700);
    }
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitText = async (s, text, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJs(s, `document.body.innerText.includes(${JSON.stringify(text)})`)) return true;
    await sleep(300);
  }
  throw new Error(`timeout waiting text "${text}"`);
};

// --- game driver sockets -----------------------------------------------------
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
const join = await new Promise((r) => pSock.emit('player:join', { pin, nickname: 'DemoPlayer' }, r));
console.log('[driver] player joined', join.participantId);

// --- pages -------------------------------------------------------------------
const host = await newPage();
await send('Network.enable', {}, host);
await send('Network.setCookie', { name: 'sid', value: sidCookie.split('=')[1], domain: 'localhost', path: '/' }, host);
await nav(host, `${WEB}/admin/host/${sessionId}`);

const disp = await newPage();
await nav(disp, `${WEB}/display/${displayKey}`);

const play = await newPage();
await nav(play, `${WEB}/`);
await evalJs(play, `localStorage.setItem('ictquiz.player', ${JSON.stringify(JSON.stringify({ sessionId, participantId: join.participantId, resumeToken: join.resumeToken }))})`);
await nav(play, `${WEB}/play`);

await sleep(3500);
await shot(disp, '01-display-lobby');
await shot(host, '02-host-lobby');
await shot(play, '03-player-lobby');

// --- QUESTION_OPEN -----------------------------------------------------------
console.log('[driver] START', JSON.stringify(await cmd(driver, 'START')));
const open = await waitState(ds, 'QUESTION_OPEN');
await sleep(1200);
await shot(disp, '04-display-question-open');
await shot(host, '05-host-question-open');
await shot(play, '06-player-question-open');

// --- ANSWER_REVEAL -----------------------------------------------------------
const ans = await new Promise((r) =>
  pSock.emit('player:answer', { attemptId: open.question.attemptId, submissionId: 'shot-1', optionIds: [open.question.options[0].id] }, r));
console.log('[driver] answer ack', ans.status);
await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);
await sleep(1200);
await shot(disp, '07-display-reveal');
await shot(host, '08-host-reveal');
await shot(play, '09-player-reveal');

// --- leaderboard + finished for good measure ----------------------------------
await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD');
await sleep(1000);
await shot(disp, '10-display-leaderboard');
await cmd(driver, 'NEXT');
await waitState(ds, 'QUESTION_OPEN', ds.length);
console.log('[driver] END');
await cmd(driver, 'END');
await waitState(ds, 'FINISHED');
await sleep(1500);
await shot(disp, '11-display-podium');
await shot(play, '12-player-finished');
await shot(host, '13-host-finished');

console.log('SHOTS DONE');
chrome.kill();
process.exit(0);
