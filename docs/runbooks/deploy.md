# Deploy runbook — ICTWEEK quiz

Self-hosted production deploy of the full stack: PostgreSQL + app + Caddy
(automatic HTTPS). Target: a single Linux VM (Ubuntu 22.04/24.04, ≥ 8 GB RAM
recommended for a venue event).

## Prerequisites

- Ubuntu 22.04 or 24.04 server with sudo access. **No Node.js, pnpm or build
  tools are needed on the server** — everything builds and runs inside the
  containers.
- Docker Engine + the compose plugin (official Docker apt repository):

  ```bash
  # Add Docker's official GPG key and apt repository
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"   # log out/in afterwards
  ```

- DNS: an A record for your hostname pointing at the server's public IP.
- Firewall: inbound **80/tcp** and **443/tcp** open (and 443/udp if you want
  HTTP/3). Caddy needs port 80 reachable to issue the certificate.

  ```bash
  sudo ufw allow 80,443/tcp
  ```

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

## First login → change the password

Browse to `https://<DOMAIN>/admin` and log in with
`INITIAL_ORGANIZER_EMAIL` / `INITIAL_ORGANIZER_PASSWORD` from `docker/.env`.

While that bootstrap password is still in use, a yellow banner is shown at the
top of every admin page. **Important:** removing `INITIAL_ORGANIZER_*` from
`.env` only prevents re-bootstrapping a new account — the existing account
**keeps the initial password** until you change it. Change it first:

- in the UI: **Account → Change password** (`/admin/account`), or
- from the CLI:

  ```bash
  docker compose -f docker/compose.yml --env-file docker/.env exec -w /app/apps/server app \
    node dist/scripts/set-password.js <email> '<newPassword>'
  ```

  (sets the new hash and revokes every existing session — sign in again).

Then remove the bootstrap variables and restart:

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
volume performs fine for 500-player events. The 2 GB ceiling on the app
container (`deploy.resources.limits.memory` in `docker/compose.yml`) **is
enforced** by `docker compose` — verified with
`docker inspect ictquiz-app-1` → `HostConfig.Memory = 2147483648`.

Measured footprint during the 500-player load test (development machine):

| Container | Memory | Notes |
| --- | --- | --- |
| app | ≈ 120–180 MB RSS at 500 players | brief peaks during batch flushes |
| db (Postgres) | ≈ 50 MB | default settings |
| caddy | ≈ 100 MB | TLS + proxy |

An 8 GB host therefore leaves ample headroom — the workload is far below the
2 GB app limit, and the rest goes to the OS page cache.
