#!/usr/bin/env bash
# ============================================================================
# Deploy / update RestaurantOS on the server.
# Run from the project directory after pulling new code:
#   bash deploy/update.sh
# ============================================================================
set -euo pipefail

echo "▸ Installing dependencies…"
npm ci

echo "▸ Generating Prisma client & applying schema…"
npx prisma generate
npx prisma db push

echo "▸ Building…"
npm run build

echo "▸ Restarting app…"
if command -v pm2 >/dev/null 2>&1 && pm2 list | grep -q restaurantos; then
  pm2 reload restaurantos
elif systemctl list-units --type=service | grep -q restaurantos; then
  sudo systemctl restart restaurantos
else
  echo "  ! No PM2 process or systemd service found — start it with:"
  echo "    pm2 start ecosystem.config.cjs   (or)   sudo systemctl start restaurantos"
fi

echo "✅ Done."
