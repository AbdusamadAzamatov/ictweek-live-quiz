#!/usr/bin/env bash
# Backup the ICTWEEK stack: postgres dump + media volume tarball.
# Usage: docker/backup.sh   →   docker/backups/<timestamp>/{db.dump,media.tar}
set -euo pipefail
cd "$(dirname "$0")"
# Git-bash would rewrite container paths like /data into Windows paths.
export MSYS_NO_PATHCONV=1

TS="$(date +%Y%m%d-%H%M%S)"
OUT="backups/$TS"
mkdir -p "$OUT"

echo "[backup] dumping postgres…"
docker compose -f compose.yml --env-file .env exec -T db \
  pg_dump -Fc -U postgres ictquiz > "$OUT/db.dump"

echo "[backup] tarring media volume…"
docker compose -f compose.yml --env-file .env exec -T app \
  tar -C /data -cf - media > "$OUT/media.tar"

echo "[backup] done → $OUT"
ls -lh "$OUT"
