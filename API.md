# API

TableFlow is server-actions-first; the HTTP surface is small and deliberate.

## Route handlers

- `GET /api/pulse?scope=ops|catalog|live` — change tokens the polling
  screens compare; the serverless substitute for sockets.
- `GET /api/reports/export?type=…&format=csv|xlsx` — filtered, branch-scoped
  exports; permission per type (cash reports require `REPORT_CASH`).
- `GET /api/health/*` — liveness, page-loader smoke checks, and
  `/api/health/errors` (owner-only, tenant-scoped error captures keyed by
  the digest shown on error screens).
- `GET /api/media/*` — images served from Postgres (bytes live in Neon
  deliberately; do not move them to blob storage).

## Server actions

Every mutation is a `'use server'` action co-located with its feature
(`src/features/*/actions.ts`), validated with zod, permission-checked,
audited, and returning `ActionResult<T>` (`{ ok: true, data } | { ok: false,
error }`). The runtime test tier drives these over real HTTP with action ids
harvested from the built client bundle — the transport is covered, not
assumed.

There is one public JSON API, for a restaurant's own website (`websiteconnect.md`):
`/api/website/v1` — connection, restaurant, menu, orders, order status — authenticated by a
per-restaurant key issued under Super Admin → Restaurants → Connect website. It is
server-to-server only and every response is fenced by the key's restaurant. Reference and
examples: `/api/docs?format=html#website`. Everything else remains server actions.
