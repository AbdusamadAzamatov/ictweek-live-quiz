# Audit — implementation vs. `docs/plan/README.md` and `docs/plan/BUILD_PROMPT.md`

Audited on 2026-09-21 at commit `781bf59`; the fixes in section A landed in `53a3923` and `3b464a0`.
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

## B. Behavioural differences that remain (accepted for the event build)

| # | Requirement / reference behaviour | Implementation | Why it stays |
| --- | --- | --- | --- |
| B1 | "Published versions" / `QuizVersion` records (BUILD_PROMPT item 2; README §6) | The quiz is frozen into an immutable JSON snapshot when a session is created; there is no separate version table or publish step | Delivers the required immutability for reports and play; a publish workflow adds UI without event value |
| B2 | Event-logo display "optional and disabled by default" (README §3) | `VITE_EVENT_LOGO_URL` is a **build-time** variable; enabling it needs a rebuild | Disabled by default as required; runtime configuration deferred |
| B3 | Late joiners "by default" start with the next question (README §5) | Fixed rule, not configurable | Matches the default; no alternative policy was requested |
| B4 | Streak bonus (reference product awards bonus points for answer streaks) | Streak is displayed only; no bonus points | README §5 asks for "streak display separately from any streak bonus"; a bonus formula is not documented by the reference and would be invented |
| B5 | Tie handling | Deterministic total order `score ↓, correct ↓, total response time ↑, joined ↑, id ↑`; no shared ranks | README §5 requires a documented policy and forbids assuming undocumented reference behaviour |
| B6 | Multi-select points | 500 per correct option (Standard), 1000 (Double); any wrong selection → 0 | Two reference support articles disagree (500 vs 1000 per correct); "How points work" was followed; single constant `MULTI_POINTS_PER_CORRECT_STANDARD` |
| B7 | Host flow extras (skip question, hide/show leaderboard, auto-advance timer) | Not implemented; countdown fixed at 5 s; every advance is manual | Not in the Release A list; manual control is the safer event default |
| B8 | Lobby music | Short synthesized cues only (countdown, open, close, reveal, leaderboard, podium) | No audio assets may be bundled without licensing; cues cover the functional need |
| B9 | Nickname of a removed participant | Stays reserved for that session | Prevents the removed person from rejoining under the same name |
| B10 | Leaderboard movement arrows after an application restart | Deltas show 0 for the first leaderboard after a restart | Previous ranks are in-memory only; scores and ranks themselves are correct |
| B11 | Join-rate / PIN-enumeration protection (README §7) | HTTP PIN lookup 600/min/IP; socket join 5/min **per socket**; no per-IP socket limit | Per-IP socket limits would block a venue NAT; PIN space (10⁶) with few active sessions and short session lifetime keep enumeration impractical; documented residual risk |
| B12 | Browser end-to-end tests (README §9 "complete journeys") | Integration tests over Socket.IO + headless-Chrome screenshot scripts; no Playwright suite | DESIGN §10 listed Playwright as stretch; journeys are exercised by the socket tests and the screenshot scripts |
| B13 | Poll variants | Polls are single-select | The reference also offers multi-select polls; not requested |
| B14 | Nickname moderation | No profanity filter; host removal only | Not required by the plan |
| B15 | `QUESTION_CLOSED` state | Transient: the persisted state goes `QUESTION_OPEN → ANSWER_REVEAL` in one transaction | Same atomicity guarantee with one fewer write |
| B16 | Ending a session mid-question | The open question is voided and excluded from reports | Keeps standings and responses consistent |
| B17 | Release B features named in BUILD_PROMPT (typed answers, ordering, slider, word cloud, team play, accuracy mode, assignments, question bank, translations…) | Not implemented | Explicitly Release B / C |
| B18 | Real-time host disconnect handling | The current question finishes on the server timer; nothing auto-advances | Matches README §5 recovery rules |

## C. Requires your server or physical devices (cannot be done from here)

| # | Check | Where the instructions are |
| --- | --- | --- |
| C1 | Load tiers 50 → 100 → 250 → 500 (+ 0.5 s burst) on the 8 GB Ubuntu server, recorded in `docs/TEST_REPORT.md` section B | `docs/runbooks/server-load-test.md` |
| C2 | Real Android and iPhone browsers on venue Wi-Fi: join by QR, answer, refresh mid-question, airplane-mode reconnect | `docs/runbooks/lan-rehearsal.md`, `docs/runbooks/event-day.md` |
| C3 | Physical 1080p projector in fullscreen (`F`), sound enabled by a click | `docs/runbooks/event-day.md` |
| C4 | Let's Encrypt certificate issuance for the real domain (needs DNS + ports 80/443) | `docs/runbooks/deploy.md` |
| C5 | Backup and restore on the server volumes | `docs/runbooks/backup-restore.md` |
