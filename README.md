# ICTWEEK Live Quiz

Self-hosted live quiz application (Kahoot-style game flow) for ICTWEEK events:
organizer-authored quizzes, PIN-join lobby, host + projector screens, timed
scoring with streaks, leaderboards, and session reports.

Monorepo layout: `packages/shared` (rules, scoring, socket contract),
`apps/server` (Fastify + Prisma + Socket.IO), `apps/web` (React + Vite +
Tailwind). The authoritative spec is [`docs/DESIGN.md`](docs/DESIGN.md).

## Dev quickstart

Requirements: Node.js >= 22, pnpm, Docker (for Postgres).

```bash
pnpm i            # install workspace deps
pnpm db:up        # start Postgres on :5432 (docker/compose.dev.yml)
pnpm db:migrate   # apply Prisma migrations
pnpm dev          # API on :3000 + web dev server on :5173 (proxied)
```

- Web: <http://localhost:5173> · API: <http://localhost:3000>
- Default dev organizer (auto-created on first boot via `INITIAL_ORGANIZER_*`):
  `admin@example.com` / `ChangeMe123!` — see `.env` / `.env.example`.
- Test DB (`ictquiz_test`) is created automatically by the compose init script.

Useful scripts: `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build`.
Add organizers later with
`pnpm --filter @ictquiz/server create-organizer -- <email> <password>`.

## Deploy

Production runs as a three-service compose stack (`docker/`): Postgres
(unpublished), the app image (multi-stage `docker/Dockerfile`, entrypoint runs
`prisma migrate deploy`), and Caddy (automatic HTTPS + WebSocket proxy).

```bash
cp docker/.env.example docker/.env   # set DOMAIN, PUBLIC_URL, secrets
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
```

Runbooks in `docs/runbooks/`: [`deploy.md`](docs/runbooks/deploy.md),
[`backup-restore.md`](docs/runbooks/backup-restore.md),
[`rollback.md`](docs/runbooks/rollback.md),
[`event-day.md`](docs/runbooks/event-day.md). Samples in `docs/samples/`
(`sample-quiz.json`, `import-template.csv`); parity notes in
[`docs/PARITY_MATRIX.md`](docs/PARITY_MATRIX.md); exact scoring and tie-break
rules in [`docs/SCORING.md`](docs/SCORING.md); measured results in
[`docs/TEST_REPORT.md`](docs/TEST_REPORT.md). The original plan and prompt are
kept in `docs/plan/`.

## Verification

```bash
pnpm lint         # eslint across the workspace
pnpm typecheck    # tsc --noEmit per package
pnpm test         # vitest per package (server tests need the dev Postgres)
pnpm build        # shared → server (prisma generate + tsc) → web (vite)
pnpm e2e          # Playwright: 10-check release suite against the production build (:3100)

# 50-player live-game load test (dev server or deployed stack):
pnpm --filter @ictquiz/server load-test -- --players 50 --questions 3 \
  --time-limit 5 --url http://localhost:3000 --origin http://localhost:5173 \
  --email admin@example.com --password 'ChangeMe123!'
```
