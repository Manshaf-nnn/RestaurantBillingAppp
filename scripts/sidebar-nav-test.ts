/**
 * The sidebar's shortcuts obey the sidebar's own permission filter.
 *
 * ── Why this is a test and not a review note ────────────────────────────────
 *
 * sidebar.md §7 is the load-bearing clause: Favorites and Recent must respect
 * the existing RBAC, and a module must disappear from them the moment its
 * permission is taken away. The obvious way to build that feature is a second
 * list of "pages the user pinned" with its own idea of what a user may see —
 * which is a second permission system, exactly what §7 forbids, and one that
 * goes stale the first time a role is edited.
 *
 * So Favorites and Recent are stored as plain hrefs and resolved through
 * `reachableNavItems` on every render. That makes the whole of §7 a property of
 * one function, and this file is what holds it: every assertion below is about
 * a permission the subject does not hold producing nothing, rather than about
 * the filter being remembered in the right places.
 *
 * The rest pins the details that are easy to get subtly wrong and impossible to
 * notice: longest-prefix path matching (without it every screen is filed under
 * "Dashboard" and every POS visit is recorded as "Cashier"), and a cap that is
 * enforced on the way in rather than on the way out.
 *
 * No database — these are pure functions over the nav registry, so this belongs
 * in the static tier and costs nothing to run.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/sidebar-nav-test.ts
 */
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '../src/lib/rbac'
import {
  MAX_FAVORITES,
  MAX_RECENT,
  NAV_SECTIONS,
  favoriteItems,
  isNavHref,
  navItemForPath,
  reachableNavItems,
  recentItems,
  sanitiseFavorites,
  searchNavItems,
} from '../src/features/dashboard/nav'
import type { UserRole } from '@prisma/client'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const OWNER = { role: 'OWNER' as UserRole }

/** A custom role holding exactly these permissions and nothing else. */
const withOnly = (permissions: Permission[]) => ({
  role: 'MANAGER' as UserRole,
  rolePermissions: permissions as string[],
})

console.log('\n1. Favorites are filtered by permission, not by trust\n')

{
  const pinned = ['/dashboard/inventory', '/cashier/pos', '/dashboard/reports/sales']

  const owner = favoriteItems(OWNER, pinned).map((item) => item.href)
  check('an owner keeps everything they pinned', owner.length === 3, owner.join(', '))

  /*
   * The §7 case, written the way the spec words it: the same saved list, a
   * person without `inventory.view`. Stock must not be in their sidebar, and
   * nothing had to remember to remove it.
   */
  const restricted = withOnly([PERMISSIONS.ORDER_CREATE, PERMISSIONS.REPORT_SALES])
  const theirs = favoriteItems(restricted, pinned).map((item) => item.href)
  check(
    'a revoked permission removes the shortcut',
    !theirs.includes('/dashboard/inventory'),
    theirs.join(', '),
  )
  check(
    'and leaves the ones they still hold',
    theirs.includes('/cashier/pos') && theirs.includes('/dashboard/reports/sales'),
    theirs.join(', '),
  )

  // Held in the stored order, not the registry's. The order IS the feature (§2).
  const reordered = favoriteItems(OWNER, ['/dashboard/reports/sales', '/dashboard/inventory'])
  check(
    'the order somebody arranged is the order they get',
    reordered[0]?.href === '/dashboard/reports/sales',
    reordered.map((i) => i.href).join(' → '),
  )
}

console.log('\n2. Nothing invented can be stored\n')

{
  const junk = sanitiseFavorites(OWNER, ['/dashboard/not-a-page', 'https://example.com', '../../etc'])
  check('an href that is not in the registry is dropped', junk.length === 0, junk.join(', '))

  const deduped = sanitiseFavorites(OWNER, [
    '/dashboard/inventory',
    '/dashboard/inventory',
    '/cashier/pos',
  ])
  check('duplicates collapse to one', deduped.length === 2, deduped.join(', '))
  check('and the first occurrence is the one kept', deduped[0] === '/dashboard/inventory')

  /*
   * Capped on the way IN. Storing twenty and showing twelve looks the same on
   * screen and is not the same thing: the eight nobody can see come back the
   * moment the cap is raised, and until then they are rows the owner arranged
   * and cannot reach.
   */
  const everything = reachableNavItems(OWNER).map((item) => item.href)
  const capped = sanitiseFavorites(OWNER, everything)
  check(
    `the cap is enforced on write (${MAX_FAVORITES})`,
    capped.length === MAX_FAVORITES,
    `${capped.length} stored from ${everything.length} sent`,
  )

  // The refusal is by permission, not by cleverness about the string.
  const cashier = withOnly([PERMISSIONS.PAYMENT_COLLECT])
  const refused = sanitiseFavorites(cashier, ['/dashboard/accounting/ledger'])
  check('a page they may not open is never stored', refused.length === 0, refused.join(', '))

  check('isNavHref knows the registry', isNavHref('/dashboard/inventory'))
  check('isNavHref rejects anything else', !isNavHref('/dashboard/inventory/secret'))
}

console.log('\n3. Recent resolves the same way, with its own cap\n')

{
  const visited = reachableNavItems(OWNER)
    .slice(0, MAX_RECENT + 4)
    .map((item) => item.href)
  const kept = recentItems(OWNER, visited)
  check(`recent keeps ${MAX_RECENT} and no more`, kept.length === MAX_RECENT, `${kept.length}`)

  const mixed = recentItems(withOnly([PERMISSIONS.ORDER_CREATE]), [
    '/dashboard/accounting/ledger',
    '/cashier/pos',
  ])
  check(
    'recent drops what they may not open',
    mixed.length === 1 && mixed[0]?.href === '/cashier/pos',
    mixed.map((i) => i.href).join(', '),
  )
}

console.log('\n4. A pathname is filed under the entry that owns it\n')

{
  /*
   * The bug this prevents, and it is not hypothetical: without the
   * longest-match sort, `reachableNavItems` returns `/dashboard/inventory`
   * first and this resolves to "Stock". Several entries are prefixes of others
   * — Inventory of its four sub-screens, Purchasing of Goods received, Reports
   * of six report pages — so Recent would fill with the same three parent rows
   * whatever anybody actually opened.
   */
  const counts = navItemForPath(OWNER, '/dashboard/inventory/counts')
  check(
    'a deep page matches its own entry, not its parent',
    counts?.href === '/dashboard/inventory/counts',
    String(counts?.href),
  )

  const receive = navItemForPath(OWNER, '/dashboard/purchases/receive')
  check(
    'Goods received is not filed under Purchasing',
    receive?.href === '/dashboard/purchases/receive',
    String(receive?.href),
  )

  /*
   * `exact` is what keeps these two apart, and it is the reason Cashier carries
   * the flag in the registry at all. Drop it and `/cashier/pos` matches both,
   * so every POS visit — the most-used screen in the product — is recorded
   * under whichever the sort happens to reach first.
   */
  const pos = navItemForPath(OWNER, '/cashier/pos')
  check('POS is POS and not Cashier', pos?.href === '/cashier/pos', String(pos?.href))

  // DELIBERATE behaviour change 2026-09 (abc.md §8): the till is a tab inside
  // the POS, so the old URL has no entry of its own — it redirects.
  const cashier = navItemForPath(OWNER, '/cashier')
  check('the old till URL owns no entry — it redirects into the POS', cashier === null, String(cashier?.href))

  // /dashboard is exact, so it must not claim every screen beneath it.
  const dashboardChild = navItemForPath(OWNER, '/dashboard/orders')
  check(
    'an exact entry does not swallow the tree below it',
    dashboardChild?.href === '/dashboard/orders',
    String(dashboardChild?.href),
  )

  const detail = navItemForPath(OWNER, '/dashboard/inventory/ledger')
  check('a child page resolves to the nearest entry', detail?.href === '/dashboard/inventory/ledger')

  check('an unknown path matches nothing', navItemForPath(OWNER, '/dashboard/nowhere') === null)

  // Permission first, as everywhere else: an unreachable page has no entry.
  const blind = navItemForPath(withOnly([PERMISSIONS.PAYMENT_COLLECT]), '/dashboard/inventory')
  check('a page they may not open is not recorded', blind === null, String(blind?.href))
}

console.log('\n5. Page search, and what it refuses to find\n')

{
  // sidebar.md §4's own example: typing "inventory" finds the stock screens,
  // including the ones whose names never say the word.
  const hits = searchNavItems(OWNER, 'inventory').map((hit) => hit.item.label)
  for (const label of ['Stock', 'Stock counts', 'Wastage', 'Stock variance']) {
    check(`"inventory" finds ${label}`, hits.includes(label), hits.join(', '))
  }

  check('search is case-insensitive', searchNavItems(OWNER, 'INVENTORY').length === hits.length)
  check('an empty term finds nothing', searchNavItems(OWNER, '   ').length === 0)

  // Exact label first, then prefix, then the rest — "stock" must offer Stock
  // before Stock ledger, and both before something that matched on its section.
  const stock = searchNavItems(OWNER, 'stock').map((hit) => hit.item.label)
  check('the closest label ranks first', stock[0] === 'Stock', stock.slice(0, 3).join(' → '))

  /*
   * §4's security half. A search that returns a row and answers the click with
   * /forbidden is worse than one that returns nothing: it confirms the screen
   * exists and names it, which is what the permission was hiding.
   */
  const cashier = withOnly([PERMISSIONS.PAYMENT_COLLECT])
  const leaked = searchNavItems(cashier, 'inventory')
  check('search finds nothing they may not open', leaked.length === 0, leaked.map((h) => h.item.label).join(', '))
}

console.log('\n6. The registry itself stays sane\n')

{
  const hrefs = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.href))
  const duplicates = hrefs.filter((href, index) => hrefs.indexOf(href) !== index)
  /*
   * Favorites are keyed by href, so two entries sharing one would make a single
   * star toggle both and a single drag move whichever React picked.
   */
  check('no two nav entries share an href', duplicates.length === 0, duplicates.join(', '))

  // Every preset role can reach something, or `firstReachablePath` sends them
  // nowhere and the sidebar they open is empty.
  const roles = Object.keys(ROLE_PERMISSIONS) as UserRole[]
  const stranded = roles.filter((role) => reachableNavItems({ role }).length === 0)
  check('every preset role reaches at least one page', stranded.length === 0, stranded.join(', '))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
