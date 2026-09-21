# Scoring, streaks and ranking — exact rules in this build

These are the rules the server applies. They are implemented in
`packages/shared/src/scoring.ts` and `packages/shared/src/ranking.ts`, applied by the game engine at
question close, and independently re-checked by `apps/server/test/oracle.test.ts`. Where they differ
from the reference product the difference is stated.

## 1. Response time

`responseTimeMs = serverReceivedAt − questionOpenedAt`, both measured on the server. Phone clocks are
never used. A response received after the deadline is rejected (`LATE`) and scores nothing.

## 2. Speed factor

```
factor(rt, limit) = 1                         if rt < 500 ms
                  = 1 − (min(rt, limit) / limit) / 2   otherwise
```

`limit` is the question's time limit in ms. The factor runs from 1.0 (answered within half a second)
down to 0.5 (answered at the deadline). Example from the reference documentation: 2 s on a 30 s
question → 1 − (2/30)/2 = 0.9667.

## 3. Points by question type

| Type | Standard | Double | No points | Rule |
| --- | --- | --- | --- | --- |
| Single choice | up to 1000 | up to 2000 | 0 | `round(max × factor)` if the chosen option is correct, else 0 |
| True / false | up to 1000 | up to 2000 | 0 | same as single choice |
| Multi-select | **500 per correct option selected** | 1000 per correct option | 0 | If **any** selected option is wrong → 0. Otherwise `round(count(selected) × perCorrect × factor)`. Selecting only some of the correct options earns points for those but counts as *not fully correct* (see §4) |
| Poll | 0 | 0 | 0 | Never scored; not counted as correct or incorrect |
| Content slide | — | — | — | No answers |

Worked multi-select example (2 correct options of 4, Standard, answered in 2 s of 30 s):

| Selection | Points | Fully correct? |
| --- | --- | --- |
| both correct options | round(2 × 500 × 0.9667) = **967** | yes |
| one correct option only | round(1 × 500 × 0.9667) = **483** | no |
| one correct + one wrong | **0** | no |
| all four | **0** | no |

**Reference conflict:** the reference product's "How points work" article states 500 points per correct
option for multi-select; another support article states 1000 per correct option. This build follows
"How points work". To switch, change `MULTI_POINTS_PER_CORRECT_STANDARD` in
`packages/shared/src/scoring.ts` (Double is always twice that) and re-run `pnpm test`. A fully correct
two-option multi-select therefore scores the same as a single-choice question (up to 1000), not 2000.

## 4. What happens when a question closes

For every active participant, in one database transaction with the state change:

| Outcome | score | streak | correctCount | totalResponseMs |
| --- | --- | --- | --- | --- |
| fully correct answer | `+points` | `+1` | `+1` | `+responseTimeMs` |
| partially correct multi-select (points > 0, not fully correct) | `+points` | reset to 0 | unchanged | unchanged |
| wrong, no answer, or late | unchanged | reset to 0 | unchanged | unchanged |
| poll (any outcome) | unchanged | **unchanged** | unchanged | unchanged |

A question voided by *Replay question* (after an application restart) or by *End session* mid-question
never enters these totals, and its answers are excluded from reports.

## 5. Streaks are display-only

The phone shows "Streak ×N" after N consecutive fully correct answers. **No bonus points are awarded for
streaks.** The reference product does award a streak bonus, so rankings in this build can differ from
the reference for the same answers: a player with a long streak gains no extra lead, and a player who
answers slightly faster but breaks streaks is not penalised relative to them. This is the behaviour the
plan specified ("streak display separately from any streak bonus"); a bonus formula would have had to be
invented because the reference does not document one.

## 6. Ranking and tie-break — exact order

Participants are sorted by, in this order:

1. `score` — higher first
2. `correctCount` — more fully correct answers first
3. `totalResponseMs` — smaller first (sum of response times of the fully correct answers only)
4. `joinedAt` — earlier join first
5. `id` — lexical, as a final deterministic fallback

Rank is the 1-based position in that order. **There are no shared ranks**: two players with identical
scores never both show "#2"; the one with more correct answers, then the faster one, ranks higher. The
same function produces the live leaderboard, the podium and the report standings, so they always agree.

Example: A 2000 pts / 2 correct / 3.1 s total; B 2000 pts / 2 correct / 2.4 s total; C 2000 pts / 1 correct
(one partial multi-select) → order **B, A, C**.

Leaderboard arrows show `previous rank − new rank`. After an application restart the first leaderboard
shows no arrows because previous ranks are not persisted.

## 7. Where the numbers are checked

- Unit tests with hand-computed expectations (`packages/shared/test/scoring.test.ts`,
  `ranking.test.ts`), including the reference's own 967-point worked example.
- `apps/server/test/oracle.test.ts` replays a game with deliberately delayed answers and recomputes every
  persisted score from `responseTimeMs` with an inline formula that does not import the production
  code, then re-derives the ranking inline.
- The load-test harness reconciles each client's own `+points` total with the server's final score.
