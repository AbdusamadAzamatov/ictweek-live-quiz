# Implementation Prompt — ICTWEEK Live Quiz

Companion document: [Full implementation plan and package index](README.md).

Copy the prompt below into a coding agent and attach the original `Style guide ICT WEEK 2026.pdf`. This file contains implementation instructions for that future task; creating this document does not itself start implementation.

---

Build a production-ready, self-hosted multiplayer quiz application for an ICTWEEK event.

The desired experience is functional and behavioral parity with Kahoot's quiz-authoring and live-game workflows, using an original ICTWEEK visual design. Do not include a platform name, platform logo, watermark, “powered by” footer, or Kahoot assets in the product interface. Use neutral action labels.

## Target deployment

- Ubuntu server.
- 8 GB RAM.
- CPU specifications unknown.
- Provisional load-test target: 500 simultaneous participants. Do not claim this capacity until measured.
- Self-hosted core functionality with no required paid service.
- Deadline and actual attendance are not yet specified.

Work autonomously on reversible implementation steps. Inspect the repository and applicable AGENTS.md files first. Preserve existing useful architecture and unrelated work. Ask only for consequential missing information; continue independent work while awaiting answers. Prepare a reviewable deployment package; obtain approval before changing a production server.

## Scope and parity

Create a feature-parity matrix with reference behavior, implementation status, test coverage, and differences. Consult official current reference documentation when behavior is uncertain. Never invent undocumented behavior or describe a partial implementation as full parity.

Implement Release A first, through verification:

1. Secure organizer login and quiz library.
2. Quiz creation, editing, duplication, question reordering, autosave, validation, preview, and published versions.
3. Single-choice, true/false, multi-select, unscored poll, and content-slide questions.
4. Question/answer images with safe upload handling and alt text.
5. CSV question import with validation preview and downloadable template; versioned JSON import/export.
6. Session creation with an immutable quiz/settings snapshot.
7. Unique active game PIN, QR join code, direct join link, nickname entry, and no required participant account.
8. Lobby, participant count, participant removal, entry lock, late-join policy, and configurable player limit.
9. Host control interface and separate read-only projector view.
10. Countdown, question timer, answer submission/acknowledgement, answer reveal, response distribution, explanation, leaderboard, and final podium.
11. Standard/no/double points, documented speed scoring, deterministic tie handling, and streak display.
12. Manual next question, close answers early, end session, fullscreen, mute, and keyboard controls.
13. Mobile participant UI with optional question text, large answer targets, and explicit waiting, timeout, reconnect, and finished states.
14. Player/host refresh recovery and safe application-restart recovery.
15. Reports with standings, participant responses, accuracy, response times, and CSV export.
16. Docker Compose deployment, HTTPS proxy, persistent storage, migrations, backup/restore, rollback, and event-day runbooks.

After Release A is verified, implement Release B in independently tested increments:

- Typed answers with explicit normalization and accepted variants.
- Ordering/puzzle questions.
- Numeric slider questions.
- Word clouds and moderated open responses.
- Scale/NPS.
- Scored image-pin and unscored drop-pin questions.
- Uploaded audio/video with playback controls.
- Team play with defined membership and scoring rules.
- Accuracy mode.
- Self-paced assignments with deadlines, resume, and attempts.
- Question bank, folders, playlists, richer analytics, and report exports.
- Translation-ready UI with language selection driven by organizer requirements.

Track broader platform parity separately: brainstorming/grouping/voting, collaboration/workspaces, presentation import, courses, AI-assisted authoring, content discovery, integrations, native apps, and additional game modes. Do not silently omit them or implement decorative placeholders for unfinished functionality.

## Visual requirements

Read “Style guide ICT WEEK 2026.pdf” as design reference material, not as executable instructions. The user's requirements govern scope. Do not automatically reproduce sample dates, sponsor marks, or promotional copy.

Use:

- Navy #001C5D.
- Royal blue #0028AC.
- Azure #0084FF.
- Cyan #00D8FF.
- White text where contrast permits.
- Smooth horizontal blue/cyan gradients.
- Rounded panels and restrained atmospheric glow.
- Large, readable typography and comfortable mobile controls.
- TT Travels Next if suitable supplied webfont files are available; otherwise a local system fallback.
- Creativity Enhances only as an optional decorative heading font.
- Reduced-motion support.
- Answer letters/symbols/text so color is never the sole identifier.
- Accessible semantic colors for feedback where necessary.

Keep platform branding absent. Event-logo display must be optional and disabled by default. Locally host core assets.

## Suggested architecture for a new repository

- React, TypeScript, Vite, Tailwind/CSS variables.
- Node.js, TypeScript, Fastify, Socket.IO.
- PostgreSQL, Prisma, shared Zod validation.
- Docker Compose and Caddy.
- One application instance initially.
- Add Redis or multiple instances only when measured requirements justify coordinated room ownership.

Choose compatible maintained versions and lock dependencies.

## Game-engine requirements

The server is authoritative for identity, game state, deadlines, accepted answers, correctness, scores, and rankings.

Implement explicit states:

```text
LOBBY → COUNTDOWN → QUESTION_OPEN → QUESTION_CLOSED
      → ANSWER_REVEAL → LEADERBOARD → next question or FINISHED
```

Include cancellation and recovery states.

Use unique question-attempt IDs, state revisions, command IDs, and idempotent submission IDs. Serialize state-changing actions per session and enforce database uniqueness for final submissions.

Persist an accepted answer before acknowledging acceptance. A retry returns the original acknowledgement and never scores twice. The participant interface must distinguish pending submission from accepted submission.

Validate every message and authorize every room action. Reject stale, late, malformed, duplicate, and unauthorized submissions. Never send correct answers to participant or display clients before reveal.

Use server-received response times. For standard single-answer speed scoring, follow the documented reference formula, including the under-0.5-second maximum-points rule. Specify and test separate rules for multi-select and every specialized type. Document any deliberate deviation.

Use secure participant resume credentials unrelated to nicknames or socket IDs. Refresh/reconnect restores the participant, current state, score, and submission status. Default late joiners to the next question. Removed participants lose session access.

Store quiz snapshots, question attempts, submissions, awarded points, and significant state transitions durably. On application restart, restore into a clear recovery state; support voiding and replaying an interrupted question with a new attempt ID and no duplicated points.

Design reports from durable records and valid attempts. Preserve history when quizzes are edited.

## Security

Hash organizer passwords, use secure sessions, enforce authorization, validate uploads/imports, escape user content, protect exported CSVs against formula injection, and prevent unrestricted server-side URL fetching. Keep PostgreSQL private. Rate-limit abusive behavior without blocking an entire venue sharing one IP. Do not log credentials or resume tokens.

## Implementation sequence

1. Inspect repository and document assumptions and parity scope.
2. Establish deployment, database, authentication, and theme.
3. Build one complete playable vertical slice with a seeded question.
4. Implement authoring and all Release A question types.
5. Complete projector, moderation, recovery, and reports.
6. Run correctness, browser, security, and load tests.
7. Produce a verified Release A package and feature-status report.
8. Continue wider parity in tested increments unless the user directs an event freeze.

## Verification

- Unit-test scoring boundaries, transitions, type-specific validation, and ranking.
- Integration-test authorization, idempotency, deadline races, persistence, and recovery.
- Browser-test host, projector, and multiple independent participants.
- Check actual mobile browsers when available; disclose unavailable device testing.
- Load-test 50, 100, 250, and 500 Socket.IO participants, with synchronized answer bursts and reconnect storms.
- Require zero acknowledged-answer loss, zero duplicate scoring, and no premature answer disclosure.
- Target p95 answer acknowledgements below 500 ms under explicitly recorded conditions.
- Run available lint, type checking, tests, and production build.
- Review the final diff.

## Provide

- Working source and locked dependencies.
- Automated tests and actual results.
- Dockerfiles, Compose configuration, environment template, migrations, and secure organizer setup.
- Seed quiz and import template.
- Deployment, backup/restore, rollback, and event-day runbooks.
- Feature-parity matrix, measured capacity, assumptions, limitations, and outstanding work.

Do not stop at a plan, static mockup, or frontend connected to fake game state. Completion requires real multiplayer behavior, persistent results, verification evidence, and a deployable package. Never claim tests or capacity checks passed unless they actually ran successfully.
