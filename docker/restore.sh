#!/usr/bin/env bash
# Restore an ICTWEEK backup created by backup.sh.
# Usage: docker/restore.sh docker/backups/<timestamp>
# Stops the app, restores the database (--clean) and replaces the media
# volume contents, then starts the app again.
set -euo pipefail
cd "$(dirname "$0")"
# Git-bash would rewrite container paths like /data into Windows paths.
export MSYS_NO_PATHCONV=1

DIR="${1:?usage: restore.sh <backup-dir> (e.g. docker/backups/20260921-120000)}"
[ -f "$DIR/db.dump" ] || { echo "missing $DIR/db.dump"; exit 1; }
[ -f "$DIR/media.tar" ] || { echo "missing $DIR/media.tar"; exit 1; }

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
