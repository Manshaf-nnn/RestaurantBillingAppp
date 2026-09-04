# Disaster Recovery

What to do when something is broken, written to be read while it is broken.

Each section answers one failure from production.md §16. If you are in an
incident, skip to the heading that matches and come back to the rest later.

---

## Before anything else

**Two numbers to know before you need them.**

| | |
| --- | --- |
| **RPO** — how much data you can lose | **Under a minute**, via Neon's point-in-time recovery, *if* the plan retains history. Check `/admin/backups`; if it says "none", your RPO is "everything since the last manual dump". |
| **RTO** — how long recovery takes | **Application: 2 minutes** (a Netlify rollback). **Database: 15–45 minutes** (a Neon restore, plus verification). |

**Who owns what.** Neon owns backups, PITR and restore. Netlify owns builds,
deploys and rollback. This application owns neither and does not pretend to —
there is no "back up now" button and never should be (production.md §10).

---

## 1. The database fails

**Symptoms.** `/api/health` returns `degraded` with `"database": "error"`; every
page shows an error; `/admin/database` will not load either.

**First: is it the database or the connection to it?**

```bash
curl -s https://<your-site>/api/health | jq
```

`"database": "error"` with the site otherwise up means the app is running and
Postgres is not answering *it*. Check the Neon console — a compute that has
scaled to zero wakes on the next connection, so wait 30 seconds and retry
before doing anything else.

**If Neon reports an incident:** there is nothing to do in this repository.
Post the notice at `/admin/maintenance` so every restaurant sees the same
message, and wait.

**If the database is up and the app cannot reach it:**

1. Check `DATABASE_URL` in the Netlify environment. The pooled host — the one
   containing `-pooler` — is the correct one for serverless.
2. Check connection exhaustion at `/admin/database`. If connections are at the
   ceiling, redeploy to recycle the functions holding them.
3. Rotate the database password only as a last resort: every environment
   pointing at it stops working the moment you do.

**If data is corrupt rather than absent** — see §6 below. Do not restore
first; a restore loses every order taken since the corruption began, and the
corruption may be narrower than that.

---

## 2. Restoring the database

**Neon performs the restore. You direct it.**

1. **Stop writes if you can.** Post the maintenance notice. Trading continues —
   that is deliberate (see `/admin/maintenance`) — so if you need trading
   stopped, disable the site at Netlify.
2. **Find the moment.** You need the timestamp *just before* the damage. The
   error centre (`/admin/errors`) and the audit log (`/admin/audit`) both carry
   timestamps; the audit log is usually where the damaging action is visible.
3. **Restore into a BRANCH first, never over the top.** In the Neon console:
   create a branch from that timestamp. This is non-destructive — the live
   database is untouched, and you now have both.
4. **Verify the branch before you switch to it.** Point a local checkout at the
   branch's connection string and run the integrity checker:

   ```bash
   DATABASE_URL="<branch url>" npx tsx --tsconfig tsconfig.test.json scripts/hardening-test.ts
   ```

   Then look at the actual damaged records. A restore that brings back the same
   corruption is worse than no restore, because it costs you the good data too.
5. **Switch.** Update `DATABASE_URL` in Netlify to the branch endpoint and
   redeploy, or promote the branch in Neon.
6. **Verify the deploy:**

   ```bash
   BASE_URL=https://<your-site> npx tsx --tsconfig tsconfig.test.json scripts/deploy-verify.ts
   ```
7. **Record it.** `/admin/backups` → "Record" the restore test with what you did
   and whether it worked.

**If PITR is not available** (the plan retains no history), the only source is a
`scripts/backup.ts` dump, restored with `psql`. Everything since that dump is
gone. This is the situation the Backups page warns about when it shows
retention as "none".

---

## 3. The application fails

**Symptoms.** The site 500s, or shows a build error, while `/api/health`'s
database check is fine — or the site does not answer at all.

**Roll back first. Diagnose second.** A rollback takes about two minutes and
costs nothing; diagnosing a live outage costs the whole service.

1. Netlify → Deploys → the last known-good deploy → **Publish deploy**.
2. Verify: `BASE_URL=... npx tsx --tsconfig tsconfig.test.json scripts/deploy-verify.ts`
3. Then find out what happened, in `/admin/errors` — Server Action failures are
   recorded there now, with the operation, the restaurant and a request id.

**The one thing a rollback does NOT undo: migrations.** See §4.

---

## 4. A deployment fails

**A failed build has changed nothing.** Netlify keeps serving the previous
deploy. Read the build log, fix, push again.

**A deploy that succeeded and broke the site** — roll back as in §3.

**A migration applied and the code rolled back.** This is the case that needs
thought, and the reason it is survivable here is a property worth stating: **no
migration in this repository's history drops or truncates anything.** It is
enforced, not hoped for — `scripts/migration-safety-test.ts` fails the build on
a `DROP COLUMN`, a `TRUNCATE`, a `NOT NULL` without a default, or a blind
unique index.

So a migration is always *additive*, which means:

- Old code runs fine against a newer schema — it ignores columns it does not
  know about.
- **Roll the code back, leave the migration.** Then fix forward.
- Never hand-revert a migration on a live database. Write a new one.

**A migration that failed halfway.** `scripts/deploy-db.mjs` handles the known
resolvable cases and refuses to guess at the rest. If it aborts, it says why.
`npx prisma migrate status` shows what applied; `/admin/database` names any
migration stuck without a `finished_at`.

---

## 5. Realtime or the queue fails

**Realtime is not on the critical path, by design.**

An event is written into `outbox_events` *inside the same transaction* as the
order, payment or stock movement it describes. They commit together or roll
back together, so **a realtime failure cannot lose an order** — the worst case
is a screen that updates late.

- Check `/admin/realtime`. A large "newest event" age on a busy platform means
  screens are not being told about things that happened.
- Screens also poll `/api/pulse` for a change token derived from
  `MAX(updatedAt)`, which cannot miss a change. If events stop entirely, screens
  still refresh; they just refresh without knowing what changed.
- **Recovery is automatic.** A reconnecting client asks for events since its
  cursor and catches up. There is nothing to replay by hand.

**The job queue.**

- `/admin/jobs` shows queued, running, completed and failed.
- A failed job retries with backoff and then stops, and is **never** swept away
  — that is what the page is for.
- "Run due jobs now" drains the queue immediately, which is also the way to test
  whether a fix worked.
- If nothing is running at all, the scheduler is the suspect: check `JOBS_SECRET`
  is set (the endpoint refuses everything without it) and look at the Netlify
  scheduled-function logs.

---

## 6. A major data integrity problem

**This is the one where speed is the enemy.** A restore loses every order taken
since the damage; the damage is often narrower than that, and correcting it in
place keeps the trading in between.

1. **Find out what is actually wrong.** `/admin/errors` filtered to CRITICAL —
   the nightly integrity job files its findings there. Or run the checker
   directly against the tenant.
2. **Understand the shape.** `runIntegrityChecks` names the failing check and up
   to five offending ids. `order-line-sum` failing on three orders is not the
   same emergency as `stock-replay` failing across an entire item ledger.
3. **Prefer a correcting entry to an edit.** This system is built so that
   correction is possible without rewriting history — reversal movements, refund
   rows, adjustment movements — and the database now refuses the alternative:
   audit rows and refunds cannot be updated at all, ledger facts on a stock
   movement cannot change, and a settled payment's amount is frozen.
4. **If the correction needs a sealed period reopened**, do it explicitly at
   Accounting → Periods, make the correction, and close it again. The reopen is
   audited.
5. **Only then consider a restore**, and only per §2, into a branch you verify
   first.

---

## 7. Losing the platform admin account

If MFA is enrolled and the phone is lost, use one of the ten recovery codes
issued at enrolment. If those are gone too, the account can be re-seeded from a
deploy environment that holds the credentials:

```bash
SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='<a strong one>' \
  npx tsx prisma/seed-production.ts
```

This is idempotent and resets only the password, and only when one is supplied.

---

## Incident checklist

Print this. It is the part you will not remember.

1. **Say what you know.** Post at `/admin/maintenance`. A stale silence costs
   more trust than a partial answer.
2. **Restore service before you understand it.** Roll back the app; do not
   debug live.
3. **Do not restore the database reflexively.** §6 first.
4. **Write down the timestamp** of when it started, before the evidence rolls
   out of retention.
5. **Afterwards:** record a restore test if you did one, resolve the errors in
   `/admin/errors` with what you did, and add what you learned here.

---

## What must be rehearsed

None of the above is real until it has been done once on a quiet Tuesday.

| Rehearsal | How often | Recorded where |
| --- | --- | --- |
| Restore a Neon branch from a past timestamp and run the integrity checker against it | Quarterly | `/admin/backups` → Record |
| Roll back a Netlify deploy and run `deploy-verify` | Quarterly | This file's history |
| Break something on staging and follow §6 | Twice a year | — |

A backup nobody has restored is a belief, not a backup. `/admin/backups` shows
"never" in red until somebody has proved otherwise, and that is deliberate.
