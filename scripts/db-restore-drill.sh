#!/usr/bin/env bash
#
# Prove a dump can be restored, without touching the real database.
#
#   npm run db:restore-drill                        # newest dump in ./backups
#   npm run db:restore-drill -- ./backups/x.pgc     # a specific one
#
# Restores the dump into a brand-new throwaway database in the same Postgres
# container, in one transaction that stops at the first error, then counts
# the rows of every table and compares them with the rows inside the dump
# itself. The throwaway database is dropped at the end, also when something
# fails. The real database is only read (row counts, for information), the
# backend keeps running, and nothing asks for confirmation — safe to schedule.
#
# Unlike db-restore.sh, which REPLACES the real database, this is the one to
# run regularly: a backup nobody ever restored is a hope, not a backup.
#
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
DB_USER="${POSTGRES_USER:-myanflix}"
DB_NAME="${POSTGRES_DB:-myanflix}"

dump="${1:-}"
if [[ -z "$dump" ]]; then
  dump="$(ls -1t "$BACKUP_DIR"/myanflix-*.pgc 2>/dev/null | head -1 || true)"
  [[ -n "$dump" ]] || { echo "error: no dumps found in $BACKUP_DIR" >&2; exit 1; }
fi
[[ -f "$dump" ]] || { echo "error: $dump not found" >&2; exit 1; }

container="$(docker compose ps -q postgres 2>/dev/null || true)"
if [[ -z "$container" ]]; then
  echo "error: the postgres service isn't running (docker compose ps -q postgres returned nothing)." >&2
  exit 1
fi

drill_db="restore_drill_$(date +%Y%m%d%H%M%S)"
if [[ "$drill_db" == "$DB_NAME" ]]; then
  echo "error: refusing to use the real database name" >&2
  exit 1
fi

# No -i: inside the row-count loop below, an attached stdin would swallow the
# rest of the table list.
psql_in() { docker exec "$container" psql -U "$DB_USER" -v ON_ERROR_STOP=1 -qtA "$@"; }

cleanup() {
  psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$drill_db\"" > /dev/null 2>&1 || true
  if [[ -n "$(psql_in -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$drill_db'" 2>/dev/null || true)" ]]; then
    echo "warning: could not drop the throwaway database $drill_db — drop it by hand" >&2
  fi
}
trap cleanup EXIT

echo "→ $(date '+%F %T') restore drill: $dump → throwaway database $drill_db"
psql_in -d postgres -c "CREATE DATABASE \"$drill_db\"" > /dev/null

# --single-transaction + --exit-on-error: the restore either completes or
# fails loudly, never "mostly worked". --no-owner/--no-privileges as in
# db-backup.sh, so the drill does not depend on roles.
if ! docker exec -i "$container" pg_restore -U "$DB_USER" -d "$drill_db" \
  --no-owner --no-privileges --single-transaction --exit-on-error < "$dump"; then
  echo "❌ restore failed — this dump cannot be restored as it is" >&2
  exit 1
fi

# Rows per table as stored in the dump: one line per row inside each
# `COPY <table> ... FROM stdin;` block, up to the closing `\.` line (COPY
# text format escapes newlines inside values, so a row is always one line).
expected="$(docker exec -i "$container" pg_restore --data-only -f - < "$dump" |
  awk '/^COPY / { table = $2; rows = 0; inside = 1; next }
       inside && /^\\\.$/ { print table, rows; inside = 0; next }
       inside { rows++ }')"
[[ -n "$expected" ]] || { echo "error: no table data found in $dump" >&2; exit 1; }

printf '%-45s %10s %10s %10s\n' table in_dump restored live_now
bad=0
tables=0
while read -r table rows; do
  [[ -n "$table" ]] || continue
  tables=$((tables + 1))
  restored="$(psql_in -d "$drill_db" -c "SELECT count(*) FROM $table")"
  live="$(psql_in -d "$DB_NAME" -c "SELECT count(*) FROM $table" 2>/dev/null || echo '-')"
  mark=""
  if [[ "$restored" != "$rows" ]]; then
    mark="  ← MISMATCH"
    bad=$((bad + 1))
  elif [[ "$live" != "$rows" ]]; then
    mark="  (changed since the dump)"
  fi
  printf '%-45s %10s %10s %10s%s\n' "$table" "$rows" "$restored" "$live" "$mark"
done <<EOF
$expected
EOF

# Which schema the dump carries, against this checkout's migrations: a dump
# from before a migration restores fine here but is older than the code.
in_dump="$(psql_in -d "$drill_db" -c 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' 2>/dev/null || echo '?')"
in_repo="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
echo "   migrations applied in the dump: $in_dump (this checkout has $in_repo)"

if [[ "$bad" -gt 0 ]]; then
  echo "❌ $bad of $tables tables restored with a different row count" >&2
  exit 1
fi
echo "✅ restore drill passed: $tables tables, every row count matches the dump"
