# Usability review — hands-on session (2026-09-21)

Setup: production build (Compose stack) in LAN mode at `http://192.168.1.161`, sample quiz
"ICTWEEK — ICT Basics" (intro slide, 8 questions, 1 poll). Renders reviewed at 1440×900 and
1280×720 (organizer/host), 1920×1080 (projector), 390×844 (phone) — `artifacts/usability/`.

Two sources are kept apart below: **[R]** = my observations from the rendered screens and from
driving the UI by script; **[U]** = feedback from the organizer trying tasks live (filled in during
the session). Ordered by impact on the event.

## 1. Event-blocking or event-degrading

| # | Source | Screen | Finding | Evidence |
| --- | --- | --- | --- | --- |
| H1 | [R] | Phone | **A removed player sees a blank page.** `PlayPage` clears the stored credentials on `player:removed`, then re-renders and returns `null` because credentials are missing — before the "You were removed" banner can render. The banner is unreachable. | `67-phone-removed.png` (empty), `PlayPage.tsx` render order |
| H2 | [R] | Host | **On a 1280×720 laptop the host's primary control ("Close answers" / "Next") sits at or below the fold during a live question.** The PIN + QR block stays full-size throughout the game and pushes the question panel and the control bar down. At 1440 the QR also overlaps the last PIN digit. | `21-host-question-open-1280.png`, `08`, `13` |
| H3 | [R] | Phone | **During a question the phone shows only four coloured cards** — no time remaining, no question number, and a poll looks identical to a scored question until after the tap. Players cannot tell how long they have or that a poll is unscored. | `57` and `63` are byte-identical |
| H4 | [R] | Host / phone | **Question numbering counts content slides** ("Q2/10" for the first real question). Hosts announcing "question 2" while the deck shows the first question will confuse the room. | `11`, `13` |
| H5 | [R] | Session settings | The button that creates the session is labelled **"Start session"** — it opens a lobby, it does not start the game. A host may hesitate or think players are already being timed. | `06-session-settings.png` |

## 2. Medium — slows the host or players, not blocking

| # | Source | Screen | Finding | Evidence |
| --- | --- | --- | --- | --- |
| M1 | [R] | Host header | Developer wording: `State LEADERBOARD · rev 9 · Q2/10`. Should read as a phase in plain words; the revision number means nothing to a host. | `13` |
| M2 | [R] | Host | Remove-player control is a bare `×` with no label; the script driver also had to hunt for it. | `08`, `13` |
| M3 | [R] | Host | "Lobby open" next to the player count is ambiguous once the game runs (it means late joiners may still enter). | `13` |
| M4 | [R] | Projector | Join URL under the PIN is small for a back row; "Tap to enable sound" pill stays on every screen until someone clicks the projector page. | `30`, `34` |
| M5 | [R] | Editor | Option text inputs are truncated by the per-option "Add image" button; the tiny `×` (delete option) sits right beside the "correct" toggle; the "Add question" menu is only at the bottom of a long list. | `03-editor-single.png` |
| M6 | [R] | Phone | Reveal shows `+points` and the explanation but not the running total or rank; players only learn their total on the leaderboard screen. | `59` |

## 3. Cosmetic

| # | Source | Finding |
| --- | --- | --- |
| L1 | [R] | Library titles are cut without an ellipsis when long; card shows both a clickable title and an "Open" button. |
| L2 | [R] | Phone lobby text "See your name on the big screen" is fine; the finished screen lists only the top 3 by design. |
| L3 | [R] | Test data (load-test quizzes/sessions) clutters the library on this machine — operational, not product. |

## 4. Live-session feedback [U]

_(filled in during the guided game; one row per task)_

| Task | What the organizer tried | Where it was unclear | Outcome |
| --- | --- | --- | --- |

## 5. Decisions and fixes

_(agreed after the session)_
