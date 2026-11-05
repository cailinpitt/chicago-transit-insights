# Database backups

The history DB (`state/history.sqlite`) is the one piece
of irreplaceable state on the server — it can't be rebuilt from the code or the
CTA feeds. It lives on a single LVM volume with no RAID, so it's backed up
off-box to **Cloudflare R2** daily.

- `scripts/backup-db.sh` — snapshot → drop `observations` → integrity-check → gzip → upload to R2.
- `scripts/restore-db.sh` — pull a snapshot back down and verify it.

Vehicle positions (`observations`) are **not** in the backup. Finished days
are archived as Parquet by `bin/export-positions.js` to `archive/positions/` and to the
public data bucket, which doubles as their off-box copy (`docs/POSITIONS.md`).
A restored DB starts with an empty `observations` table, so it loses up to 14
days of hot-window positions. The archived days are unaffected; the
detectors' 7-day lookbacks are thin for the first week after a restore.

The snapshot is taken with `VACUUM INTO`, which reads the DB in a single
transaction, so under WAL it does not block the bots mid-write. Don't switch
back to the CLI's `.backup`: it copies in small steps and restarts whenever
another process writes, so with the bots writing every minute it never finished
and four stuck copies starved the box of memory (Nov 2026). The script holds a
`flock` so a slow run can't overlap the next night's, and caps the snapshot at
2h. A raw `cp` of the `.sqlite` file is **not**
safe — it can capture a torn state while the `-wal` file holds uncommitted
writes.

## One-time setup (on the server)

### 1. Install rclone

```sh
sudo apt update && sudo apt install -y rclone
```

### 2. Create the R2 bucket + API token (Cloudflare dashboard)

1. **R2 → Create bucket** → name it `cta-insights-db-backups`.
2. **R2 → Manage R2 API Tokens → Create API Token**:
   - Permission: **Object Read & Write**
   - Scope it to the `cta-insights-db-backups` bucket.
   - Save the **Access Key ID**, **Secret Access Key**, and the
     **S3 endpoint** (`https://<account-id>.r2.cloudflarestorage.com`).

### 3. Configure the `r2` rclone remote

Run this on the server and paste your own credentials — the secret is stored in
`~/.config/rclone/rclone.conf` (mode 600), never in this repo:

```sh
rclone config create r2 s3 \
  provider=Cloudflare \
  access_key_id=<ACCESS_KEY_ID> \
  secret_access_key=<SECRET_ACCESS_KEY> \
  endpoint=https://<account-id>.r2.cloudflarestorage.com \
  acl=private
```

Verify:

```sh
rclone lsd r2:                       # should list cta-insights-db-backups
scripts/backup-db.sh                 # first real backup
scripts/restore-db.sh --list         # should show the file you just uploaded
```

### 4. Retention (R2 lifecycle rule)

The backup script keeps only 2 local copies; remote retention is handled by an
R2 lifecycle rule rather than scripted deletes (safer — the server can't
accidentally wipe history). In the dashboard: **R2 → cta-insights-db-backups →
Settings → Object lifecycle rules → Add rule → delete objects N days after
creation**.

Retention is **7 days** to stay inside R2's 10 GB free tier: each snapshot is
~320 MB, so 7 days ≈ 2.2 GB (vs. ~9.5 GB at 30 days, which would top out the
free tier with no room for the DB to grow). Also enable **abort incomplete
multipart uploads after 1 day** in the same rule — the server's older rclone
uploads multipart, and a failed part would otherwise linger and accrue
storage.

## Schedule

A daily 04:17 entry is in `cron/crontab.txt` under `--- Backups ---`. It runs
off-peak and well clear of the `fetch-gtfs` (03:15) and `fetch-signals`
(04:00 monthly) jobs. Install it with the merge procedure documented at the
top of `cron/crontab.txt`.

Logs: `cron/backup-db-cron.log`.

## Restoring

```sh
scripts/restore-db.sh --list                 # see what's available
scripts/restore-db.sh                         # fetch + verify the latest
scripts/restore-db.sh history-YYYYMMDD-HHMMSS.sqlite.gz   # a specific one
```

The restore script never overwrites the live DB on its own — it verifies the
snapshot into `tmp/db-backups/` and prints the manual swap-in steps (stop
writers → copy into place → re-enable cron). Test a restore periodically; an
unverified backup is only a guess.
