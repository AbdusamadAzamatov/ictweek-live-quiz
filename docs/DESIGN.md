# ICTWEEK Live Quiz — Technical Design (Release A, event build)

This is the authoritative implementation spec. The plan and original prompt live in `docs/plan/`.
Where this file and the plan disagree, this file wins (it records the decisions made for the event build).

## 0. Event-build scope decisions

- Event is within 1–2 days. Release A only, frozen once verified.
- Question types in scope: `SINGLE` (single choice, 2–6 options), `TRUE_FALSE`, `MULTI` (multi-select, 2–6 options).
  `POLL` and `CONTENT` slides are deferred to Release B (schema enum reserves them; UI/engine reject them for now).
- Fonts: local system font stack. `--font-display` token exists so TT Travels Next can be dropped in later.
- One application instance. No Redis.
- Team play, accuracy mode, auto-advance, generated nicknames, typed answers: out of scope.

## 1. Repository layout (pnpm workspaces)

```
/
├── package.json                # workspace root: scripts lint/typecheck/test/build
├── pnpm-workspace.yaml
├── packages/shared/            # zod schemas, types, scoring, ranking, quiz validation, socket contract
├── apps/server/                # Fastify + Socket.IO + Prisma (also serves built web in prod)
├── apps/web/                   # React + Vite + Tailwind v4
├── scripts/                    # load-test, create-organizer
├── docker/
│   ├── compose.dev.yml         # local Postgres only (port 5432) + init sql creating ictquiz_test
│   ├── Dockerfile              # multi-stage app image
│   ├── compose.yml             # production: db + app + caddy
│   ├── Caddyfile
│   └── .env.example
└── docs/
    ├── DESIGN.md               # this file
    ├── PARITY_MATRIX.md        # reference behaviour vs implementation vs test vs difference
    ├── TEST_REPORT.md          # actual results (only what really ran)
    ├── runbooks/               # deploy, backup-restore, rollback, event-day
    └── plan/                   # original plan + prompt
```

Naming: package names `@ictquiz/shared`, `@ictquiz/server`, `@ictquiz/web`. TypeScript strict everywhere. ESLint flat config + Prettier.
Pick current stable versions published at least 7 days ago; commit `pnpm-lock.yaml`.

## 2. Data model (Prisma, PostgreSQL)

```prisma
enum QuestionType { SINGLE TRUE_FALSE MULTI POLL CONTENT }
enum PointsMode   { NONE STANDARD DOUBLE }
enum SessionState { LOBBY COUNTDOWN QUESTION_OPEN QUESTION_CLOSED ANSWER_REVEAL LEADERBOARD FINISHED CANCELLED RECOVERY }
enum ParticipantStatus { ACTIVE REMOVED }
enum AttemptStatus { OPEN CLOSED VOIDED }

model Organizer        { id String @id @default(uuid()); email String @unique; passwordHash String; createdAt DateTime @default(now()); sessions OrganizerSession[]; quizzes Quiz[]; media MediaAsset[]; gameSessions GameSession[] }
model OrganizerSession { id String @id; /* sha256(token) hex */ organizerId String; expiresAt DateTime; createdAt DateTime @default(now()); organizer Organizer @relation(...) }

model Quiz         { id String @id @default(uuid()); organizerId String; title String; description String @default(""); coverMediaId String?; createdAt DateTime @default(now()); updatedAt DateTime @updatedAt; questions Question[]; ... }
model Question     { id String @id @default(uuid()); quizId String; order Int; type QuestionType; text String @default(""); mediaId String?; timeLimitSec Int @default(20); pointsMode PointsMode @default(STANDARD); explanation String @default(""); options AnswerOption[]; @@unique([quizId, order]) }
model AnswerOption { id String @id @default(uuid()); questionId String; order Int; text String @default(""); mediaId String?; isCorrect Boolean @default(false); @@unique([questionId, order]) }
model MediaAsset   { id String @id @default(uuid()); organizerId String; originalName String; mimeType String; sizeBytes Int; width Int; height Int; storagePath String; altText String @default(""); createdAt DateTime @default(now()) }

model GameSession {
  id            String @id @default(uuid())
  organizerId   String
  quizId        String?              // nullable: quiz may be deleted later, snapshot remains
  pin           String               // 6 digits, kept for history
  activePin     String? @unique      // == pin while state not in (FINISHED, CANCELLED); null afterwards. Enforces unique active PIN.
  displayKey    String @unique       // random 16 bytes base64url, projector access
  quizSnapshot  Json                 // QuizSnapshot (frozen content incl. isCorrect, shuffled per settings)
  settings      Json                 // SessionSettings
  state         SessionState @default(LOBBY)
  revision      Int @default(0)
  questionIndex Int?                 // current question index in snapshot
  locked        Boolean @default(false)
  createdAt DateTime @default(now()); startedAt DateTime?; endedAt DateTime?
  participants Participant[]; attempts QuestionAttempt[]; events SessionEvent[]
}
model Participant {
  id String @id @default(uuid()); sessionId String; nickname String; nicknameKey String /* lowercased trimmed */
  resumeTokenHash String @unique      // sha256 of the resume token; token itself only ever sent to that participant
  status ParticipantStatus @default(ACTIVE)
  score Int @default(0); streak Int @default(0); correctCount Int @default(0); totalResponseMs Int @default(0)
  joinedAt DateTime @default(now()); lastSeenAt DateTime @default(now())
  submissions Submission[]
  @@unique([sessionId, nicknameKey])  // nickname unique per session (removed participants keep their row → a removed name cannot be reused; acceptable)
}
model QuestionAttempt {
  id String @id @default(uuid()); sessionId String; questionIndex Int; attemptNo Int  // attemptNo increments on replay
  openedAt DateTime; deadlineAt DateTime; closedAt DateTime?
  status AttemptStatus @default(OPEN)
  submissions Submission[]
  @@unique([sessionId, questionIndex, attemptNo])
}
model Submission {
  id String @id @default(uuid()); attemptId String; participantId String
  submissionId String                 // client idempotency key (uuid)
  optionIds String[]                  // snapshot option ids selected
  receivedAt DateTime; responseTimeMs Int
  isCorrect Boolean; points Int
  @@unique([attemptId, participantId]) // DB-enforced: one final answer per participant per attempt
}
model SessionEvent { id BigInt @id @default(autoincrement()); sessionId String; type String; payload Json; createdAt DateTime @default(now()); @@index([sessionId, id]) }
```

Rules:

- Reports are computed from `Submission` rows whose attempt `status != VOIDED`, joined with participants `status = ACTIVE`.
- `activePin` is set to `pin` on create and nulled on FINISHED/CANCELLED. PIN generation retries on unique violation.
- Never store or log raw resume tokens or session tokens; store sha256 hex.

### QuizSnapshot (shared type, stored as JSON on the session)

```ts
type QuizSnapshot = {
  quizId: string;
  title: string;
  description: string;
  coverUrl: string | null;
  questions: Array<{
    id: string;
    index: number;
    type: 'SINGLE' | 'TRUE_FALSE' | 'MULTI';
    text: string;
    media: { url: string; alt: string } | null;
    timeLimitSec: number;
    pointsMode: 'NONE' | 'STANDARD' | 'DOUBLE';
    explanation: string;
    options: Array<{
      id: string;
      index: number;
      text: string;
      media: { url: string; alt: string } | null;
      isCorrect: boolean;
    }>;
  }>;
};
type SessionSettings = {
  maxParticipants: number; // default 500, 1..2000
  showQuestionOnPlayer: boolean; // default false (phones show letters/shapes only)
  randomizeQuestions: boolean; // default false; applied once when the snapshot is built
  randomizeAnswers: boolean; // default false; applied once when the snapshot is built (TRUE_FALSE never shuffled)
  allowLateJoin: boolean; // default true; false = lobby locks automatically on START
};
```

## 3. Quiz content rules (shared Zod)

Two schemas: `QuizDraftSchema` (lenient; what autosave persists) and `validateQuizForPlay(quiz): Issue[]` (strict; must be empty to create a session).

Play-validation rules (mirroring the reference product's documented limits):

- title 1–95 chars; description ≤ 500.
- ≥ 1 question. Question text 1–120 chars (media alone is not enough).
- `SINGLE`: 2–6 options, exactly 1 correct. `MULTI`: 2–6 options, ≥ 1 correct. `TRUE_FALSE`: exactly 2 options with text `True`/`False` (UI fixed), exactly 1 correct.
- Option: text 1–75 chars OR media present.
- `timeLimitSec ∈ {5,10,20,30,60,90,120,240}`. `pointsMode ∈ NONE|STANDARD|DOUBLE`. explanation ≤ 500.
- `POLL`/`CONTENT` → issue "not supported in this release".

Nickname: trim, collapse whitespace, strip control chars, 1–20 chars, unique case-insensitively per session.

## 4. Scoring, streaks, ranking (shared, pure functions, unit-tested)

```ts
speedFactor(rtMs, durationMs) = rtMs < 500 ? 1 : 1 - (clamp(rtMs, 0, durationMs) / durationMs) / 2
maxPoints(pointsMode)          = NONE 0 | STANDARD 1000 | DOUBLE 2000
multiPerCorrect(pointsMode)    = NONE 0 | STANDARD 500  | DOUBLE 1000   // constant MULTI_POINTS_PER_CORRECT_STANDARD = 500

scoreSubmission(question, optionIds, rtMs):
  SINGLE / TRUE_FALSE: exactly one optionId; correct = option.isCorrect; points = correct ? round(maxPoints * speedFactor) : 0
  MULTI: selected = unique optionIds (1..options.length); if any selected option is incorrect → correct=false, points=0
         else points = round(count(selected) * multiPerCorrect * speedFactor); correct = (selected set == correct set)
         // partial correct-only selections earn points but count as "not fully correct" for streak/accuracy
  NONE points mode → points 0, correctness still computed.
```

Reference: support.kahoot.com "How points work" (single 1000 / multi 500-per-correct / <0.5 s rule / round). Note: another reference article states 1000 per correct for multi-select; the two articles conflict — we follow "How points work" and record this in PARITY_MATRIX.md.

Per question close (engine, in one pass over ACTIVE participants):

- has submission with `isCorrect` → `score += points; streak += 1; correctCount += 1; totalResponseMs += responseTimeMs`
- has submission, partially correct MULTI (points > 0, isCorrect false) → `score += points; streak = 0`
- otherwise (wrong / no answer / late) → `streak = 0`
- Streak is display-only. No streak bonus (documented deviation).

Ranking (deterministic total order, no shared ranks): `score desc, correctCount desc, totalResponseMs asc, joinedAt asc, id asc`. Rank = 1-based position.
Leaderboard delta = rank before this question − rank after.

## 5. Game engine (server, authoritative)

One in-memory `GameRoom` per live session, owned by a `RoomManager`. Every state-changing action (host command, submission, timer firing, join, disconnect bookkeeping) goes through the room's serial async queue (`p-queue` concurrency 1 or a hand-rolled promise chain). Each transition: update DB (session state/revision/questionIndex, attempt, participants), append `SessionEvent`, then broadcast role-filtered snapshots.

States and transitions:

```
LOBBY          --START(host)-------------------> COUNTDOWN(q=0)      (locks lobby if !allowLateJoin)
COUNTDOWN      --timer 5 s---------------------> QUESTION_OPEN       creates QuestionAttempt{openedAt=now, deadlineAt=now+timeLimit}
QUESTION_OPEN  --deadline | CLOSE_ANSWERS(host) | all eligible ACTIVE participants answered--> QUESTION_CLOSED
QUESTION_CLOSED --auto after scoring persisted--> ANSWER_REVEAL       (distribution + correct + explanation + per-player result)
ANSWER_REVEAL  --NEXT(host)--------------------> LEADERBOARD         if more questions remain
               --NEXT(host)--------------------> FINISHED            if last question (podium)
LEADERBOARD    --NEXT(host)--------------------> COUNTDOWN(q+1)
any non-final  --END(host, confirmed in UI)----> FINISHED if startedAt set, else CANCELLED
RECOVERY       --REPLAY_QUESTION(host)---------> COUNTDOWN(same q)   voids the interrupted attempt (status VOIDED), attemptNo+1
RECOVERY       --END(host)---------------------> FINISHED
```

Boot recovery (`RoomManager.restore()` at server start): load every session with `activePin != null`.

- state in {COUNTDOWN, QUESTION_OPEN, QUESTION_CLOSED} → set state RECOVERY (host UI offers Replay question / End).
- state in {LOBBY, ANSWER_REVEAL, LEADERBOARD} → restore as-is (stable states).
  Scores are never recomputed from voided attempts; participant totals were only applied at QUESTION_CLOSED, which is atomic (single transaction with the state change), so a crash mid-question never double-counts.

Timers: `setTimeout` per room for countdown and deadline; re-armed from DB timestamps on restore only for stable states (none needed). Host disconnect does not stop the current question; nothing auto-advances after reveal anyway.

Submission acceptance (inside the room queue; `receivedAt` captured at handler entry, before queueing):

1. socket role player, participant ACTIVE, belongs to this session → else `UNAUTHORIZED`
2. state == QUESTION_OPEN and payload.attemptId == current attempt id → else `STALE_ATTEMPT` (or `CLOSED` if state is beyond open for that attempt)
3. `receivedAt <= deadlineAt` → else `LATE`
4. participant.joinedAt < attempt.openedAt → else `NOT_ELIGIBLE` (late joiners start with the next question)
5. optionIds valid for question type (SINGLE/TF exactly 1 known id; MULTI 1..n unique known ids) → else `INVALID`
6. compute rt = receivedAt − openedAt, score via shared fn; `INSERT Submission`; on unique violation → load existing: same submissionId → return the original `accepted` ack; different → `duplicate` ack. Never score twice.
7. ack `{ status:'accepted', submissionId, receivedAt }` only after the insert committed; emit `player:submission` to the participant room (other tabs); update answered count (coalesced) for host/display.
8. If every eligible ACTIVE participant has a submission → close early.

Answer-key protection: the snapshot builder strips `isCorrect` and `explanation` for `player` and `display` roles unless state ∈ {ANSWER_REVEAL, LEADERBOARD, FINISHED}. Host always gets them. Covered by an integration test that inspects raw socket payloads.

## 6. Socket.IO contract (shared `socket.ts`; every client→server event uses an ack)

Handshake `auth`:

- `{ role:'player', participantId, resumeToken }` — or `{ role:'player' }` before joining
- `{ role:'host', sessionId }` — organizer cookie is validated from the handshake headers; must own the session
- `{ role:'display', displayKey }`
  Server sets `socket.data = { role, sessionId?, participantId? }`, joins rooms `s:{sid}:host`, `s:{sid}:players`, `s:{sid}:display`, `p:{participantId}`.

Client → Server:

- `player:join { pin, nickname }` → `{ ok:true, participantId, resumeToken, sessionId, snapshot }` | `{ ok:false, code:'NOT_FOUND'|'LOCKED'|'FULL'|'NICKNAME_TAKEN'|'NICKNAME_INVALID'|'ENDED'|'RATE_LIMITED' }`
- `player:answer { attemptId, submissionId, optionIds }` → `{ status:'accepted', submissionId, receivedAt }` | `{ status:'duplicate', submissionId }` | `{ status:'rejected', reason }`
- `state:sync {}` → `{ ok:true, snapshot }` (used after reconnect; the server also pushes `state` on reconnect automatically)
- `host:command { commandId, type, payload? }` types `START | CLOSE_ANSWERS | NEXT | LOCK_LOBBY | UNLOCK_LOBBY | REMOVE_PARTICIPANT{participantId} | END | REPLAY_QUESTION` → `{ ok:true, revision }` | `{ ok:false, code:'INVALID_STATE'|'UNAUTHORIZED'|'INVALID' }`. Commands are idempotent on `commandId` (room keeps last 200 ids).

Server → Client:

- `state` `GameSnapshot` (role-filtered) on every transition and on (re)connect
- `lobby:participants { count, participants:[{id,nickname}] }` host+display, coalesced ≥300 ms
- `answers:progress { attemptId, answered, eligible }` host+display, coalesced ≥300 ms
- `player:submission { attemptId, optionIds }` to `p:{id}` (syncs duplicate tabs)
- `player:removed {}` then server disconnects the socket; client clears local credentials

`GameSnapshot`:

```ts
{
  sessionId, revision, state, serverTime,                 // serverTime = Date.now() at emit; clients derive an offset for timers
  quiz: { title, questionCount }, pin, joinUrl, locked, participantCount,
  questionIndex: number | null,
  question?: { attemptId, index, type, text, media, timeLimitSec, pointsMode, showTextOnPlayer,
               options: [{ id, index, text, media, isCorrect? }], explanation?, openedAt?, deadlineAt? },
  results?: { answered, eligible, distribution: [{ optionId, count }], correctOptionIds: string[] },   // reveal+
  leaderboard?: [{ participantId, nickname, score, rank, delta }],   // top 5 (LEADERBOARD) / top 3 (FINISHED); host gets full list in host.participants
  me?: { participantId, nickname, score, rank, streak, canAnswer,
         submission?: { attemptId, optionIds }, lastResult?: { correct, points, streak } },
  host?: { participants: [{ id, nickname, score, rank, status, connected }], answered, eligible, displayKey }
}
```

## 7. HTTP API (Fastify, prefix `/api`; JSON; Zod-validated; cookie session)

Auth & security:

- `POST /auth/login {email,password}` (rate-limit 10/min/IP) → sets `sid` cookie (httpOnly, sameSite=lax, secure in prod, 30 d). Argon2id via `@node-rs/argon2`.
- `POST /auth/logout`, `GET /auth/me`.
- All `/api/*` except `/auth/login`, `/health`, `/join/:pin` require an organizer session. Mutating requests must carry an `Origin` matching `PUBLIC_URL` (CSRF).
- Organizer resources are always scoped by `organizerId` (no cross-organizer access).

Quizzes:

- `GET /quizzes` (list with question counts, updatedAt) · `POST /quizzes` (empty quiz) · `GET /quizzes/:id` · `PUT /quizzes/:id` (full `QuizDraft` replace, returns saved doc + `playIssues`) · `DELETE /quizzes/:id` · `POST /quizzes/:id/duplicate`
- `GET /quizzes/:id/export` → `{ format:'ictquiz-v1', quiz }` JSON download · `POST /quizzes/import` (same JSON, validated) → new quiz
- `GET /import-template.csv` · `POST /quizzes/:id/import-csv/preview` (multipart, ≤1 MB) → `{ questions, errors:[{row,message}] }` · `POST /quizzes/:id/import-csv` → appends valid rows
  CSV columns: `type,question,option1,option2,option3,option4,option5,option6,correct,timeLimit,points,explanation`; `correct` = 1-based indexes separated by `;`; `type` ∈ single|truefalse|multi; `points` ∈ none|standard|double.
- `POST /media` (multipart image ≤5 MB; png/jpeg/webp/gif; MIME verified by magic bytes with `file-type`; dimensions via `image-size`; stored `MEDIA_DIR/{uuid}.{ext}`) → `{ id, url:'/media/{file}', width, height }`. Files served at `/media/*` with long cache headers. Never fetch remote URLs server-side.

Sessions:

- `POST /sessions { quizId, settings }` → 400 with `playIssues` if invalid, else `{ id, pin, displayKey }` (snapshot built here; quiz frozen)
- `GET /sessions` (organizer's; state, pin, participantCount, createdAt, quiz title) · `GET /sessions/:id`
- `GET /sessions/:id/report` → `{ session, standings:[...], questions:[{ index, text, type, correctOptionIds, distribution, answered, correctCount, avgResponseMs }], responses:[{ participant, questionIndex, optionIds, isCorrect, points, responseTimeMs }] }`
- `GET /sessions/:id/report.csv` → two sections (standings; per-response rows). Every cell that starts with `= + - @ \t \r` is prefixed with `'` (formula-injection protection); fields quoted.

Public / ops:

- `GET /join/:pin` (rate-limit 120/min/IP, PIN must be 6 digits) → `{ sessionId, title, locked, state }` or 404
- `GET /health` → `{ ok, db }` (used by Docker healthcheck)
- `GET /diagnostics` (organizer) → `{ uptimeSec, memory: process.memoryUsage(), db:{ ok, latencyMs }, sockets:{ total, byRole }, rooms:{ active, list:[{sessionId,pin,state,participants}] }, recentErrors:[{ at, message }] }` (ring buffer of last 50 errors from the Fastify error handler and engine).

Rate limiting: `@fastify/rate-limit` keyed by IP with the generous limits above; Socket.IO join/answer are additionally limited per socket (join ≤ 5/min, answer ≤ 30/min) rather than per IP, so a venue NAT is never blocked as a whole.

Production serving: Fastify serves `apps/web/dist` (SPA fallback to `index.html`, `/assets/*` immutable). Dev: Vite on :5173 proxies `/api`, `/media`, `/socket.io` (ws) to :3000.

## 8. Web app (React + TS + Vite + Tailwind v4 + React Router + TanStack Query + zustand for live state)

Routes:

- `/` join page (PIN) · `/join/:pin` prefilled · `/play` participant game (credentials in `localStorage: ictquiz.player = {sessionId, participantId, resumeToken}`)
- `/display/:displayKey` projector (read-only, large type)
- `/admin/login` · `/admin` (quiz library + recent sessions) · `/admin/quizzes/:id` editor · `/admin/quizzes/:id/preview` (simulated participant, runs the shared scoring locally, no server session)
- `/admin/sessions/new?quizId=` settings → creates session → `/admin/host/:sessionId` · `/admin/sessions/:id/report` · `/admin/diagnostics`

Participant screen states: `enter-pin → nickname → lobby → get-ready(countdown) → answer(pending→accepted) → waiting/time's up → result(+points, streak, rank) → … → podium/final rank`. Plus banners: `Reconnecting…`, `Removed by host`, `Session ended`. Refresh restores everything from the snapshot (`me.submission` shows the accepted answer). Multi-select uses an explicit Submit button; single/TF submit on tap with an immediate pending state.

Host screen: same phase visuals as the projector but smaller, plus controls (Start / Close answers / Next / Lock / Remove / End with confirm), participant list with connection dots, answered/eligible progress, connection status pill, fullscreen (`F`), mute (`M`), keyboard: `Space`/`→`/`N` = next or start, `C` = close answers, `L` = lock toggle, `F`, `M`. In `RECOVERY` state show "Replay question" / "End session".

Projector: lobby (PIN big, QR of `joinUrl`, names grid), countdown, question (text, media, options with shape+letter, timer ring, answered counter), reveal (bar chart distribution, correct highlighted, explanation), leaderboard top 5 with movement, podium top 3 with staged animation. No controls.

Theme tokens (`apps/web/src/styles/theme.css`, Tailwind `@theme`):
`--color-navy #001C5D`, `--color-royal #0028AC`, `--color-azure #0084FF`, `--color-cyan #00D8FF`, `--color-ink #FFFFFF`,
`--color-success #22C55E`, `--color-danger #EF4444`, `--color-warning #F59E0B`,
gradient `--gradient-brand: linear-gradient(90deg, #0028AC 0%, #0084FF 55%, #00D8FF 100%)`, radius `--radius-panel 1.25rem`, glow `radial-gradient` corners at low alpha.
Answer option identity (shape + letter + colour; colour is never the only cue):
`A ▲ #0084FF`, `B ◆ #7C3AED`, `C ● #00D8FF (dark text)`, `D ■ #F59E0B (dark text)`, `E ⬟ #EC4899`, `F ★ #10B981`. TRUE_FALSE uses A/B slots with labels True/False.
Reduced motion: `@media (prefers-reduced-motion: reduce)` disables transitions/animations globally.
No platform name/logo/watermark. Event logo slot: `VITE_EVENT_LOGO_URL` optional, empty by default → nothing rendered.
Sounds: synthesized with WebAudio (no assets): countdown tick, answers-closed, reveal, podium; muted state in `localStorage`.

## 9. Deployment

- `docker/Dockerfile`: `node:22-alpine` multi-stage (pnpm fetch → build shared/web/server → runtime with prod deps, prisma client, `apps/web/dist`). Entrypoint runs `prisma migrate deploy` then `node apps/server/dist/index.js`. Non-root user, `MEDIA_DIR=/data/media` volume.
- `docker/compose.yml`: `db` (postgres:16-alpine, internal only, healthcheck, volume `pgdata`), `app` (depends_on db healthy, volume `media`, healthcheck `/api/health`), `caddy` (caddy:2-alpine, ports 80/443, `Caddyfile` reverse_proxy to `app:3000` — WebSockets pass through by default, volumes `caddy_data`, `caddy_config`). Images pinned by tag+digest in the final package.
- `docker/.env.example`: `DOMAIN`, `PUBLIC_URL`, `POSTGRES_PASSWORD`, `DATABASE_URL`, `SESSION_SECRET`, `MEDIA_DIR`, `INITIAL_ORGANIZER_EMAIL`, `INITIAL_ORGANIZER_PASSWORD` (bootstrap only when zero organizers exist; remove after first boot), `MAX_UPLOAD_MB=5`, `TRUST_PROXY=1`.
- `scripts/create-organizer.ts` for adding organizers later.
- Runbooks: deploy, backup/restore (`pg_dump` + media tar), rollback (previous image tag + `migrate` note), event-day checklist (rehearsal, fallback PIN, projector setup, Wi-Fi).

## 10. Verification matrix

| Layer              | Tool                                                       | Must cover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared unit        | Vitest                                                     | speedFactor boundaries (0, 499, 500, 501, duration, > duration), SINGLE/TF/MULTI incl. partial + any-wrong, NONE/DOUBLE, ranking tie policy, quiz play-validation, nickname normalisation, CSV parse                                                                                                                                                                                                                                                                                                                                                                      |
| server integration | Vitest + real Postgres (`ictquiz_test`) + socket.io-client | login/authz isolation; full 2-question game with 3 players (fast-correct, wrong, late); acks; duplicate submissionId → identical ack; second submissionId → `duplicate`; stale attempt → rejected; player payload never contains `isCorrect`/`explanation` before reveal; lock → `LOCKED`; remove → answer `UNAUTHORIZED` + disconnected; resume token restores `me.submission`; late joiner `NOT_ELIGIBLE` then eligible next question; restart → RECOVERY → REPLAY voids attempt, no double points; report totals == sum of persisted points; CSV formula cells escaped |
| browser            | Playwright (stretch)                                       | host + 2 players to podium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| load               | `scripts/load-test.ts`                                     | 50/100/250/500 clients; synchronized bursts; p50/p95/p99 ack latency; zero lost acks; zero duplicate scoring; reconnect storm                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| static             | eslint, tsc, `pnpm build`                                  | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Only record results in `docs/TEST_REPORT.md` that actually ran.
