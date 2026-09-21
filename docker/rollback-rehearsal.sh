#!/usr/bin/env bash
# Rehearse the full deploy → upgrade → rollback cycle against the real
# compose configuration in an ISOLATED project (ictquiz-rbtest, app on :3101).
# Never touches the live `ictquiz` project, its volumes, or docker/.env:
# all state lives in a repo-local temp dir + project-scoped volumes,
# removed on exit.
# Usage: docker/rollback-rehearsal.sh <old-sha> [new-sha=HEAD]
set -uo pipefail
cd "$(dirname "$0")/.."
# Git-bash would rewrite container paths like /data into Windows paths.
export MSYS_NO_PATHCONV=1

OLD_ARG=${1:-}
[ -n "$OLD_ARG" ] || { echo "usage: $0 <old-sha> [new-sha=HEAD]" >&2; exit 2; }
OLD=$(git rev-parse --short "$OLD_ARG") || exit 2
NEW=$(git rev-parse --short "${2:-HEAD}") || exit 2

# Repo-local temp dir: relative paths survive MSYS_NO_PATHCONV and are
# resolvable by both git and docker (Git Bash /tmp is NOT where cygpath
# claims, so Windows-style paths under it don't exist for docker.exe).
WORK=".rbtest-$$"
WT="$WORK/wt"
ENVF="$WORK/rb.env"
OVERRIDE="$WORK/override.yml"
LOG="$WORK/rehearsal.log"
JAR="$WORK/cookies.txt"
BASE=http://localhost:3101
PROJECT=ictquiz-rbtest
mkdir -p "$WORK"

COMPOSE=(docker compose -p "$PROJECT" -f docker/compose.yml
         -f "$OVERRIDE" --env-file "$ENVF")

cleanup() {
  "${COMPOSE[@]}" down -v >>"$LOG" 2>&1
  git worktree remove --force "$WT" >>"$LOG" 2>&1
  rm -rf "$WORK" >/dev/null 2>&1
}
trap cleanup EXIT

FAILED=0
STEPS=(); RES=()
pass() { STEPS+=("$1"); RES+=("PASS"); echo "[ok] $1"; }
fail() {
  STEPS+=("$1"); RES+=("FAIL${2:+ — $2}"); FAILED=1
  echo "[FAIL] $1 ${2:+— $2}"
  echo "      --- log tail ---"; tail -20 "$LOG" | sed 's/^/      /'
}
run_logged() { "$@" >>"$LOG" 2>&1; }

# ------------------------------------------------------------------ build
echo "== rollback rehearsal: $OLD -> $NEW -> $OLD (isolated project $PROJECT) =="

if run_logged git worktree add "$WT" "$OLD" \
   && run_logged docker build -f "$WT/docker/Dockerfile" \
        -t "ictquiz-app:$OLD" "$WT"; then
  pass "build ictquiz-app:$OLD from worktree"
else
  fail "build ictquiz-app:$OLD from worktree"
fi

if run_logged docker build -f docker/Dockerfile -t "ictquiz-app:$NEW" .; then
  pass "build ictquiz-app:$NEW from HEAD"
else
  fail "build ictquiz-app:$NEW from HEAD"
fi

# ------------------------------------------------------------------ env + override
cat >"$ENVF" <<EOF
DOMAIN=http://localhost:3101
PUBLIC_URL=http://localhost:3101
POSTGRES_PASSWORD=rbtest
INITIAL_ORGANIZER_EMAIL=rb@example.com
INITIAL_ORGANIZER_PASSWORD=RollbackTest123!
TRUST_PROXY=0
APP_TAG=$OLD
EOF
# env_file !override: the base compose.yml points app at docker/.env — replace
# it outright so this rehearsal can never read live configuration.
# deploy.replicas 0 on caddy: compose v5 rejects --scale for services that are
# not in the up-list, and caddy must never start here anyway.
cat >"$OVERRIDE" <<EOF
services:
  app:
    env_file: !override
      - ../$ENVF
    ports:
      - '3101:3000'
  caddy:
    deploy:
      replicas: 0
EOF
pass "write temp env + override (env_file replaced; docker/.env never read)"

# ------------------------------------------------------------------ helpers
health() { curl -sf "$BASE/api/health" >/dev/null 2>&1; }
wait_health() {
  for _ in $(seq 1 "${1:-60}"); do health && return 0; sleep 2; done
  return 1
}
# A stale container from the previous phase can keep :3101 healthy after a
# failed recreate — always verify the image actually running.
running_image() {
  docker inspect "$PROJECT-app-1" --format '{{.Config.Image}}' 2>/dev/null
}
login() {
  # note: `>/dev/null`, not `-o /dev/null` — curl.exe cannot open /dev/null.
  curl -sf -c "$JAR" -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' -H "Origin: $BASE" \
    -d '{"email":"rb@example.com","password":"RollbackTest123!"}' >/dev/null
}
quiz_loads() { curl -sf -b "$JAR" "$BASE/api/quizzes/$QID" >/dev/null 2>&1; }
mig_count() {
  "${COMPOSE[@]}" exec -T db \
    psql -U postgres -d ictquiz -Atc 'select count(*) from _prisma_migrations' \
    2>/dev/null | tr -d '[:space:]'
}
set_tag() { sed -i "s/^#\?APP_TAG=.*/APP_TAG=$1/" "$ENVF"; }

# ------------------------------------------------------------------ deploy old
if run_logged "${COMPOSE[@]}" up -d --no-build db app \
   && wait_health 90 && [ "$(running_image)" = "ictquiz-app:$OLD" ]; then
  pass "up db+app on :3101 ($OLD) and healthy"
else
  fail "up db+app on :3101 ($OLD)" "image=$(running_image)"
fi

MIGS_BEFORE=$(mig_count)
echo "      _prisma_migrations after old-image deploy: $MIGS_BEFORE"

QID=""
if login; then
  QID=$(curl -sf -b "$JAR" -c "$JAR" -X POST "$BASE/api/quizzes" -H "Origin: $BASE" \
        | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
fi
if [ -n "$QID" ] \
   && curl -sf -b "$JAR" -X PUT "$BASE/api/quizzes/$QID" -H "Origin: $BASE" \
        -H 'Content-Type: application/json' \
        -d '{"title":"Rehearsal quiz","description":"","questions":[{"type":"SINGLE","text":"2+2?","timeLimitSec":20,"pointsMode":"STANDARD","explanation":"","options":[{"text":"4","isCorrect":true},{"text":"5","isCorrect":false}]}]}' \
        >/dev/null \
   && quiz_loads; then
  pass "login + create quiz on $OLD (id=$QID)"
else
  fail "login + create quiz on $OLD"
fi

# ------------------------------------------------------------------ upgrade
set_tag "$NEW"
if run_logged "${COMPOSE[@]}" up -d --no-build app && wait_health 90 \
   && [ "$(running_image)" = "ictquiz-app:$NEW" ]; then
  pass "upgrade to $NEW (no-build) and healthy"
else
  fail "upgrade to $NEW" "image=$(running_image)"
fi

MIGS_AFTER=$(mig_count)
echo "      _prisma_migrations after upgrade: $MIGS_AFTER"
if [ -n "${MIGS_BEFORE:-}" ] && [ -n "${MIGS_AFTER:-}" ] \
   && [ "$MIGS_AFTER" -gt "$MIGS_BEFORE" ]; then
  pass "migration count increased ($MIGS_BEFORE -> $MIGS_AFTER)"
else
  fail "migration count increased" "got $MIGS_BEFORE -> $MIGS_AFTER"
fi

if quiz_loads && login; then pass "quiz loads + login works on $NEW"
else fail "quiz loads + login works on $NEW"; fi

# ------------------------------------------------------------------ rollback
set_tag "$OLD"
run_logged "${COMPOSE[@]}" up -d --no-build app
if wait_health 60 && [ "$(running_image)" = "ictquiz-app:$OLD" ]; then
  pass "rollback to $OLD (no-build) and healthy"
  if quiz_loads; then pass "quiz still loads on $OLD"
  else fail "quiz still loads on $OLD"; fi
  if login; then pass "login works on $OLD"
  else fail "login works on $OLD"; fi
else
  echo "      --- app container state after rollback ---"
  "${COMPOSE[@]}" ps app 2>&1 | tail -5
  echo "      --- last app logs ---"
  "${COMPOSE[@]}" logs --tail 40 app 2>&1 | tail -40
  fail "rollback to $OLD" "not healthy; state/logs above"
  if quiz_loads; then pass "quiz still loads on $OLD (despite unhealthy)"
  else fail "quiz still loads on $OLD"; fi
  if login; then pass "login works on $OLD (despite unhealthy)"
  else fail "login works on $OLD"; fi
fi

# ------------------------------------------------------------------ report
echo
docker image ls ictquiz-app
echo
printf '%-62s %s\n' 'STEP' 'RESULT'
printf '%-62s %s\n' '----' '------'
for i in "${!STEPS[@]}"; do printf '%-62s %s\n' "${STEPS[$i]}" "${RES[$i]}"; done
echo
echo "rehearsal log: $LOG (removed with temp dir on exit)"
[ "$FAILED" -eq 0 ] && echo "REHEARSAL OK $OLD -> $NEW -> $OLD" || echo "REHEARSAL FAILED"
exit "$FAILED"
