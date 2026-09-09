# Moving TableFlow from Netlify to Render

Same domain, same database, no downtime, nothing lost. Follow this in order.

---

## The one thing that makes this safe

**Your data is not on Netlify.** Every restaurant, order, payment, staff
account and image byte lives in **Neon**, a separate database service you pay
for separately. Netlify only runs the *code*.

So this is not a data migration at all. It is: stand a second copy of the app
up on Render, point it at the same Neon database, check it works, then move
the domain. At no point is there one copy of anything.

```
                    ┌──────────────┐
   tableflow.       │   Netlify    │──┐
   markui.lk  ──▶   │  (running)   │  │      ┌──────────────────┐
                    └──────────────┘  ├─────▶│  Neon Postgres   │
                    ┌──────────────┐  │      │  ALL YOUR DATA   │
                    │    Render    │──┘      │  (never moves)   │
                    │  (new copy)  │         └──────────────────┘
                    └──────────────┘
```

Both hosts can run against the same database at the same time — they are
stateless. That is what lets you test Render properly *before* touching DNS,
and what makes rollback a one-line DNS change.

---

## What you gain by moving

- **Live updates come back.** Netlify is serverless and cannot run
  `server.mjs`, so realtime was switched off and every screen polls instead
  (`NEXT_PUBLIC_REALTIME_DISABLED = "true"` in `netlify.toml`). Render runs a
  real Node process, so the kitchen screen updates the instant an order is
  placed. Your server already reads `RENDER_EXTERNAL_URL` and `$PORT` — no
  code change needed.
- **One log, one place.** Build, runtime and cron logs together.
- **Predictable cost.** $7/month, flat.

## What it costs

| | |
|---|---|
| Render Web Service — Starter, always on | **$7 / month** |
| Render Cron Job — the 15-minute job runner | included on Starter |
| Neon | **unchanged** — you already pay this |
| **Total new spend** | **$7 / month** |

If a build ever dies with *"JavaScript heap out of memory"*, move the service
to **Standard ($25)** long enough to build, then drop back to Starter. Starter
serves this app comfortably; it is only the build that is memory-hungry.

---

## Step 1 — Take an insurance copy (5 minutes)

You will not need it. Take it anyway.

1. Open the **Neon console** → your project → **Branches** → **New branch**.
2. Name it `before-render-2026-09-09`.

A Neon branch is copy-on-write: it costs almost nothing and is an instant,
complete snapshot of the database as it is right now. If anything ever looks
wrong, that branch still holds today's data exactly.

---

## Step 2 — Copy your settings out of Netlify (10 minutes)

Netlify → your site → **Site configuration → Environment variables**. Reveal
each value and paste it into a scratch file. You need:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | The Neon string. **Must contain `-pooler`** |
| `JWT_ACCESS_SECRET` | Copy exactly — a new one signs everyone out |
| `JWT_REFRESH_SECRET` | Same |
| `SUPER_ADMIN_EMAIL` | Your `/admin` login |
| `SUPER_ADMIN_PASSWORD` | See the warning below |
| `JOBS_SECRET` | The scheduled runner's key |
| `NEXT_PUBLIC_APP_URL` | `https://tableflow.markui.lk` |
| `CLOUDINARY_*` | Only if you set them up |
| `NEON_API_KEY`, `NEON_PROJECT_ID` | Optional — powers `/admin/backups` |
| `REDIS_URL` | Optional — rate limits use Postgres without it |

> **Rotate the Neon password now.** It has been sitting exposed since August
> and you are about to retype the connection string anyway. Neon console →
> **Roles** → reset the password, copy the new pooled string, and use *that*
> everywhere below. Update Netlify's copy too, so the old site keeps working
> during the changeover.

> **About `SUPER_ADMIN_PASSWORD`:** the deploy re-seeds the admin account every
> time it runs. While that variable is set, every deploy resets your `/admin`
> password back to it. That is fine — just know it, and do not wonder later why
> a password you changed by hand reverted.

---

## Step 3 — Create the Render service (15 minutes)

Do this **by hand in the dashboard**, not with the Blueprint button. The
blueprint is fine now, but doing it by hand means you see every setting.

1. Go to **render.com**, sign up, connect your **GitHub**.
2. **New + → Web Service** → pick `Manshaf-nnn/RestaurantBillingAppp`.
3. Fill in:

   | Field | Value |
   |---|---|
   | Name | `tableflow` |
   | Region | **Singapore** (closest to Sri Lanka) |
   | Branch | `main` |
   | Runtime | **Node** |
   | Build command | `npm ci && npx prisma generate && npx next build` |
   | Pre-deploy command | `npm run db:deploy:safe && npm run db:seed:prod` |
   | Start command | `npm start` |
   | Instance type | **Starter — $7/mo** |
   | Health check path | `/api/health` |

4. **Add the environment variables** from Step 2 — *before* the first deploy,
   or the migration step will fail with no database to reach. Add these too:

   - `NODE_ENV` = `production`
   - `NODE_VERSION` = `20`

5. **Leave `NEXT_PUBLIC_APP_URL` out for now.** Unset, the app uses Render's
   own address, so the test site links to itself instead of bouncing you to the
   live one. You will add it at Step 6.

6. Click **Create Web Service** and watch the log. First build takes 5–10
   minutes.

**What the pre-deploy step does:** `db:deploy:safe` applies any migrations that
have not run yet. Right now there are none pending, so it will look at your
Neon database, find it up to date, and do nothing. That is the expected
outcome — it is not skipping anything.

---

## Step 4 — Test Render properly, before any DNS change (20 minutes)

Render gives you an address like `https://tableflow-xxxx.onrender.com`. The
live site is still Netlify and still serving customers. Test hard:

1. **`/api/health`** — expect `"status":"healthy"` and `"database":"ok"`. The
   `build.commit` should match your latest commit on `main`.
2. **Sign in** as the owner. Your existing account works, because it is the
   same database.
3. **Check the data is all there** — orders, menu, staff, suppliers. It should
   look exactly like the live site, because it *is* the live site's data.
4. **Place a test order** on the POS and settle it. Then check it appears on
   the live Netlify site too. Same database, so it will — that is your proof
   the two are genuinely connected to the same place.
5. **Open the kitchen screen** and place an order from another tab. On Render,
   with realtime working, the ticket should appear **without a refresh**.
6. Open the browser console (F12) and confirm no red errors.

Do not continue until this all passes.

---

## Step 5 — Prepare DNS (do this the day before, if you can)

Find where `markui.lk`'s DNS is managed — your domain registrar, or Cloudflare.
Look for the record for `tableflow`.

**Lower its TTL to 300 seconds (5 minutes) and save.** Leave everything else
alone. TTL is how long the world caches the old answer; dropping it first means
the actual switch takes minutes instead of hours. Wait for the old TTL to
elapse (if it was 3600, wait an hour) before Step 6.

---

## Step 6 — Move the domain (15 minutes, then a wait)

1. **In Render:** your service → **Settings → Custom Domains → Add**. Enter
   `tableflow.markui.lk`. Render shows you a target like
   `tableflow-xxxx.onrender.com` and marks the domain *unverified*.

2. **At your DNS provider:** edit the `tableflow` record.
   - It is currently a `CNAME` pointing at Netlify (something like
     `xxx.netlify.app`).
   - **Change the value** to the Render target. Keep it a `CNAME`. Save.
   - If Cloudflare is in front, set the record to **DNS only** (grey cloud)
     until Render has issued its certificate, then turn the orange cloud back on
     if you want it.

3. **Wait.** Render verifies the domain, then issues a TLS certificate
   automatically. Usually 5–20 minutes. The dashboard says *Certificate issued*
   when it is done. Do not skip ahead — HTTPS will fail until it appears.

4. **Now set `NEXT_PUBLIC_APP_URL`** = `https://tableflow.markui.lk` in Render's
   environment variables and let it redeploy. This matters: the Secure flag on
   session cookies and every absolute link are derived from it.

5. Check `https://tableflow.markui.lk/api/health` and sign in.

---

## Step 7 — Stop Netlify deploying (5 minutes)

Do **not** delete the Netlify site yet. Just stop it building, so you are not
running two hosts that both migrate and re-seed on every push:

- Netlify → **Site configuration → Build & deploy → Stop builds**.

Keep the site parked for **a week**. It costs nothing and it is your rollback.

---

## Step 8 — Verify the whole thing (30 minutes)

Work through this on the real domain:

- [ ] Sign in as owner, manager, cashier, waiter — each lands on their own screen
- [ ] Guest QR order → appears in the kitchen → served → paid at the cashier
- [ ] Cash drawer opens and closes, variance review works
- [ ] Accounting → Overview figures match the sales report
- [ ] Accounting → Ledger → Trial balance still says **Balanced: Yes**
- [ ] An export downloads (Excel and CSV)
- [ ] The 15-minute cron ran — check Render's cron log, and `/admin` → Jobs
- [ ] Images load on the menu (they come from the database, so they will)

---

## Rollback, if anything goes wrong

**One change, and you are back on Netlify:**

1. Netlify → **Build & deploy → Start builds** (if you stopped them).
2. At your DNS provider, point the `tableflow` CNAME back at the Netlify target.
3. Wait 5 minutes for the low TTL to expire.

Nothing else moves. The database was never touched, so no data is lost or
rolled back — the old host simply starts answering again.

---

## Step 9 — After a week of quiet

- Delete the Netlify site (or leave it; it is free while idle).
- Delete the `before-render` Neon branch once you are sure.
- Consider **Render Key Value** ($) or Upstash for `REDIS_URL` — rate limits
  currently count in Postgres, which works but adds writes.

---

## Things specific to this app

**Realtime turns itself on.** `NEXT_PUBLIC_REALTIME_DISABLED` was set by
`netlify.toml`, which Render does not read. So on Render it is simply absent
and live updates are enabled. That is the upgrade — but it is also a behaviour
change on day one. If anything misbehaves on the kitchen or live-floor screens,
set `NEXT_PUBLIC_REALTIME_DISABLED` = `true` in Render and you are back to the
polling behaviour you have today.

**Never run `prisma db push` against Neon.** The deploy uses
`npm run db:deploy:safe`, which migrates properly and keeps migration history.
A `db push` would leave the database in a state that makes future deploys
abort.

**The connection string must be the pooled one.** `src/server/db/prisma.ts`
checks for `-pooler` in the host in production and complains otherwise. Neon
gives you both; take the pooled one.

**The scheduled job moved hosts.** `netlify/functions/scheduled-jobs.mts` ran
every 15 minutes and called `/api/jobs/run`. On Render that becomes a **Cron
Job** — `render.yaml` in this repo now declares it, or create it by hand:

- **New + → Cron Job**, same repo, region Singapore, schedule `*/15 * * * *`
- Build command: `true`
- Command:
  ```
  curl -fsS -X POST -H "authorization: Bearer $JOBS_SECRET" \
    -H "content-type: application/json" -d '{"source":"render-cron"}' \
    https://tableflow.markui.lk/api/jobs/run
  ```
- Environment: `JOBS_SECRET`, the same value as the web service

Without it, nightly integrity sweeps and retention trimming stop running —
quietly, which is the worst way for them to stop.

**`render.yaml` no longer creates a database.** It used to declare a Render
Postgres instance. Pointed at your live setup that would have stood up an empty
database beside Neon and served a site with no customers in it. It now asks you
to paste the Neon URL instead.
