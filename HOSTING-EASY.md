# Get RestaurantOS live — the easy way (mostly clicking, ~10 minutes)

You don't need to be technical for this. We'll use **Render**, which connects to
your GitHub, runs the app, and gives you a database — all from a web page.

> Why not the ServerByt VPS? You can use that too (see `DEPLOYMENT.md`), but it
> needs terminal commands. Render is the "just click" option. Your call.

---

## Before you start

- The code is already on GitHub: **https://github.com/devmarkui/restaurantBillling-**
- Have ready: an **email** and a **password** you want to use to log in as the
  platform admin (the account that approves restaurants).

---

## Step 1 — Make a Render account

1. Go to **https://render.com** → **Get Started** → **Sign in with GitHub**.
2. Approve access so Render can see your `restaurantBillling-` repository.

## Step 2 — Deploy with the Blueprint

1. In Render, click **New +** (top right) → **Blueprint**.
2. Choose your **restaurantBillling-** repository → **Connect**.
3. Render reads the `render.yaml` in the repo and shows a plan: one **web
   service** + one **PostgreSQL database**. Click **Apply**.
4. It will ask you to fill in two values:
   - **SUPER_ADMIN_EMAIL** → the email you'll log in with
   - **SUPER_ADMIN_PASSWORD** → a strong password
   Enter them and continue.
5. Render now builds and deploys (5–10 minutes the first time). Grab a coffee.

## Step 3 — Open your live app

1. When it's done, Render shows your web service with a URL like
   **`https://restaurantos.onrender.com`** (yours may differ slightly).
2. That URL **is your live app**. Everything runs there:

| Link | For |
| ---- | --- |
| `https://YOUR-URL/` | The public website (Free trial / Request access) |
| `https://YOUR-URL/admin` | **You** — approve/reject restaurant sign-ups |
| `https://YOUR-URL/login` | Restaurant staff login |
| `https://YOUR-URL/order?r=<slug>` | A restaurant's guest QR menu |

3. Go to **`https://YOUR-URL/admin`** and sign in with the admin email + password
   from Step 2. You're live. 🎉

---

## Step 4 (optional) — Use your own domain

1. In Render → your web service → **Settings → Custom Domains → Add**.
2. Type your domain (e.g. `app.yourrestaurant.com`).
3. Render shows a DNS record to add at your domain registrar (or ServerByt DNS).
   Add it. Render adds HTTPS automatically.
4. Done — your app now also answers on your own domain.

---

## Money & notes

- **Cost:** roughly **$7/month** for the always-on web service + **$7/month** for
  the database on the starter plans in `render.yaml`. You can switch either to
  **Free** in the Render dashboard to trial it — but the free web service *sleeps*
  after 15 minutes of no traffic (the first request then takes ~50s to wake), which
  isn't good for a real restaurant. Keep it on **starter** for live use.
- **Email** (order receipts, password resets): optional. Add `SMTP_*` variables in
  Render → your service → **Environment** to turn on real emails. Without them the
  app still works; those messages just aren't sent.
- **Images:** uploads are stored on the server. On Render's disk this resets on
  redeploy, so for permanent images add free **Cloudinary** keys (`CLOUDINARY_*`)
  in the Environment tab — then uploads go to Cloudinary and stay forever.
- **Updates:** because `autoDeploy` is on, every time new code is pushed to the
  `main` branch on GitHub, Render rebuilds and redeploys automatically.

---

## If something goes wrong

- In Render, open your web service → **Logs** to see what happened.
- Most common: the database wasn't ready on the very first build. Just click
  **Manual Deploy → Deploy latest commit** to run it again.
- Still stuck? Send me the last ~30 lines of the Logs and I'll tell you the fix.
