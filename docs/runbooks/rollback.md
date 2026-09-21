# Rollback runbook

App images are tagged per release so any previous build can be re-deployed
in seconds.

## Tagging per release

`docker/compose.yml` builds the app as `ictquiz-app:${APP_TAG:-latest}`.
**`APP_TAG` lives in `docker/.env` — it is the single source of truth.** Never
`export APP_TAG` in a shell: a later `up -d` in another shell would silently
fall back to `latest`. Set it with `sed` so it survives shells and reboots:

```bash
sed -i "s/^#\?APP_TAG=.*/APP_TAG=$(git rev-parse --short HEAD)/" docker/.env
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
# image: ictquiz-app:<sha>   (earlier tags stay on the host)
```

Record the deployed sha (e.g. in the deploy log or a `deployed-sha` file).

**Keep at least the last two `ictquiz-app:<sha>` tags** on the host — rollback
needs the previous image to already exist. Never run `docker image prune -a`
on the event host (it deletes every unused tag, i.e. the rollback target).
`docker image ls ictquiz-app` shows which tags are retained.

## Rolling back the app

```bash
sed -i "s/^#\?APP_TAG=.*/APP_TAG=<previous-sha>/" docker/.env
docker compose -f docker/compose.yml --env-file docker/.env up -d --no-build
# compose recreates app with the older image; db/caddy are untouched.
```

If the previous tag is missing, rebuild it from a worktree (no checkout of the
live tree):

```bash
git worktree add /tmp/ictquiz-<previous-sha> <previous-sha>
docker build -f /tmp/ictquiz-<previous-sha>/docker/Dockerfile \
  -t ictquiz-app:<previous-sha> /tmp/ictquiz-<previous-sha>
git worktree remove --force /tmp/ictquiz-<previous-sha>
# then the sed + up -d --no-build above
```

Rehearse the whole cycle without touching the live stack:

```bash
docker/rollback-rehearsal.sh <previous-sha>   # isolated compose project on :3101
```

## Migrations are forward-only

`prisma migrate deploy` only applies migrations — it never rolls them back.
Rolling back the **code** to a version older than the applied migrations is
only safe if the old code still works against the newer schema (additive
changes are usually fine; renames/drops are not).

### Migration compatibility (verified by `rollback-rehearsal.sh`)

Rehearsed `ed3f707 → <head> → ed3f707` in an isolated project: the old image's
entrypoint ran `prisma migrate deploy` against a database containing two
migrations it does not know about and printed:

```
1 migration found in prisma/migrations

No pending migrations to apply.
```

then started normally — `migrate deploy` does **not** fail on applied
migrations that are missing from the image's migrations folder. The container
became healthy, the previously created quiz still loaded, and login still
worked. Rollback safety is therefore about whether the old **code** can run
against the newer **schema**, not about the migration table:

| Migration | Schema change | Old-image compatibility |
| --- | --- | --- |
| `init` | baseline | n/a |
| `add_content_slide_state` | adds `CONTENT_SLIDE` to the `SessionState` enum | Safe **unless** a `GameSession` row is actually in `CONTENT_SLIDE` — an old image cannot represent that state and would fail deserializing it. |
| `organizer_password_changed_at` | adds nullable `Organizer.passwordChangedAt` | Safe — old code simply ignores the column. |

So: rolling back **from this release to any image from `53a3923` onwards
(e.g. `3b464a0`, which already carries all three migrations) is safe without a
database restore**. Rolling back to an image older than `53a3923` (e.g.
`ed3f707`) is safe provided no live session is on a content slide at that
moment (sessions are in `LOBBY`/finished between games — check
`select state, count(*) from "GameSession" group by state` if unsure). Any
rollback that must cross a destructive migration — or a stray `CONTENT_SLIDE`
row — requires a database restore: `docker/restore.sh --yes
docker/backups/<pre-deploy-ts>` (verify it first with `verify-backup.sh`).

If a migration itself must be undone:

1. **Verify the pre-deploy backup before relying on it** (isolated throwaway
   Postgres — live data untouched):
   `docker/verify-backup.sh docker/backups/<pre-deploy-ts>` → expect
   `VERIFY OK`.
2. Restore it (destructive — stops the app, overwrites the live DB + media):
   `docker/restore.sh --yes docker/backups/<pre-deploy-ts>`
3. Then roll back the app image as above (matching the backup's schema era).

Rule of thumb: **always take and verify a backup immediately before
`up -d --build`** so a schema-level rollback is one `restore.sh` away.

## Verify

```bash
curl -k https://<DOMAIN>/api/health
docker compose -f docker/compose.yml --env-file docker/.env ps
docker compose -f docker/compose.yml --env-file docker/.env logs --tail=50 app
```
