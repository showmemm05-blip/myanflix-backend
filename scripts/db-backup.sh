#!/usr/bin/env bash
#
# Dump the Postgres database to ./backups, verify the dump is readable,
# prune old ones, and copy the dumps off this machine when
# BACKUP_OFFSITE_DEST is set.
#
# Runs the same on a laptop and on the VPS: the container is located through
# `docker compose ps -q postgres` rather than a hard-coded name, and the
# credentials come from the same .env the stack itself uses — so there is no
# second place to keep in sync.
#
#   npm run db:backup              # keeps the default number of dumps
#   KEEP=30 npm run db:backup      # keep more
#   BACKUP_DIR=/mnt/x npm run db:backup
#   BACKUP_OFFSITE_DEST=/Volumes/SSD/myanflix-db npm run db:backup
#   BACKUP_OFFSITE_DEST=backup@203.0.113.7:/srv/myanflix-db npm run db:backup
#
# BACKUP_OFFSITE_DEST (here or in .env) is any rsync destination: a folder on
# another disk, or user@host:/folder over SSH (key login, folder created
# beforehand). Scheduling (launchd on the Mac, cron on the VPS) and the
# restore drill are in DOCKER.md, "Backups".
#
set -euo pipefail

cd "$(dirname "$0")/.."

# A dump holds every user's phone number, password hash and wallet history:
# readable by this account only (0600), from the first byte of the partial
# file on. Existing dumps in the folder are tightened the same way below.
umask 077

# Default: ./backups, which git and the Docker build both ignore (.gitignore,
# .dockerignore). Set BACKUP_DIR to keep dumps outside the repo entirely; the
# restore scripts honour the same variable.
BACKUP_DIR="${BACKUP_DIR:-./backups}"
# Enough history to survive "the bad data was there yesterday too" without
# quietly filling a disk. Dumps are small (~150 KB) — this is about noticing,
# not about space.
KEEP="${KEEP:-14}"

# A destination given on the command line wins over .env.
cli_offsite="${BACKUP_OFFSITE_DEST:-}"

# POSTGRES_* are what docker-compose.yml feeds the container, so reading the
# same file is what keeps this correct after a credential rotation.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
DB_USER="${POSTGRES_USER:-myanflix}"
DB_NAME="${POSTGRES_DB:-myanflix}"
OFFSITE="${cli_offsite:-${BACKUP_OFFSITE_DEST:-}}"

container="$(docker compose ps -q postgres 2>/dev/null || true)"
if [[ -z "$container" ]]; then
  echo "error: the postgres service isn't running (docker compose ps -q postgres returned nothing)." >&2
  echo "       start it with: docker compose up -d postgres" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
# The folder too: umask only shapes a folder this run creates, and the usual
# one already existed as 0755 (listable by every account on the machine).
chmod 700 "$BACKUP_DIR"
stamp="$(date +%F-%H%M%S)"
out="$BACKUP_DIR/myanflix-$stamp.pgc"
# Written under a name the pruning, the restore script and the off-site copy
# all ignore, and renamed only once it is verified: a pg_dump that dies
# halfway (set -e stops the script right there) must not leave a truncated
# file that then looks like the newest backup.
partial="$BACKUP_DIR/.myanflix-$stamp.pgc.partial"
trap 'rm -f "$partial"' EXIT

echo "→ $(date '+%F %T') dumping ${DB_NAME}…"
# --format=custom so pg_restore can be selective later; --no-owner/--no-privileges
# so the dump restores onto a host that has no `myanflix` role yet.
docker exec "$container" pg_dump -U "$DB_USER" -d "$DB_NAME" \
  --format=custom --no-owner --no-privileges > "$partial"

# A dump that can't be listed is not a backup. Catching it here means the
# failure surfaces now rather than during a restore, which is the one moment
# there is no time to discover it.
if ! docker exec -i "$container" pg_restore --list < "$partial" > /dev/null 2>&1; then
  echo "error: the dump is unreadable — not keeping it" >&2
  exit 1
fi
mv "$partial" "$out"
chmod 600 "$out"
# Dumps made before this script set the mode keep their 0644 otherwise.
chmod 600 "$BACKUP_DIR"/myanflix-*.pgc 2>/dev/null || true

tables="$(docker exec -i "$container" pg_restore --list < "$out" | grep -c 'TABLE DATA' || true)"
echo "✅ $out ($(du -h "$out" | cut -f1), $tables tables)"

# Prune oldest-first, keeping $KEEP. Only ever touches files this script's own
# naming pattern produced.
#
# A while-read loop rather than `mapfile`: macOS ships bash 3.2, where mapfile
# does not exist, and the failure is at the very end of an otherwise successful
# backup — the least likely place anyone looks.
pruned=0
while IFS= read -r stale; do
  [ -n "$stale" ] || continue
  rm -f "$stale"
  pruned=$((pruned + 1))
done <<EOF
$(ls -1t "$BACKUP_DIR"/myanflix-*.pgc 2>/dev/null | tail -n +$((KEEP + 1)))
EOF
[ "$pruned" -gt 0 ] && printf '   pruned %s old backup(s)\n' "$pruned"

# Off-site copy. A dump that only lives on the machine it protects is lost
# with that machine. rsync sends every local dump the far side does not have
# yet (so one a failed run could not send goes with the next run) and never
# deletes there, so the far side keeps a longer history than KEEP.
if [[ -z "$OFFSITE" ]]; then
  echo "   no off-site copy (BACKUP_OFFSITE_DEST is not set)"
  exit 0
fi
OFFSITE="${OFFSITE%/}/"
echo "→ copying to $OFFSITE…"
[[ "$OFFSITE" == *:* ]] || mkdir -p "$OFFSITE"
if ! rsync -a "$BACKUP_DIR"/myanflix-*.pgc "$OFFSITE"; then
  echo "error: the off-site copy failed — the local dump $out is fine." >&2
  exit 1
fi
# Check the far side instead of trusting rsync's exit code: a dry run that
# still wants to send something means a dump is missing there or differs.
pending="$(rsync -an --size-only -i "$BACKUP_DIR"/myanflix-*.pgc "$OFFSITE")"
if [[ -n "$pending" ]]; then
  echo "error: the off-site copy is incomplete:" >&2
  printf '%s\n' "$pending" >&2
  exit 1
fi
echo "✅ off-site copy has every local dump ($OFFSITE)"
exit 0
