# Parity matrix — ICTWEEK quiz vs. reference platform behaviour

Reference = Kahoot! feature behaviour as described in `docs/plan/BUILD_PROMPT.md`
(Release A items 1–16) and `docs/DESIGN.md` §4–§5. Only behaviour that was
implemented **and verified** is listed; untested claims are marked as such.

Device testing was performed in headless Chrome (CDP screenshots) and with
`socket.io-client` harnesses only — **real Android/iOS devices were not
tested by us**.

## Release A items (BUILD_PROMPT)

| # | Reference behaviour | Implementation (file/route) | Test (file::name) | Difference / note |
|---|---|---|---|---|
| 1 | Secure organizer login and quiz library | `routes/auth.ts`, `plugins/auth.ts`, argon2 hashes, `sid` httpOnly cookie; `LibraryPage` | `auth.test.ts::*` (7 tests) | — |
| 2 | Quiz create/edit/duplicate/reorder/autosave/validation/preview | `QuizEditorPage` (800 ms debounce → `PUT /quizzes/:id`), `QuizPreviewPage` | `quizzes.test.ts::CRUD round trip`, `duplicate produces a copy` | "Published versions" = immutable session snapshot (item 6), not a separate flag |
| 3 | SINGLE / TRUE_FALSE / MULTI (+ poll, content) | `QuestionType` enum; editor add-question menu | `quiz.test.ts::accepts a valid 3-type quiz` | **POLL and CONTENT are deferred** — enum reserves them; `validateQuizForPlay` reports "unsupported" |
| 4 | Question/answer images, safe upload, alt text | `POST/PATCH /api/media` (magic-byte check via file-type, image-size dims), `MediaField` in editor | `media-csv.test.ts::accepts a png`, `::rejects wrong magic bytes`, `::rejects oversize`, `::scopes PATCH` | Local disk storage only; no remote URL fetching |
| 5 | CSV import w/ preview + template; JSON import/export | `GET /api/import-template.csv`, `POST /quizzes/:id/import-csv[/preview]`, `POST /quizzes/import`, per-quiz export | `media-csv.test.ts::serves the template`, `::previews valid rows`, `::imports only valid rows`; `csv.test.ts` (21) | `format: "ictquiz-v1"` for JSON |
| 6 | Session creation w/ immutable quiz/settings snapshot | `POST /api/sessions` → `quizSnapshot` JSON incl. resolved media URLs | `sessions.test.ts::POST /sessions on a valid quiz`; `media-csv::freezes media urls` | — |
| 7 | Unique active PIN, QR, join link, nickname, no account | `activePin` on session; `/join/:pin`; `qrcode` on display+host | `sessions.test.ts::GET /api/join/:pin is public`; `live.test.ts` joins | — |
| 8 | Lobby, count, removal, lock, late-join, player limit | `GameRoom.join/removeParticipant/setLocked`; `maxParticipants`, `allowLateJoin` settings | `live.test.ts::locks the lobby, removes participants and kills their tokens`, `::marks late joiners ineligible` | Removed participant's **nickname stays taken** for that session |
| 9 | Host control UI + read-only projector view | `/admin/host/:id`; `/display/:displayKey` | `live.test.ts` host/display socket flows; phase screenshots | — |
| 10 | Countdown, timer, submit+ack, reveal, distribution, explanation, leaderboard, podium | `GameRoom` state machine; `TimerRing`; reveal/leaderboard/podium views | `live.test.ts::runs a full 2-question game` | Countdown is **fixed 5 s**; **no auto-advance** after reveal (host drives NEXT) |
| 11 | Standard/no/double points, speed scoring, deterministic ties, streak display | `shared/scoring.ts`, `shared/ranking.ts` | `scoring.test.ts` (20), `ranking.test.ts` (7) | See scoring rows below — **no streak bonus** (display only) |
| 12 | Manual next, close early, end, fullscreen, mute, keyboard | Host command bar + `Space/→/N`, `C`, `L`, `F`, `M`, `?` hints | `live.test.ts` command flows | — |
| 13 | Mobile participant UI, optional question text, big targets, waiting/timeout/reconnect/finished states | `PlayPage` (≥5 rem cards, `showQuestionOnPlayer` setting, reconnect pill, removed banner) | `live.test.ts::resumes a player`, `::marks late joiners ineligible` | Tested headless only — see device note |
| 14 | Player/host refresh recovery + app-restart recovery | resumeToken + `state:sync`; `RoomManager.restore()` boot rule → `RECOVERY` | `live.test.ts::resumes a player`, `::recovers to RECOVERY on restart` | Leaderboard **deltas reset to 0** after restart (previousRanks is in-memory) |
| 15 | Reports: standings, responses, accuracy, times, CSV | `GET /api/sessions/:id/report[.csv]`, `SessionReportPage` | `report.test.ts` (2) | Ending mid-question **voids** that attempt (see A-fix) |
| 16 | Compose deploy, HTTPS proxy, storage, migrations, backup/restore, rollback, runbooks | `docker/` + `docs/runbooks/` | this phase's compose verification | — |

## Engine & scoring rules (DESIGN §4–§5)

| Reference behaviour | Implementation | Test | Difference / note |
|---|---|---|---|
| `speedFactor`: rt<500 ms → 1; else `1 − rt/duration/2`, floor 0.5 | `scoring.ts::speedFactor` | `scoring.test.ts::speedFactor` (7 cases) | — |
| maxPoints: NONE 0 / STANDARD 1000 / DOUBLE 2000 | `scoring.ts::maxPoints` | `scoring.test.ts::maps modes` | — |
| MULTI = 500 per correct (STANDARD) | `scoring.ts::multiPerCorrect` | `scoring.test.ts::MULTI` | **Source conflict**: "How points work" says 500/correct, another support article says 1000 — we follow "How points work" and flag the conflict |
| MULTI any wrong selection → 0 | `scoreSubmission` | `::one correct + one wrong → 0` | — |
| Partial MULTI earns points but counts incorrect for streak/accuracy | `scoreSubmission` + close pass | `::one correct only → 500 & not fully correct` | — |
| Streak increments on correct, resets otherwise | `closeQuestion` pass | `live.test.ts::runs a full 2-question game` (streak asserted) | **Display only — no streak bonus points** (documented deviation) |
| Ranking: score↓, correctCount↓, totalResponseMs↑, joinedAt↑, id↑ | `ranking.ts::rankParticipants` | `ranking.test.ts` (7) | **Deterministic total order — no shared ranks** (deviation) |
| Leaderboard delta = prev rank − new rank | `GameRoom.computeLeaderboard` | `live.test.ts::runs a full game` (deltas) | Deltas are 0 after an app restart |
| All mutations through one serial queue | `GameRoom.run` promise chain | `live.test.ts` whole file | — |
| START locks lobby when `!allowLateJoin` | `GameRoom.start` | `live.test.ts::locks the lobby` | — |
| COUNTDOWN → QUESTION_OPEN via timer | `armCountdown` | `live.test.ts::runs a full game` | Fixed 5 s (`COUNTDOWN_MS`, overridable in tests) |
| Attempt: openedAt, deadlineAt = open+limit, attemptNo++ | `openQuestion` | `live.test.ts::recovers to RECOVERY` (attemptNo 2) | — |
| Close triggers: deadline / CLOSE_ANSWERS / all eligible answered | `closeQuestion` + deadline timer | `live.test.ts::runs a full game` (deadline + manual) | — |
| Scoring applied atomically with the close | `closeQuestion` one `$transaction` | `live.test.ts::recovers` (no double-score) | **QUESTION_CLOSED is transient** — persisted state jumps QUESTION_OPEN → ANSWER_REVEAL in one transaction |
| NEXT → LEADERBOARD or FINISHED | `next` | `live.test.ts::runs a full game` | — |
| END → FINISHED (started) else CANCELLED | `GameRoom.end` | `report.test.ts::voids the open attempt when the host ends mid-question` | **Ending mid-question voids the open attempt** — its submissions never enter reports |
| RECOVERY: REPLAY voids attempt; END works | `replayQuestion`, `end` | `live.test.ts::recovers to RECOVERY` | — |
| Boot recovery: mid-question states → RECOVERY; stable states restored | `RoomManager.restore` | `live.test.ts::recovers` | Timers are not re-armed for stable states |
| Eligibility: ACTIVE + joinedAt < attempt.openedAt | `GameRoom.submit` | `live.test.ts::marks late joiners ineligible` | — |
| Idempotent submit: same submissionId → original ack; different → duplicate | `submit` P2002 path + post-close precheck | `live.test.ts::dedupes submissions`, `::returns the original ack when a retry lands after the question closed` | — |
| Ack only after commit | `submit` | `live.test.ts` | — |
| Answer key stripped for player/display until reveal | `buildSnapshot` | `live.test.ts::never leaks the answer key` | — |
| Leaderboard top 5 / podium top 3 | `buildSnapshot` | `live.test.ts::runs a full game` | — |
| No team mode / accuracy mode / generated nicknames | — | — | Not implemented (out of Release A scope) |
