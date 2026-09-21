# Deploy runbook — ICTWEEK quiz

Self-hosted production deploy of the full stack: PostgreSQL + app + Caddy
(automatic HTTPS). Target: a single Linux VM (Ubuntu 22.04/24.04, ≥ 8 GB RAM
recommended for a venue event).

## Prerequisites

- Ubuntu 22.04 or 24.04 server with sudo access.
- Docker Engine + the compose plugin:

  ```bash
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER"   # log out/in afterwards
  ```

- DNS: an A record for your hostname pointing at the server's public IP.
- Firewall: inbound **80/tcp** and **443/tcp** open (and 443/udp if you want
  HTTP/3). Caddy needs port 80 reachable to issue the certificate.

## First start

```bash
git clone <repo-url> ictquiz && cd ictquiz
cp docker/.env.example docker/.env
nano docker/.env          # set DOMAIN, PUBLIC_URL, POSTGRES_PASSWORD, SESSION_SECRET,
                          # INITIAL_ORGANIZER_*
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
docker compose -f docker/compose.yml --env-file docker/.env ps
```

Wait until `app` is `healthy` (first build takes a few minutes; the app
entrypoint runs `prisma migrate deploy` before listening).

```bash
curl https://<DOMAIN>/api/health        # {"ok":true,"db":{"ok":true,...}}
```

For a local check use `DOMAIN=localhost` + `PUBLIC_URL=https://localhost`;
Caddy issues an internal (self-signed) certificate, so use `curl -k`.

## First login

Browse to `https://<DOMAIN>/admin` and log in with
`INITIAL_ORGANIZER_EMAIL` / `INITIAL_ORGANIZER_PASSWORD` from `docker/.env`.
These variables only take effect **while the organizer table is empty** —
after the first login, remove them from `docker/.env` and restart:

```bash
nano docker/.env    # delete INITIAL_ORGANIZER_EMAIL / _PASSWORD
docker compose -f docker/compose.yml --env-file docker/.env up -d
```

## Adding organizers

```bash
docker compose -f docker/compose.yml --env-file docker/.env exec -w /app/apps/server app \
  node dist/scripts/create-organizer.js <email> <password>
```

(The script also runs from a checkout on the host:
`pnpm --filter @ictquiz/server create-organizer <email> <password>` with a
matching `DATABASE_URL`.)

## Updating

```bash
cd ictquiz
git pull
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
```

The entrypoint applies new migrations automatically on start. Take a backup
before every update (see `backup-restore.md`); see `rollback.md` for reverting.

## Operations

- Logs: `docker compose -f docker/compose.yml --env-file docker/.env logs -f app`
- Health: `https://<DOMAIN>/api/health`
- Diagnostics (organizer cookie required): `https://<DOMAIN>/api/diagnostics`
- Config reference: `docker/.env.example` (every variable is commented).

## Sizing note (8 GB host)

Postgres defaults are left untouched — on an 8 GB VM the shared `pgdata`
volume performs fine for 500-player events. The only explicit limit is a
2 GB ceiling on the app container in `docker/compose.yml`
(`deploy.resources.limits.memory`), which leaves headroom for Postgres,
Caddy, and the OS page cache.
