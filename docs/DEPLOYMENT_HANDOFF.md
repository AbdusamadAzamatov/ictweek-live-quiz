# Deployment handoff — ICTWEEK Live Quiz (Release A)

Status: **package frozen at git tag `release-a-event` — not deployed.** Target-server capacity is
**unverified** until `docs/TEST_REPORT.md` §2B is filled in from runs on the real server. Deploy the
tagged commit (`git checkout release-a-event`); any later change re-opens the package and must re-run
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e`.

## 1. What to transfer

Everything builds inside Docker; the server needs no Node.js, pnpm or build tools.

| Item | Purpose |
| --- | --- |
| The git repository at the reviewed commit (`main`) | Source, `docker/`, migrations, runbooks, samples |
| `docker/.env` — **created on the server from `docker/.env.example`, never copied from a laptop and never committed** | Secrets and hostname |
| Optional: `docs/samples/sample-quiz.json` (already in the repo) | First test quiz |

Nothing has been pushed to a remote. Two ways to get the code onto the server:

```bash
# A) push to your git remote, then on the server:
git clone <your-remote-url> /opt/ictquiz

# B) no remote — bundle on this machine and copy:
git bundle create ictquiz.bundle main            # run in the repo root
scp ictquiz.bundle <user>@<server>:/tmp/
ssh <user>@<server> 'git clone /tmp/ictquiz.bundle /opt/ictquiz'
```

Files that must exist on the server after this step: `docker/Dockerfile`, `docker/compose.yml`,
`docker/Caddyfile`, `docker/entrypoint.sh`, `docker/.env.example`, `docker/backup.sh`,
`docker/restore.sh`, `docker/verify-backup.sh`, `apps/`, `packages/`, `pnpm-lock.yaml`.

## 2. Required configuration (`docker/.env`)

| Variable | Value | Notes |
| --- | --- | --- |
| `DOMAIN` | `quiz.example.uz` (your hostname, no scheme) | Caddy requests a Let's Encrypt certificate for it |
| `PUBLIC_URL` | `https://quiz.example.uz` | Must be exactly `https://<DOMAIN>`; drives join links, QR codes, the CSRF origin check and secure cookies |
| `POSTGRES_PASSWORD` | `openssl rand -base64 24` | Database is not reachable from outside the stack |
| `SESSION_SECRET` | `openssl rand -hex 32` | Reserved; set anyway |
| `INITIAL_ORGANIZER_EMAIL` / `INITIAL_ORGANIZER_PASSWORD` | your organizer login | Used **only while the organizer table is empty**; the account keeps this password until changed (step 4.5) |
| `MEDIA_DIR` | `/data/media` | Leave as is (named volume) |
| `MAX_UPLOAD_MB` | `5` | Image upload limit |
| `TRUST_PROXY` | `1` | Required behind the bundled Caddy so rate limits see client IPs |
| `APP_TAG` | git short SHA of the deployed commit | Source of truth for the deployed image; set by `sed` in `docker/.env` — never `export` it. Enables rollback (step 6) |

## 3. Server access and DNS

- Ubuntu 22.04/24.04, 8 GB RAM, SSH user with `sudo`.
- Inbound **TCP 80 and 443** open to the internet (80 is needed for certificate issuance and the
  http→https redirect; 443/udp optional for HTTP/3). Outbound HTTPS open (image pulls, ACME).
- **DNS A record** `quiz.example.uz → <server public IPv4>` (add AAAA only if the server has a
  routable IPv6). Propagated **before** `docker compose up`, otherwise Caddy cannot obtain the
  certificate and will keep retrying.
- Time synchronised (`timedatectl`), otherwise TLS and cookie expiry misbehave.
- Nobody else may listen on 80/443 (no existing nginx/apache).

## 4. Ordered deployment

```bash
# 4.1 Docker Engine + compose plugin (official repo) — full block in docs/runbooks/deploy.md
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"      # log out and back in
sudo ufw allow 80,443/tcp

# 4.2 Code + configuration
cd /opt/ictquiz
cp docker/.env.example docker/.env
nano docker/.env                     # section 2 values
sed -i "s/^#\?APP_TAG=.*/APP_TAG=$(git rev-parse --short HEAD)/" docker/.env

# 4.3 Build and start (first build ≈ 3–6 min; entrypoint runs prisma migrate deploy)
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
docker compose -f docker/compose.yml --env-file docker/.env ps        # wait: app (healthy), db (healthy), caddy Up

# 4.4 Health checks
curl -fsS https://quiz.example.uz/api/health        # {"ok":true,"db":{"ok":true,"latencyMs":N}}
curl -fsSI https://quiz.example.uz/ | head -1        # HTTP/2 200 (SPA)
docker compose -f docker/compose.yml --env-file docker/.env logs --tail=30 caddy   # "certificate obtained successfully"
```

**4.5 First login and password change (mandatory)**

1. Open `https://quiz.example.uz/admin`, log in with `INITIAL_ORGANIZER_*`. A yellow banner shows
   while the bootstrap password is in use.
2. **Account → Change password** (or CLI:
   `docker compose -f docker/compose.yml --env-file docker/.env exec -w /app/apps/server app node dist/scripts/set-password.js <email> '<newPassword>'`).
   Other sessions are signed out. The banner disappears.
3. Only now remove `INITIAL_ORGANIZER_EMAIL` / `INITIAL_ORGANIZER_PASSWORD` from `docker/.env` and
   `docker compose -f docker/compose.yml --env-file docker/.env up -d`. (Removing them first does
   **not** change the existing account's password.)
4. Add further organizers with `node dist/scripts/create-organizer.js <email> '<password>'` (same
   `exec` prefix).

**4.6 Smoke test and baseline backup**

```bash
# Library → Import JSON → docs/samples/sample-quiz.json → Host session → open the projector link
docker/backup.sh                                     # → docker/backups/<ts>/
docker/verify-backup.sh docker/backups/<ts>          # restores into a throwaway container; live data untouched
```

## 5. Health checks to keep at hand

| Check | Command / URL | Expect |
| --- | --- | --- |
| API + DB | `curl -fsS https://<DOMAIN>/api/health` | `{"ok":true,"db":{"ok":true}}` |
| Containers | `docker compose -f docker/compose.yml --env-file docker/.env ps` | `app (healthy)`, `db (healthy)`, `caddy Up` |
| Live rooms, sockets, memory, recent errors | `https://<DOMAIN>/admin/diagnostics` (organizer login) | rooms/sockets match the running game |
| Memory limit | `docker stats --no-stream ictquiz-app-1` | RSS well under the 2 GiB limit (dev measurement: 120–180 MB at 500 players) |
| Logs | `… logs -f app` | no repeated errors |

**Pre-deploy gate for anyone changing code:** `pnpm lint && pnpm typecheck && pnpm test &&
pnpm build && pnpm e2e` must all pass on the reviewed commit before it is tagged for deploy.

**Configured limits** (defaults; override in `docker/.env` only if a venue needs it):
`JOIN_FAIL_PER_MIN=120`, `JOIN_FAIL_PER_HOUR=1000`, `JOIN_SUCCESS_PER_MIN=1200` — shared per
client IP across `GET /api/join/:pin` and socket `player:join`, reconnect-resistant; plus a
per-socket bucket of 5 joins/min. Venue NAT is safe: successes barely count, only failures burn
the small budget.

If the app container ever hits the 2 GiB limit it is OOM-killed and restarted by Docker; any question
in progress goes to **RECOVERY** and the host chooses *Replay question*.

## 6. Rollback

```bash
# before every deploy
docker/backup.sh && docker/verify-backup.sh docker/backups/<ts>

# roll the app back to the previous image (db/caddy untouched)
sed -i "s/^#\?APP_TAG=.*/APP_TAG=<previous-sha>/" docker/.env
docker compose -f docker/compose.yml --env-file docker/.env up -d --no-build

# if a migration must be undone (schema-level rollback): planned downtime
docker/restore.sh --yes docker/backups/<pre-deploy-ts>   # DESTRUCTIVE: replaces live DB + media
sed -i "s/^#\?APP_TAG=.*/APP_TAG=<sha matching that backup>/" docker/.env
docker compose -f docker/compose.yml --env-file docker/.env up -d --no-build
```

Keep the last two `ictquiz-app:<sha>` tags on the host (`docker image ls ictquiz-app`) and never run
`docker image prune -a` on the event host — that deletes the rollback target. Rehearse the whole
upgrade → rollback cycle without touching the live stack: `docker/rollback-rehearsal.sh <previous-sha>`.
Migrations are forward-only; compatibility details in `docs/runbooks/rollback.md`.

## 7. Target-server load test (under the configured 2 GiB app limit)

Run from a **second machine on the venue network** (preferred) — Node 22 + pnpm:

```bash
corepack enable && corepack prepare pnpm@11.22.0 --activate
git clone <repo> && cd ictquiz && pnpm install --frozen-lockfile && pnpm --filter @ictquiz/shared build
B="pnpm --filter @ictquiz/server load-test -- --url https://quiz.example.uz --origin https://quiz.example.uz --email <organizer> --password '<pwd>'"
$B --players 50  --questions 5 --time-limit 10 --burst-ms 2000 --out load-results/server-050p.json
$B --players 100 --questions 5 --time-limit 10 --burst-ms 2000 --out load-results/server-100p.json
$B --players 250 --questions 5 --time-limit 10 --burst-ms 2000 --out load-results/server-250p.json
$B --players 500 --questions 5 --time-limit 10 --burst-ms 2000 --out load-results/server-500p.json
$B --players 500 --questions 4 --time-limit 10 --burst-ms 500 --retry-rate 0.25 --storm 0.5 --out load-results/server-500p-burst500.json
```

On the server during each run: `docker stats --no-stream`, plus once `nproc`, `free -h`, `lscpu | head -20`.
Pass criteria: exit code 0, `totalLost 0`, `scoreMismatch 0`, `idempotentRetries true`, `allResynced true`,
ack p95 < 500 ms, app memory bounded. Paste each SUMMARY into `docs/TEST_REPORT.md` §2B with the server
specs. Fallback (loopback, excludes network): `docs/runbooks/server-load-test.md` §3.

## 8. Venue checklist (cannot be done from the development machine)

- [ ] **HTTPS**: `https://<DOMAIN>` shows a valid certificate in a phone browser (no warning); `http://<DOMAIN>` redirects to https.
- [ ] **Phones**: one Android and one iPhone on venue Wi-Fi — scan the lobby QR, join, answer a SINGLE and a MULTI question, refresh mid-question (answer still shown), airplane mode 10 s → reconnect (same nickname/score), late join during a question → "You'll join at the next question".
- [ ] **Projector**: `/display/<displayKey>` at 1080p, fullscreen, readable from the back row; click once to enable sound; timer ring, reveal bars, podium animation.
- [ ] **Host**: second device can open `/admin/host/<id>` and take over; `C`/`Space`/`L`/`F`/`M` work.
- [ ] **Capacity**: section 7 results recorded in `docs/TEST_REPORT.md` §2B — until then capacity is **unverified**.
- [ ] **Backup / restore**: `backup.sh` + `verify-backup.sh` pass on the server; the backup is copied off the server.
- [ ] Pre-event: lock the lobby at start if late joiners are unwanted; `docs/runbooks/event-day.md` incident table printed.
