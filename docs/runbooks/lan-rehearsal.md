# LAN rehearsal runbook — real phones before the server exists

Phones on the same Wi-Fi cannot reach `localhost` on your machine — that name
always points at the phone itself. To rehearse join/answer/reconnect with real
devices before the event server is deployed, run the stack on your laptop and
serve it on your LAN IP over plain HTTP.

> Rehearsal only: cookies are non-secure in this mode (no TLS), so do not reuse
> this configuration for the event. The app itself fully supports insecure
> contexts — join links, QR codes and player resume all work over `http://`.

## 1. Find the machine's LAN IP

- Windows: `ipconfig` → the `IPv4 Address` of your Wi-Fi/Ethernet adapter
  (e.g. `192.168.1.161`). Ignore `vEthernet`/VMware/VirtualBox adapters.
- Linux/macOS: `ip a` or `ifconfig` → the `inet` address of `wlan0`/`eth0`/`en0`.

## 2. Point the compose stack at the LAN IP

In `docker/.env` (create it from `docker/.env.example` if needed):

```dotenv
DOMAIN=http://192.168.1.161          # your LAN IP, with the http:// scheme
PUBLIC_URL=http://192.168.1.161
```

Caddy serves plain HTTP when the site address has an explicit `http://` scheme
— no certificate is involved.

## 3. Open the firewall

Allow inbound TCP 80 on the laptop:

- Windows (elevated PowerShell):
  `New-NetFirewallRule -DisplayName "ictquiz http" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow`
- Ubuntu: `sudo ufw allow 80/tcp`

## 4. Start the stack

```bash
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
docker compose -f docker/compose.yml --env-file docker/.env ps   # wait for healthy
curl http://192.168.1.161/api/health                             # {"ok":true,...}
```

## 5. Join from phones

Create a session as usual (`http://192.168.1.161/admin`). Phones on the same
Wi-Fi open `http://192.168.1.161` or scan the lobby QR — the QR and join link
are built from `PUBLIC_URL` on the server, **never** from the browser's
address bar, so they automatically contain the LAN IP.

Rehearse: join by QR, answer questions, refresh mid-question, toggle airplane
mode and reconnect (the resume token restores nickname and score).

## 6. Switch back afterwards

```dotenv
DOMAIN=localhost
PUBLIC_URL=https://localhost
```

```bash
docker compose -f docker/compose.yml --env-file docker/.env up -d
```

## Dev-server variant (no Docker)

If you just want a quick UI check against the dev servers instead of the
production image:

```bash
# terminal 1 — API
cd apps/server && pnpm dev

# terminal 2 — web, exposed on the LAN
cd apps/web && pnpm dev --host
```

Set `PUBLIC_URL=http://192.168.1.161:5173` in the API's `.env` so join
links/QR point at the LAN address, restart the API, then phones open
`http://192.168.1.161:5173`. Vite proxies `/api` and `/socket.io` to the API.
