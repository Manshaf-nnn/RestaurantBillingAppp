# TableFlow — deployment handover (OVH)

Everything you need to host this. Follow it top to bottom; it assumes you know
Linux and Docker, and explains only what is specific to this system.

**Read §1 before provisioning anything.** One decision there shapes the rest.

---

## 1. What you are hosting

A **multi-tenant restaurant POS** — one deployment serves every restaurant.
Guests order from a QR code, the kitchen sees tickets, the till takes payment,
stock comes off the shelf as food sells, and the accounts add up at month end.

| | |
|---|---|
| Framework | Next.js 15.5, App Router, React 19, TypeScript |
| Server | **Custom Node server** (`server.mjs`) — Next + Socket.IO |
| Database | PostgreSQL via Prisma 6 — **91 models** |
| Auth | Custom JWT (jose + bcryptjs), own session rotation |
| Realtime | Socket.IO — kitchen and floor screens |
| Size | 529 source files, ~115,000 lines, 82 test suites |

### The three things that constrain hosting

1. **It needs one always-on Node process.** Not serverless. Socket.IO holds
   open connections; that is why it is leaving Netlify.
2. **It needs PostgreSQL** — not MySQL.
3. **The build wants ~2–4 GB RAM.** Serving needs far less.

### The database is NOT on this server

**All data lives in Neon**, a managed Postgres service, and stays there. This
box runs code only.

That is deliberate and it is what makes your job safe: a bad deploy is a
rebuilt container, not a lost restaurant. There is **no database dump to
restore and no data migration to perform**. You will be given a connection
string; the app connects out to it.

There is also **no persistent storage on this box**. Menu photos are bytes in
the database, not files on disk. The container is disposable — nothing to back
up here, no volume to preserve except Caddy's certificates.

---

## 2. Server sizing

| | Minimum | Comfortable |
|---|---|---|
| RAM | 2 GB **+ 2 GB swap** | 4 GB |
| vCPU | 2 | 2–4 |
| Disk | 20 GB | 40 GB |
| OS | Ubuntu 22.04 or 24.04 LTS | same |

**Region matters more than specs.** The users are in Sri Lanka and the database
is in Neon. Put this box in the region **closest to the Neon project** — ask
Manshaf which region that is before you provision. An app in Europe talking to
a database in Singapore will feel broken no matter how fast the CPU is.

On a 2 GB box, **add swap before the first build** or `next build` will be
killed by the OOM reaper:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 3. Prepare the server

```bash
# As root, first login
adduser deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # keep your key

# Lock the front door
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443
sudo ufw enable
sudo apt update && sudo apt install -y fail2ban
```

Then disable password logins in `/etc/ssh/sshd_config`
(`PasswordAuthentication no`, `PermitRootLogin no`) and
`sudo systemctl restart ssh`.

Install Docker:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy    # log out and back in
```

---

## 4. Get the code and configure it

```bash
git clone git@github.com:Manshaf-nnn/RestaurantBillingAppp.git
cd RestaurantBillingAppp/deploy/ovh
cp .env.example .env
nano .env          # fill in every SECRET — Manshaf supplies them
```

Read the comments in `.env.example`; each one explains what breaks if the value
is wrong. Three that catch people:

- **`DATABASE_URL` must be the POOLED Neon string** — the host contains
  `-pooler`. The app refuses the direct host in production, because unpooled
  connections exhaust Neon's limit.
- **`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` must be COPIED from the current
  host**, not generated. New ones sign every user out.
- **`NEXT_PUBLIC_APP_URL` must be the domain people type, with `https://`.**
  The Secure cookie flag and every absolute link come from it. Get it wrong and
  logins fail in a way that looks like an auth bug.

Set your own address in `deploy/ovh/Caddyfile` (the `email` line) so Let's
Encrypt can reach you about expiring certificates.

---

## 5. Deploy

```bash
cd ~/RestaurantBillingAppp/deploy/ovh
docker compose up -d --build      # first build: 5–15 minutes
docker compose logs -f app
```

Then bring the database schema up to date:

```bash
docker compose exec app npm run db:deploy:safe
docker compose exec app npm run db:seed:prod
```

**`db:deploy:safe` is the only correct way to touch the schema.** It handles
all three states a database can be in — empty, has migration history, or has
tables with no history — and is safe to re-run. Right now it will find Neon
already up to date and do nothing. That is the expected outcome, not a skip.

> **Never run `prisma db push` or `prisma migrate dev` against Neon.** `db push`
> applies a schema without recording migration history, which makes every later
> deploy abort. There is no undo.

Check it is alive:

```bash
curl -s localhost:3000/api/health | head -c 300
```

Expect `"status":"healthy"` and `"database":"ok"`, plus the commit it is
running.

---

## 6. DNS and certificates

Two records at the DNS host for `markui.lk`, both pointing at this server's IP:

| Type | Name | Value |
|---|---|---|
| `A` | `tableflow` | your OVH IP |
| `A` | `*` (wildcard) | your OVH IP |

The wildcard is what lets you hand a restaurant `copperspoon.markui.lk` without
touching DNS again.

**Certificates are automatic and you do not manage them.** Caddy requests one
per hostname on first use — including for restaurant domains that did not exist
when you deployed. It asks the app first, at
`/api/public/domain-allowed`, whether the hostname is one we serve, so pointing
a stranger's DNS record at this IP gets refused rather than served.

Nothing to renew, nothing in cron. Keep the `caddy_data` volume and the
certificates survive rebuilds.

---

## 7. How restaurants get their own address

Three tiers, all already built into the app:

| Tier | Looks like | Setup |
|---|---|---|
| Path | `tableflow.markui.lk/order/copper-spoon/main` | none — works today |
| **Subdomain** | `copperspoon.markui.lk` | **set it in /admin, done** |
| Own domain | `menu.copperspoon.lk` | restaurant adds a CNAME to us |

For the last two: in `/admin`, set the restaurant's custom domain, then press
**Verify**. Verification fetches `https://<domain>/api/public/whoami` and checks
it answers with the right restaurant — so it proves DNS, TLS, routing and
tenant lookup all work before the domain is trusted. Until verified, the app
refuses to resolve it.

**One rule:** custom domains serve the **guest ordering surface only**. Staff
always sign in at `tableflow.markui.lk`. Session cookies are per-domain, so
spreading logins across tenant domains breaks sessions in confusing ways.

---

## 8. Day-to-day

```bash
# Deploy a new version
git pull && docker compose up -d --build
docker compose exec app npm run db:deploy:safe    # if migrations were added

# Watch
docker compose logs -f app
docker compose ps

# Roll back
git checkout <previous-commit> && docker compose up -d --build
```

Rolling back code is safe on its own. **Rolling back across a migration is
not** — if a deploy added one, restore the database from Neon's
point-in-time recovery rather than guessing.

**Backups:** Neon handles them, and `/admin/backups` shows the recovery window
when `NEON_API_KEY` is set. Nothing on this box needs backing up.

**The jobs container** calls `/api/jobs/run` every 15 minutes for integrity
sweeps and retention trimming. If it stops, those stop silently — check
`docker compose logs jobs` occasionally, and `/admin` shows job history.

---

## 9. Verify the deployment

- [ ] `https://tableflow.markui.lk/api/health` → healthy, database ok
- [ ] Sign in as owner; the existing data is all there
- [ ] Place an order on the POS → it appears on the kitchen screen
      **without a refresh** (this proves Socket.IO is working — it could not on
      the old host)
- [ ] Take a payment; the cashier totals move
- [ ] Accounting → Ledger → Trial balance says **Balanced: Yes**
- [ ] An export downloads
- [ ] `docker compose logs jobs` shows a call every 15 minutes
- [ ] Browser console (F12) is free of red errors

---

## 10. Things that will confuse you if nobody says them

**Realtime turns itself on here.** The old host set
`NEXT_PUBLIC_REALTIME_DISABLED=true` because it could not run a socket server.
This box can, so the variable is absent and live updates are enabled. That is
the upgrade — but it is also new behaviour. If the kitchen or live-floor screens
misbehave, set it to `true` and you are back to polling.

**The admin password re-seeds on every deploy** while `SUPER_ADMIN_PASSWORD` is
set. A password changed by hand reverts next deploy. Expected, not a bug.

**Menu photos come out of the database**, served through `/api/media`. If images
are slow, that is bandwidth and database reads, not a disk problem — there is no
disk to look at.

**Two hosts can run at once.** Both talk to the same Neon database, so you can
run this box and the old host side by side and compare, then move DNS when
satisfied. That is the recommended cutover, and it makes rollback a DNS change.

---

## 11. Who to ask

Repository: `Manshaf-nnn/RestaurantBillingAppp` — Manshaf grants access.

Secrets (`DATABASE_URL`, both JWT secrets, `SUPER_ADMIN_*`, `JOBS_SECRET`) come
from Manshaf **through a password manager or one-time secret link**. They are
production credentials for a system holding other businesses' money: not over
chat, not in a screenshot, not committed.

Other documents in the repo worth reading before you start:
`ARCHITECTURE.md`, `RENDER-MIGRATION.md` (the same move to a managed host, with
the reasoning), `TESTING.md`, `SECURITY.md`.
