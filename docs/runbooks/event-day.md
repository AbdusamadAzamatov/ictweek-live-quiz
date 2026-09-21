# Event-day runbook

## T-1 day — rehearsal checklist

- [ ] Stack is up and healthy: `docker compose -f docker/compose.yml ps` → all
      `healthy`; `curl https://<DOMAIN>/api/health` → `{"ok":true}`.
- [ ] Quiz is imported/created and passes play validation (no `playIssues` —
      run it through the editor's Preview once).
- [ ] One real phone joins a test session from the QR / join link and answers
      a question end-to-end. If the event server is not deployed yet, rehearse
      against your laptop over the LAN first — see `lan-rehearsal.md` (phones
      cannot reach `localhost` on another machine). For the event itself, use
      the real domain `https://<DOMAIN>`.
- [ ] Projector laptop: open `/display/<displayKey>` fullscreen (`F` on the
      host page, or the browser's own fullscreen) at 1080p; type is readable
      from the back of the room.
- [ ] Sound: click once on the display page (the "Tap to enable sound" pill
      disappears) — cues then play on transitions. `M` toggles mute on host
      and display.
- [ ] Host laptop: `/admin/host/<sessionId>` opens, keyboard shortcuts work
      (`Space`/`→`/`N` next, `C` close answers, `L` lock, `F` fullscreen, `M`
      mute, `?` hint overlay).
- [ ] Backup taken: `docker/backup.sh` (see backup-restore.md).

## T-0 — 30 minutes before

- [ ] Create the session from the library (quiz → Host session → settings →
      create). Keep it in LOBBY.
- [ ] Host laptop on wired ethernet if available; otherwise the same Wi-Fi as
      the projector, not the player network.
- [ ] Open the projector view on the second screen; open the host page on the
      primary screen.
- [ ] Let players join as they arrive; **lock the lobby when starting** if
      late joiners are not wanted (session setting / `L` on the host page).
- [ ] Diagnostics page open in a spare tab (`/api/diagnostics` via the
      organizer session) for socket/room counts.

## Incident playbook

| Symptom | Action |
| --- | --- |
| Host laptop dies | Log in on any other device and open `/admin/host/<sessionId>` — the session keeps running. |
| API restarts mid-question | Session drops to **RECOVERY**; on the host page choose **Replay question** (voids the interrupted attempt — no double scoring) or **End session**. |
| A phone loses Wi-Fi | Reopen the join link — the stored resume token restores the same nickname and score. If it was removed, it must rejoin with a new nickname. |
| Player with a bad nickname | Host page → participant list → × (remove). The nickname stays taken for this session; they rejoin under another one. |
| Projector disconnects | Reload the display URL `/display/<displayKey>` — it resyncs to the current state. No re-auth needed. |
| Players can't join | Check `/api/diagnostics` socket counts; check the PIN is the live one; check lobby isn't locked and `maxParticipants` not hit. |
| Everything is down | `docker compose -f docker/compose.yml ps` / `logs -f app`; worst case `up -d` — running sessions recover to RECOVERY. |

## Afterwards — collect

- [ ] CSV report per session: report page → **Download CSV**
      (`/api/sessions/<id>/report.csv`).
- [ ] Diagnostics screenshot/export for the record (`/api/diagnostics`).
- [ ] Final backup: `docker/backup.sh`.
