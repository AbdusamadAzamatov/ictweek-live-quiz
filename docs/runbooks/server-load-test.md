# Server load test — target 8 GB Ubuntu server

Runs the load harness against the **deployed** stack so the numbers reflect the
real machine (and, when run from a second machine, the real network path).
Paste the results into `docs/TEST_REPORT.md` section 2B.

## 0. Prerequisite

The stack is deployed per `deploy.md` and healthy:

```bash
curl https://<DOMAIN>/api/health    # {"ok":true,"db":{"ok":true,...}}
```

## 1. Preferred: run the harness from a second machine on the venue network

This exercises the real path (Wi-Fi/LAN → Caddy → app), which is what the
players' phones will do.

```bash
# Node 22 + pnpm on the client machine (any Linux/macOS/Windows)
corepack enable && corepack prepare pnpm@11.22.0 --activate
git clone <repo-url> ictquiz && cd ictquiz
pnpm install --frozen-lockfile
pnpm --filter @ictquiz/shared build

# tiers — same commands as the development runs, aimed at the real domain
pnpm --filter @ictquiz/server load-test -- \
  --players 50  --questions 5 --time-limit 10 --burst-ms 2000 \
  --url https://<DOMAIN> --origin https://<DOMAIN> \
  --email <organizer> --password '<pwd>' \
  --out load-results/server-050p.json

pnpm --filter @ictquiz/server load-test -- \
  --players 100 --questions 5 --time-limit 10 --burst-ms 2000 \
  --url https://<DOMAIN> --origin https://<DOMAIN> \
  --email <organizer> --password '<pwd>' \
  --out load-results/server-100p.json

pnpm --filter @ictquiz/server load-test -- \
  --players 250 --questions 5 --time-limit 10 --burst-ms 2000 \
  --url https://<DOMAIN> --origin https://<DOMAIN> \
  --email <organizer> --password '<pwd>' \
  --out load-results/server-250p.json

pnpm --filter @ictquiz/server load-test -- \
  --players 500 --questions 5 --time-limit 10 --burst-ms 2000 \
  --url https://<DOMAIN> --origin https://<DOMAIN> \
  --email <organizer> --password '<pwd>' \
  --out load-results/server-500p.json

# worst case: all 500 answers inside half a second
pnpm --filter @ictquiz/server load-test -- \
  --players 500 --questions 4 --burst-ms 500 --retry-rate 0.25 --storm 0.5 \
  --url https://<DOMAIN> --origin https://<DOMAIN> \
  --email <organizer> --password '<pwd>' \
  --out load-results/server-500p-burst500.json
```

The real Let's Encrypt certificate verifies normally — do **not** set
`NODE_TLS_REJECT_UNAUTHORIZED`.

## 2. Fallback: run on the server itself (loopback)

If no second machine is available, run the same commands on the server over
`https://<DOMAIN>` — the public listener still terminates TLS, so the stack
path is exercised, but **loopback numbers exclude network latency**: treat ack
p95 as a floor, not the venue figure.

```bash
# on the server — Node 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable && corepack prepare pnpm@11.22.0 --activate
# … same clone/install/tier commands as above …
```

## 3. Capture server-side numbers during each run

In a second shell on the server:

```bash
docker stats --no-stream        # app/db/caddy CPU + memory, per container
nproc                           # logical CPUs
free -h                         # RAM
lscpu | head -20                # CPU model
```

## 4. Pass criteria (from `docs/plan/README.md` §9)

- zero acknowledged answers lost (`totalLost: 0`)
- zero duplicate scoring (`retryMismatch: 0`, `scoreMismatch: 0`)
- answer ack p95 < 500 ms under the planned burst
- every reconnected client resynced (`allResynced: true`)
- bounded memory — app RSS stays well under its 2 GB limit

Record each run's SUMMARY JSON and the `docker stats` snapshot into
`docs/TEST_REPORT.md` **2B**, including the "Run from" column (venue-network
machine vs server loopback).
