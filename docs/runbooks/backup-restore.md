# Backup & restore runbook

Backups capture both stateful parts of the stack: the Postgres database
(`pgdata` volume → `pg_dump -Fc`) and uploaded media (`media` volume → tar).

## Backup

```bash
docker/backup.sh
# → docker/backups/<yyyymmdd-hhmmss>/db.dump + media.tar
```

Copy `docker/backups/` off the box (rsync/scp/object storage) — a backup that
only exists on the same disk is not a backup.

**Suggested schedule:** cron nightly during the event week, plus one manual
run immediately before the event starts and one right after it ends:

```cron
0 3 * * *  cd /opt/ictquiz && docker/backup.sh >> /var/log/ictquiz-backup.log 2>&1
```

## Restore

```bash
docker/restore.sh docker/backups/<yyyymmdd-hhmmss>
```

What it does, in order:

1. Stops the `app` service.
2. `pg_restore --clean --if-exists` into the `ictquiz` database.
3. Starts `app` (its entrypoint runs `prisma migrate deploy`, which is a
   no-op when the restored schema is current).
4. Replaces the media volume contents from `media.tar`.

## Verify a restore

```bash
curl -k https://localhost/api/health
# log in at https://<DOMAIN>/admin and open the library — quizzes, sessions
# and uploaded images should all be present.
```

Verify every backup you actually plan to rely on: run `backup.sh`, then
`restore.sh` on the same stack, and confirm the quiz library still opens.

## Notes

- `pg_dump`/`pg_restore` run inside the `db` container, so the Postgres
  major version always matches the server.
- Media files are immutable (`/media/<uuid>.<ext>`), so replacing the whole
  directory is safe and idempotent.
- Sessions, participants, submissions and reports are all inside the single
  `db.dump`.
