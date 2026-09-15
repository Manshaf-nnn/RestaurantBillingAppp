/**
 * Favorites are per person, per restaurant, and never a way in.
 *
 * ── What this is defending ──────────────────────────────────────────────────
 *
 * `sidebar-nav-test` proves the pure filter is right. This proves the parts
 * that only exist once there is a database under them, and each one is a way
 * the feature could be right in the sidebar and wrong in the row:
 *
 *   1. §1 says favorites are saved per USER, not globally. The failure mode is
 *      not subtle in description and is very easy to write by accident — a
 *      restaurant-level column, or a cache keyed on the wrong id — and it looks
 *      completely fine until a second person signs in.
 *   2. §7 says a saved shortcut must not be accessible once the permission is
 *      gone. Filtering on the way OUT is not enough: the row would still exist,
 *      and the next thing to read it (an export, a report, a future feature)
 *      would not know to filter. So the write is checked too, and this asserts
 *      on the stored row rather than on what the sidebar drew.
 *   3. Restaurant isolation, because everything in this codebase is scoped and
 *      a new column is a new chance to forget.
 *   4. §9 says no database request per sidebar render. The favorites have to
 *      come back on `USER_SELECT` — the one user row resolving a session
 *      already reads — so this checks the shape that guarantee depends on.
 *
 * Written against the service, not the HTTP layer, so it runs in the service
 * tier with a self-contained fixture it deletes on the way out.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/sidebar-favorites-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { PERMISSIONS, permissionsFor } from '../src/lib/rbac'
import {
  MAX_FAVORITES,
  favoriteItems,
  reachableNavItems,
  sanitiseFavorites,
} from '../src/features/dashboard/nav'

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

/**
 * What `setNavFavorites` does, minus the session lookup.
 *
 * The action itself calls `requireTenantUser()`, which needs cookies and a
 * request — neither exists in a Node script. Everything after that line is
 * here verbatim, so what is being tested is the real filter and the real write
 * against the real column, with only "who is asking" supplied differently.
 */
async function save(
  user: { id: string; role: any; permissions: string[]; rolePermissions: string[] | null },
  hrefs: string[],
) {
  const kept = sanitiseFavorites(user, hrefs)
  await prisma.user.update({ where: { id: user.id }, data: { navFavorites: kept } })
  return kept
}

const stamp = Date.now().toString(36)

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Sidebar Co', slug: `sidebar-${stamp}`, email: `sb-${stamp}@test.local` },
  })
  const other = await prisma.restaurant.create({
    data: { name: 'Other Co', slug: `other-${stamp}`, email: `ot-${stamp}@test.local` },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })

  const owner = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `owner-${stamp}@test.local`,
      name: 'Owner A',
      passwordHash: 'x',
      role: 'OWNER',
      branchId: branch.id,
    },
  })

  /*
   * A saved role rather than a preset, because that is the case §7 is really
   * about: a list the owner composed, which they can edit later — and editing
   * it is what has to reach into this person's favorites.
   */
  const role = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id,
      name: `Floor manager ${stamp}`,
      preset: 'MANAGER',
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.ORDER_VIEW,
        PERMISSIONS.INVENTORY_VIEW,
        PERMISSIONS.KITCHEN_VIEW,
      ],
    },
  })
  const manager = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `mgr-${stamp}@test.local`,
      name: 'Manager B',
      passwordHash: 'x',
      role: 'MANAGER',
      branchId: branch.id,
      staffRoleId: role.id,
    },
  })
  const outsider = await prisma.user.create({
    data: {
      restaurantId: other.id,
      email: `out-${stamp}@test.local`,
      name: 'Owner C',
      passwordHash: 'x',
      role: 'OWNER',
    },
  })

  const subject = (u: typeof owner, rolePermissions: string[] | null = null) => ({
    id: u.id,
    role: u.role,
    permissions: u.permissions,
    rolePermissions,
  })

  const ownerSubject = subject(owner)
  const managerSubject = subject(manager, role.permissions)

  console.log('\n── 1. Each person sees their own (§1) ──')
  {
    // The spec's own example: an owner keeps POS/Inventory/Sales, a manager
    // keeps KDS/Orders.
    await save(ownerSubject, ['/cashier/pos', '/dashboard/inventory', '/dashboard/reports/sales'])
    await save(managerSubject, ['/kitchen', '/dashboard/orders'])

    const a = await prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
      select: { navFavorites: true },
    })
    const b = await prisma.user.findUniqueOrThrow({
      where: { id: manager.id },
      select: { navFavorites: true },
    })

    check(
      "the owner's three are the owner's",
      a.navFavorites.join(',') === '/cashier/pos,/dashboard/inventory,/dashboard/reports/sales',
      a.navFavorites.join(','),
    )
    check(
      "the manager's two are the manager's",
      b.navFavorites.join(',') === '/kitchen,/dashboard/orders',
      b.navFavorites.join(','),
    )
    check(
      'and writing one did not touch the other',
      a.navFavorites.length === 3 && b.navFavorites.length === 2,
    )

    const c = await prisma.user.findUniqueOrThrow({
      where: { id: outsider.id },
      select: { navFavorites: true },
    })
    check('a user in another restaurant is untouched', c.navFavorites.length === 0)
  }

  console.log('\n── 2. The order is the data (§2) ──')
  {
    const reordered = ['/dashboard/reports/sales', '/cashier/pos', '/dashboard/inventory']
    await save(ownerSubject, reordered)
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
      select: { navFavorites: true },
    })
    check(
      'a drag is stored as the new order, not a set',
      row.navFavorites.join(',') === reordered.join(','),
      row.navFavorites.join(','),
    )
  }

  console.log('\n── 3. The write is guarded, not just the render (§7) ──')
  {
    /*
     * The manager's role has no accounting permission. Storing the href and
     * hiding it at render would leave a row saying "this person pinned the
     * ledger", which the next thing to read this column would have to know to
     * distrust. Nothing is stored at all.
     */
    const kept = await save(managerSubject, [
      '/kitchen',
      '/dashboard/accounting/ledger',
      '/dashboard/staff',
    ])
    check('a page outside their role is refused on write', !kept.includes('/dashboard/accounting/ledger'), kept.join(','))

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: manager.id },
      select: { navFavorites: true },
    })
    check(
      'and the column holds only what they may open',
      row.navFavorites.join(',') === '/kitchen',
      row.navFavorites.join(','),
    )

    const junk = await save(ownerSubject, ['/dashboard/not-a-real-page'])
    check('an invented href is refused on write', junk.length === 0, junk.join(','))
  }

  console.log('\n── 4. Losing a permission loses the shortcut (§7) ──')
  {
    await save(managerSubject, ['/dashboard/inventory', '/kitchen'])

    const before = favoriteItems(managerSubject, ['/dashboard/inventory', '/kitchen'])
    check('Stock is in their sidebar while they hold inventory.view', before.length === 2)

    // The owner edits the role and unticks Inventory.
    const narrowed = await prisma.staffRole.update({
      where: { id: role.id },
      data: { permissions: role.permissions.filter((p) => p !== PERMISSIONS.INVENTORY_VIEW) },
    })

    const now = subject(manager, narrowed.permissions)
    const after = favoriteItems(now, ['/dashboard/inventory', '/kitchen'])
    check(
      'and it is gone from it the moment the role changes',
      after.length === 1 && after[0]?.href === '/kitchen',
      after.map((i) => i.href).join(','),
    )

    // Still in the column, and that is deliberate: a role edited back puts the
    // shortcut back, rather than silently destroying a list somebody arranged.
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: manager.id },
      select: { navFavorites: true },
    })
    check('the stored row is left alone, so it survives a reinstated role', row.navFavorites.includes('/dashboard/inventory'))
    check(
      'but it is inert — the permission set no longer contains it',
      !permissionsFor(now).has(PERMISSIONS.INVENTORY_VIEW),
    )

    // And the next save cleans it out, so the column self-heals.
    const cleaned = await save(now, row.navFavorites)
    check('the next save drops it for good', !cleaned.includes('/dashboard/inventory'), cleaned.join(','))
  }

  console.log('\n── 5. The cap holds at the database (§1) ──')
  {
    const everything = reachableNavItems(ownerSubject).map((item) => item.href)
    await save(ownerSubject, everything)
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
      select: { navFavorites: true },
    })
    check(
      `at most ${MAX_FAVORITES} rows are ever written`,
      row.navFavorites.length === MAX_FAVORITES,
      `${row.navFavorites.length} of ${everything.length}`,
    )
  }

  console.log('\n── 6. It costs no query of its own (§9) ──')
  {
    /*
     * The guarantee is structural: favorites ride the select that resolving a
     * session already runs. If somebody later moves this to its own table or
     * its own fetch, `USER_SELECT` stops carrying it and this fails — which is
     * the only cheap way to notice a performance promise being quietly dropped.
     */
    const { USER_SELECT } = await import('../src/server/auth/session')
    check(
      'navFavorites is on the session user select',
      Object.keys(USER_SELECT).includes('navFavorites'),
      Object.keys(USER_SELECT).join(', '),
    )
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: other.id } })
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
