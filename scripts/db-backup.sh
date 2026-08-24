#!/usr/bin/env bash
#
# Dump the Postgres database to ./backups, verify the dump is readable, and
# prune old ones.
#
# Runs the same on a laptop and on the VPS: the container is located through
# `docker compose ps -q postgres` rather than a hard-coded name, and the
# credentials come from the same .env the stack itself uses — so there is no
# second place to keep in sync.
#
#   npm run db:backup              # keeps the default number of dumps
#   KEEP=30 npm run db:backup      # keep more
#   BACKUP_DIR=/mnt/x npm run db:backup
#
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
# Enough history to survive "the bad data was there yesterday too" without
# quietly filling a disk. Dumps are small (~150 KB) — this is about noticing,
# not about space.
KEEP="${KEEP:-14}"

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

container="$(docker compose ps -q postgres 2>/dev/null || true)"
if [[ -z "$container" ]]; then
  echo "error: the postgres service isn't running (docker compose ps -q postgres returned nothing)." >&2
  echo "       start it with: docker compose up -d postgres" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date +%F-%H%M%S)"
out="$BACKUP_DIR/myanflix-$stamp.pgc"

echo "→ dumping ${DB_NAME}…"
# --format=custom so pg_restore can be selective later; --no-owner/--no-privileges
# so the dump restores onto a host that has no `myanflix` role yet.
docker exec "$container" pg_dump -U "$DB_USER" -d "$DB_NAME" \
  --format=custom --no-owner --no-privileges > "$out"

# A dump that can't be listed is not a backup. Catching it here means the
# failure surfaces now rather than during a restore, which is the one moment
# there is no time to discover it.
if ! docker exec -i "$container" pg_restore --list < "$out" > /dev/null 2>&1; then
  echo "error: the dump is unreadable — removing $out" >&2
  rm -f "$out"
  exit 1
fi

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
exit 0
