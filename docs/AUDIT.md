# Audit — implementation vs. `docs/plan/README.md` and `docs/plan/BUILD_PROMPT.md`

Audited on 2026-09-21 at commit `781bf59`; the fixes in section A landed in `53a3923`, `3b464a0`
and the final corrections round (`d4f52c2`).
Every Release A requirement in the two plan documents was compared with the code, the tests and the
runbooks. Items are classified as **A** fixed in this round, **B** accepted differences for the event
build (documented, not fixed), **C** cannot be verified from the development machine.

## A. Gaps found and fixed in this round

| # | Requirement (source) | What was missing | Fix |
| --- | --- | --- | --- |
| A1 | Poll and content-slide question types (BUILD_PROMPT item 3; README §1 Release A) | Only SINGLE / TRUE_FALSE / MULTI were playable; POLL/CONTENT were rejected by validation | Unscored `POLL` (single-select, no correct option, no leaderboard afterwards, streak untouched) and `CONTENT` slides (title, body, image, host-advanced, no timer) across schema, engine (`CONTENT_SLIDE` state), editor, preview, host, projector, phone, CSV/JSON import, reports |
| A2 | "Edit title, **cover**, questions…" (README §2) | The editor could set a cover image but nothing ever displayed it | Cover shown on the library card and on the lobby (projector + host) |
| A3 | Phone/projector must work on a venue network (README §9) | `crypto.randomUUID()` (player, host, editor) and `navigator.clipboard` only exist in secure contexts; on `http://<LAN-IP>` answering would throw | Insecure-context fallbacks (`randomId()` helper, clipboard fallback); LAN rehearsal runbook |
| A4 | "Secure first-organizer setup" (README §9 deliverables; BUILD_PROMPT "secure organizer setup") | No way to change the bootstrap password from the UI or CLI; removing `INITIAL_ORGANIZER_*` only stops re-bootstrap, the account keeps the old password | `POST /api/auth/change-password` (revokes other sessions), Account page with a persistent warning while the bootstrap password is still in use (`passwordChangedAt` column), `set-password` CLI, runbook step |
| A5 | "Reports against independently calculated expected scores" (README §9) | Integration tests asserted literal points only for sub-500 ms answers; the speed-decay path was checked end-to-end only by self-consistency (`score == sum(points)`) | Oracle test: answers with deliberate delays, points recomputed from `responseTimeMs` with an inline formula that does not import `scoring.ts`, ranking recomputed inline |
| A6 | "Narrow screens and a 1080p projector" (README §9) | Screens were only checked at 1440×900 | Headless screenshot passes at 390×844 (phone) and 1920×1080 (projector) |
| A7 | Deployment runbook accuracy (README §9) | Docker install steps were incomplete (no apt repository); the 2 GB app memory limit was described as "informational" although `docker compose` enforces it (`docker inspect` → `HostConfig.Memory = 2147483648`); no HSTS header | Runbook rewritten with the official install steps and sizing; Caddy adds `Strict-Transport-Security` |
| A8 | Capacity must be measured on the real server (README "Confirmed facts"; BUILD_PROMPT "Do not claim this capacity until measured") | Only development-machine numbers existed and the report did not separate them from server numbers | `docs/runbooks/server-load-test.md` with exact commands; `docs/TEST_REPORT.md` split into "development machine (measured)" and "target server (pending)" |
| A9 | Phone testing instructions | Earlier guidance said to join from a phone against `localhost`, which is unreachable from another device | Replaced by the LAN rehearsal runbook (`DOMAIN=http://<LAN-IP>`, `PUBLIC_URL=http://<LAN-IP>`, firewall note) |

**Resolved in the final corrections round** (no longer open differences):

- **B11** — join-rate / PIN-enumeration protection was hardened: a shared per-IP `JoinLimiter`
  now covers both `GET /api/join/:pin` and socket `player:join` (failures 120/min and 1000/h,
  successes 1200/min, sliding windows; the per-socket 5/min bucket is kept; the check runs before
  the PIN lookup so a limited IP learns nothing). Reconnecting no longer resets the budget;
  `ratelimit.test.ts` proves a 300-player mass join from one venue IP still works.
- **B12** — a real Playwright suite now exists (`apps/e2e`, 10 serial checks against the
  production build, `pnpm e2e`). What remains untested is physical Android/iOS hardware —
  tracked under section C.

## B. Behavioural differences that remain (accepted for the event build)

**Origin** says who made the call. *Plan* = the behaviour is what your plan documents specify;
*Disclosed* = an implementation decision of mine that was reported to you in an earlier summary but
never individually approved; *Mine* = an implementation decision first disclosed in this audit.
None of the eighteen was explicitly approved by you item by item; the only scope decisions you
approved directly were Release A, the three original question types (later widened to polls and
slides at your request) and the system-font fallback.

| # | Original requirement / reference behaviour | Implemented behaviour | User-visible impact | Origin | Recommendation |
| --- | --- | --- | --- | --- | --- |
| B1 | "Published versions" / `QuizVersion` (BUILD_PROMPT 2; README §6) | Quiz frozen into an immutable snapshot when a session is created; no version table or publish step | None during play; the library has no version history to browse | Mine | Keep for the event; add version history in Release B if authoring continues after the event |
| B2 | Event logo "optional and disabled by default" (README §3) | `VITE_EVENT_LOGO_URL` is a build-time variable | Logo can only be enabled by rebuilding the image | Mine | Keep (logo is off by default); decide before building the event image whether you want it |
| B3 | Late joiners "by default" start with the next question (README §5) | Fixed rule, not configurable | A phone that joins mid-question waits for the next one — always | Plan (default) / Mine (not configurable) | Keep |
| B4 | Streak bonus (reference product awards extra points for streaks) | Streak shown on the phone; no bonus points | Scores are lower than the reference for streaks **and rankings can differ**: a long streak earns no extra lead, so relative order between a streaky player and a slightly faster non-streaky player may be reversed compared with the reference | Plan (README §5: display "separately from any streak bonus") | Keep as specified; rules stated in `docs/SCORING.md` §5 |
| B5 | Tie handling | Deterministic order `score ↓, correctCount ↓, totalResponseMs ↑, joinedAt ↑, id ↑`; no shared ranks | Two players with equal points never share a place; more correct answers, then the faster total, ranks higher | Plan (README §5 requires a documented policy) | Keep; exact order and example in `docs/SCORING.md` §6 |
| B6 | Multi-select points | 500 per correct option selected (1000 doubled); any wrong pick → 0; partial correct-only selections earn points but break the streak | A fully correct multi-select with 2 correct options scores up to 1000, the same as a single-choice question; the reference may award up to 2000 | Mine (chose "How points work" over a conflicting article) | Keep unless you prefer the higher value — one constant (`MULTI_POINTS_PER_CORRECT_STANDARD`); full rules and worked examples in `docs/SCORING.md` §3 |
| B7 | Skip question, hide/show leaderboard, auto-advance timer (reference host tools) | Not implemented; 5 s countdown; every step is a manual Next | Host must press Next after each reveal and leaderboard; cannot skip a question live | Mine | Keep for the event (manual control is safer); consider "skip" post-event |
| B8 | Lobby music (reference product loops music in the lobby) | Short synthesized cues only | Silent lobby apart from cues | Mine (no licensed audio available) | Keep; if you own a licensed track, it can be dropped in later |
| B9 | Removed participant's nickname | Stays reserved for that session | The removed person cannot rejoin under the same name; nobody else can use it either | Mine | Keep |
| B10 | Leaderboard movement arrows after an app restart | First leaderboard after a restart shows no ▲/▼ | Cosmetic, only after a crash/restart | Mine | Keep |
| B13 | Poll variants | Single-select polls only | Audience cannot pick several poll options | Mine | Keep unless your quiz needs multi-select polls |
| B14 | Nickname moderation (reference has a profanity filter) | None; host removes offenders | Offensive names appear on the projector until removed | Mine | Keep; brief the host on the × button and the lobby lock |
| B15 | `QUESTION_CLOSED` state | Transient; persisted state goes `QUESTION_OPEN → ANSWER_REVEAL` in one transaction | None | Disclosed | Keep |
| B16 | Ending a session mid-question | The open question is voided and excluded from reports | If the host ends during a question, that question's answers are discarded | Disclosed | Keep; hosts should end only from a reveal or leaderboard |
| B17 | Release B features (typed answers, ordering, slider, word cloud, team play, accuracy mode, assignments, question bank, translations…) | Not implemented | Only SINGLE / TRUE_FALSE / MULTI / POLL / CONTENT are available | Plan (BUILD_PROMPT Release B) | Keep |
| B18 | Host disconnect mid-question | The question finishes on the server timer; nothing auto-advances | Players see the reveal even if the host laptop drops; the game waits for the host to return | Plan (README §5) | Keep |

## C. Requires your server or physical devices (cannot be done from here)

| # | Check | Where the instructions are |
| --- | --- | --- |
| C1 | Load tiers 50 → 100 → 250 → 500 (+ 0.5 s burst) on the 8 GB Ubuntu server, recorded in `docs/TEST_REPORT.md` section B | `docs/runbooks/server-load-test.md` |
| C2 | Real Android and iPhone browsers on venue Wi-Fi: join by QR, answer, refresh mid-question, airplane-mode reconnect | `docs/runbooks/lan-rehearsal.md`, `docs/runbooks/event-day.md` |
| C3 | Physical 1080p projector in fullscreen (`F`), sound enabled by a click | `docs/runbooks/event-day.md` |
| C4 | Let's Encrypt certificate issuance for the real domain (needs DNS + ports 80/443) | `docs/runbooks/deploy.md` |
| C5 | Backup and restore on the server volumes | `docs/runbooks/backup-restore.md` |
