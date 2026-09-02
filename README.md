# RestaurantOS

A cloud-based, multi-restaurant **POS & QR Ordering platform**. One deployment hosts many restaurants, each with fully isolated data. Guests scan a single QR code, enter their table number, and order from their phone; staff run the floor from realtime kitchen, waiter, cashier and admin dashboards.

Built with **Next.js 15 (App Router) · React 19 · TypeScript · Prisma · PostgreSQL · Socket.IO · Tailwind**.

---

## Highlights

- **One QR for the whole restaurant** — guests type their table number after scanning, so you never reprint codes when tables move.
- **Realtime everywhere** — orders, kitchen status, payments, table state and notifications propagate over WebSockets with zero page refresh. Falls back to polling if the socket is unavailable.
- **Kitchen Display System** — large ticket cards, notification chime, flash animation on new orders, live cook-time stats.
- **Waiter & Cashier stations** — ready-to-serve queue, guest service requests, floor map; bill settlement with cash/card/QR, dynamic UPI payment QR, tips, discounts and thermal receipts.
- **Admin dashboard** — revenue/orders/AOV with day-over-day deltas, sales & peak-hour charts, best sellers, payment mix, live order feed.
- **Full management** — menu (variants, add-ons, happy-hour & offer pricing, recipes), categories, tables, orders, customers, staff (RBAC), coupons, inventory, suppliers, purchases, reservations and reviews.
- **Reports & exports** — CSV and Excel, plus print/PDF receipts and kitchen tickets (58 mm & 80 mm thermal).
- **Loyalty, coupons, happy hour** — points earn/redeem, percentage/fixed coupons with limits, time-boxed pricing.
- **Security** — httpOnly JWT access + rotating refresh tokens, per-role + per-user permissions, tenant-scoped queries, rate limiting, CSRF-safe writes, audit logging, OWASP-minded input validation.
- **PWA + offline** — installable dashboards with an offline shell service worker.
- **Money done right** — integer minor units everywhere, basis-point rates, server-side re-pricing of every order (client prices are never trusted).

---

## Documentation

The methodology docs are the contract every screen obeys:

| Doc | What it covers |
| --- | --- |
| [ACCOUNTING.md](ACCOUNTING.md) | The one billing engine, revenue/tips/payments/refunds methodology, invoices, daily close, periods, loyalty ledger |
| [INVENTORY.md](INVENTORY.md) | The stock ledger, value-carrying WAC, COGS methodology, counts, reconciliation |
| [REPORTING.md](REPORTING.md) | One definition per number; which module owns which report |
| [TESTING.md](TESTING.md) | The three-tier harness and its house rules; the proof suites |
| [ARCHITECTURE.md](ARCHITECTURE.md) · [DATABASE.md](DATABASE.md) · [SECURITY.md](SECURITY.md) · [API.md](API.md) · [DEPLOYMENT.md](DEPLOYMENT.md) | The rest of the platform |
| [AUDIT.md](AUDIT.md) | The Phase 0 audit this work started from, and the re-scored scorecard |

---

## Architecture

```
src/
  app/                     # routes (App Router)
    (auth)/                #   login, register, forgot/reset, verify
    order/                 #   guest QR ordering: entry → menu → cart → track → bill
    kitchen/ waiter/ cashier/
    dashboard/             #   admin console (analytics + every management screen)
    api/                   #   REST: health, public menu/orders, reports export, auth refresh, docs
  components/ui/           # design-system primitives (shadcn-style)
  features/                # feature-based modules: schema · queries · service · actions · components
    auth/ menu/ orders/ payments/ kitchen/ waiter/ cashier/
    inventory/ staff/ floor/ analytics/ reports/ settings/ dashboard/ printing/
  lib/                     # framework-agnostic helpers (money, rbac, errors, utils, realtime contract)
  server/                  # server-only: db (prisma + tenant scoping), auth, cache/redis,
                           #   realtime emitter, notifications, mailer, audit, security
  middleware.ts            # route protection, role gating, tenant pinning, CSRF, silent refresh
server.mjs                 # custom Node server running Next.js + Socket.IO in one process
prisma/schema.prisma       # full domain model
prisma/seed.ts             # realistic demo restaurant + 30 days of orders
```

**Design principles**

- *Feature-based architecture.* Each module owns its Zod schemas, data queries, business service, server actions and UI.
- *Server actions* return a uniform `ActionResult` — no throwing across the RSC boundary; forms consume it directly.
- *Tenant isolation.* Every tenant-owned query is filtered by `restaurantId` at the database level via `src/server/db/tenant.ts`. Guessing an id can never read another restaurant's data.
- *One source of truth for pricing* (`features/orders/pricing.ts`), used by both the guest UI and the server so tampered payloads are harmless.

---

## Getting started

### Prerequisites

- Node.js 20+
- PostgreSQL 14+ (Redis optional — used for rate limiting and multi-instance sockets; falls back to in-process otherwise)

### 1. Install & configure

```bash
npm install
cp .env.example .env
# Edit .env: set DATABASE_URL and generate JWT secrets with `openssl rand -base64 48`
```

### 2. Set up the database (schema + seed)

```bash
npm run setup     # prisma generate + db push + seed
```

### 3. Run

```bash
npm run dev       # custom server: Next.js + Socket.IO on http://localhost:3000
```

Open:

- **Guest ordering** — http://localhost:3000/order?r=the-copper-spoon
- **Dashboard** — http://localhost:3000/dashboard
- **Kitchen** — http://localhost:3000/kitchen · **Waiter** — /waiter · **Cashier** — /cashier

### Demo logins (password: `Password123!`)

| Role    | Email                      | Lands on   |
| ------- | -------------------------- | ---------- |
| Owner   | owner@restaurantos.dev     | /dashboard |
| Manager | manager@restaurantos.dev   | /dashboard |
| Kitchen | kitchen@restaurantos.dev   | /kitchen   |
| Cashier | cashier@restaurantos.dev   | /cashier   |
| Waiter  | waiter@restaurantos.dev    | /waiter    |

> **Tip:** open the guest menu in one window and the kitchen display in another, place an order, and watch it appear instantly with a chime.

---

## Docker

Bring up app + PostgreSQL + Redis:

```bash
docker compose up -d --build
docker compose exec app npm run setup   # first run only: generate, push schema, seed
```

App on http://localhost:3000. Set `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` in your shell or a `.env` before `up` for production use.

---

## Scripts

| Command             | What it does                                             |
| ------------------- | ------------------------------------------------------- |
| `npm run dev`       | Dev server (Next + Socket.IO)                           |
| `npm run build`     | Prisma generate + production build                      |
| `npm start`         | Production server                                       |
| `npm run setup`     | generate + db push + seed                               |
| `npm run db:migrate`| Create/apply a dev migration                            |
| `npm run db:seed`   | Seed the demo restaurant                                |
| `npm run db:studio` | Prisma Studio                                           |
| `npm run db:backup` | gzip `pg_dump` into `BACKUP_DIR`, prune old dumps       |
| `npm run typecheck` | `tsc --noEmit`                                          |

---

## API

Self-describing docs at **`/api/docs`** (JSON) or **`/api/docs?format=html`**.

- `GET /api/health` — liveness + dependency status
- `GET /api/public/menu?r={slug}` — fully priced public menu
- `GET /api/public/orders/{orderId}` — guest order status (guest cookie)
- `GET /api/reports/export?type=summary|orders&format=csv|xlsx&range=week` — downloads
- WebSocket at `/socket.io` — see the docs page for the event contract

---

## Configuration notes

- **Cloudinary / SMTP are optional.** Without Cloudinary, image URLs are entered directly. Without SMTP, verification/reset/receipt emails are logged to the console with working links — every flow stays testable locally.
- **Redis is optional.** Absent `REDIS_URL`, rate limiting and caching use an in-process implementation, and the app runs single-instance. Add Redis (and the Socket.IO Redis adapter) to scale horizontally.
- **Multi-tenant routing.** A tenant is resolved from the URL in this order: an explicit slug in the path (`/order/<slug>/<branch>`), then the request host — a **verified custom domain**, then a `<slug>.example.com` subdomain — then the `ros_r` cookie, then, on a single-restaurant deployment, the only active restaurant. The cookie sits *below* the host on purpose: it pins a choice on the shared address and must not override a restaurant's own domain.
- **Custom domains.** A restaurant can be given its own address from `/admin` → the restaurant card → **Set domain**. It stays inert until the platform has fetched `/api/public/whoami` on that host and been told the right restaurant, so a row alone can never aim a hostname at somebody else's menu. Add the domain in Netlify as a domain alias; the shared address keeps working throughout, so printed QR codes never stop.

---

## Tech stack

**Frontend:** Next.js 15, React 19, TypeScript, Tailwind CSS, Radix UI primitives, Framer Motion, TanStack Query, React Hook Form, Zod, Recharts, Sonner.
**Backend:** Next.js App Router + Server Actions, Prisma ORM, PostgreSQL, Socket.IO, `jose` JWT, bcrypt, Nodemailer, ExcelJS, `qrcode`, ioredis.
**Ops:** Docker multi-stage build, docker-compose, PWA service worker, health checks, audit logs, automated backups.

---

Built to be sold to thousands of restaurants: polished, secure, scalable and maintainable.
