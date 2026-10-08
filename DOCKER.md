# Running the backend in Docker

Builds the NestJS API into an image and runs it alongside its own Postgres
container — everything the Flokinet VPS needs for the `backend` role.

## Run it

```bash
cd backend
cp .env.example .env
# edit .env: set JWT_SECRET and JWT_REFRESH_SECRET (two different random
# values, 32+ chars each: `openssl rand -hex 32` twice), POSTGRES_PASSWORD,
# STREAM_SIGNING_SECRET, and MINIO_ACCESS_KEY / MINIO_SECRET_KEY to match
# ../storage-server/.env
docker compose up -d --build
```

There are no fallback passwords: `docker compose` refuses to start while
`POSTGRES_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `STREAM_SIGNING_SECRET`,
`MINIO_ACCESS_KEY` or `MINIO_SECRET_KEY` is empty, and the backend refuses to
boot with a placeholder-looking JWT secret (`replace-…`, `change-me`, …) in
any environment, or, with `NODE_ENV=production` (the image sets it), with a
JWT secret under 32 characters or two equal ones.

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

Playback links expire after `STREAM_URL_TTL_SECONDS` (default 4 h, rounded
to the hour, minimum 1 h). A link is a bearer URL — anyone who is handed it
can play that title until it expires — so keep this short; the website and
mobile players fetch a fresh link on their own when one answers 410.

## Browser origins (CORS)

`CORS_ORIGINS` lists the browser origins allowed to call the API, comma-
separated: on the real deployment, the admin's and the website's addresses,
e.g. `CORS_ORIGINS=https://admin.example.com,https://www.example.com`. Each
entry is scheme + host (+ port), nothing after it; a bad entry stops the
boot with a message naming it. Left empty, **any** origin is allowed (what
the API always did), so nothing changes until it is set. The mobile app,
the phone-monitor and `curl` send no `Origin` header and are never affected.
The same list governs the socket.io handshake.

What the list does and does not do: it is a rule the **browser** follows,
so it stops a web page on some other site from reading this API from a
visitor's browser. It does not stop `curl`, a script or an attacker's own
machine, which can send any `Origin` or none — so by itself it cannot stop
someone who already stole a token from using it elsewhere. That protection
comes from the admin/website hardening (security headers, CSP, a cookie-held
refresh token), which is separate work.

## Putting nginx/HTTPS in front

The API keys its rate limits, its tracking rows (comments, sessions, last
seen, the audit log) and the live "active users" list on the **socket
peer**. A reverse proxy makes every visitor that peer. The day one goes in
front of port 3001:

1. Set `TRUSTED_PROXIES` in `.env` to the proxy's IP as the backend sees it
   (the container's address on the compose network, or the host's bridge
   address — the first request's `tracking` row shows it), comma-separated
   if there are several. Only a connection **from** those addresses may set
   `X-Forwarded-For`; from anyone else the header is ignored.
2. Make the proxy **replace** the header with the real client address
   (nginx: `proxy_set_header X-Forwarded-For $remote_addr;`), never append
   to what the client sent (`$proxy_add_x_forwarded_for`) — the first hop is
   the one believed, and appending would let a client choose it.
3. Set `CORS_ORIGINS` (above) to the public admin and website origins.

Left empty behind a proxy, every user shares one rate-limit bucket per
route (50 OTP requests lock everyone out of sign-in for an hour) and every
row records the proxy. A production boot with a public
`STREAM_PUBLIC_BASE_URL` and an empty `TRUSTED_PROXIES` therefore logs a
`WARNING:` line from `EnvValidation` — harmless only if the API really is
reached directly.

## Backups (database)

`npm run db:backup` (`scripts/db-backup.sh`) dumps Postgres into `./backups`,
checks the dump can be read, keeps the newest `KEEP` (default 14), and, when
`BACKUP_OFFSITE_DEST` is set, copies every dump to that place and checks the
far side has them all. A dump that fails halfway is thrown away rather than
left behind as the "newest" backup.

Dumps hold every user's phone number, password hash and wallet history, so:
every dump is written mode `0600` (this account only, and older ones in the
folder are tightened on each run); `./backups` and `*.pgc` are in
`.gitignore` **and** `.dockerignore`, so no dump ever enters a Docker build
context or image; and `BACKUP_DIR=/some/folder/outside/the/repo` (in `.env`
or on the command line) moves new dumps out of the source tree altogether —
the restore scripts read the same setting. When deploying `backend/` to the
VPS by copying the folder (rsync/scp) rather than `git clone`, exclude
`backups/`, or the VPS gets every dump too.

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

## SMS gateway phone (OTP codes)

With `SMS_PROVIDER=phone-gateway` the company Android phone
(`sms-gateway-android`) texts every sign-in code. It talks to
`/api/sms-gateway/device/*` with `SMS_GATEWAY_TOKEN` (see `.env.example`).

**The token works for ONE phone only.** The first device id that presents the
token is pinned (table `sms_gateway_binding`); every other device gets 401,
the API logs an error line, and the admin dashboard's SMS card shows
"another device tried to use the token at …" with that device's id. The card
also shows the pinned phone's device id. So:

- **First start after this deploy:** nothing is pinned; the phone pins itself
  on its next heartbeat or poll (within 30 s). Nothing to do.
- **Reinstalled the app, or a new phone:** the app has a new device id, so it
  is refused. A super admin opens the admin dashboard, SMS gateway card,
  presses **Reset phone**, and starts the app on the phone: the next device
  to present the token is pinned. The reset is written to the audit log.
- **The card warns and you did NOT reinstall anything:** someone else holds
  the token. Rotate `SMS_GATEWAY_TOKEN` (change it in `.env`, restart the
  backend, re-enter it in the app), then press **Reset phone** if the phone
  was also replaced.
- **The warning comes back right after a reset:** between the reset and the
  phone's next check-in (up to 30 s) nothing is pinned, and whoever presents
  the token first takes the pin — someone holding the token who keeps
  polling wins that race every time, and the company phone then shows up as
  the "refused" one. Do not keep resetting: rotate `SMS_GATEWAY_TOKEN` first
  (as above), then press **Reset phone** once more.

**What the pin does NOT stop (audit M-28, still open).** The pin has no
per-phone secret: someone who holds the token AND the phone's device id (both
travel in the phone's requests — readable while the gateway path is plain
http, see H-1 — and the id is on the admin card) is accepted as the phone
for everything the phone can do: poll and take the queued codes in its name
(the H-5/H-7 theft, for this one attacker — so the pin closes H-5/H-7 for
someone who only has the token, e.g. copied from `.env` or a chat, NOT for
someone who read the phone's plain-http traffic, which carries both), and
send a "cannot send" heartbeat in its name, which makes the API refuse every
sign-in code (503) until the phone's own next heartbeat 30 s later — or for
as long as they keep repeating it. What is in place:
the backend log gets one ERROR line when the phone's "can send" verdict
flips to no, and one when the gateway goes offline (and a plain line when it
is back); the admin card's "can't send" warning says to check the phone's
own screen; and the rate limit now counts gateway requests per sending
address, so a token holder elsewhere cannot use up the phone's own 120/min
budget or get a fresh budget per made-up device id. If the card says the
phone cannot send but the phone's own screen says it is fine, rotate the
token. Closing it fully needs a per-phone secret in the Android app, or TLS
on the gateway path so the token cannot be read in transit.

Once the phone reports a code as sent (or failed, or it expires unsent), the
message text is blanked in `sms_messages` at once — a code never sits
readable in the database or in a backup. (A privacy extra of the 2026-10-06
fix round; no audit finding asked for it.)

### Fixed dev OTP code (`OTP_DEV_CODE`, local machine only)

To sign in and out on your own computer without waiting for a real SMS, add
one line to `backend/.env` and recreate the backend container:

```
OTP_DEV_CODE=123456
```

(any 6 digits). Every code request — sign-in, password reset, withdrawal-code
reset — then uses that code, and **no SMS is sent or queued** for the gateway
phone. Everything else stays as it is: the code expires after 5 minutes,
works once, allows 5 wrong tries, and the 60-second resend wait and the
8-codes-per-hour limit still apply (so a 409 "please wait" still means
"wait"). The apps show their normal "code sent" step. The backend log shows
`OTP_DEV_CODE is ON — ...` at startup (never the code itself).

**It cannot reach the real server by accident:** whatever `NODE_ENV` says,
the backend refuses to start with `OTP_DEV_CODE` set when any of these is true:

- `STREAM_PUBLIC_BASE_URL` is a public address, or is not an http(s) URL;
- `STREAM_PUBLIC_BASE_URL_IS_PUBLIC=true`;
- `MINIO_PUBLIC_ENDPOINT` is set to anything but a localhost/LAN address;
- any `CORS_ORIGINS` entry is not a localhost/LAN address;
- `TRUSTED_PROXIES` is set (a reverse proxy sits in front of the API).

"Local" means localhost, a LAN address (`192.168.x.x`, `10.x.x.x`,
`172.16-31.x.x`) or a `.local` name. The extra checks exist because compose
fills in `http://localhost:8080` when `STREAM_PUBLIC_BASE_URL` is left out, so
the cache address alone can look local on a real server. Never put
`OTP_DEV_CODE` in a server's `.env`, even so. Delete the line (or leave it empty) and recreate the container to go
back to real codes.
