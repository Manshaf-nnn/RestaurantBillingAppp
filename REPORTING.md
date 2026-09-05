# Reporting

One definition per number, one resolver per date range, drill-down from every
headline. See ACCOUNTING.md for the revenue/COGS/tip methodology.

## Modules

- `features/reports/range.ts` — `resolveRange`: presets in the restaurant's
  own timezone; granularity derived from the span. The ONLY range resolver.
- `features/reports/sales.ts` — `getSalesReport` (gross/discounts/refunds/
  net, buckets by hour/day/category/item/branch/employee/type) and
  `getPaymentsReport` (method mix from payments, refunds from the refunds
  ledger — partial-refund-aware, drawer variance beside it).
- `features/reports/profit.ts` — line-level COGS from pinned snapshots,
  net-of-reduction revenue, margin rows, and the honesty panel: how much
  revenue is costed vs not.
- `features/reports/reconciliation.ts` — the quantity ladder per item
  (opening + in − out vs stored) and its value ladder (§75).
- `features/analytics/queries.ts` — the dashboard; `getReportSummary`
  composes the report modules and computes nothing of its own.
- `features/insights/*` — the owner's Command Center, menu matrix, stock
  outlook and waste breakdown; composes the engines above. See INSIGHTS.md.
- `features/accounting/` — the daily close snapshot (§51), sealed periods
  (§59), and the §115 integrity checker.

## Guarantees

- §102: dashboard, hub, sales report and exports agree to the minor unit —
  pinned by `scripts/report-agreement-test.ts`.
- Every report page passes `timeZone: restaurant.timezone`; "today" rolls
  over at the restaurant's midnight, not the server's.
- Branch scope follows the switcher everywhere, refunds included, so branch
  pages sum to the group.
- Closed days render their frozen snapshot, not live figures.
- Exports carry the active filters and label money honestly.
