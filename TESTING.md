# Testing

How this codebase is verified, and the rules that keep the suite honest.

## The three tiers

`npm run verify` runs `scripts/verify-all.ts`:

- **static** — grep-level guards for bug classes that type-check cleanly and
  fail at runtime: `'use server'` exports, function props crossing the RSC
  boundary, unguarded action calls, unscoped branch pages, pages whose
  permission disagrees with their feature registration. Plus
  `billing-math-test`, which is pure arithmetic and needs no database.
- **service** — fifty-odd suites against a real local Postgres, calling the
  service layer directly: the phase suites, the domain suites
  (`payment-model-test`, `inventory-truth-test`, `structural-test`,
  `hardening-test`, `report-agreement-test`, `e2e-reconciliation-test`, …).
- **runtime** — pages and Server Actions over real HTTP against a built
  server (`next build && next start`), driving action ids harvested from the
  client bundle with real cookies. These are the checks that caught what
  everything else missed.

**The runtime tier is mandatory.** A verify run that skips it exits non-zero.
`SKIP_RUNTIME=1` waives that for quick service-tier iteration and says so in
the output — it is never a sign-off run.

```
npm run verify                      # fails if no server is up (deliberately)
npx next build && npx next start -p 3210 &
BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/verify-all.ts
```

## House rules for tests

- **Output contract**: every suite prints `N passed, M failed` and exits
  non-zero on failure; `verify-all` parses exactly that.
- **Failing-before**: a regression test for a bug must fail against the code
  before the fix. A test that cannot fail is worse than no test, because it
  reads as coverage.
- **Deliberate pin changes are labelled.** When behaviour changes on purpose,
  the old pin is updated — never deleted — with a `DELIBERATE behaviour
  change <date>` comment explaining both the old rule and why the new one is
  right (see the walk-in pin in `live-board-test.ts`, the transfer added to
  `recipe-costing-test.ts`).
- **Fixtures are self-contained**: each suite creates its own restaurant with
  a timestamp slug and deletes it at the end. Nothing depends on seed state
  except the suites that exist to verify the seed.
- **Tests post honest data.** A test that writes rows production code could
  never write (a SALE with no order, a balance with no movement) will be
  flagged by the integrity checker like any other corruption — this happened,
  and the tests were fixed, not the checker.
- **Races are tested as races**: concurrent settlements, concurrent counter
  draws, two orders spending the same loyalty points — with `Promise.all`,
  not by hoping the lock comment is right.

## The proof suites (spec §101–102, §122–125)

- `e2e-reconciliation-test` — the spec's worked example end to end: purchase
  → recipe sale → wastage, every figure explained by ledger, item, profit
  report and reconciliation ladder, purchases ≠ COGS.
- `report-agreement-test` — one seeded day of trade (tip, coupon, partial
  refund, cancellation); dashboard, reports hub and sales report must answer
  with the same number, and no revenue figure may move by the tip.
- `billing-math-test` — `computeTotals` across its full matrix (96
  combinations) plus the clamping, rounding and tip rules.
- `hardening-test` — breaks the books on purpose and requires the §115
  integrity checker to notice, then fixes them and requires OK.

## Writing a new suite

Copy the shape of an existing one (`payment-model-test.ts` is a good
template): `check()`/`refuses()` helpers, a stamped fixture restaurant,
sections with narrated headings, cleanup, the output contract. Register it in
`verify-all.ts` under the right tier with a one-line comment saying what it
pins. If it needs a served page or a real Server Action payload, it belongs
in the runtime tier — service-level calls cannot see what the seam between
button and service does.
