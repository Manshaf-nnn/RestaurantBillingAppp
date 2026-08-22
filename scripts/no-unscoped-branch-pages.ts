/**
 * Every branch-dependent page must resolve a branch.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Multi-branch support was added one module at a time and the sweep never
 * finished. Nineteen dashboard pages called `selectedBranch()`; about forty did
 * not. The result was a system that told two contradictory stories about the
 * same restaurant — a Branch 01 handover note appearing in Main Branch, while a
 * branch manager's own closed drawers vanished the moment they picked their
 * branch.
 *
 * Fixing those forty was a one-off sweep, and a one-off sweep decays: the next
 * page somebody adds will be written the way the old ones were. This check is
 * the part that does not decay. A new page is either scoped, or it is named
 * here with a reason.
 *
 * ── What it actually checks ─────────────────────────────────────────────────
 *
 * That the page CALLS `selectedBranch()` — not that the answer is then used
 * correctly in every query on it. That second half is not statically decidable,
 * and pretending otherwise would be worse than not claiming it: the real
 * coverage for "does the filter work" is `branch-isolation-test`, which asks
 * the questions from the outside. What this stops is the specific, common,
 * silent failure of a page that never asks which branch it is showing.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/no-unscoped-branch-pages.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pages that are legitimately business-wide.
 *
 * Every entry is a decision, not an omission, and each one says why. The rule
 * for being on this list: the page shows either master data shared across the
 * whole business, or something with no location dimension at all.
 */
const GROUP_WIDE: Record<string, string> = {
  // ── Master data. Shared on purpose; the branch dimension lives on the
  //    per-branch join rows (FoodBranch, InventoryStock), not on these.
  'dashboard/suppliers': 'One supplier list for the business — purchasing depends on it',
  'dashboard/suppliers/[supplierId]': 'As above; a supplier belongs to the restaurant',
  'dashboard/customers': 'A guest belongs to the restaurant, not to a site',
  'dashboard/customers/[customerId]': 'Profile is group-level; its ORDER list is scoped in the query',
  'dashboard/customers/analytics': 'Customer behaviour across the whole business',
  'dashboard/loyalty': 'One loyalty scheme for the business',
  'dashboard/coupons': 'A promotion can be group-wide; branchId is nullable and means "everywhere"',
  'dashboard/recipes': 'A recipe is how a dish is made, the same everywhere',
  'dashboard/recipes/[foodId]': 'As above',
  'dashboard/menu/import': 'Bulk import into the shared catalogue',
  'dashboard/inventory/setup': 'Units and stock categories are shared definitions',

  // ── Settings and administration. About the business itself.
  'dashboard/settings': 'Restaurant-level settings',
  'dashboard/settings/profile': 'The signed-in user’s own account',
  'dashboard/links': 'Share links for the restaurant',
  'dashboard/help': 'Static guidance',
  'dashboard/locations': 'The list of locations — narrowed by visibleBranchIds, not by a selection',
  'dashboard/locations/[branchId]': 'IS one location; guarded by canAccessBranch on the id in the URL',
  'dashboard/staff': 'Narrowed by visibleBranchIds — the roster is a permission question, not a filter',
  'dashboard/staff/codes': 'As above',

  // ── Reads that carry the branch on the record instead of in a selection.
  'dashboard/orders/[orderId]': 'One order; its own branch is checked with canAccessBranch',
  'dashboard/transfers/[transferId]': 'Guarded by assertTransferSide on the transfer’s two ends',
  'dashboard/transfers/new': 'The form picks both ends explicitly',
  'dashboard/purchases/[purchaseId]': 'One order; its own branch is checked',
  'dashboard/purchases/[purchaseId]/edit': 'As above',
  'dashboard/purchases/[purchaseId]/receipts/[receiptId]': 'As above',
  'dashboard/purchases/new': 'The form picks the destination explicitly',
  'dashboard/production/[orderId]': 'One run; its own branch is checked',
  'dashboard/inventory/[itemId]': 'One item; its history is scoped by visibleBranchIds in the query',
  'dashboard/inventory/counts/[countId]': 'One count; its own branch is checked',

  // ── Genuinely group-level views.
  'dashboard/reports': 'Scoped — see the selectedBranch call; listed only because it also has a range',
  'dashboard/audit-logs': 'The audit trail spans the business; AuditLog.branchId is nullable by design',
  'dashboard/reviews': 'Reviews are about the restaurant',
  'dashboard/feedback': 'Feedback is about the product',
  'dashboard/qr': 'Renders a sheet per branch — filtered by visibleBranchIds, not by one selection',
  'dashboard/reservations': 'Reservation has no branch column; would need a schema change to scope',

  // ── The guest side. These are the pages a QR code opens, so the branch is
  //    the whole point — only three are legitimately without one.
  'order': 'IS the branch chooser — the one page that must not assume a branch',
  'order/cart': 'Legacy redirect to the canonical /order/<slug>/<branch>/cart',
  'order/track/[orderId]': 'One order; authorised by the guest session cookie, not by branch',
  'order/bill/[orderId]': 'As above',
}

const ROOT = 'src/app'

/** Every page.tsx under a directory, as a route-ish key. */
function pages(dir: string, prefix = ''): Array<{ key: string; file: string }> {
  const found: Array<{ key: string; file: string }> = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // Route groups — (console) — are not part of the path.
      const next = entry.startsWith('(') ? prefix : prefix ? `${prefix}/${entry}` : entry
      found.push(...pages(full, next))
    } else if (entry === 'page.tsx') {
      found.push({ key: prefix, file: full })
    }
  }
  return found
}

function main() {
  /*
   * The guest tree is included deliberately.
   *
   * `/order` is where the QR lands, and it was outside this check while being
   * the flow the branch model exists for — `/order/menu` could have lost its
   * branch resolution and nothing would have noticed. It is a small tree and
   * every page in it either resolves a branch or is named above.
   */
  const all = [
    ...pages(join(ROOT, 'dashboard'), 'dashboard'),
    ...pages(join(ROOT, 'order'), 'order'),
  ]

  const unscoped: string[] = []
  const stale: string[] = []
  let scoped = 0

  for (const { key, file } of all) {
    const src = readFileSync(file, 'utf8')
    // Two helpers, one question: staff pages ask `selectedBranch`, guest pages
    // ask `resolvePublicBranch`. Either counts as having resolved a branch.
    const resolves = src.includes('selectedBranch(') || src.includes('resolvePublicBranch(')

    if (resolves) {
      scoped += 1
      continue
    }
    if (key in GROUP_WIDE) continue
    unscoped.push(`  ${file}\n    route: ${key}`)
  }

  // An exemption that is no longer needed is a comment that has stopped being
  // true, so it is reported too.
  for (const key of Object.keys(GROUP_WIDE)) {
    const match = all.find((p) => p.key === key)
    if (!match) stale.push(`  ${key} — no such page any more`)
    else if (
      readFileSync(match.file, 'utf8').includes('selectedBranch(') ||
      readFileSync(match.file, 'utf8').includes('resolvePublicBranch(')
    ) {
      // Scoped AND exempt is fine for a page like /dashboard/reports that was
      // listed for another reason, so this is not an error — only reported when
      // the note does not say so.
      if (!GROUP_WIDE[key].startsWith('Scoped')) {
        stale.push(`  ${key} — now calls selectedBranch(); drop the exemption`)
      }
    }
  }

  console.log(`pages checked:        ${all.length}`)
  console.log(`branch-scoped:        ${scoped}`)
  console.log(`business-wide:        ${Object.keys(GROUP_WIDE).length}`)

  if (stale.length > 0) {
    console.log('\nExemptions that no longer match the code:')
    console.log(stale.join('\n'))
  }

  if (unscoped.length > 0) {
    console.error(`\n✖ ${unscoped.length} page(s) show branch data without resolving a branch:\n`)
    console.error(unscoped.join('\n\n'))
    console.error(
      '\nResolve a branch — `selectedBranch(user, searchParams)` on the staff side,\n' +
      '`resolvePublicBranch(restaurantId, code)` on the guest side — and pass it\n' +
      'into the queries. Or, if the page really is business-wide, add it to GROUP_WIDE\n' +
      `in ${__filename.split('/').pop()} with the reason.`,
    )
    process.exit(1)
  }

  if (stale.length > 0) {
    console.error('\n✖ stale exemptions — fix the list above')
    process.exit(1)
  }

  console.log('\n✓ every branch-dependent page resolves a branch')
}

main()
