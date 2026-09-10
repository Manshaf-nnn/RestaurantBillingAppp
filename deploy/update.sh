#!/usr/bin/env bash
# ============================================================================
# Deploy / update RestaurantOS on the server.
#
#   sudo -u tableflow -H bash /srv/tableflow/current/deploy/update.sh
#
# Builds into a fresh release directory and flips a symlink, so a failed build
# leaves the running site untouched. The previous release stays on disk — see
# "Rolling back" at the bottom.
# ============================================================================
set -euo pipefail

BASE="${TABLEFLOW_BASE:-/srv/tableflow}"
REPO="${TABLEFLOW_REPO:-https://github.com/Manshaf-nnn/RestaurantBillingAppp.git}"
BRANCH="${TABLEFLOW_BRANCH:-main}"
KEEP_RELEASES="${TABLEFLOW_KEEP:-3}"
REL="$BASE/releases/$(date +%Y%m%d%H%M%S)"

if [ ! -f "$BASE/shared/.env" ]; then
  echo "✗ $BASE/shared/.env is missing. Create it before deploying." >&2
  exit 1
fi

echo "▸ Fetching $BRANCH into $REL…"
git clone --depth 50 --branch "$BRANCH" "$REPO" "$REL"
cd "$REL"

# The shared .env lives outside every release, so it survives rollbacks and is
# never one `git clean` from deletion. Both `next build` (which auto-loads
# ./.env) and `node --env-file=.env` follow the symlink to the same file.
ln -sfn "$BASE/shared/.env" .env
mkdir -p logs

echo "▸ Installing dependencies…"
npm ci

echo "▸ Generating Prisma client…"
npx prisma generate

# ── The database ────────────────────────────────────────────────────────────
# `npx prisma db push` used to be here. It applies the schema with no migration
# history and will drop columns to force a match, and calling the Prisma CLI
# directly walks straight past scripts/guard-local-db.mjs, which is only wired
# into the `setup` scripts. Against the production Neon database that is not
# recoverable without a restore.
#
# scripts/deploy-db.mjs is the only correct path: it handles an empty database,
# one with migration history, and one that was pushed without history, and it
# refuses to baseline when `migrate diff` shows drift.
#
# Migrations here are additive by construction (scripts/migration-safety-test.ts
# rejects drops and truncates), so applying them before the new build is up is
# safe — the currently running release keeps working against the new schema.
echo "▸ Database…"
npm run db:deploy:safe

# Deliberately NOT running `npm run db:seed:prod`. While SUPER_ADMIN_PASSWORD is
# set it re-seeds the platform admin's password on every run, silently reverting
# a password changed through the UI.

echo "▸ Building…"
# Cap the heap so V8 fails on its own limit instead of the kernel OOM killer
# choosing a victim by score — which, on a box that hosts other sites, may not
# be this one.
NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS="--max-old-space-size=2560" npm run build

echo "▸ Switching to the new release…"
ln -sfn "$REL" "$BASE/current"
# delete+start rather than reload: ecosystem.config.cjs uses `cwd: __dirname`,
# which Node resolves through the symlink to the real release path, so a reload
# would keep serving the old directory. Costs ~5-10s; in fork mode `pm2 reload`
# is a restart anyway.
pm2 delete restaurantos 2>/dev/null || true
pm2 start "$BASE/current/ecosystem.config.cjs"
pm2 save

echo "▸ Verifying…"
sleep 8
if ! BASE_URL="${VERIFY_URL:-http://127.0.0.1:3010}" \
     EXPECT_COMMIT="$(git -C "$REL" rev-parse HEAD)" \
     npx tsx --tsconfig tsconfig.test.json scripts/deploy-verify.ts; then
  echo "✗ Verification failed. The new release is live — roll back with:" >&2
  echo "    ln -sfn \$(ls -1dt $BASE/releases/* | sed -n 2p) $BASE/current" >&2
  echo "    pm2 delete restaurantos && pm2 start $BASE/current/ecosystem.config.cjs && pm2 save" >&2
  exit 1
fi

echo "▸ Pruning old releases (keeping $KEEP_RELEASES)…"
ls -1dt "$BASE"/releases/* | tail -n "+$((KEEP_RELEASES + 1))" | xargs -r rm -rf

echo "✅ Live: $REL"

# ── Rolling back ────────────────────────────────────────────────────────────
#   ln -sfn /srv/tableflow/releases/<previous> /srv/tableflow/current
#   pm2 delete restaurantos
#   pm2 start /srv/tableflow/current/ecosystem.config.cjs && pm2 save
