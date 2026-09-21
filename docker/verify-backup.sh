#!/usr/bin/env bash
# Verify an ICTWEEK backup by restoring it into a THROWAWAY Postgres container
# and a temp dir. Never touches the live compose stack: this script does not
# reference the compose db/app services or the pgdata/media volumes.
# Usage: docker/verify-backup.sh docker/backups/<timestamp>
set -euo pipefail
cd "$(dirname "$0")"
# Git-bash would rewrite container paths like /data into Windows paths.
export MSYS_NO_PATHCONV=1

# Same image (tag + digest) as docker/compose.yml's db service.
PG_IMAGE='postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'

DIR="${1:?usage: verify-backup.sh <backup-dir> (e.g. docker/backups/20260921-120000)}"
[ -f "$DIR/db.dump" ] || { echo "missing $DIR/db.dump"; exit 1; }
[ -f "$DIR/media.tar" ] || { echo "missing $DIR/media.tar"; exit 1; }

CNAME="ictquiz-verify-db-$$"
TMP="$(mktemp -d)"
cleanup() {
  docker rm -f "$CNAME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "[verify] starting throwaway postgres ($CNAME)…"
docker run -d --rm --name "$CNAME" -e POSTGRES_PASSWORD=verify "$PG_IMAGE" >/dev/null

echo "[verify] waiting for postgres…"
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CNAME" pg_isready -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "[verify] postgres did not become ready"; echo "VERIFY FAILED $DIR"; exit 1; }

echo "[verify] restoring database dump…"
docker exec -i "$CNAME" psql -U postgres -c 'CREATE DATABASE ictquiz' >/dev/null
docker exec -i "$CNAME" pg_restore -U postgres -d ictquiz --no-owner --no-privileges < "$DIR/db.dump"

echo "[verify] row counts:"
cat > "$TMP/counts.sql" <<'SQL'
SELECT 'Organizer', count(*) FROM "Organizer"
UNION ALL SELECT 'Quiz', count(*) FROM "Quiz"
UNION ALL SELECT 'Question', count(*) FROM "Question"
UNION ALL SELECT 'AnswerOption', count(*) FROM "AnswerOption"
UNION ALL SELECT 'MediaAsset', count(*) FROM "MediaAsset"
UNION ALL SELECT 'GameSession', count(*) FROM "GameSession"
UNION ALL SELECT 'Participant', count(*) FROM "Participant"
UNION ALL SELECT 'QuestionAttempt', count(*) FROM "QuestionAttempt"
UNION ALL SELECT 'Submission', count(*) FROM "Submission";
SQL
docker exec -i "$CNAME" psql -U postgres -d ictquiz -Atf - < "$TMP/counts.sql" | paste -sd' ' -

echo "[verify] latest migration:"
docker exec -i "$CNAME" psql -U postgres -d ictquiz -Atc \
  'SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 1'

echo "[verify] extracting media.tar…"
tar -xf "$DIR/media.tar" -C "$TMP"
total=$(find "$TMP/media" -type f | wc -l | tr -d ' ')

docker exec -i "$CNAME" psql -U postgres -d ictquiz -Atc \
  'SELECT "storagePath" FROM "MediaAsset"' > "$TMP/paths.txt"
referenced=0
missing=0
missing_names=""
while IFS= read -r p; do
  [ -z "$p" ] && continue
  referenced=$((referenced + 1))
  if [ ! -f "$TMP/media/$p" ]; then
    missing=$((missing + 1))
    if [ "$missing" -le 5 ]; then missing_names="$missing_names $p"; fi
  fi
done < "$TMP/paths.txt"
echo "media files: $total in tar, $referenced referenced, missing: $missing"
[ -n "$missing_names" ] && echo "first missing:$missing_names"

if [ "$missing" -gt 0 ]; then
  echo "VERIFY FAILED $DIR"
  exit 1
fi
echo "VERIFY OK $DIR"
