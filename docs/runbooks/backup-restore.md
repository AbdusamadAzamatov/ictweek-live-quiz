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
run immediately before the event starts and one right after it ends.
**Verify each backup after taking it** (see below) — a backup that has never
been restored anywhere is only a hope:

```cron
0 3 * * *  cd /opt/ictquiz && docker/backup.sh >> /var/log/ictquiz-backup.log 2>&1
```

## Verify a backup (safe — never touches live data)

```bash
docker/verify-backup.sh docker/backups/<yyyymmdd-hhmmss>
```

This restores the dump into a **throwaway Postgres container**
(`docker run --rm`, same `postgres:16-alpine` image as the stack) and extracts
`media.tar` into a temp dir. It never references the compose `db`/`app`
services or the `pgdata`/`media` volumes — live data cannot be touched.

It prints:

- row counts for `Organizer, Quiz, Question, AnswerOption, MediaAsset,
  GameSession, Participant, QuestionAttempt, Submission`,
- the latest applied `_prisma_migrations` name (the schema era),
- `media files: N in tar, M referenced, missing: K` — every
  `MediaAsset.storagePath` in the restored DB must exist in the tar,
- a final `VERIFY OK <dir>` (exit 0) or `VERIFY FAILED <dir>` (exit 1; also
  fails if any restore step errors or a referenced media file is missing).

## Restore (destructive — downtime required)

```bash
docker/restore.sh --yes docker/backups/<yyyymmdd-hhmmss>
```

**This overwrites the live database and the media volume.** The script
refuses to run without `--yes`, and before touching anything it prints the
live `GameSession`/`Participant` counts it is about to replace. The app is
stopped for the duration — schedule it accordingly.

What it does, in order:

1. Stops the `app` service.
2. `pg_restore --clean --if-exists` into the `ictquiz` database.
3. Starts `app` (its entrypoint runs `prisma migrate deploy`, which is a
   no-op when the restored schema is current).
4. Replaces the media volume contents from `media.tar`.

Afterwards:

```bash
curl -k https://<DOMAIN>/api/health
# log in at https://<DOMAIN>/admin and open the library — quizzes, sessions
# and uploaded images should all be present.
```

## Notes

- `pg_dump`/`pg_restore` run inside the `db` container, so the Postgres
  major version always matches the server.
- Media files are immutable (`/media/<uuid>.<ext>`), so replacing the whole
  directory is safe and idempotent.
- Sessions, participants, submissions and reports are all inside the single
  `db.dump`.
