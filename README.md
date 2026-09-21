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
