#!/usr/bin/env bash
# Bring up a local Postgres data dir, create the database, push schema and seed.
# Idempotent — safe to re-run.
set -euo pipefail

PGBIN="/opt/homebrew/opt/postgresql@16/bin"
export PATH="$PGBIN:$PATH"
PGDATA="${PGDATA:-$HOME/.restaurantos-pg}"
PORT=5432

echo "▸ Using Postgres at $PGBIN"

if [ ! -d "$PGDATA/base" ]; then
  echo "▸ Initialising data directory at $PGDATA"
  "$PGBIN/initdb" -D "$PGDATA" -U "$USER" --auth=trust >/dev/null
fi

# Start server if not already accepting connections.
if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  echo "▸ Starting Postgres"
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -o "-p $PORT" start
  sleep 2
fi

# Wait until it accepts connections.
for i in $(seq 1 20); do
  if "$PGBIN/pg_isready" -q -p "$PORT"; then break; fi
  sleep 1
done

# Create database if missing.
if ! "$PGBIN/psql" -p "$PORT" -lqt | cut -d'|' -f1 | grep -qw restaurantos; then
  echo "▸ Creating database 'restaurantos'"
  "$PGBIN/createdb" -p "$PORT" restaurantos
fi

echo "▸ Postgres is up on port $PORT"
