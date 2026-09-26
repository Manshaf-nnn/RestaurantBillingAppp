/**
 * Create Role reads the sidebar, and a tab carries what it requires.
 *
 * ── What is being held ──────────────────────────────────────────────────────
 *
 * The simple Create Role dialog offers exactly the sidebar's entries — all of
 * them, always — and "Based on" only decides which start ticked. A tab that
 * needs another (POS needs Payment details) ticks it and locks it, and the
 * server closes a saved list over the same declarations so the state cannot
 * be stored however the request was made. All of that is arithmetic in
 * `sidebar-access.ts`, shared by the dialog, the action and this file.
 *
 * The property that matters most on the day this ships is the last one in
 * §2: closing every built-in role over its dependencies changes nothing.
 * Every dependency declared is one the presets already satisfied, so no
 * existing account gains a tab.
 *
 * No database — pure functions over the nav registry, so this is static.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/sidebar-access-test.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { UserRole } from '@prisma/client'

import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  assignableRoles,
  seesAllLocations,
  type Permission,
} from '../src/lib/rbac'
import { NAV_SECTIONS, isNavHref, visibleSections } from '../src/features/dashboard/nav'
import { posTabsFor } from '../src/features/cashier/pos-tabs'
import {
  SIDEBAR_MODULES,
  accessTwin,
  closeSelection,
  inferPreset,
  modulesShownBy,
  permissionsForSelection,
  requiredBy,
  requiredHrefs,
  sidebarModule,
  withRequiredPermissions,
} from '../src/features/access/sidebar-access'

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

const same = (a: Iterable<string>, b: Iterable<string>) => {
  const x = new Set(a)
  const y = new Set(b)
  return x.size === y.size && [...x].every((v) => y.has(v))
}
const diff = (a: Iterable<string>, b: Iterable<string>) => {
  const y = new Set(b)
  return [...new Set(a)].filter((v) => !y.has(v))
}

/**
 * What `middleware.ts` asks before any page runs. Duplicated on purpose, as
 * `role-assignment-test.ts` does: the real table is an edge module and this
 * keeps asserting the rule that was agreed.
 */
const ROLE_ALLOWED: Record<string, string[]> = {
  '/kitchen': ['OWNER', 'MANAGER', 'ADMIN', 'KITCHEN'],
  '/waiter': ['OWNER', 'MANAGER', 'ADMIN', 'WAITER'],
  '/cashier': ['OWNER', 'MANAGER', 'ADMIN', 'POS', 'CASHIER'],
}

const POS = '/cashier/pos'
const PAYMENT_DETAILS = '/dashboard/payment-details'
const OWNER_CAN = assignableRoles('OWNER')
const MANAGER_CAN = assignableRoles('MANAGER')

console.log('\n1. The list is the sidebar, and every tab opens its page\n')

{
  const navItems = NAV_SECTIONS.flatMap((section) => section.items)
  check(
    'every sidebar entry is offered, in sidebar order',
    SIDEBAR_MODULES.length === navItems.length &&
      SIDEBAR_MODULES.every((m, i) => m.href === navItems[i].href && m.section !== ''),
    `${SIDEBAR_MODULES.length} modules for ${navItems.length} entries`,
  )

  const badTargets = SIDEBAR_MODULES.flatMap((m) =>
    m.requires.filter((dep) => !isNavHref(dep) || dep === m.href).map((dep) => `${m.href} → ${dep}`),
  )
  check('every requirement names another real sidebar entry', badTargets.length === 0, badTargets.join(', '))

  const cycles = SIDEBAR_MODULES.filter((m) => requiredHrefs(m.href).includes(m.href)).map((m) => m.href)
  check('no entry requires itself, however indirectly', cycles.length === 0, cycles.join(', '))

  /*
   * A requirement the edge would refuse is a lock on a tab that cannot open.
   * Whoever may reach the requirer must be able to reach what it requires.
   */
  const unreachable = SIDEBAR_MODULES.flatMap((m) =>
    requiredHrefs(m.href)
      .map((dep) => sidebarModule(dep)!)
      .filter((dep) => dep.roles && (!m.roles || m.roles.some((r) => !dep.roles!.includes(r))))
      .map((dep) => `${m.href} → ${dep.href}`),
  )
  check('a required entry is open to everyone the requirer is open to', unreachable.length === 0, unreachable.join(', '))

  const mirrors = Object.entries(ROLE_ALLOWED).flatMap(([prefix, roles]) =>
    SIDEBAR_MODULES.filter((m) => m.href === prefix || m.href.startsWith(`${prefix}/`)).flatMap((m) =>
      same(m.roles ?? [], roles) ? [] : [`${m.href} says ${m.roles?.join(',') ?? 'everyone'}, edge says ${roles.join(',')}`],
    ),
  )
  check('the edge-gated entries carry a literal mirror of the edge table', mirrors.length === 0, mirrors.join('; '))

  /*
   * A ticked tab has to open its page. The page guard is the authority, so
   * the entry's permission must be one the guard accepts — the staff-codes
   * entry said `staff.view` while its page asked for `staff.manage`, which was
   * a tab that could be ticked and never opened.
   */
  const mismatched: string[] = []
  let compared = 0
  for (const m of SIDEBAR_MODULES) {
    const page = join('src/app', m.href.split('?')[0], 'page.tsx')
    if (!existsSync(page)) continue
    const src = readFileSync(page, 'utf8')
    const guard = src.match(/requirePage(?:Any)?Permission\(\s*(\[[^\]]*\]|PERMISSIONS\.\w+)/)
    if (!guard) continue
    const names = [...guard[1].matchAll(/PERMISSIONS\.(\w+)/g)].map((x) => (PERMISSIONS as Record<string, string>)[x[1]])
    compared += 1
    if (!names.includes(m.permission)) mismatched.push(`${m.href} shows on ${m.permission}, page guards ${names.join('|')}`)
  }
  check(`every entry's permission is one its page accepts (${compared} pages compared)`, mismatched.length === 0, mismatched.join('; '))
  check('compared a meaningful number of pages', compared > 40, `${compared}`)
}

console.log('\n2. A tab carries what it requires\n')

{
  const pos = sidebarModule(POS)!
  check('POS requires Payment details, and nothing else', same(requiredHrefs(POS), [PAYMENT_DETAILS]), requiredHrefs(POS).join(', '))

  const closed = withRequiredPermissions([PERMISSIONS.ORDER_CREATE], 'POS')
  check(
    'a list that shows POS gains Payment details when closed',
    closed.includes(PERMISSIONS.ACCOUNT_VIEW),
    closed.join(', '),
  )
  check('closing again changes nothing', same(withRequiredPermissions(closed, 'POS'), closed))

  const sidebar = visibleSections({ role: 'POS', rolePermissions: closed }).flatMap((s) => s.items.map((i) => i.href))
  check('and the real sidebar shows both tabs', sidebar.includes(POS) && sidebar.includes(PAYMENT_DETAILS), sidebar.join(', '))

  const waiter = withRequiredPermissions([PERMISSIONS.ORDER_CREATE], 'WAITER')
  check(
    'a Waiter-based role holding order.create is not given Payment details — the edge hides POS from it',
    !waiter.includes(PERMISSIONS.ACCOUNT_VIEW),
    waiter.join(', '),
  )

  const shownWithPos = modulesShownBy(new Set(closed), 'POS')
  check('Payment details is held in place by POS', requiredBy(PAYMENT_DETAILS, shownWithPos).map((m) => m.href).join() === POS)
  const shownWithout = modulesShownBy(new Set([PERMISSIONS.ACCOUNT_VIEW]), 'POS')
  check('and is free once POS is off', requiredBy(PAYMENT_DETAILS, shownWithout).length === 0)
  check('POS ticks on with its tabs usable, not just its door', pos.grants.includes(PERMISSIONS.PAYMENT_COLLECT))

  const pairs: Array<[string, Permission, Permission]> = [
    ['Goods received → Purchasing', PERMISSIONS.PURCHASE_RECEIVE, PERMISSIONS.PURCHASE_VIEW],
    ['Customer insights → Customers', PERMISSIONS.CUSTOMER_ANALYTICS, PERMISSIONS.CUSTOMER_VIEW],
    ['Add your menu → Menu items', PERMISSIONS.MENU_MANAGE, PERMISSIONS.MENU_VIEW],
    ['Roles & access → Staff', PERMISSIONS.STAFF_MANAGE, PERMISSIONS.STAFF_VIEW],
  ]
  for (const [label, child, parent] of pairs) {
    check(label, withRequiredPermissions([child]).includes(parent))
  }

  /*
   * Deploy-day safety: no built-in role changes when closed. Every dependency
   * declared is one the presets already satisfied, so nobody gains a tab.
   */
  const changed = (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter(
    (role) => !same(withRequiredPermissions(ROLE_PERMISSIONS[role], role), ROLE_PERMISSIONS[role]),
  )
  check('no built-in role changes when closed over dependencies', changed.length === 0, changed.join(', '))
}

console.log('\n3. Ticked boxes become a permission list, and back\n')

{
  const selected = closeSelection([POS], 'POS')
  check('ticking POS selects Payment details too', selected.has(PAYMENT_DETAILS))
  const fromScratch = permissionsForSelection(selected, [], 'POS')
  check(
    'from scratch, POS is a working till',
    [PERMISSIONS.ORDER_CREATE, PERMISSIONS.PAYMENT_COLLECT, PERMISSIONS.ACCOUNT_VIEW].every((p) => fromScratch.includes(p)),
    fromScratch.join(', '),
  )
  check(
    'and nothing the owner did not ask for — no refunds, discounts or drawer',
    ![PERMISSIONS.PAYMENT_REFUND, PERMISSIONS.DISCOUNT_APPLY, PERMISSIONS.CASH_DRAWER_OPERATE].some((p) => fromScratch.includes(p)),
  )
  check('unticking everything leaves nothing', permissionsForSelection(new Set()).length === 0)

  /*
   * A list the client sends without the dependency is repaired, not trusted:
   * the closure is the server's, and it puts Payment details back.
   */
  const stripped = fromScratch.filter((p) => p !== PERMISSIONS.ACCOUNT_VIEW)
  check('a hand-made list without the dependency gets it back on the server', withRequiredPermissions(stripped, 'POS').includes(PERMISSIONS.ACCOUNT_VIEW))

  // Round trip: seed from a template, change nothing, get the template back.
  const lossy = (Object.keys(ROLE_PERMISSIONS) as UserRole[]).flatMap((role) => {
    const base = ROLE_PERMISSIONS[role] as string[]
    const seed = modulesShownBy(new Set(base), role).map((m) => m.href)
    const out = permissionsForSelection(closeSelection(seed, role), base, role)
    return same(out, base) ? [] : [`${role}: −${diff(base, out).join(',')} +${diff(out, base).join(',')}`]
  })
  check('every template round-trips through the boxes unchanged', lossy.length === 0, lossy.join('; '))

  // Unticking a tab takes its feature's actions with it — the builder's rule.
  const manager = ROLE_PERMISSIONS.MANAGER as string[]
  const seed = modulesShownBy(new Set(manager), 'MANAGER').map((m) => m.href)
  const withoutPurchasing = closeSelection(
    seed.filter((h) => h !== '/dashboard/purchases' && h !== '/dashboard/purchases/receive'),
    'MANAGER',
  )
  const trimmed = permissionsForSelection(withoutPurchasing, manager, 'MANAGER')

  // Unticking POS hides the till and keeps what other screens still use.
  const withoutPos = permissionsForSelection(closeSelection(seed.filter((h) => h !== POS), 'MANAGER'), manager, 'MANAGER')
  check(
    'a manager without POS no longer holds what shows it',
    ![PERMISSIONS.ORDER_CREATE, PERMISSIONS.PAYMENT_COLLECT, PERMISSIONS.CASH_DRAWER_MANAGE].some((p) => withoutPos.includes(p)),
    withoutPos.filter((p) => p.startsWith('order.') || p.startsWith('payment.') || p.startsWith('cashDrawer.')).join(', '),
  )
  check(
    'but still changes order status from Orders and keeps the drawer they ticked',
    withoutPos.includes(PERMISSIONS.ORDER_UPDATE_STATUS) && withoutPos.includes(PERMISSIONS.CASH_DRAWER_OPERATE),
  )
  /*
   * The drawer tab lives inside the POS shell (abc.md §8), so the sidebar
   * still offers the door — with only the drawer behind it. The dialog shows
   * that box as "Shown with Cash drawer" rather than pretending otherwise.
   */
  const drawerOnly = { role: 'MANAGER' as UserRole, rolePermissions: withoutPos }
  check(
    'the POS door stays for the drawer that lives inside it',
    visibleSections(drawerOnly).some((s) => s.items.some((i) => i.href === POS)),
  )
  const tabs = posTabsFor(drawerOnly)
  check('with only the drawer behind it — no orders, no till', tabs.includes('drawer') && !tabs.includes('orders') && !tabs.includes('cashier'), tabs.join(', '))
  const withoutBoth = permissionsForSelection(
    closeSelection(seed.filter((h) => h !== POS && h !== '/dashboard/cash-drawer'), 'MANAGER'),
    manager,
    'MANAGER',
  )
  check(
    'untick Cash drawer too and POS is gone from the real sidebar',
    !visibleSections({ role: 'MANAGER', rolePermissions: withoutBoth }).some((s) => s.items.some((i) => i.href === POS)),
  )
  check(
    'unticking Purchasing removes raising, receiving and returning orders',
    ![PERMISSIONS.PURCHASE_VIEW, PERMISSIONS.PURCHASE_CREATE, PERMISSIONS.PURCHASE_RECEIVE, PERMISSIONS.PURCHASE_RETURN].some((p) => trimmed.includes(p)),
    trimmed.filter((p) => p.startsWith('purchase.')).join(', '),
  )
  check(
    'but keeps approving, which Approvals still sells as "Decide"',
    trimmed.includes(PERMISSIONS.PURCHASE_APPROVE) && trimmed.includes(PERMISSIONS.APPROVALS_VIEW),
  )
  check('and leaves the rest of the manager alone', trimmed.includes(PERMISSIONS.SETTINGS_VIEW) && trimmed.includes(PERMISSIONS.INVENTORY_ADJUST))

  // Goods received cannot stay on with Purchasing off: the closure brings it back.
  const keptReceive = closeSelection(seed.filter((h) => h !== '/dashboard/purchases'), 'MANAGER')
  check('Goods received holds Purchasing in place', keptReceive.has('/dashboard/purchases'))

  check('Invoices on its own is Invoices', permissionsForSelection(closeSelection(['/dashboard/invoices'])).includes(PERMISSIONS.INVOICE_VIEW))

  check('Stock ledger shares its access with Stock', accessTwin('/dashboard/inventory/ledger')?.href === '/dashboard/inventory')
  check('Stock itself has no twin', accessTwin('/dashboard/inventory') === null)
  check('Command Center shares its access with nothing before it', accessTwin('/dashboard/insights') === null)

  const kitchenTicksPos = permissionsForSelection(closeSelection([POS, '/kitchen'], 'KITCHEN'), [], 'KITCHEN')
  check(
    'a Kitchen-based role cannot tick POS, so it gains neither the till nor Payment details',
    !kitchenTicksPos.includes(PERMISSIONS.ORDER_CREATE) && !kitchenTicksPos.includes(PERMISSIONS.ACCOUNT_VIEW) && kitchenTicksPos.includes(PERMISSIONS.KITCHEN_VIEW),
    kitchenTicksPos.join(', '),
  )
}

console.log('\n4. "Start from scratch" lands somewhere the tabs can open\n')

{
  const posPerms = permissionsForSelection(closeSelection([POS]), [], 'POS')
  check('POS ticked → based on POS', inferPreset(posPerms, OWNER_CAN).preset === 'POS')
  check('Kitchen display ticked → based on Kitchen', inferPreset([PERMISSIONS.KITCHEN_VIEW], OWNER_CAN).preset === 'KITCHEN')
  check('Waiter station ticked → based on Waiter', inferPreset([PERMISSIONS.WAITER_VIEW], OWNER_CAN).preset === 'WAITER')

  const both = inferPreset([...posPerms, PERMISSIONS.KITCHEN_VIEW], OWNER_CAN)
  check('POS and Kitchen display together → Manager, the only assignable base that opens both', both.preset === 'MANAGER', String(both.preset))
  const managerBoth = inferPreset([...posPerms, PERMISSIONS.KITCHEN_VIEW], MANAGER_CAN)
  check(
    'a manager, who cannot mint managers, is told which two tabs cannot go together',
    managerBoth.preset === null && same(managerBoth.blockedBy.map((m) => m.href), [POS, '/kitchen']),
    managerBoth.blockedBy.map((m) => m.href).join(', '),
  )

  const stock = inferPreset([PERMISSIONS.INVENTORY_VIEW], OWNER_CAN, 'branch-1')
  check('Stock with a location → Stock keeper: lands on Stock and is confined to the site', stock.preset === 'STOCK_KEEPER', String(stock.preset))
  const stockAnywhere = inferPreset([PERMISSIONS.INVENTORY_VIEW], OWNER_CAN)
  check('Stock without a location still prefers the confined base over Inventory manager', stockAnywhere.preset === 'STOCK_KEEPER', String(stockAnywhere.preset))

  const buying = inferPreset([PERMISSIONS.PURCHASE_VIEW], OWNER_CAN)
  check('Purchasing for all locations → Purchasing manager, which lands there', buying.preset === 'PURCHASING_MANAGER', String(buying.preset))
  const buyingAtKandy = inferPreset([PERMISSIONS.PURCHASE_VIEW], OWNER_CAN, 'kandy')
  check(
    'Purchasing at one location → a base that is actually confined by it',
    buyingAtKandy.preset !== null && !seesAllLocations(buyingAtKandy.preset, 'kandy'),
    String(buyingAtKandy.preset),
  )

  const dashboard = inferPreset([PERMISSIONS.DASHBOARD_VIEW], OWNER_CAN)
  check('Dashboard alone → Manager, which lands on it', dashboard.preset === 'MANAGER', String(dashboard.preset))

  const empty = inferPreset([], OWNER_CAN)
  check('nothing ticked still resolves to something assignable', empty.preset !== null && OWNER_CAN.includes(empty.preset))
  check('nobody assignable → nothing inferred', inferPreset(posPerms, []).preset === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
