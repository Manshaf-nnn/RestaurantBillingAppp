# Architecture

Next.js 15 App Router + React 19, Prisma 6 on Postgres (local dev via
`postgresql@16`, Neon in production), deployed on Netlify. One repository, one
service; there are no queues, no cron and no background workers by design —
every deferred effect is computed lazily on read (the house pattern:
`autoCloseStale`, forgotten-drawer flags, rate-limit sweeps).

## Layering

```
src/app/**            routes: server components + route handlers, thin
src/features/<x>/     the product, one directory per domain:
  actions.ts            'use server' — auth, zod, audit, delegate to service
  service.ts            the rules; owns transactions
  queries.ts            read paths
  schema.ts             zod input schemas
  components/           client components
src/server/**          cross-cutting: auth, db, audit, notifications, security
src/lib/**             pure helpers usable on both sides (rbac, money, errors)
```

Actions never contain business rules; services never check permissions.
Every action: `requirePermission` → branch guard (`assertRecordBranch` /
`assertBranchAccess`) → zod-validated input → service → `audit()` →
`revalidatePath`.

## Single engines (the preserve-list)

One function owns each hard problem, and everything routes through it:

- `computeTotals` — every bill (see ACCOUNTING.md)
- `outstandingOn` — what a guest owes (grand total + tip − paid)
- `postMovement` — every stock balance change (see INVENTORY.md)
- `reconcileOrderDepletion` — declarative, idempotent order consumption
- `recalculateOrderTotals` — re-deriving a bill after line changes
- `cancelOrder` — the ONE cancellation entry point (status paths refuse it)
- `ensureInvoice` — invoice minting, idempotent, counter-numbered
- `resolveRange` (`features/reports/range.ts`) — the one timezone-aware
  date-range resolver; every report and export goes through it
- `nextCounterValue` — atomic per-restaurant sequences (invoices, POs)

## Realtime

Socket.IO exists but is OFF in production (`NEXT_PUBLIC_REALTIME_DISABLED`,
netlify.toml); every server-side `realtime.*()` call is a no-op there.
Screens poll `/api/pulse` (scoped change tokens: ops/catalog/live) via
`<AutoRefresh>`. Anything that must be seen goes to the persistent
notification bell, which enforces audience and branch on read.

## Multi-tenancy

`restaurantId` is derived from the session, never from input. Branch scoping
is fail-closed: `visibleBranchIds` returns `[]` (sees nothing) for a confined
user with no branch. Public surfaces resolve the tenant from domain,
subdomain or pinned cookie (`resolvePublicTenant`). Guests hold an anonymous
session cookie; knowing an order id is never enough.
