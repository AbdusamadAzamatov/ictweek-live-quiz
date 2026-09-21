// Usability review pass: full screenshot set of every screen on the LAN stack.
// Target: http://192.168.1.161 (compose, production build, PUBLIC_URL=http://192.168.1.161)
// Screenshots → artifacts/usability/
// Usage: pnpm exec tsx scripts/shot-usability.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'http://192.168.1.161';
const WEB = BASE;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = `${ROOT}artifacts/usability`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9347;
const EMAIL = 'admin@example.com';
const PASSWORD = 'ChangeMe123!';
const QUIZ_TITLE = 'ICTWEEK — ICT Basics';
fs.mkdirSync(OUT, { recursive: true });

// --- api ----------------------------------------------------------------------
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: BASE },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const sidCookie = login.headers.get('set-cookie').split(';')[0];
const sidValue = sidCookie.split('=')[1];
console.log('[api] logged in');

const api = async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, {
    headers: {
      'content-type': 'application/json',
      cookie: sidCookie,
      origin: BASE,
    },
    ...opts,
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// Pick the named quiz — but only one that has the CONTENT slide + POLL needed
// for the shot list; older imports of the sample lack them, so re-import.
const { quizzes } = await api('/quizzes');
let quiz = null;
for (const q of quizzes.filter((x) => x.title === QUIZ_TITLE)) {
  const full = await api(`/quizzes/${q.id}`);
  const types = full.quiz.questions.map((x) => x.type);
  if (types.includes('CONTENT') && types.includes('POLL')) {
    quiz = full.quiz;
    break;
  }
}
if (!quiz) {
  const sample = JSON.parse(
    fs.readFileSync(`${ROOT}docs/samples/sample-quiz.json`, 'utf8'),
  );
  const imported = await api('/quizzes/import', {
    method: 'POST',
    body: JSON.stringify(sample),
  });
  quiz = imported.quiz;
  console.log('[api] imported sample quiz', quiz.id);
} else {
  console.log('[api] using quiz', quiz.id);
}

const session = await api('/sessions', {
  method: 'POST',
  body: JSON.stringify({ quizId: quiz.id }),
});
console.log('[api] session', session.id, 'pin', session.pin);

// --- chrome -------------------------------------------------------------------
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--user-data-dir=/tmp/ictquiz-usa-profile',
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
const contexts = [];
async function newPage(width = 1440, height = 900, { mobile = false, ownContext = false } = {}) {
  let browserContextId;
  if (ownContext) {
    ({ browserContextId } = await send('Target.createBrowserContext'));
    contexts.push(browserContextId);
  }
  const { targetId } = await send('Target.createTarget', {
    url: 'about:blank',
    ...(browserContextId ? { browserContextId } : {}),
  });
  const { sessionId: sid } = await send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile },
    sid,
  );
  if (mobile) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true }, sid);
    await send(
      'Emulation.setUserAgentOverride',
      {
        userAgent:
          'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
      },
      sid,
    );
  }
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
  window.__cards = () => [...document.querySelectorAll('button')]
    .filter((b) => /^[▲◆●■⬟★]/.test(b.textContent.trim()));
  window.__card = (i) => { const c = window.__cards()[i]; if (!c) throw new Error('no card ' + i); c.click(); };
  window.__clickAria = (label) => { const b = document.querySelector('[aria-label=' + JSON.stringify(label) + ']'); if (!b) throw new Error('no [aria-label] ' + label); b.click(); };
`;

const adminPage = async () => {
  const p = await newPage();
  await send('Network.enable', {}, p);
  await send(
    'Network.setCookie',
    { name: 'sid', value: sidValue, domain: '192.168.1.161', path: '/' },
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
    }, 30000);
  });
const cmd = (s, type, participantId) =>
  new Promise((r) =>
    s.emit(
      'host:command',
      { commandId: crypto.randomUUID(), type, payload: participantId ? { participantId } : undefined },
      r,
    ),
  );

// --- phone helpers ------------------------------------------------------------
const newPhone = () => newPage(390, 844, { mobile: true, ownContext: true });
const joinViaUi = async (phone, pin, nickname, { waitFor = "You're in!" } = {}) => {
  await nav(phone, `${WEB}/join/${pin}`);
  await evalJs(phone, HELPERS);
  await waitBody(phone, 'Enter lobby');
  await evalJs(phone, `window.__set('input', ${JSON.stringify(nickname)})`);
  await evalJs(phone, `window.__click('Enter lobby')`);
  await evalJs(phone, HELPERS);
  await waitBody(phone, waitFor);
};

// ===============================================================================
// DESKTOP SETUP SHOTS
// ===============================================================================
const loginPg = await newPage(1440, 900, { ownContext: true });
await nav(loginPg, `${WEB}/admin/login`);
await waitBody(loginPg, 'Sign in');
await sleep(400);
await shot(loginPg, '01-login');

const admin = await adminPage();
await nav(admin, `${WEB}/admin`);
await evalJs(admin, HELPERS);
await waitBody(admin, QUIZ_TITLE);
await sleep(600);
await shot(admin, '02-library');

await nav(admin, `${WEB}/admin/quizzes/${quiz.id}`);
await evalJs(admin, HELPERS);
await waitBody(admin, 'What does "HTTP" stand for?');
await sleep(600);
await evalJs(admin, `window.__clickHas(${JSON.stringify('What does "HTTP" stand for?')})`);
await sleep(700);
await shot(admin, '03-editor-single');
await evalJs(admin, `window.__clickHas('Welcome to ICTWEEK')`);
await sleep(700);
await shot(admin, '04-editor-content');
await evalJs(admin, `window.__clickHas('Which topic should we dive into')`);
await sleep(700);
await shot(admin, '05-editor-poll');

await nav(admin, `${WEB}/admin/sessions/new?quizId=${quiz.id}`);
await evalJs(admin, HELPERS);
await waitBody(admin, 'Host a session');
await waitBody(admin, QUIZ_TITLE);
await sleep(600);
await shot(admin, '06-session-settings');

await nav(admin, `${WEB}/admin/host/${session.id}`);
await evalJs(admin, HELPERS);
await waitBody(admin, 'PIN');
await waitBody(admin, 'Players (0)');
await sleep(700);
await shot(admin, '07-host-lobby-empty');

// ===============================================================================
// PHONE JOINS (real UI)
// ===============================================================================
const phoneA = await newPhone();
await nav(phoneA, `${WEB}/`);
await evalJs(phoneA, HELPERS);
await waitBody(phoneA, 'Enter the game PIN');
await sleep(400);
await shot(phoneA, '50-phone-home-pin');

await evalJs(phoneA, `window.__set('input', '000000')`);
await evalJs(phoneA, `window.__click('Join game')`);
await waitBody(phoneA, 'Game not found');
await sleep(300);
await shot(phoneA, '51-phone-pin-error');

await evalJs(phoneA, `window.__set('input', '${session.pin}')`);
await evalJs(phoneA, `window.__click('Join game')`);
await evalJs(phoneA, HELPERS);
await waitBody(phoneA, 'Enter lobby');
await sleep(300);
await shot(phoneA, '52-phone-nickname');

await evalJs(phoneA, `window.__set('input', 'Aziza')`);
await evalJs(phoneA, `window.__click('Enter lobby')`);
await evalJs(phoneA, HELPERS);
await waitBody(phoneA, "You're in!");

const phoneB = await newPhone();
await nav(phoneB, `${WEB}/join/${session.pin}`);
await evalJs(phoneB, HELPERS);
await waitBody(phoneB, 'Enter lobby');
await evalJs(phoneB, `window.__set('input', 'Aziza')`);
await evalJs(phoneB, `window.__click('Enter lobby')`);
await waitBody(phoneB, 'taken');
await sleep(300);
await shot(phoneB, '53-phone-nickname-taken');
await evalJs(phoneB, `window.__set('input', 'Bekzod')`);
await evalJs(phoneB, `window.__click('Enter lobby')`);
await evalJs(phoneB, HELPERS);
await waitBody(phoneB, "You're in!");

const phoneC = await newPhone();
await joinViaUi(phoneC, session.pin, 'Dilnoza');
await sleep(400);
await shot(phoneC, '54-phone-lobby');

console.log('[driver] 3 players joined via UI');

await waitBody(admin, 'Players (3)');
await sleep(500);
await shot(admin, '08-host-lobby-3players');

const disp = await newPage(1920, 1080);
await nav(disp, `${WEB}/display/${session.displayKey}`);
await waitBody(disp, 'JOIN WITH PIN');
await waitBody(disp, 'Dilnoza');
await sleep(1000);
await shot(disp, '30-display-lobby');

// small-laptop host view, parked until Q1 opens
const host1280 = await adminPage();
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
  host1280,
);
await nav(host1280, `${WEB}/admin/host/${session.id}`);

// ===============================================================================
// GAME DRIVE
// ===============================================================================
const driver = await connect(
  { role: 'host', sessionId: session.id },
  { extraHeaders: { cookie: sidCookie } },
);
const ds = snaps(driver);
const openNextQuestion = () => waitState(ds, 'QUESTION_OPEN', ds.length);

await cmd(driver, 'START');
await waitState(ds, 'CONTENT_SLIDE');
await waitBody(admin, 'SLIDE 1/');
await sleep(500);
await shot(admin, '09-host-content-slide');
await waitBody(disp, 'Welcome to ICTWEEK');
await sleep(400);
await shot(disp, '31-display-content-slide');
await waitBody(phoneA, 'Look at the screen');
await sleep(300);
await shot(phoneA, '55-phone-content-slide');

// → COUNTDOWN into Q1 (SINGLE "HTTP")
await cmd(driver, 'NEXT');
await waitState(ds, 'COUNTDOWN');
await waitBody(disp, 'Get ready');
await shot(admin, '10-host-countdown');
await shot(disp, '32-display-countdown');
await shot(phoneA, '56-phone-countdown');

await openNextQuestion();
await waitBody(disp, 'What does "HTTP" stand for?');
await sleep(500);
await shot(admin, '11-host-question-open');
await shot(disp, '33-display-question-open');
await sleep(400);
await shot(phoneA, '57-phone-question-open');
await waitBody(host1280, 'What does "HTTP" stand for?');
await sleep(400);
await shot(host1280, '21-host-question-open-1280');

// late joiner during Q1 — lands on "Hold tight" instead of the lobby
const phoneD = await newPhone();
await joinViaUi(phoneD, session.pin, 'Sardor', { waitFor: 'Hold tight' });
await waitBody(phoneD, 'Hold tight');
await sleep(300);
await shot(phoneD, '65-phone-late-join');

// 2 of 3 answer: Aziza correct (A), Bekzod wrong (B)
await evalJs(phoneA, `window.__card(0)`);
await waitBody(phoneA, 'Answer sent');
await sleep(300);
await shot(phoneA, '58-phone-answer-sent');
await evalJs(phoneB, `window.__card(1)`);
await waitBody(phoneB, 'Answer sent');
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL');
await waitBody(admin, 'Answer reveal');
await sleep(600);
await shot(admin, '12-host-reveal');
await shot(disp, '34-display-reveal');
await waitBody(phoneA, 'Correct!');
await shot(phoneA, '59-phone-reveal-correct');
await waitBody(phoneB, 'Incorrect');
await shot(phoneB, '60-phone-reveal-wrong');

await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD');
await sleep(800);
await shot(admin, '13-host-leaderboard');
await waitBody(disp, 'Leaderboard');
await sleep(400);
await shot(disp, '35-display-leaderboard');
await waitBody(phoneA, "You're #");
await sleep(300);
await shot(phoneA, '61-phone-leaderboard');

// Q2 TRUE_FALSE — drive through without answers
await cmd(driver, 'NEXT');
await waitState(ds, 'QUESTION_OPEN', ds.length - 1);
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);
await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD', ds.length - 1);

// Q3 MULTI — phone A selects two options, Submit visible
await cmd(driver, 'NEXT');
await waitState(ds, 'QUESTION_OPEN', ds.length - 1);
await sleep(600);
await evalJs(phoneA, `window.__card(0)`);
await evalJs(phoneA, `window.__card(2)`);
await sleep(400);
await shot(phoneA, '62-phone-multi-open');
await evalJs(phoneA, `window.__clickHas('Submit')`);
await waitBody(phoneA, 'Answer sent');
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);
await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD', ds.length - 1);

// Q4 SINGLE — pass through
await cmd(driver, 'NEXT');
await waitState(ds, 'QUESTION_OPEN', ds.length - 1);
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);
await cmd(driver, 'NEXT');
await waitState(ds, 'LEADERBOARD', ds.length - 1);

// Q5 POLL — open, vote, reveal (no leaderboard after a poll)
await cmd(driver, 'NEXT');
await waitState(ds, 'QUESTION_OPEN', ds.length - 1);
await waitBody(disp, 'workshop');
await sleep(500);
await shot(admin, '14-host-poll-open');
await sleep(300);
await shot(phoneA, '63-phone-poll-open');
await evalJs(phoneA, `window.__card(0)`);
await waitBody(phoneA, 'Vote sent');
await evalJs(phoneB, `window.__card(1)`);
await waitBody(phoneB, 'Vote sent');
await evalJs(phoneC, `window.__card(0)`);
await waitBody(phoneC, 'Vote sent');
await cmd(driver, 'CLOSE_ANSWERS');
await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);
await sleep(800);
await shot(disp, '36-display-poll-reveal');
await waitBody(phoneA, 'Thanks for voting!');
await sleep(300);
await shot(phoneA, '64-phone-poll-thanks');

// remove the late joiner through the host UI (× → confirm) while the game continues
const sardor = ds[ds.length - 1]?.host?.participants?.find(
  (p) => p.nickname === 'Sardor',
);
if (sardor) {
  await evalJs(admin, `window.__clickAria('Remove Sardor')`);
  await waitBody(admin, 'Remove Sardor?');
  await evalJs(admin, `window.__click('Remove')`);
  await sleep(2000);
  // NOTE: the real render here may be a blank page — see driver report.
  console.log(
    '[check] phoneD after removal:',
    JSON.stringify((await evalJs(phoneD, 'document.body.innerText')).slice(0, 200)),
  );
  await shot(phoneD, '67-phone-removed');
} else {
  console.log('[warn] Sardor not found in host snapshot — 67 skipped');
}

// Q6 MULTI → Q7 T/F → Q8 SINGLE → Q9 MULTI → FINISHED
for (let i = 0; i < 4; i++) {
  await cmd(driver, 'NEXT');
  await waitState(ds, 'QUESTION_OPEN', ds.length - 1);
  await cmd(driver, 'CLOSE_ANSWERS');
  await waitState(ds, 'ANSWER_REVEAL', ds.length - 1);
  await cmd(driver, 'NEXT');
  const last = ds[ds.length - 1];
  if (last.state === 'FINISHED') break;
  await waitState(ds, 'LEADERBOARD', ds.length - 2);
}
await waitState(ds, 'FINISHED');
await sleep(1200);
await shot(admin, '15-host-podium');
await shot(disp, '37-display-podium');
await waitBody(phoneA, 'Thanks for playing');
await sleep(300);
await shot(phoneA, '66-phone-finished');
console.log('[driver] FINISHED');

// ===============================================================================
// POST-GAME DESKTOP SHOTS
// ===============================================================================
await nav(admin, `${WEB}/admin/sessions/${session.id}/report`);
await evalJs(admin, HELPERS);
await waitBody(admin, 'Standings');
await sleep(700);
await shot(admin, '16-report');

await nav(admin, `${WEB}/admin/account`);
await waitBody(admin, 'Confirm new password');
await sleep(500);
await shot(admin, '17-account');

await nav(admin, `${WEB}/admin/diagnostics`);
await waitBody(admin, 'Diagnostics');
await sleep(800);
await shot(admin, '18-diagnostics');

// second session → host page → End session dialog
const session2 = await api('/sessions', {
  method: 'POST',
  body: JSON.stringify({ quizId: quiz.id }),
});
await nav(admin, `${WEB}/admin/host/${session2.id}`);
await evalJs(admin, HELPERS);
await waitBody(admin, 'PIN');
await sleep(500);
await evalJs(admin, `window.__click('End session')`);
await waitBody(admin, 'End this session for everyone?');
await sleep(300);
await shot(admin, '19-host-end-confirm');
await evalJs(admin, `window.__click('Cancel')`);

// optional: reconnecting pill on a phone
try {
  await send('Network.enable', {}, phoneA);
  await send(
    'Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
    phoneA,
  );
  await waitBody(phoneA, 'Reconnecting', 8000);
  await sleep(300);
  await shot(phoneA, '68-phone-reconnecting');
  await send(
    'Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    phoneA,
  );
} catch {
  console.log('[warn] reconnecting pill not captured — 68 skipped');
}

console.log('[done] artifacts in', OUT);
process.exit(0);
