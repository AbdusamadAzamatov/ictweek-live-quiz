# Rollback runbook

App images are tagged per release so any previous build can be re-deployed
in seconds.

## Tagging per release

`docker/compose.yml` builds the app as `ictquiz-app:${APP_TAG:-latest}`.
Set `APP_TAG` to the git sha when deploying a release:

```bash
export APP_TAG=$(git rev-parse --short HEAD)
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
# images: ictquiz-app:<sha>   (keeps earlier tags on the host)
```

Record the deployed sha (e.g. in the deploy log or a `deployed-sha` file).

## Rolling back the app

```bash
export APP_TAG=<previous-sha>
docker compose -f docker/compose.yml --env-file docker/.env up -d
# compose recreates app with the older image; db/caddy are untouched.
```

If the previous tag is missing (`docker image prune`), rebuild it:

```bash
git checkout <previous-sha>
export APP_TAG=<previous-sha>
docker compose -f docker/compose.yml --env-file docker/.env build app
git checkout -
```

## Migrations are forward-only

`prisma migrate deploy` only applies migrations — it never rolls them back.
Rolling back the **code** to a version older than the applied migrations is
only safe if the old code still works against the newer schema (additive
changes are usually fine; renames/drops are not).

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
