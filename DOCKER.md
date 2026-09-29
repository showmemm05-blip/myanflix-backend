# Running the backend in Docker

Builds the NestJS API into an image and runs it alongside its own Postgres
container — everything the Flokinet VPS needs for the `backend` role.

## Run it

```bash
cd backend
cp .env.example .env
# edit .env: set real JWT_SECRET / JWT_REFRESH_SECRET (16+ chars each),
# change POSTGRES_PASSWORD from the placeholder, and set MINIO_ACCESS_KEY /
# MINIO_SECRET_KEY to match ../storage-server/.env
docker compose up -d --build
```

Requires `../storage-server` (MinIO) and `../cacheserver` running too — this
starts:
- `postgres` — Postgres 17, data persisted in a named volume
- `backend` — the API, built from `Dockerfile`, on `http://localhost:3001/api`

Pending Prisma migrations run automatically every time the container starts
(`prisma migrate deploy`, safe to repeat — it only applies what hasn't run
yet). They create the roles and permissions, but no account.

## First Super Admin (one time, on a fresh database)

```bash
docker compose exec backend npm run create-superadmin -- --username <name>
```

It asks for the password twice without showing it. Without a terminal, pipe
it instead (`printf '%s\n' '<password>' | docker compose exec -T backend npm
run create-superadmin -- --username <name>`), or set `SUPERADMIN_PASSWORD`
for that one command only — never in `.env` or the compose file. There is no
default username or password. It refuses, and changes nothing, once any Super
Admin exists: every further staff account is created from the admin's Staff
page. Locally (outside Docker) run `npm run build` first.

The seed scripts (`npm run db:seed`, `npm run db:seed:users`) are for local
demo data only. They refuse `NODE_ENV=production` (the image sets it), they
need `SEED_PASSWORD` set for the run (every seeded account gets it; there is
no default), and `db:seed` **wipes** users, titles and money tables first.
They cannot run inside the image anyway: they build from sources the image
does not contain.

## Where video actually lives now

ffmpeg only ever writes to local disk (`/app/storage`, the `backend-storage`
volume) as scratch space — it can't write directly to S3. Once a rendition
finishes transcoding, `ProcessingService` pushes it to MinIO
(`../storage-server`) and deletes the local copy; `backend-storage` only ever
holds in-flight uploads and the current transcode job now, not what's
actually streamed. Playback URLs point at `STREAM_PUBLIC_BASE_URL`
(`../cacheserver`), never at this backend or MinIO directly.

## Moving to the real VPS

Same image, same compose file — just:
- point `DATABASE_URL`/`POSTGRES_*` at whatever you actually want in
  production (this bundled Postgres container, or a managed one),
- point `MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` at the real
  Movie Storage Server VPS,
- set the stream and upload addresses in `.env` (next list),
- set real secrets in `.env` (never commit it — already gitignored),
- deploy `backend/` to the Flokinet VPS and run the same `docker compose up
  -d --build`.

Stream and upload addresses for the three-VPS layout (API, storage and cache
on different machines):

| Setting | Value | Why |
|---|---|---|
| `STREAM_PUBLIC_BASE_URL` | `https://<cache-host>` (the cache server VPS's domain) | every playback, subtitle, book page and poster URL starts with it |
| `STREAM_PUBLIC_BASE_URL_IS_PUBLIC` | `true` | use that address as written; left empty, the backend swaps in the host the app used to reach the API — the API VPS, where no cache server runs |
| `STREAM_SIGNING_SECRET` | the same value as `../cacheserver/.env` | the cache refuses every link it cannot verify |
| `MINIO_PUBLIC_ENDPOINT` | `https://<upload-proxy-host>` (the storage server's upload proxy) | admin browsers upload straight to it |
| `STREAM_INTERNAL_BASE_URL` | the cache server's address as the API VPS reaches it (`https://<cache-host>` works) | only the admin's "Check playback" uses it; the compose default points at this machine |

With `NODE_ENV=production` (the image sets it) the backend **refuses to
start** when `STREAM_PUBLIC_BASE_URL` is a public address and either
`STREAM_PUBLIC_BASE_URL_IS_PUBLIC` is empty or `MINIO_PUBLIC_ENDPOINT` is
unset or `localhost`/`127.0.0.1`/`host.docker.internal`; the container log
says which one. A cache on the same computer or LAN (a `localhost`, `127.x`,
`10.x`, `172.16-31.x`, `192.168.x` or `*.local` base, as on a development
Mac) needs none of this and keeps building URLs from the request host.

## Backups (database)

`npm run db:backup` (`scripts/db-backup.sh`) dumps Postgres into `./backups`,
checks the dump can be read, keeps the newest `KEEP` (default 14), and, when
`BACKUP_OFFSITE_DEST` is set, copies every dump to that place and checks the
far side has them all. A dump that fails halfway is thrown away rather than
left behind as the "newest" backup.

- **Off-site** (`BACKUP_OFFSITE_DEST`, in `.env` or on the command line; the
  owner picks the place): any rsync destination. A folder on another disk
  (`/Volumes/YOUR_SSD/myanflix-db`), or another machine over SSH
  (`backup@<host>:/srv/myanflix-db`, key login with no passphrase prompt, the
  folder created beforehand, `rsync` installed on both ends). Never the same
  disk as `./backups`. Dumps hold every user's phone number and wallet
  history, so the place must be private. The far side is never pruned.

**Schedule it.**

- This Mac: `scripts/launchd/com.myanflix.db-backup.plist` runs it daily at
  03:30 (or at the next wake). It is in the repo, **not loaded**. Set
  `BACKUP_OFFSITE_DEST` in `.env`, then:

  ```bash
  cp scripts/launchd/com.myanflix.db-backup.plist ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.myanflix.db-backup.plist
  launchctl kickstart gui/$(id -u)/com.myanflix.db-backup    # run once now
  tail ~/Library/Logs/myanflix-db-backup.log                  # must end with ✅
  ```

  macOS blocks background jobs from reading `~/Desktop` (where this repo
  lives) until `/bin/bash` has **Full Disk Access** (System Settings > Privacy
  & Security > Full Disk Access, `+`, Cmd+Shift+G, `/bin/bash`). "Operation
  not permitted" in the log means exactly that. Remove the job with
  `launchctl bootout gui/$(id -u)/com.myanflix.db-backup`.
- API VPS (`mfxadmin`, `~/myanflix-backend`; the user must be able to run
  `docker`), `crontab -e`. Hourly dumps, three days kept on the VPS, a
  restore drill every Sunday:

  ```cron
  17 * * * * cd /home/mfxadmin/myanflix-backend && KEEP=72 flock -n /tmp/myanflix-db-backup.lock bash scripts/db-backup.sh >> /home/mfxadmin/myanflix-db-backup.log 2>&1
  40 4 * * 0 cd /home/mfxadmin/myanflix-backend && bash scripts/db-restore-drill.sh >> /home/mfxadmin/myanflix-db-backup.log 2>&1
  ```

  Check after the first hour: `tail ~/myanflix-db-backup.log` shows a ✅ line
  for the dump and one for the off-site copy.

**Prove it restores.** `npm run db:restore-drill` (or `-- ./backups/x.pgc`)
restores a dump into a new throwaway database in the same Postgres
container, compares every table's row count with the rows inside the dump,
prints the live count next to them, reports which migration level the dump
carries, and drops the throwaway database. It never writes to the real
database and never stops the backend. Run on 2026-09-28 with a fresh dump:
52 tables, every count equal to the dump and to the live database, 56 of 56
migrations.

**Restore for real.** `npm run db:restore -- ./backups/<file>.pgc` REPLACES
the live database (it asks for the database name first, stops the backend
while it runs and starts it again if it was running). Run the drill on that
same file first.

**How much can be lost, how long it takes.** On the VPS schedule, at most
about one hour of wallet and transaction history (plus whatever the off-site
copy had not received yet, if the VPS is lost). A dump is about 200 KB, so
the restore itself takes seconds; the time goes into getting the file onto
the new machine and redeploying. Media is backed up separately:
`../storage-server/README.md`, "Backups (media)".
