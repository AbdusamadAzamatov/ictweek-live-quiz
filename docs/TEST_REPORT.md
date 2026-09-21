# Test report — Release A event build

Everything below actually ran on 2026-09-21 against commit `ed3f707` (or the commit named in the row).
Anything not listed here was **not** tested.

## 1. Automated suites (`pnpm test`)

| Package | Files | Tests | What they cover |
| --- | --- | --- | --- |
| `@ictquiz/shared` | 5 | 69 | speed factor boundaries (0 / 499 / 500 / 501 / = duration / > duration), SINGLE / TRUE_FALSE / MULTI scoring incl. partial and any-wrong, NONE / DOUBLE, ranking tie chain, quiz play-validation rules, nickname normalisation, snapshot shuffling, RFC-4180 CSV parse + formula-safe serialize |
| `@ictquiz/server` | 7 | 44 | login / authz isolation / CSRF origin; quiz CRUD, export→import, organizer scoping; session creation (PIN, snapshot, media URLs); media upload magic-byte + size checks; CSV preview/import; **live engine**: full 2-question game, idempotent submissions (incl. retry after close and retry while pending), stale / late / malformed rejection, answer-key never sent to player/display before reveal, lock / remove / token kill, resume + duplicate tabs, late-join eligibility, restart → RECOVERY → REPLAY without double scoring, per-socket rate limit, diagnostics; **burst**: 150 same-tick answers, close racing a burst, batch failure → TEMPORARY rollback; **reports**: standings/questions/responses from durable rows, CSV formula escaping, end-mid-question voids the attempt |

Also clean at `ed3f707`: `pnpm lint`, `pnpm typecheck`, `pnpm build`.

## 2. Load tests

Harness: `apps/server/scripts/load-test.ts` — N Socket.IO clients join by PIN, an automated host drives the whole game, each client answers at a random moment inside a burst window after QUESTION_OPEN, a fraction re-sends the identical submission (idempotency check), a fraction disconnects and resumes at the second leaderboard (reconnect storm), and at the end every client's own `+points` sum is reconciled against the server's final score.

### Conditions (record these with the numbers — they are not the target server)

- Client and server on the **same Windows 11 developer machine**: 24 logical CPUs, 32 GB RAM, Docker Desktop (Linux containers).
- Server = the **production Compose stack** (`docker/compose.yml`: app image + PostgreSQL 16 + Caddy 2 with its internal TLS certificate for `localhost`). Traffic went through Caddy over `wss://localhost` (loopback — no real network latency or Wi-Fi loss).
- App container memory limit 2 GB. Postgres defaults.
- 5 questions (4 in the burst runs) × 10 s timer; SINGLE / TRUE_FALSE / MULTI mix; retry rate 10 % (25 % in burst runs); reconnect storm 30 % (50 % in burst runs).
- **The target 8 GB Ubuntu server with unknown CPU was not available.** Re-run the same commands there before the event (see `docs/runbooks/event-day.md`); loopback numbers are an upper bound on what a venue network will show.

### Results (raw JSON in `apps/server/load-results/`, gitignored)

| Run | Players | Answer window | Join ok | Join p95 | Ack p50 / p95 / p99 / max | Lost acks | Retries identical | Reconnect storm | App RSS | Targets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tier-100p` | 100 | 2 s | 100/100 | 9 ms | 5 / 10 / 43 / 70 ms | 0 | 41/41 | 37/37 resynced, p95 152 ms | 118–143 MB | all pass |
| `tier-250p` | 250 | 2 s | 250/250 | 9 ms | 6 / 12 / 20 / 158 ms | 0 | 134/134 | 73/73, p95 191 ms | 130–148 MB | all pass |
| `tier-500p` | 500 | 2 s | 500/500 | 8 ms | 9 / 26 / 43 / 309 ms | 0 | 228/228 | 139/139, p95 365 ms | 148–175 MB | all pass |
| `tier-500p-burst500` (commit `5f5a468`, before batching) | 500 | **0.5 s** | 500/500 | 8 ms | 340 / **614** / 686 / 984 ms | 0 | 504/504 | 261/261, p95 651 ms | 152–178 MB | p95 target **failed**; correctness intact |
| `tier-500p-burst500-batched` (`ed3f707`) | 500 | **0.5 s** | 500/500 | 9 ms | 9 / **14** / 22 / 41 ms | 0 | 500/500 | 261/261, p95 680 ms | 116–166 MB | all pass |

Per-question detail for the final 500-player burst run: every question `eligible 500 / answered 500 / accepted 500 / lost 0`; ANSWER_REVEAL fan-out to all 500 phones completed in 100–113 ms.

Reconciliation in every run: `scoreMismatch 0` (each client's summed `+points` equals its server score), `missingResults 0`, `playersFinished = players`.

### Reading the numbers

- Release targets (`docs/plan/README.md` §9): no acknowledged answer lost — **met in all runs**; no duplicate scoring — **met**; no early answer-key disclosure — covered by the integration test, not by the load harness; p95 ack < 500 ms — **met** after micro-batching (the pre-batching run shows the failure that motivated it); reconnected clients receive current state — **met (all storms 100 %)**; bounded memory — app RSS stayed under 180 MB at 500 players.
- The 2 s answer window is realistic (people do not all tap within the same half-second); the 0.5 s window is a deliberate worst case.
- Reconnect storm p95 (365–680 ms for 139–261 simultaneous resumes) is dominated by the burst of fresh WebSocket handshakes through TLS; it is well inside what a player perceives as instant.

## 3. Browser / device checks

- Host, projector and participant screens were exercised in **headless Chrome (CDP)** at 1440×900 through every phase (lobby → countdown → question → reveal → leaderboard → podium → report, plus RECOVERY). Screenshots were reviewed for each phase.
- **Not tested: real Android or iPhone browsers, a physical 1080p projector, venue Wi-Fi.** The event-day runbook requires one real phone and the projector to be checked at the venue rehearsal.

## 4. Known limitations carried into the event build

See `docs/PARITY_MATRIX.md` for the full list. Headlines: POLL and CONTENT slides deferred; multi-select points follow the "How points work" reference (500 per correct option) while another support article says 1000 — flagged; streak is display-only; no auto-advance; ending mid-question discards that question; one application instance (no Redis / replicas).
