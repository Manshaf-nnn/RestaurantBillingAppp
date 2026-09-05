# Authentication sessions — how they work, and the fix behind them

*Written 2026-09-05 after the `athu.md` audit. This is the reference for how
sign-in state is held; the reasoning is kept because the bug it fixed was
subtle enough to have survived several rounds of "working" tests.*

---

## 1. The problem, and what it actually was

**Reported:** people were signed out far too soon — sometimes minutes after
signing in — with valid credentials and no logout.

**Two obvious explanations were checked and are wrong.** They are recorded so
nobody chases them again:

- *"The cookies have no Max-Age, so they die when the browser closes."* False.
  Every auth cookie always went through `cookieOptions(maxAge)`.
- *"Server Actions never refresh the session, so any click after 15 minutes
  fails."* False. `resolveUser → renewFromRefreshToken` already renewed the
  access token from the refresh cookie during actions and renders.

**The root cause was a race in refresh-token rotation.** Four facts combined:

| | Where it was | What it did |
| --- | --- | --- |
| 1 | `jwt.ts` | The access JWT lived **15 min**; its cookie lived **60 min**. For 45 of every 60 minutes the browser presented a cookie whose token was already dead. |
| 2 | `middleware.ts` | Every protected navigation with a dead JWT and a refresh cookie was redirected to `/api/auth/refresh`. Nothing excluded Next's own prefetches; `AutoRefresh` re-fetched 41 screens every 7 s. Concurrent hits were routine, not rare. |
| 3 | `session.ts rotateSession` | Every refresh **rotated** the token: revoked the old row, wrote a new one. No compare-and-swap, no grace window, no record of *what replaced what*. A token rotated 200 ms ago was indistinguishable from a stolen one. |
| 4 | `api/auth/refresh/route.ts` | When rotation returned null it **deleted the refresh cookie** and sent the user to `/login`. |

Put together: a till and a kitchen screen (a POS always has two tabs) both
refresh with the same token. Tab A rotates and receives the new cookie. Tab B
arrives a moment later with the old token, finds it revoked, gets null — **and
deletes the refresh cookie the winner had just set** (same name, one jar). A
perfectly live session is orphaned in the database and the user is at the login
screen. The code even named the race in a comment, and then did not handle it.

Secondary findings fixed alongside, in order of impact:

- Editing a restaurant's **feature flags revoked every session in the tenant**
  (`feature-actions.ts`). Permissions are read live per request, so this was
  pure collateral.
- The client decided "session expired" by **regex over an English error
  message** (`/session|sign in|401|unauthor/i`) — in an app with cash-drawer
  sessions and a `/cashier/session` route.
- The **"Remember me" checkbox did nothing.**
- A working, tested TOTP implementation had **zero callers** — there was no
  way to turn MFA on, only a page reporting its coverage.
- `Secure` on cookies derived from `NEXT_PUBLIC_APP_URL`, which the Netlify
  config did not set.
- `GET /logout` destroyed the session with no check on who asked.
- The `sessions` table had **no purge**: ~96 dead rows per active user per day.
- A poller that got a 401 backed off and froze on stale data, silently.

---

## 2. What changed

### The database learns lineage
`Session.replacedById` (nullable, no FK, no index). Set only when a row is
revoked *by rotation*, pointing at its successor. Revoked **with** it = rotated;
revoked **without** it = a real revocation (logout, reset, suspend). Migration
`20260917130000_session_lineage`, one additive column.

### Refresh has a state machine, and a race-safe core
`session.ts` now has a cookie-free core (`lookupRefreshSession`,
`rotateSessionRecord`, `refreshSession`) that the tests call directly, and thin
cookie-writing wrappers with the old names (`rotateSession`,
`renewFromRefreshToken`) so no caller changed.

| Row state | Result |
| --- | --- |
| Live, under 24 h old | **renewed** — new access token only. No DB write, refresh cookie untouched. |
| Live, 24 h or older | **rotated** — successor created and predecessor revoked in one transaction with a compare-and-swap (`updateMany where {id, revokedAt: null}`); losing the swap rolls back the successor. |
| Revoked by rotation ≤ 30 s ago, successor live | **superseded** — the caller is handed the successor's session. The refresh cookie is **never** touched: the winner's `Set-Cookie` owns it. This is the case that used to log people out. |
| Same, but successor also gone (rotated then logged out) | **refused** — one hop, asserted. A chain would let a predecessor outlive a logout. |
| Revoked by rotation > 30 s ago | **refused**, and recorded as `auth.session_reuse_detected`. Observed for one release before it becomes a reason to revoke a lineage. |
| Revoked without lineage · expired · absent · inactive user · wrong scope | **refused** — both cookies cleared. |

Rotation also happens **wherever a cookie can be written**, not only at the
redirect route: `renewFromRefreshToken` writes the access cookie first and only
rotates if that write succeeded (a render cannot write cookies; a route handler
or Server Action can). That is why a kitchen screen that only polls
`/api/pulse` and never navigates still rotates daily and never hits the
absolute expiry mid-service.

### Middleware stops feeding the race
Router fetches — prefetches and soft navigations, identified by the browser's
`Sec-Fetch-Dest: empty` — pass through when a refresh cookie is present; the
render authenticates them read-only and the page guards remain the authority.
Document navigations still take the redirect so a fresh cookie is set at once.
(Next's own markers, `Next-Router-Prefetch` and `?_rsc=`, are stripped before
middleware runs — `next/dist/server/web/adapter.js`. The runtime test caught
that twice; see §5.)

### Client: a code, one deduplicated refresh, one retry
- `callAction` on `UNAUTHORIZED` performs **one** tab-wide deduplicated
  `POST /api/auth/refresh` and retries the action once. Safe by construction:
  `UNAUTHORIZED` means the permission guard refused *before* the handler ran.
  `TRANSPORT_FAILED` is **never** retried — the action may have executed.
- A second refusal returns `code: SESSION_EXPIRED`, and `useAction` routes to
  `/login` or `/admin/login` by path. The regex is gone.
- `usePulse` treats **401 only** as "no session": one silent refresh (at most
  once a minute), then poll again; a second 401 while the tab is visible sends
  the station to sign in instead of freezing on stale tickets.

### Remember me is real
Unchecked → the session row expires in **12 h** and the refresh cookie has no
`Max-Age` (browser-session cookie). Both halves matter: omitting `Max-Age` is
only a hint browsers may ignore when restoring tabs; the 12 h row is the bound.

### Super admin: shorter session, second factor
- Admin refresh lifetime **12 h, absolute** — below the 24 h rotation
  threshold, so an admin session never slides. The operator signs in daily.
- **MFA step-up at sign-in** when the account is enrolled (`mfaEnabledAt`):
  the password is checked, then `{ mfaRequired: true }` comes back with no
  session created; the form shows a code box and resubmits the same
  credentials plus the code. Stateless — no half-signed-in cookie. Wrong codes
  count toward the lockout and rate limit (`mfa`: 5 per 5 min per user).
- **Enrolment surface** on `/admin/security`: QR + manual secret → code →
  recovery codes shown once. Turning it off requires a current code, so a
  stolen live session cannot remove the control.

### Hardening
- `feature-actions.ts` no longer revokes sessions; a static guard
  (`no-collateral-session-revocation`) allow-lists the five files permitted to
  write `revokedAt`.
- `/logout` requires a top-level navigation from this site (Fetch Metadata) and
  destroys both scopes.
- Nightly `sessions-trim` job removes rows revoked or expired more than 7 days
  ago.
- Dead code removed: `signRefreshToken`, `verifyRefreshToken`, `CSRF_COOKIE`.

---

## 3. Session lifetime — the actual numbers

| | Access token | Refresh token / session | Slides? |
| --- | --- | --- | --- |
| Staff, remember me on (default) | 15 min | **30 days** | Yes — rotated once it is a day old, each rotation grants a fresh 30 days |
| Staff, remember me off | 15 min | **12 h**, browser-session cookie | No (12 h < 24 h threshold, so it can never rotate) |
| Super admin | 15 min | **12 h, absolute** | No — daily sign-in by design |
| Guest (QR ordering) | — | unchanged | — |

Refresh happens silently: middleware redirect on a document navigation, or
in-place during a route handler / Server Action. A user with a live refresh
token never sees the login page. A user whose token is expired, revoked, or
whose account was deactivated is refused on the next request and both cookies
are cleared.

---

## 4. Cookie configuration

| Cookie | Holds | HttpOnly | SameSite | Path | Max-Age | Secure |
| --- | --- | --- | --- | --- | --- | --- |
| `ros_at` | staff access JWT | yes | Lax | / | **900 s** (was 3600 — now equals the JWT, so a dead token is never presented) | see below |
| `ros_rt` | staff refresh token (opaque, hashed in DB) | yes | Lax | / | 30 d — or none when remember-me is off | see below |
| `ros_admin_at` | admin access JWT | yes | Lax | / | 900 s | see below |
| `ros_admin_rt` | admin refresh token | yes | Lax | / | **43 200 s** (12 h) | see below |

`Secure` is on when `NEXT_PUBLIC_APP_URL` starts with `https://`, or when it is
unset in production. No `Domain` attribute (host-only — custom tenant domains
depend on it). Nothing is stored in `localStorage`; no token ever reaches
JavaScript.

---

## 5. Tests

Everything below was written to **fail before the fix** and pass after.

**`scripts/session-lifecycle-test.ts`** (service tier, real Postgres) — the
race, run as a race: two concurrent `refreshSession` calls on a day-old token →
neither refused, exactly one *rotated* and one *superseded*, same session, one
live row, predecessor carries `replacedById`. Then: grace replay inside and
outside the 30 s window (with the reuse audit row), logout-inside-grace refused,
rotate-daily threshold (fresh → renewed, no new row; backdated → rotated;
non-persisting caller never rotates), scope lifetimes (30 d / 12 h, admin below
threshold, cross-scope refused, expired refused), transient < threshold
asserted, feature edit leaves the session live, the second-factor gate
(not-enrolled / challenged / bad / ok / recovery once), and the compare-and-swap
under concurrency (one winner, loser's row rolled back).

**`scripts/no-collateral-session-revocation.ts`** (static) — failed on
`feature-actions.ts` before the change; a probe re-adding the revocation is
caught.

**`scripts/session-runtime-test.ts`** (runtime, against the built server with a
cookie jar that follows 307s and applies `Set-Cookie` as a browser would) —
two tabs on one day-old token both stay signed in and no response deletes the
refresh cookie; fresh token renews without re-issuing the refresh cookie;
access cookie `Max-Age=900; HttpOnly; SameSite=Lax; Path=/`; an RSC fetch with
an expired access token is served rather than redirected while a document
navigation still refreshes; a revoked session ends at `/login` with both
cookies cleared; the admin console renews with its own cookies and the admin
refresh cookie is never touched; `<img src=/logout>` signs nobody out while a
real navigation does; `/api/pulse` answers 401 without a session; sign-in
through the real `login` action sets `ros_admin_rt Max-Age=43200`, an enrolled
admin gets `mfaRequired` with no cookie, a wrong code is `MFA_BAD_CODE`, the
right code signs in.

This test is also what caught the middleware twice: the prefetch check passed
in the test runner with Next's own headers and did nothing on the served build,
because Next strips them before middleware. The final check uses the browser's
Fetch Metadata, which Next cannot strip.

**Full run** — `npx tsc --noEmit` clean; `npx next build` clean; three-tier
`verify-all` with `BASE_URL` against the built server:

```
static    12 suites   (incl. no-collateral-session-revocation)
service   71 suites   (incl. session-lifecycle-test 35, mfa-test 20, jobs-test 16,
                       action-transport-test 24, staff-login-test 21)
runtime   10 suites   (incl. session-runtime-test 35, action-e2e-test 20,
                       role-url-refusal-test 12; socket-order-room-test skipped —
                       it needs `node server.mjs`, not `next start`)

2399 passed · 0 failed · 1 suite skipped        2026-09-05, Next 15.5.22
```


---

## 6. Production requirements

Required, as before:

- `NEXT_PUBLIC_APP_URL=https://…` — the cookies' `Secure` flag follows it. In
  `netlify.toml` this must be the real https origin.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — distinct, ≥ 32 characters.
- `DATABASE_URL` — with `pgbouncer=true`; the rotation transaction is two
  statements and runs inside transaction-mode pooling.

Optional, all defaulted (see `.env.example`, `.env.production.example`,
`DEPLOYMENT.md` §6):

| Key | Default |
| --- | --- |
| `ACCESS_TOKEN_TTL` | `15m` |
| `REFRESH_TOKEN_TTL_DAYS` | `30` |
| `ADMIN_REFRESH_TOKEN_TTL_HOURS` | `12` |
| `REFRESH_ROTATE_AFTER_HOURS` | `24` |
| `REFRESH_GRACE_SECONDS` | `30` |

The deploy is transition-safe: existing live rows stay live; rows revoked
before the deploy have no `replacedById` and are refused exactly as before.
Nobody is signed out by shipping this. The migration is additive and runs from
`db:deploy:safe` before `next build`.

---

## 7. What was deliberately not done

- No client-held tokens, no `localStorage`, no `Domain=` on cookies.
- No change to RBAC, tenant or branch guards — the middleware was never the
  authority and still is not; page and action guards are.
- No revocation of a lineage on reuse detection yet — audit only, for one
  release, so the true rate of legitimate late replays is known first.
- Access-link sign-ins (`join-actions.ts`) bypass MFA: the link is its own
  credential. Stated, not hidden.
- Nothing weakened: staff lifetime unchanged, admin **shorter**, rotation still
  happens — daily, not 96 times a day.
