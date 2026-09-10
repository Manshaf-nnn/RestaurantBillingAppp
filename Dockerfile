# syntax=docker/dockerfile:1
# ============================================================================
# RestaurantOS production image — multi-stage, runs the custom Socket.IO server.
# ============================================================================

# ── deps ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ── builder ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# Which commit is actually serving. next.config.mjs stamps this into the build
# at compile time and /api/health reports it, which is how deploy-verify.ts
# answers "did my fix reach the site". Without it the field is null and that
# check silently cannot work — it passes whatever is deployed.
#
# The build context is a plain COPY of the source, not a git clone, so there is
# no .git here to read: the value has to be handed in. CI passes it from
# github.sha; a hand-run build can use
#   docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
ARG GIT_COMMIT=""
ARG GIT_BRANCH=""
ENV GIT_COMMIT=$GIT_COMMIT
ENV BRANCH=$GIT_BRANCH

RUN npx prisma generate && npm run build

# ── runner ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Bring only what the runtime needs. Everything stays root-owned and therefore
# read-only to the app user, EXCEPT .next — Next writes its ISR and fetch
# caches under .next/cache at runtime, and without ownership every render logs
# "EACCES: permission denied, mkdir '/app/.next/cache/fetch-cache'" and falls
# back to uncached. Noisy, and slower than it needs to be.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.mjs ./server.mjs
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/prisma ./prisma

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
