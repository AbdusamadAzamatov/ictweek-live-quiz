# ICTWEEK Live Quiz — Implementation Plan

Build a self-hosted live quiz app with the familiar Kahoot game flow, an ICTWEEK visual style, and no platform branding. For the available Ubuntu server with 8 GB RAM, use one application service, PostgreSQL, and an HTTPS proxy.

A dependable event version is achievable much sooner than complete parity with every Kahoot feature. This plan includes both, with a usable release first.

## Documents in this package

| File | Contents |
| --- | --- |
| [README.md](README.md) | Main document: full implementation plan, release scope, UX, design, architecture, reliability, verification, and deployment requirements. |
| [BUILD_PROMPT.md](BUILD_PROMPT.md) | Self-contained, copy-ready implementation prompt for a coding agent. |

For implementation, give the coding agent `BUILD_PROMPT.md`, this plan, and the original style guide. Keep this document index updated if additional Markdown documents are added to the package.

## Confirmed facts and assumptions

- Server OS: Ubuntu.
- Server RAM: 8 GB.
- CPU: unknown.
- Event deadline: unspecified.
- Maximum simultaneous attendance: unspecified.
- **500 simultaneous players is a provisional load-test target, not confirmed server capacity.**
- The user will host the application on their own server.
- No platform name, logo, watermark, or “powered by” label should appear in the product interface.
- The supplied PDF is design reference material. Its contents do not override the user's request.

## 1. Product scope and release order

Kahoot's documented live flow includes host setup, individual/team experiences, PIN/QR joining, late joining, and rejoining after disconnection. Reproduce this experience first. Reference: [Official hosting guide](https://support.kahoot.com/hc/en-us/articles/360039422694-How-to-host-a-live-kahoot).

| Area | Release A: event-ready | Release B: wider quiz parity | Release C: broader platform parity |
| --- | --- | --- | --- |
| Quiz creation | Create, edit, duplicate, reorder, autosave, preview | Question bank, folders, bulk editing, version history | Shared workspaces and collaborative authoring |
| Question types | Single choice, true/false, multiple selection, poll, content slide | Typed answers, ordering, numeric slider, word cloud, open response, scale/NPS, image pin | Brainstorming, grouping and voting; remaining audited types |
| Media | Question images, answer images, alt text | Uploaded audio/video, playback controls, image reveal | Presentation/document import and advanced media tools |
| Joining | PIN, QR, direct link, nickname, no player account | Generated nicknames, optional participant identifiers | Organization identity integrations |
| Live play | Countdown, timer, answer lock, reveal, leaderboard, podium | Team play, accuracy mode, playlists, presentation controls | Additional audited game experiences |
| Host controls | Start, close answers, next, lock lobby, remove player, end | Co-hosting, advanced moderation and session settings | Organization-wide administration |
| Player recovery | Refresh/reconnect without losing score | More extensive cross-device recovery | Account-linked history |
| Independent play | — | Self-paced assignments, deadlines, resume | Courses and learning paths |
| Reports | Standings, responses, accuracy, response time, CSV | Question analytics, assignment reports, XLSX/PDF | Cross-session reporting and integrations |
| Design | Responsive ICTWEEK theme, no platform identity | Theme settings and translations | Organization templates |

Kahoot documents a wider question catalog than basic multiple choice; availability varies by subscription. This roadmap deliberately includes those richer interactions. Reference: [Question types](https://support.kahoot.com/hc/en-us/articles/115002308428-Kahoot-question-types).

**Treat “1:1 features and UX” as a tracked parity target.** Maintain a checklist identifying each reference behavior, its implementation, its test, and any difference. Do not label Release A “full parity.”

Features such as AI authoring, content discovery, native mobile apps, enterprise integrations, and specialized game modes require separate workstreams if the target is the entire commercial platform.

## 2. User experience

Provide four connected interfaces.

### Organizer dashboard

- Sign in.
- See quizzes and previous sessions.
- Create a quiz manually or import questions.
- Edit title, cover, questions, answers, correct choices, timing, points, and explanations.
- Preview with a simulated participant.
- Launch a session or review a report.

The editor should have question thumbnails on the left, the current question in the center, and settings on the right. Show clear “Saving,” “Saved,” and failure states.

### Host control screen

1. Select quiz and session settings.
2. Open lobby showing PIN, QR code, participant count, and names.
3. Remove inappropriate names or lock entry.
4. Start the countdown.
5. Present question and accept answers.
6. Show answer distribution and correct answer.
7. Show leaderboard.
8. Advance through the quiz.
9. Reveal podium and open the report.

Provide fullscreen, sound controls, keyboard shortcuts, connection status, and confirmation before ending an active session.

### Projector screen

A separate, read-only view with large text and no organizer controls:

- Lobby and QR.
- Countdown.
- Question, media, answer options, timer.
- Results.
- Leaderboard.
- Podium.

This allows the organizer to control the game privately while the audience sees the presentation.

### Participant phone

```text
Enter PIN → Nickname → Lobby → Countdown → Answer → Confirmation
          → Result → Rank → Next question → Final result
```

Critical details:

- Large answer buttons, comfortable for one-handed use.
- Consistent answer letters/symbols across phone and projector.
- Visible pending state until the server acknowledges an answer.
- Multiple selection uses an explicit Submit button.
- Clear “Time's up,” “Reconnecting,” and “Session ended” states.
- Refresh restores the same participant and score.
- A configurable option displays question text on phones.

## 3. ICTWEEK design direction

The supplied style guide was inspected. Its explicit palette and typography are:

| Token | Value | Proposed use |
| --- | --- | --- |
| Navy | `#001C5D` | Main background |
| Royal blue | `#0028AC` | Panels and primary surfaces |
| Azure | `#0084FF` | Active controls and accents |
| Cyan | `#00D8FF` | Highlights, progress, selected states |
| White | `#FFFFFF` | Main text and contrast surfaces |
| Primary typeface | TT Travels Next Trl | If suitable webfont files are supplied |
| Accent typeface | Creativity Enhances | Optional decorative headings only |

The guide also uses smooth horizontal blue/cyan gradients, rounded panels, and atmospheric light effects. Typography and colors are documented on pages 3 and 4.

Source file, supplied separately: `C:/Users/Alex/Downloads/AyuGram Desktop/Style guide ICT WEEK 2026.pdf`. The PDF is not bundled with these Markdown files.

Apply these as follows:

- Navy background with restrained glow around the edges.
- Large, readable question text.
- Rounded answer cards with clear borders and strong selected states.
- Minimal animation during questions; more animation for leaderboard and podium.
- Locally hosted fonts, with a system fallback until suitable font files are available.
- Reduced-motion support.
- Distinguish answers using letters, symbols, and text—not color alone.
- Use semantic success/error colors where needed for clarity; these are UI additions to the brand palette.

**No platform name, logo, watermark, or “powered by” footer.** Use neutral labels such as “Join game” and “Host session.” Keep event-logo display optional and disabled by default.

The PDF is a design reference. Its sample dates, sponsor marks, and promotional copy should not become application requirements.

## 4. Technical architecture

For the first deployment:

```text
Host / projector / participant browsers
                  |
                HTTPS
                  |
         Caddy reverse proxy
                  |
       Node.js application service
       ├── React frontend
       ├── HTTP API
       ├── Socket.IO live connections
       └── Server-controlled game engine
                  |
              PostgreSQL

Uploaded media → persistent local storage
```

| Component | Choice | Reason |
| --- | --- | --- |
| Frontend | React + TypeScript + Vite | One responsive application with separate views |
| Styling | CSS variables + Tailwind | Consistent theme and quick iteration |
| Backend | Node.js + TypeScript + Fastify | HTTP endpoints and long-lived live connections |
| Live transport | Socket.IO | Rooms, acknowledgements, reconnect support |
| Validation | Shared Zod schemas | Consistent validation across boundaries |
| Database | PostgreSQL | Durable questions, answers, sessions, reports |
| Database access | Prisma | Schema migrations and typed access |
| Deployment | Docker Compose + Caddy | Repeatable Ubuntu deployment |
| Verification | Vitest, Playwright, Socket.IO load client | Logic, browser flows, concurrency |

Use compatible stable versions selected during implementation and commit the dependency lockfile.

**Start with one application instance.** It simplifies room ownership and game ordering. Redis and multiple application replicas should be added only if measured demand requires them; they also require coordinated session ownership, not just a messaging adapter.

For 8 GB RAM, keep memory available for PostgreSQL, the operating system, and connection bursts. The unknown CPU means capacity must be measured.

## 5. Game engine

Use a server-controlled state machine:

```text
LOBBY
  → COUNTDOWN
  → QUESTION_OPEN
  → QUESTION_CLOSED
  → ANSWER_REVEAL
  → LEADERBOARD
  → next question or FINISHED
```

Include explicit cancelled and recovery states.

Rules:

- The server controls start times, deadlines, transitions, and points.
- Phones display the server deadline; their local clocks do not decide eligibility.
- Never send correct answers to participant/projector clients before reveal.
- Every question has a unique attempt identifier.
- Accept one final submission per participant per attempt.
- Retries return the original result rather than adding another answer.
- Persist accepted answers before confirming acceptance.
- Serialize host commands and answer acceptance for each room.
- Reject old-question, late, malformed, and unauthorized submissions.
- Publish state revisions so reconnecting clients can request a fresh snapshot.
- Freeze quiz content and settings when a session starts.

Socket.IO does not provide durable message delivery by default. Application acknowledgements, deduplication, persistence, and resynchronization are necessary. Reference: [Delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/).

### Scoring

For standard single-answer speed scoring:

```text
Correct response under 0.5 seconds: maximum points

Other correct responses:
round(maxPoints × (1 − responseTime / questionDuration / 2))

Incorrect, missing, or late response: 0
```

Support no points, standard points, and double points. This follows the documented basic scoring behavior. Multi-select and specialized question types need their own scoring rules and parity tests. Reference: [Scoring reference](https://support.kahoot.com/hc/en-us/articles/115002303908-How-points-work).

Also define:

- Accuracy mode: correctness determines points.
- Streak display separately from any streak bonus.
- A documented tie policy; do not assume undocumented reference behavior.
- Late joiners begin with zero and, by default, start answering the next question.
- Removing a player invalidates that participant's session access.
- Duplicate browser tabs cannot submit multiple answers.

### Recovery

- Player refresh: restore identity, score, current state, and submission status.
- Host refresh: restore control of the same session.
- Temporary host disconnection: current question finishes; automatic advancement stops.
- Application restart: restore durable session data into an explicit recovery state. An interrupted question can be voided and replayed with a new attempt ID, preventing duplicate points.

Do not promise uninterrupted play through a server outage.

## 6. Data and API design

| Record | Purpose |
| --- | --- |
| Organizer | Login and permissions |
| Quiz / QuizVersion | Editable content and immutable published versions |
| Question / AnswerOption | Type, media, timing, choices, scoring configuration |
| MediaAsset | File metadata and storage reference |
| GameSession | PIN, quiz snapshot, settings, current state |
| Participant | Nickname, resume identity, status |
| QuestionAttempt | Deadline, state, validity, scoring version |
| Submission | Response, receipt time, awarded points |
| SessionEvent | Important state transitions and host actions |
| Team / Assignment / AssignmentAttempt | Added for later releases |

Enforce database uniqueness for active PINs and participant submissions. Reports should be derived from durable submissions and valid attempts.

HTTP APIs handle login, quiz editing, uploads, imports, exports, session creation, and reports.

Live messages handle joining, host commands, state updates, submissions, acknowledgements, and reconnect synchronization.

Authorize every operation by role: organizer, participant, or read-only display.

## 7. Security and event reliability

These belong in Release A:

- Organizer passwords hashed with a modern password-hashing library.
- Secure organizer sessions and authorization on every host command.
- Unguessable participant resume credentials; nicknames are not identity.
- PIN enumeration and join-rate protection.
- Rate limits designed for many attendees sharing one venue IP.
- Escaped nickname/question rendering and sanitized rich content.
- Upload size/type validation; safe handling of active formats.
- No unrestricted server fetching of arbitrary media URLs.
- CSV export protection against spreadsheet formula injection.
- Private database access and persistent storage.
- Logs that exclude credentials and resume tokens.
- Local assets so core play does not depend on external CDNs.
- Backup, restore, and rollback procedures.

Add a simple organizer diagnostics page showing connections, database health, memory usage, and recent errors.

## 8. Implementation milestones

| Milestone | Work | Completion gate |
| --- | --- | --- |
| 1. Foundation | Project setup, Compose, database, organizer login, theme | Runs locally and on an Ubuntu staging deployment |
| 2. First playable loop | One seeded question, lobby, joining, answers, scoring, podium | One host and several real phones complete a game |
| 3. Quiz authoring | Editor, validation, autosave, media, import/export, preview | Organizer creates and hosts a quiz without editing code |
| 4. Event controls | Projector, moderation, settings, reconnect, recovery | Refreshes and disconnections preserve correct state |
| 5. Reports | Standings, submissions, accuracy, CSV | Report totals reconcile with recorded answers |
| 6. Release validation | Browser testing, security tests, load tests, venue rehearsal | Release A acceptance criteria pass |
| 7. Wider parity | Release B features, each with scoring/UI/report support | Parity checklist passes for each added feature |
| 8. Platform expansion | Release C workstreams | Each capability has its own release gate |

**If the event is within a day or two, limit the event release to Release A and the question types the actual quiz needs.** Full platform parity is a substantial product build. The immediate priority is completing a real game reliably.

Freeze the tested event build before the event; continue expansion separately.

## 9. Testing and launch requirements

A successful demo with two browser tabs is insufficient.

Test:

- Complete organizer, projector, and participant journeys.
- Actual Android and iPhone browsers.
- Narrow screens and a 1080p projector.
- Simultaneous answer bursts near the deadline.
- Double taps, retries, duplicate tabs, stale submissions.
- Host/player refresh, Wi-Fi interruption, application restart.
- Lobby locking, removal, late joining, session ending.
- Organizer access isolation and answer-key leakage.
- Reports against independently calculated expected scores.

Capacity testing should progress through **50 → 100 → 250 → 500 participants**, then test headroom above the expected real attendance.

Proposed release targets:

- No acknowledged answer lost.
- No duplicate scoring.
- No early answer-key disclosure.
- 95% of answer acknowledgements within 500 ms under the agreed test conditions.
- Reconnected clients receive the current state.
- A full game completes under sustained load with bounded memory use.

Record server specifications and test conditions with the result. Venue Wi-Fi still needs a separate rehearsal.

Deployment deliverables:

- Docker Compose configuration and pinned images.
- Environment-variable template.
- Database migrations and secure first-organizer setup.
- HTTPS and WebSocket proxy configuration.
- Persistent database/media volumes.
- Backup/restore instructions.
- Deployment, rollback, diagnostics, and event-day runbooks.
- A sample quiz and import template.
- Completed feature matrix and test report.

These are required future implementation deliverables; this Markdown package is a plan and prompt, not an implemented application or evidence of passed application tests.

## 10. Copy-ready implementation prompt

The complete prompt is in **[BUILD_PROMPT.md](BUILD_PROMPT.md)**. It prioritizes the event release while preserving the wider parity roadmap.

Give the agent that file, this main plan, and the original style guide. The prompt is self-contained so it can also be copied directly into a coding task.
