#!/usr/bin/env bash
# Restore an ICTWEEK backup created by backup.sh — DESTRUCTIVE.
# Overwrites the live database and replaces the media volume contents.
# Requires downtime (the app is stopped for the duration) and an explicit
# --yes flag. Verify the backup first with docker/verify-backup.sh.
# Usage: docker/restore.sh --yes docker/backups/<timestamp>
set -euo pipefail
cd "$(dirname "$0")"
# Git-bash would rewrite container paths like /data into Windows paths.
export MSYS_NO_PATHCONV=1

DIR=""
YES=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    *) DIR="$a" ;;
  esac
done

if [ "$YES" != 1 ]; then
  echo "[restore] REFUSED — restoring overwrites the LIVE database and the" >&2
  echo "[restore] media volume and requires downtime. This cannot be undone." >&2
  echo "[restore] Verify the backup first: docker/verify-backup.sh <backup-dir>" >&2
  echo "[restore] Then re-run: docker/restore.sh --yes <backup-dir>" >&2
  exit 1
fi

[ -n "$DIR" ] || { echo "usage: restore.sh --yes <backup-dir>"; exit 1; }
[ -f "$DIR/db.dump" ] || { echo "missing $DIR/db.dump"; exit 1; }
[ -f "$DIR/media.tar" ] || { echo "missing $DIR/media.tar"; exit 1; }

GS=$(docker compose -f compose.yml --env-file .env exec -T db \
  psql -U postgres -d ictquiz -Atc 'SELECT count(*) FROM "GameSession"')
PT=$(docker compose -f compose.yml --env-file .env exec -T db \
  psql -U postgres -d ictquiz -Atc 'SELECT count(*) FROM "Participant"')
echo "[restore] WARNING: live rows about to be replaced — GameSession=$GS Participant=$PT"

echo "[restore] stopping app…"
docker compose -f compose.yml --env-file .env stop app

echo "[restore] restoring database from $DIR/db.dump…"
docker compose -f compose.yml --env-file .env exec -T db \
  pg_restore --clean --if-exists -U postgres -d ictquiz < "$DIR/db.dump"

echo "[restore] starting app (runs migrate deploy, idempotent)…"
docker compose -f compose.yml --env-file .env start app

echo "[restore] replacing media volume from $DIR/media.tar…"
docker compose -f compose.yml --env-file .env exec -T app \
  sh -c 'find /data/media -mindepth 1 -delete'
docker compose -f compose.yml --env-file .env exec -T app \
  tar -C /data -xf - < "$DIR/media.tar"

echo "[restore] done — verify with: curl -k https://\${DOMAIN:-localhost}/api/health"
