# Test report — Release A event build

Sections 1–3 actually ran on 2026-09-21; the automated suites, the browser
suite and the rollback rehearsal ran against the tree committed as
`d4f52c2`, earlier load tests against `ed3f707` (the live-game hot path is
unchanged since; polls/slides/password work touched validation, reports,
UI and a new state). Section 2B is
pending the target server; section 5 lists what cannot be done from the
development machine at all. Anything not listed here was **not** tested.

## 1. Automated suites (`pnpm test`)

| Package | Files | Tests | What they cover |
| --- | --- | --- | --- |
| `@ictquiz/shared` | 5 | 78 | speed factor boundaries (0 / 499 / 500 / 501 / = duration / > duration), SINGLE / TRUE_FALSE / MULTI / POLL scoring incl. partial and any-wrong, NONE / DOUBLE, ranking tie chain, quiz play-validation rules incl. poll/content slides and the all-CONTENT rejection, nickname normalisation, snapshot shuffling with content slides pinned in place, RFC-4180 CSV parse incl. poll/content rows + formula-safe serialize |
| `@ictquiz/server` | 10 | 58 | login / authz isolation / CSRF origin; **change-password** (happy path revokes other sessions and flips `mustChangePassword`, wrong current → 401, short new → 400, unauthenticated → 401); quiz CRUD, export→import, organizer scoping; session creation (PIN, snapshot, media URLs); media upload magic-byte + size checks; CSV preview/import; **live engine**: full game, idempotent submissions (incl. retry after close and retry while pending), stale / late / malformed rejection, answer-key never sent to player/display before reveal, lock / remove / token kill, resume + duplicate tabs, late-join eligibility, restart → RECOVERY → REPLAY without double scoring, diagnostics; **join rate limiting** (`ratelimit.test.ts`): shared per-IP failure budget across HTTP + socket channels, reconnect-resistant (25 fresh sockets → 20 `NOT_FOUND` then `RATE_LIMITED`, valid PIN blinded, HTTP 429), 300-player mass join from one venue IP unaffected, window expiry; **content slides + polls**: CONTENT_SLIDE transitions, poll scoring skip, poll reveal without leaderboard, stable CONTENT_SLIDE boot recovery; **scoring oracle**: independent inline recomputation of every submission's points/correctness and the final ranking; **burst**: 150 same-tick answers, close racing a burst, batch failure → TEMPORARY rollback — the close-vs-burst test asserts `accepted == counted in the reveal == persisted rows` plus score reconciliation (ack arrival order across 101 sockets is not guaranteed, so an answer may legitimately be `rejected:CLOSED`); **reports**: standings/questions/responses from durable rows, CSV formula escaping, end-mid-question voids the attempt |

Also clean: `pnpm lint`, `pnpm typecheck`, `pnpm build`.

## 1b. Real-browser suite (`pnpm e2e`)

Playwright **1.63.0**, Chromium build **1243** — run against the **production
build** (`apps/server/dist` serving `apps/web/dist` on :3100 with a dedicated
`ictquiz_e2e` database), never against the Vite dev server. One serial spec
(`apps/e2e/tests/release-a.spec.ts`), desktop 1440×900 plus two 390×844
mobile-touch contexts. Result: **10/10 passed (12.5 s)**.

| # | Check | Result |
| --- | --- | --- |
| 1 | Organizer login | pass |
| 2 | Quiz creation (SINGLE 4-option + TRUE_FALSE, autosave, "playable") | pass |
| 3 | Hosting (PIN issued, "Players (0)") | pass |
| 4 | Projector view shows the PIN + player count | pass |
| 5 | Two phones join the lobby; host + display update | pass |
| 6 | Start → question on display; both answers acknowledged | pass |
| 7 | Reveal: distribution, Correct!/Incorrect, +points | pass |
| 8 | Host refresh mid-reveal → recovered, Next works | pass |
| 9 | Player refresh after answering → answer state kept; non-answerer sees Incorrect at reveal | pass |
| 10 | Podium, phone "Game over" rank #1, report standings + CSV link | pass |

## 2. Load tests

Harness: `apps/server/scripts/load-test.ts` — N Socket.IO clients join by PIN, an automated host drives the whole game, each client answers at a random moment inside a burst window after QUESTION_OPEN, a fraction re-sends the identical submission (idempotency check), a fraction disconnects and resumes at the second leaderboard (reconnect storm), and at the end every client's own `+points` sum is reconciled against the server's final score.

Exact commands for the server runs: `docs/runbooks/server-load-test.md`.

### 2A. Load tests — development machine (measured)

#### Conditions (record these with the numbers — they are not the target server)

- Client and server on the **same Windows 11 developer machine**: 24 logical CPUs, 32 GB RAM, Docker Desktop (Linux containers).
- Server = the **production Compose stack** (`docker/compose.yml`: app image + PostgreSQL 16 + Caddy 2 with its internal TLS certificate for `localhost`). Traffic went through Caddy over `wss://localhost` (loopback — no real network latency or Wi-Fi loss).
- App container memory limit 2 GB. Postgres defaults.
- 5 questions (4 in the burst runs) × 10 s timer; SINGLE / TRUE_FALSE / MULTI mix; retry rate 10 % (25 % in burst runs); reconnect storm 30 % (50 % in burst runs).

#### Results (raw JSON in `apps/server/load-results/`, gitignored)

| Run | Players | Answer window | Join ok | Join p95 | Ack p50 / p95 / p99 / max | Lost acks | Retries identical | Reconnect storm | App RSS | Targets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tier-100p` | 100 | 2 s | 100/100 | 9 ms | 5 / 10 / 43 / 70 ms | 0 | 41/41 | 37/37 resynced, p95 152 ms | 118–143 MB | all pass |
| `tier-250p` | 250 | 2 s | 250/250 | 9 ms | 6 / 12 / 20 / 158 ms | 0 | 134/134 | 73/73, p95 191 ms | 130–148 MB | all pass |
| `tier-500p` | 500 | 2 s | 500/500 | 8 ms | 9 / 26 / 43 / 309 ms | 0 | 228/228 | 139/139, p95 365 ms | 148–175 MB | all pass |
| `tier-500p-burst500` (commit `5f5a468`, before batching) | 500 | **0.5 s** | 500/500 | 8 ms | 340 / **614** / 686 / 984 ms | 0 | 504/504 | 261/261, p95 651 ms | 152–178 MB | p95 target **failed**; correctness intact |
| `tier-500p-burst500-batched` (`ed3f707`) | 500 | **0.5 s** | 500/500 | 9 ms | 9 / **14** / 22 / 41 ms | 0 | 500/500 | 261/261, p95 680 ms | 116–166 MB | all pass |
| `tier-500p-limiter` (`d4f52c2`, join-limiter active) | 500 | 2 s | 500/500 | 10 ms | 7 / 10 / 11 / 25 ms | 0 | 237/237 | 169/169 resynced, p95 497 ms | 116–165 MB | all pass |

Per-question detail for the final 500-player burst run: every question `eligible 500 / answered 500 / accepted 500 / lost 0`; ANSWER_REVEAL fan-out to all 500 phones completed in 100–113 ms. The `tier-500p-limiter` run proves the per-IP join limiter (Round C) does not impede a 500-player venue join — all clients share one `X-Forwarded-For` IP through Caddy.

Reconciliation in every run: `scoreMismatch 0` (each client's summed `+points` equals its server score), `missingResults 0`, `playersFinished = players`.

#### Reading the numbers

- Release targets (`docs/plan/README.md` §9): no acknowledged answer lost — **met in all runs**; no duplicate scoring — **met**; no early answer-key disclosure — covered by the integration test, not by the load harness; p95 ack < 500 ms — **met** after micro-batching (the pre-batching run shows the failure that motivated it); reconnected clients receive current state — **met (all storms 100 %)**; bounded memory — app RSS stayed under 180 MB at 500 players.
- The 2 s answer window is realistic (people do not all tap within the same half-second); the 0.5 s window is a deliberate worst case.
- Reconnect storm p95 (365–680 ms for 139–261 simultaneous resumes) is dominated by the burst of fresh WebSocket handshakes through TLS; it is well inside what a player perceives as instant.

### 2B. Load tests — target server (pending)

The development-machine numbers above are loopback figures on different
hardware. They must be re-measured on the event server before claiming
capacity — see `docs/runbooks/server-load-test.md` for the exact commands.

- CPU: _fill in (`lscpu`)_ · RAM: _fill in (`free -h`)_ · Ubuntu: _version_ ·
  Docker: _version_ · Network path: venue Wi-Fi/LAN or loopback

| Run | Players | Answer window | Join ok | Join p95 | Ack p50 / p95 / p99 / max | Lost acks | Retries identical | Reconnect storm | App RSS | Targets | Run from |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `server-050p` | 50 | 2 s | — | — | — / — / — / — ms | — | — | — | — | — | — |
| `server-100p` | 100 | 2 s | — | — | — / — / — / — ms | — | — | — | — | — | — |
| `server-250p` | 250 | 2 s | — | — | — / — / — / — ms | — | — | — | — | — | — |
| `server-500p` | 500 | 2 s | — | — | — / — / — / — ms | — | — | — | — | — | — |
| `server-500p-burst500` | 500 | 0.5 s | — | — | — / — / — / — ms | — | — | — | — | — | — |

### 2C. Rollback rehearsal (`docker/rollback-rehearsal.sh`)

Run on 2026-09-21 against the real `docker/compose.yml` in an **isolated**
project (`ictquiz-rbtest`, published on :3101, own throwaway env file — the
live stack and `docker/.env` were untouched). Cycle: `ed3f707` (1 migration)
→ `a421692` (3 migrations) → `ed3f707`.

```
step                                    result
old image build (ed3f707, worktree)     ok
new image build (a421692, HEAD)         ok
temp env + override                     ok
deploy old image on :3101               ok (healthy)
_prisma_migrations after old deploy     1
login + create quiz on ed3f707          ok (id=942faac7-8067-4304-902b-4a04896f1ca8)
upgrade to a421692 (--no-build)         ok (healthy)
_prisma_migrations after upgrade        3
migration count increased               ok (1 -> 3)
quiz loads + login works on a421692     ok
rollback to ed3f707 (--no-build)        ok (healthy)
quiz still loads on ed3f707             ok
login works on ed3f707                  ok
REHEARSAL OK ed3f707 -> a421692 -> ed3f707   (exit 0)
```

Key finding — the old image's entrypoint `prisma migrate deploy`, run against
a database containing two migrations it does not know about, prints:

```
1 migration found in prisma/migrations

No pending migrations to apply.
```

then the server starts, becomes healthy and serves the quiz created before
the upgrade. Rolling code back across these migrations is safe **without** a
database restore; per-migration rules are in `docs/runbooks/rollback.md`
("Migration compatibility").

## 3. Browser / device checks

- A **Playwright suite** (`pnpm e2e`, §1b) drives a real Chromium through the whole journey — login → author → host → projector → two phone-sized contexts → start/answer/reveal → host and player refresh recovery → podium → report — against the production build.
- Host, projector and participant screens were exercised in **headless Chrome (CDP)** at 1440×900 through every phase (lobby → countdown → question → reveal → leaderboard → podium → report, plus RECOVERY). Screenshots were reviewed for each phase.
- **390×844 pass** (`artifacts/round-b-screens/`): join PIN → nickname → lobby → SINGLE open → answer sent → reveal (+points) → leaderboard → MULTI open with Submit → podium, plus POLL open and "Thanks for voting". A scripted measurement pass (`scripts/check-phone-overflow.mjs`, incl. deliberately long question/option text) found **no horizontal overflow and no clipped buttons in any state**.
- **1920×1080 pass**: display lobby with QR + 31 player names, question open with image, reveal, leaderboard, podium — all captured in `artifacts/round-b-screens/`.
- Polls and content slides were exercised end-to-end in headless Chrome (`artifacts/round-a-screens/`): editor, host, projector, phone.
- **Not tested: real Android or iPhone browsers, a physical 1080p projector, venue Wi-Fi.** The event-day runbook requires one real phone and the projector to be checked at the venue rehearsal (see `docs/runbooks/lan-rehearsal.md` for pre-event LAN rehearsal).

## 4. Known limitations carried into the event build

See `docs/PARITY_MATRIX.md` for the full list. Headlines: multi-select points follow the "How points work" reference (500 per correct option) while another support article says 1000 — flagged; streak is display-only; no auto-advance; ending mid-question discards that question; one application instance (no Redis / replicas).

## 5. Checks that require the server or physical devices

These cannot be done from the development machine — they are the C-items in
`docs/AUDIT.md` and each has a runbook:

- **C1** — Load tiers 50 → 100 → 250 → 500 (+ 0.5 s burst) on the 8 GB Ubuntu
  server → `docs/runbooks/server-load-test.md`, results into section 2B above.
- **C2** — Real Android and iPhone browsers on venue Wi-Fi: join by QR,
  answer, refresh mid-question, airplane-mode reconnect →
  `docs/runbooks/lan-rehearsal.md`, `docs/runbooks/event-day.md`.
- **C3** — Physical 1080p projector in fullscreen (`F`), sound enabled by a
  click → `docs/runbooks/event-day.md`.
- **C4** — Let's Encrypt certificate issuance for the real domain (needs DNS +
  ports 80/443) → `docs/runbooks/deploy.md`.
- **C5** — Backup and restore on the server volumes →
  `docs/runbooks/backup-restore.md`.
