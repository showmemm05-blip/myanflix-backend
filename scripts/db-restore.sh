#!/usr/bin/env bash
#
# Restore a dump produced by db-backup.sh.
#
#   npm run db:restore                          # newest dump in ./backups
#   npm run db:restore -- ./backups/x.pgc       # a specific one
#
# The backend is stopped for the duration: it holds pooled connections, and
# --clean cannot drop objects those connections are using. It is started again
# afterwards only if it was running to begin with.
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
  echo "→ newest dump: $dump"
fi
[[ -f "$dump" ]] || { echo "error: $dump not found" >&2; exit 1; }

container="$(docker compose ps -q postgres 2>/dev/null || true)"
if [[ -z "$container" ]]; then
  echo "error: the postgres service isn't running." >&2
  echo "       start it with: docker compose up -d postgres" >&2
  exit 1
fi

echo "⚠️  This REPLACES the contents of '$DB_NAME'."
read -r -p "   Type the database name to confirm: " reply
[[ "$reply" == "$DB_NAME" ]] || { echo "aborted."; exit 1; }

# Only restart the backend afterwards if it was up before — otherwise this
# would silently start a service the operator had deliberately stopped.
backend_was_up="$(docker compose ps --status running -q backend 2>/dev/null || true)"
if [[ -n "$backend_was_up" ]]; then
  echo "→ stopping backend (it holds connections --clean would trip over)…"
  docker compose stop backend > /dev/null
fi

echo "→ restoring…"
# --clean --if-exists so this is repeatable and tolerates a partially-populated
# database; a fresh one simply logs "does not exist, skipping".
docker exec -i "$container" pg_restore -U "$DB_USER" -d "$DB_NAME" \
  --clean --if-exists --no-owner < "$dump"

if [[ -n "$backend_was_up" ]]; then
  echo "→ starting backend…"
  docker compose up -d backend > /dev/null
fi

users="$(docker exec "$container" psql -U "$DB_USER" -d "$DB_NAME" -tAc 'select count(*) from users' 2>/dev/null || echo '?')"
echo "✅ restored — users: $users"
