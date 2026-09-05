# Deploying RestaurantOS to a ServerByt VPS

Read this once, top to bottom. It takes ~30–45 minutes the first time.

---

## 0. Understand what you're hosting (important!)

RestaurantOS is **one application**, not a separate "frontend" and "backend".
A single Node.js process (`server.mjs`) serves **everything**:

| What | URL (on your domain) |
| ---- | -------------------- |
| Marketing / landing page | `https://yourdomain.com/` |
| Guest QR ordering | `https://yourdomain.com/order?r=<restaurant-slug>` |
| Staff login | `https://yourdomain.com/login` |
| Restaurant dashboard | `https://yourdomain.com/dashboard` |
| Kitchen / Waiter / Cashier | `https://yourdomain.com/kitchen` · `/waiter` · `/cashier` |
| **Your platform admin** (approve sign-ups) | `https://yourdomain.com/admin` |
| REST + WebSocket API | `https://yourdomain.com/api/...` and `/socket.io` |

So you **do not** host the admin page, frontend, and backend separately. You deploy
**one app + one PostgreSQL database**, on **one domain**. That's it.

### What you need from ServerByt

You need a **VPS / Cloud Server plan with root SSH access** (Ubuntu 22.04 or 24.04
recommended). This app runs a long-lived Node server, a database, and WebSockets.

> ⚠️ It **cannot** run on basic shared / cPanel "web hosting" (those only run PHP and
> have no long-running Node process). If your ServerByt plan is shared hosting, upgrade
> to their **VPS / Cloud** plan. If your panel has a "Node.js App" + PostgreSQL option,
> that also works — the steps are the same in spirit.

You also need a **domain name** pointed at the server (Section 2).

---

## 1. Create the server

In the ServerByt dashboard, create a **VPS** with:

- OS: **Ubuntu 24.04 LTS** (or 22.04)
- Size: **2 GB RAM minimum** (2 vCPU / 2–4 GB is comfortable)
- Note the server's **public IP address** (e.g. `203.0.113.10`).

---

## 2. Point your domain at the server

In your domain registrar (or ServerByt DNS, if the domain is there), add:

| Type | Name | Value |
| ---- | ---- | ----- |
| A | `@` | your server IP |
| A | `www` | your server IP |

Wait a few minutes for DNS to propagate. Test: `ping yourdomain.com` should show your IP.

---

## 3. Connect to the server

From your Mac's Terminal:

```bash
ssh root@YOUR_SERVER_IP
```

(Enter the password ServerByt gave you, or use your SSH key.)

---

## 4. Install the software (copy-paste each block)

**Node.js 20 + build tools:**

```bash
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git nginx
node -v      # should print v20.x
```

**PostgreSQL:**

```bash
apt install -y postgresql
systemctl enable --now postgresql
```

**Create the database and user** (pick a strong password and remember it):

```bash
sudo -u postgres psql -c "CREATE USER restaurantos WITH PASSWORD 'YOUR_DB_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE restaurantos OWNER restaurantos;"
```

**PM2** (keeps the app running & auto-starts on reboot):

```bash
npm install -g pm2
```

---

## 5. Get the code onto the server

**Option A — from GitHub** (recommended). Push this project to a GitHub repo first, then:

```bash
cd /root
git clone https://github.com/YOUR_USERNAME/restaurantos.git app
cd app
```

**Option B — upload from your Mac** (no GitHub). Run this on your **Mac**, in the
project folder:

```bash
# from the restaurantos folder on your Mac
rsync -av --exclude node_modules --exclude .next --exclude .env \
  ./ root@YOUR_SERVER_IP:/root/app/
```

Then back on the server: `cd /root/app`

---

## 6. Configure the environment

```bash
cp .env.production.example .env
nano .env
```

Fill in **every** value. The critical ones:

- `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SOCKET_URL` → `https://yourdomain.com`
- `DATABASE_URL` → use the DB password from step 4
- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` → generate each with:
  `openssl rand -base64 48` (run it twice, paste two different values)
- `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` → your login for `/admin`

`NEXT_PUBLIC_APP_URL` **must** start with `https://` in production — the session
cookies take their `Secure` flag from it. With it missing or `http://`, browsers
still store the cookies, but they travel unencrypted.

Session lifetimes are optional and have sensible defaults — leave them out
unless you have a reason:

| Key | Default | What it is |
| --- | --- | --- |
| `ACCESS_TOKEN_TTL` | `15m` | How long a signed access token lives; its cookie lives exactly as long |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Staff session length. Slides forward each day the person uses the app |
| `ADMIN_REFRESH_TOKEN_TTL_HOURS` | `12` | Super-admin session length. Absolute — an admin signs in again every day |
| `REFRESH_ROTATE_AFTER_HOURS` | `24` | How old a refresh token must be before it is swapped for a new one |
| `REFRESH_GRACE_SECONDS` | `30` | How long a just-swapped token still resolves to its successor (two tabs refreshing at once) |

Save: `Ctrl+O`, `Enter`, then `Ctrl+X`.

---

## 7. Build, set up the database, start

```bash
npm ci
npm run setup:prod     # generates client, creates tables, creates YOUR admin account
npm run build          # builds the production app
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup            # run the command it prints, so the app survives reboots
```

The app is now running on `http://127.0.0.1:3000` (not public yet — Nginx does that next).
Check it: `curl -s localhost:3000/api/health` → should say `"healthy"`.

---

## 8. Put it on your domain with Nginx

```bash
cp deploy/nginx.conf.example /etc/nginx/sites-available/restaurantos
nano /etc/nginx/sites-available/restaurantos     # replace yourdomain.com (2 places)
ln -s /etc/nginx/sites-available/restaurantos /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Now `http://yourdomain.com` should load the site.

---

## 9. Add HTTPS (free, automatic)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Follow the prompts (enter your email, agree, choose redirect-to-HTTPS).
Certbot edits Nginx for you and auto-renews. Done — visit **https://yourdomain.com**.

> 🔒 HTTPS is not optional: the app marks login cookies `Secure` on HTTPS, which is
> what makes logins reliable. Always use the `https://` domain.

---

## 10. Open the firewall (if ServerByt's is on)

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

---

## ✅ You're live. Where everything is:

| You want to… | Go to |
| ------------ | ----- |
| **Approve/reject new restaurants** | `https://yourdomain.com/admin` (log in with your SUPER_ADMIN email/password) |
| Let a restaurant owner sign up | Send them to `https://yourdomain.com` → they click **Start free trial** or **Request access** |
| Restaurant staff log in | `https://yourdomain.com/login` |
| A restaurant's guest QR menu | `https://yourdomain.com/order?r=<their-slug>` (each restaurant gets its QR under **Dashboard → QR code**) |
| API reference | `https://yourdomain.com/api/docs?format=html` |

### The real-world flow

1. A restaurant owner opens your site, clicks **Start free trial** → instantly gets 30 days.
   (Or **Request access** → you approve them at `/admin`.)
2. They set up their menu/tables, print their QR poster (**Dashboard → QR code**).
3. Their guests scan it, pick a table, and order. Kitchen/waiter/cashier screens update live.

---

## Day-2 operations

**Deploy an update** (after `git pull` or re-uploading):

```bash
cd /root/app
bash deploy/update.sh
```

**Watch logs:** `pm2 logs restaurantos`
**Restart:** `pm2 restart restaurantos`
**Status:** `pm2 status`

**Automatic daily database backup** — add a cron job:

```bash
crontab -e
# add this line (runs 2am daily):
0 2 * * * cd /root/app && /usr/bin/npm run db:backup >> /root/app/logs/backup.log 2>&1
```

**Uploaded images** live in `/root/app/public/uploads` (unless you set Cloudinary keys,
in which case they go to Cloudinary). Include that folder in your backups if you use disk
storage. Set Cloudinary keys in `.env` to offload images instead.

---

## Notes & optional extras

- **Email** (verification, password reset, receipts): set the `SMTP_*` values in `.env`.
  Without them the app still works — those messages just get written to the log instead of sent.
- **Online card gateway**: the built-in payment flow covers **cash, card (recorded at the
  till), and dynamic UPI/QR** — all fully functional. A fully-automated online card gateway
  (Stripe/Razorpay) is not included; wire your own provider keys if you need card-on-file.
- **Redis**: only needed if you scale to multiple app instances. A single VPS doesn't need it.
- **Scaling**: for very high load, move Postgres to a managed DB, add `REDIS_URL`, and run
  multiple instances behind the Socket.IO Redis adapter.

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| Site won't load | `pm2 status` (is it online?), `nginx -t`, `systemctl status nginx` |
| "Welcome back" but can't log in | You're not on **https** — cookies need HTTPS. Use the `https://` domain and confirm `NEXT_PUBLIC_APP_URL` is `https://…` |
| Database errors | Check `DATABASE_URL` in `.env` matches the password from step 4; `systemctl status postgresql` |
| Realtime not updating | Make sure the Nginx `Upgrade`/`Connection` headers from the example are present |
| 502 Bad Gateway | The app isn't running: `pm2 logs restaurantos` to see why, then `pm2 restart restaurantos` |
