# Parity matrix — ICTWEEK quiz vs. reference platform behaviour

Reference = Kahoot! feature behaviour as described in `docs/plan/BUILD_PROMPT.md`
(Release A items 1–16) and `docs/DESIGN.md` §4–§5. Only behaviour that was
implemented **and verified** is listed; untested claims are marked as such.

Device testing was performed in headless Chrome (CDP screenshots) and with
`socket.io-client` harnesses only — **real Android/iOS devices were not
tested by us**.

Remaining behavioural differences are numbered **B1–B18**, matching
`docs/AUDIT.md` section B row-for-row.

## Release A items (BUILD_PROMPT)

| # | Reference behaviour | Implementation (file/route) | Test (file::name) | Difference / note |
|---|---|---|---|---|
| 1 | Secure organizer login and quiz library | `routes/auth.ts`, `plugins/auth.ts`, argon2 hashes, `sid` httpOnly cookie; `LibraryPage` | `auth.test.ts::*` (12 tests) | — |
| 2 | Quiz create/edit/duplicate/reorder/autosave/validation/preview | `QuizEditorPage` (800 ms debounce → `PUT /quizzes/:id`), `QuizPreviewPage` | `quizzes.test.ts::CRUD round trip`, `duplicate produces a copy` | "Published versions" = immutable session snapshot (item 6), not a separate flag — **B1** |
| 3 | SINGLE / TRUE_FALSE / MULTI / POLL / CONTENT | `QuestionType` enum; editor add-question menu; `CONTENT_SLIDE` session state | `slides.test.ts` (2 tests — full deck through CONTENT_SLIDE, poll open/vote/reveal, no post-poll leaderboard, restart mid-slide) | Poll: single-select, unscored (`pointsMode NONE`, options `isCorrect:false`), distribution shown at reveal, **no leaderboard afterwards**, streak untouched. Content slide: title + body + image, host-advanced, no timer — **B13** (multi-select polls not offered) |
| 4 | Question/answer images, safe upload, alt text | `POST/PATCH /api/media` (magic-byte check via file-type, image-size dims), `MediaField` in editor | `media-csv.test.ts::accepts a png`, `::rejects wrong magic bytes`, `::rejects oversize`, `::scopes PATCH` | Local disk storage only; no remote URL fetching |
| 5 | CSV import w/ preview + template; JSON import/export | `GET /api/import-template.csv`, `POST /quizzes/:id/import-csv[/preview]`, `POST /quizzes/import`, per-quiz export | `media-csv.test.ts::serves the template`, `::previews valid rows`, `::imports only valid rows`; `csv.test.ts` (25 — incl. poll/content rows) | `format: "ictquiz-v1"` for JSON |
| 6 | Session creation w/ immutable quiz/settings snapshot | `POST /api/sessions` → `quizSnapshot` JSON incl. resolved media URLs and cover | `sessions.test.ts::POST /sessions on a valid quiz`; `media-csv::freezes media urls` | — |
| 7 | Unique active PIN, QR, join link, nickname, no account | `activePin` on session; `/join/:pin`; `qrcode` on display+host | `sessions.test.ts::GET /api/join/:pin is public`; `live.test.ts` joins | — |
| 8 | Lobby, count, removal, lock, late-join, player limit | `GameRoom.join/removeParticipant/setLocked`; `maxParticipants`, `allowLateJoin` settings | `live.test.ts::locks the lobby, removes participants and kills their tokens`, `::marks late joiners ineligible` | Removed participant's **nickname stays taken** for that session — **B9** |
| 9 | Host control UI + read-only projector view | `/admin/host/:id`; `/display/:displayKey` | `live.test.ts` host/display socket flows; phase screenshots | — |
| 10 | Countdown, timer, submit+ack, reveal, distribution, explanation, leaderboard, podium | `GameRoom` state machine; `TimerRing`; reveal/leaderboard/podium views | `live.test.ts::runs a full 2-question game`; `oracle.test.ts` recomputes every row independently | Countdown is **fixed 5 s**; **no auto-advance** after reveal — **B7** |
| 11 | Standard/no/double points, speed scoring, deterministic ties, streak display | `shared/scoring.ts`, `shared/ranking.ts` | `scoring.test.ts` (21), `ranking.test.ts` (7), `oracle.test.ts` (inline formula + inline ranking) | See scoring rows — **no streak bonus** (**B4**), deterministic ties (**B5**) |
| 12 | Manual next, close early, end, fullscreen, mute, keyboard | Host command bar + `Space/→/N`, `C`, `L`, `F`, `M`, `?` hints | `live.test.ts` command flows | Skip-question / hide-show leaderboard / auto-advance timer not implemented — **B7** |
| 13 | Mobile participant UI, optional question text, big targets, waiting/timeout/reconnect/finished states | `PlayPage` (≥5 rem cards, `showQuestionOnPlayer` setting, reconnect pill, removed banner) | `live.test.ts::resumes a player`, `::marks late joiners ineligible`; `check-phone-overflow.mjs` 390×844 pass | Tested headless only — see device note |
| 14 | Player/host refresh recovery + app-restart recovery | resumeToken + `state:sync`; `RoomManager.restore()` boot rule → `RECOVERY` (CONTENT_SLIDE restores as-is) | `live.test.ts::resumes a player`, `::recovers to RECOVERY on restart`; `slides.test.ts` restart-mid-slide | Leaderboard **deltas reset to 0** after restart (**B10**) |
| 15 | Reports: standings, responses, accuracy, times, CSV | `GET /api/sessions/:id/report[.csv]`, `SessionReportPage`; `scoredQuestionCount`; poll `n/a` cells | `report.test.ts` (2); `slides.test.ts` report asserts | Ending mid-question **voids** that attempt — **B16** |
| 16 | Compose deploy, HTTPS proxy, storage, migrations, backup/restore, rollback, runbooks | `docker/` + `docs/runbooks/` | compose verification (both `localhost` HTTPS and LAN-IP HTTP configurations) | — |

## Additional Release A fixes (this round)

| Reference behaviour | Implementation | Test | Difference / note |
|---|---|---|---|
| Cover image displayed | `GET /quizzes` resolves `cover: {url, alt}`; library card + host/display lobby thumbnails | `artifacts/round-a-screens/08,09` | — |
| Works on plain-http LAN (insecure contexts) | `lib/ids.ts` `randomId()` (getRandomValues fallback), `lib/clipboard.ts` execCommand fallback, join link text always visible; `docs/runbooks/lan-rehearsal.md` | live LAN-IP verification (`ws://<LAN-IP>` state + `joinUrl` on `http://`) | — |
| Change the organizer password | `POST /api/auth/change-password` (revokes other sessions, sets `passwordChangedAt`), `/admin/account` page + warning banner, `dist/scripts/set-password.js` | `auth.test.ts` change-password describe (5 tests); UI exercised in `round-b-screens/15–17` | — |
| Reports against independently calculated scores | `oracle.test.ts` — reads every Submission from the DB, recomputes points with an inline formula (does **not** import `scoring.ts`), recomputes the leaderboard inline; covers delayed answers, retry, restart+replay voided rows | `oracle.test.ts` (2 tests) | — |

## Engine & scoring rules (DESIGN §4–§5)

| Reference behaviour | Implementation | Test | Difference / note |
|---|---|---|---|
| `speedFactor`: rt<500 ms → 1; else `1 − rt/duration/2`, floor 0.5 | `scoring.ts::speedFactor` | `scoring.test.ts::speedFactor` (7 cases); `oracle.test.ts` delayed rows | — |
| maxPoints: NONE 0 / STANDARD 1000 / DOUBLE 2000 | `scoring.ts::maxPoints` | `scoring.test.ts::maps modes` | — |
| MULTI = 500 per correct (STANDARD) | `scoring.ts::multiPerCorrect` | `scoring.test.ts::MULTI` | **B6** — "How points work" says 500/correct, another support article says 1000 — we follow "How points work" and flag the conflict |
| MULTI any wrong selection → 0 | `scoreSubmission` | `::one correct + one wrong → 0` | — |
| Partial MULTI earns points but counts incorrect for streak/accuracy | `scoreSubmission` + close pass | `::one correct only → 500 & not fully correct` | — |
| POLL: exactly one known option; 0 points, not correct; streak/score untouched | `decideSubmission` single-id path + `closeQuestion` poll skip | `slides.test.ts` poll section | **B13** — single-select only |
| CONTENT: never scored, never timed, host-advanced; keeps authored position when questions are shuffled | `advanceTo`, `buildQuizSnapshot` | `slides.test.ts`, `snapshot.test.ts` shuffle test | — |
| Streak increments on correct, resets otherwise | `closeQuestion` pass | `live.test.ts::runs a full 2-question game` (streak asserted) | **B4** — display only, no streak bonus points |
| Ranking: score↓, correctCount↓, totalResponseMs↑, joinedAt↑, id↑ | `ranking.ts::rankParticipants` | `ranking.test.ts` (7); `oracle.test.ts` inline sort | **B5** — deterministic total order, no shared ranks |
| Leaderboard delta = prev rank − new rank | `GameRoom.computeLeaderboard` | `live.test.ts::runs a full game` (deltas) | **B10** — deltas are 0 after an app restart |
| All mutations through one serial queue | `GameRoom.run` promise chain | `live.test.ts` whole file | — |
| START locks lobby when `!allowLateJoin` | `GameRoom.start` | `live.test.ts::locks the lobby` | **B3** — late-join policy is a fixed rule, not configurable per reference default |
| COUNTDOWN → QUESTION_OPEN via timer | `armCountdown` | `live.test.ts::runs a full game` | Fixed 5 s (`COUNTDOWN_MS`, overridable in tests) — **B7** |
| Attempt: openedAt, deadlineAt = open+limit, attemptNo++ | `openQuestion` | `live.test.ts::recovers to RECOVERY` (attemptNo 2) | — |
| Close triggers: deadline / CLOSE_ANSWERS / all eligible answered | `closeQuestion` + deadline timer | `live.test.ts::runs a full game` (deadline + manual) | — |
| Scoring applied atomically with the close | `closeQuestion` one `$transaction` | `live.test.ts::recovers` (no double-score) | **B15** — `QUESTION_CLOSED` is transient: persisted state jumps QUESTION_OPEN → ANSWER_REVEAL in one transaction |
| NEXT → LEADERBOARD or FINISHED; after a POLL → next slide directly | `next` | `live.test.ts::runs a full game`; `slides.test.ts` | — |
| END → FINISHED (started) else CANCELLED | `GameRoom.end` | `report.test.ts::voids the open attempt when the host ends mid-question` | **B16** — ending mid-question voids the open attempt |
| RECOVERY: REPLAY voids attempt; END works | `replayQuestion`, `end` | `live.test.ts::recovers to RECOVERY`; `oracle.test.ts` second test | — |
| Boot recovery: mid-question states → RECOVERY; stable states (incl. CONTENT_SLIDE) restored | `RoomManager.restore` | `live.test.ts::recovers`; `slides.test.ts` | Timers are not re-armed for stable states |
| Eligibility: ACTIVE + joinedAt < attempt.openedAt | `GameRoom.submit` | `live.test.ts::marks late joiners ineligible` | — |
| Idempotent submit: same submissionId → original ack (incl. retry while the batch is pending); different → duplicate | `submit` reservation + `prior.pending` | `live.test.ts::dedupes submissions`, `::returns the original ack when a retry lands after the question closed`; `burst.test.ts` retry-while-pending | — |
| Ack only after commit | `submit` → `pendingInserts` batch (`createMany`, sequential `flushChain`) | `burst.test.ts` (4) | — |
| Answer key stripped for player/display until reveal | `buildSnapshot` | `live.test.ts::never leaks the answer key` | — |
| Leaderboard top 5 / podium top 3 | `buildSnapshot` | `live.test.ts::runs a full game` | — |
| Event logo optional, disabled by default | `VITE_EVENT_LOGO_URL` build-time var | — | **B2** — enabling needs a rebuild (runtime config deferred) |
| Lobby music | short synthesized cues only | — | **B8** — no bundled audio assets (licensing); cues cover transitions |
| Join-rate / PIN-enumeration protection | HTTP PIN lookup 600/min/IP; socket join 5/min per socket | `live.test.ts` rate-limit test | **B11** — no per-IP socket limit (venue NAT); residual risk documented |
| Browser end-to-end journeys | Socket.IO integration tests + headless-Chrome screenshot scripts | all of the above + `artifacts/*-screens/` | **B12** — no Playwright suite (stretch goal) |
| Nickname moderation | host removal only | `live.test.ts` remove flow | **B14** — no profanity filter |
| Release B/C features (typed answers, ordering, slider, word cloud, team play, accuracy mode, assignments, question bank, translations) | — | — | **B17** — explicitly out of Release A scope |
| Host disconnect handling | current question finishes on server timer; nothing auto-advances | `live.test.ts` | **B18** — matches README §5 recovery rules |

## Accepted differences — cross-reference with AUDIT.md §B

| # | Summary | Where in this document |
| --- | --- | --- |
| B1 | No publish/version table — immutable session snapshot instead | Release A item 2 |
| B2 | `VITE_EVENT_LOGO_URL` is build-time | Engine & scoring rows |
| B3 | Late-join policy fixed (next question), not configurable | Engine & scoring rows |
| B4 | Streak is display-only, no bonus points — **rankings can differ from the reference** for streaky players (see `docs/SCORING.md` §5) | Item 11 + engine rows |
| B5 | Deterministic total order `score ↓, correctCount ↓, totalResponseMs ↑, joinedAt ↑, id ↑`, no shared ranks (`docs/SCORING.md` §6) | Item 11 + engine rows |
| B6 | MULTI 500 per correct option selected, any wrong pick → 0 (reference articles conflict 500 vs 1000; `docs/SCORING.md` §3) | Engine & scoring rows |
| B7 | No skip-question / hide-leaderboard / auto-advance; fixed 5 s countdown | Items 10, 12 + engine rows |
| B8 | Synthesized cues only, no lobby music | Engine & scoring rows |
| B9 | Removed participant's nickname stays reserved | Item 8 |
| B10 | Leaderboard deltas reset to 0 after restart | Item 14 + engine rows |
| B11 | No per-IP socket join limit | Engine & scoring rows |
| B12 | No Playwright suite | Engine & scoring rows |
| B13 | Polls are single-select | Item 3 + engine rows |
| B14 | No profanity filter | Engine & scoring rows |
| B15 | `QUESTION_CLOSED` is transient | Engine & scoring rows |
| B16 | Ending mid-question voids that question | Item 15 + engine rows |
| B17 | Release B/C features not implemented | Engine & scoring rows |
| B18 | No auto-advance on host disconnect | Engine & scoring rows |
