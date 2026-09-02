# Security

- **AuthN**: JWT access token (1h) + rotating refresh token, httpOnly
  cookies; separate admin session for the platform operator. Guest surfaces
  use an anonymous session cookie — order access requires it to match.
- **AuthZ**: `permissionsFor` = role preset (or saved role REPLACING the
  preset) ∪ per-user grants, intersected with what the platform sold the
  restaurant (`availablePermissions`). Every action calls
  `requirePermission`; every page `requirePagePermission`; static guards fail
  the build when a page's guard disagrees with its feature registration.
- **Tenancy**: `restaurantId` from session only. Branch guards fail closed;
  the five cashier bill actions, all report pages and the error log are
  branch/tenant scoped (the error endpoint attributes captures via the
  *verified* session cookie and shows each owner only their own).
- **Money controls**: maker-checker on stock counts; approval thresholds on
  discounts and refunds (`ApprovalRequest`, self-approval refused); cash
  variance sign-off (`CASH_VARIANCE_REVIEW`); period sealing
  (`ACCOUNTING_CLOSE` — deliberately not held by the read-only accountant
  role); every sensitive mutation writes an `audit_logs` row, price and
  recipe changes with before/after.
- **Rate limits**: Redis where configured, else Postgres fixed-window
  counters shared across serverless instances (per-guest-device keys for
  ordering, per-venue-IP backstops), memory as last resort.
- **No payment processing**: card data never touches the system (§6).
