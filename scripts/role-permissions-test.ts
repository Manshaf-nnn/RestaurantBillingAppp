/**
 * A feature switched off has to actually be off.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * `permissionsFor` was `ROLE_PERMISSIONS[role] ∪ user.permissions` and nothing
 * else. A union can only grant. An owner could give a cashier the inventory
 * screen; there was no expressible way to take the payment screen away, because
 * whatever you did, the union put it back. Every ON/OFF switch Rolelogic asks
 * for needs the OFF half to mean something, and it could not.
 *
 * So the first section below is written to fail against the old code: it saves
 * a role WITHOUT `payment.collect` and asserts the cashier cannot collect.
 * Under the union that assertion is false — the role default puts it straight
 * back — which is the point of writing it first.
 *
 * ── And splitting permissions must not quietly demote anybody ───────────────
 *
 * Fourteen screens that used to share somebody else's permission got their own
 * (`report.sales` split out of `report.view`, and so on). That is a silent
 * downgrade for every role holding the parent unless each is brought with it.
 * Section 6 checks all eleven roles against the exact list of splits, so a
 * missed one fails here rather than on an accountant's empty screen.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/role-permissions-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  can,
  permissionsFor,
  visibleBranchIds,
  type Permission,
} from '../src/lib/rbac'
import { NAV_SECTIONS } from '../src/features/dashboard/nav'
import {
  FEATURES,
  REGISTERED_PERMISSIONS,
  featureForRoute,
  describePermissions,
  permissionsForFeatures,
} from '../src/features/access/features'
import {
  assertNoEscalation,
  assertPresetScopeAllowed,
  templateFor,
} from '../src/features/access/service'
import type { UserRole } from '@prisma/client'

let passed = 0
let failed = 0

/** Assert that a guard throws, and throws for the right reason. */
function refuses(name: string, run: () => unknown, expect: RegExp) {
  try {
    run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * The subject the server builds for a request.
 *
 * Deliberately re-reads the user with the same `select` and the same fallback
 * rule as `resolveUser` in `src/server/auth/session.ts`, so this test exercises
 * the shape production actually assembles rather than one invented here. If
 * those diverge, they diverge in a place a test can catch.
 */
async function subjectFor(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      role: true,
      permissions: true,
      branchId: true,
      staffRole: { select: { permissions: true, isActive: true } },
    },
  })
  return {
    role: user.role,
    permissions: user.permissions,
    branchId: user.branchId,
    rolePermissions:
      user.staffRole && user.staffRole.isActive ? user.staffRole.permissions : null,
  }
}

/** What the sidebar would render for this person. */
function navFor(subject: Parameters<typeof permissionsFor>[0]): string[] {
  const granted = permissionsFor(subject)
  return NAV_SECTIONS.flatMap((section) =>
    section.items.filter((item) => granted.has(item.permission)).map((item) => item.href),
  )
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Roles ${stamp}`, slug: `roles-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const second = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Branch 02', code: 'BR02' },
  })

  const mkUser = (email: string, role: UserRole, branchId: string | null) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        email: `${email}-${stamp}@test.local`,
        name: email,
        passwordHash: 'x',
        role,
        branchId,
      },
    })

  // ── 1. OFF means off ──────────────────────────────────────────────────────
  console.log('\n── 1. a switch that is off denies ──')

  const cashier = await mkUser('cashier', 'CASHIER', second.id)

  const before = await subjectFor(cashier.id)
  check(
    'a plain cashier can collect payment to begin with',
    can(before, PERMISSIONS.PAYMENT_COLLECT),
  )
  check('and the till is in their sidebar', navFor(before).includes('/cashier'))

  /*
   * "Front of house" — everything a cashier gets EXCEPT taking money. The whole
   * question this test exists to answer: can an owner remove one thing?
   */
  const restricted = ROLE_PERMISSIONS.CASHIER.filter(
    (p) => p !== PERMISSIONS.PAYMENT_COLLECT && p !== PERMISSIONS.PAYMENT_VIEW,
  )
  const frontOfHouse = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Front of house',
      preset: 'CASHIER',
      branchId: second.id,
      permissions: restricted,
    },
  })
  await prisma.user.update({ where: { id: cashier.id }, data: { staffRoleId: frontOfHouse.id } })

  const after = await subjectFor(cashier.id)
  check(
    'with the switch off they cannot collect',
    !can(after, PERMISSIONS.PAYMENT_COLLECT),
    'the role default put it back — this is the union bug',
  )
  check('nor even see payments', !can(after, PERMISSIONS.PAYMENT_VIEW))
  check('the till is gone from their sidebar', !navFor(after).includes('/cashier'))
  check(
    'and everything else they had is untouched',
    can(after, PERMISSIONS.ORDER_CREATE) && can(after, PERMISSIONS.TABLE_VIEW),
  )

  /*
   * The sidebar and the URL must agree. A hidden item that still opens is the
   * `/dashboard/links` bug, and it is the one this whole system is for.
   */
  const paymentsFeature = featureForRoute('/cashier')
  check('the till route resolves to a feature', paymentsFeature?.key === 'payments')
  check(
    'and every permission it guards is switchable',
    (paymentsFeature?.actions ?? []).every((a) => REGISTERED_PERMISSIONS.has(a.permission)),
  )

  // ── 2. per-user grants still add on top ───────────────────────────────────
  console.log('\n── 2. one person can still be given extra ──')

  await prisma.user.update({
    where: { id: cashier.id },
    data: { permissions: [PERMISSIONS.INVENTORY_WASTAGE_APPROVE] },
  })
  const granted = await subjectFor(cashier.id)
  check('the extra key is granted', can(granted, PERMISSIONS.INVENTORY_WASTAGE_APPROVE))
  check('without re-granting what the role removed', !can(granted, PERMISSIONS.PAYMENT_COLLECT))
  await prisma.user.update({ where: { id: cashier.id }, data: { permissions: [] } })

  // ── 3. an owner cannot lock themselves out ────────────────────────────────
  console.log('\n── 3. the owner is not lockable ──')

  const owner = await mkUser('owner', 'OWNER', null)
  const empty = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Locked out',
      preset: 'OWNER',
      permissions: [],
    },
  })
  await prisma.user.update({ where: { id: owner.id }, data: { staffRoleId: empty.id } })

  const ownerSubject = await subjectFor(owner.id)
  check(
    'an owner with an empty role still holds everything',
    can(ownerSubject, PERMISSIONS.SETTINGS_MANAGE) && can(ownerSubject, PERMISSIONS.STAFF_MANAGE),
    'they would have no way to switch it back on',
  )
  check(
    'and their sidebar is complete',
    navFor(ownerSubject).length ===
      NAV_SECTIONS.reduce((sum, section) => sum + section.items.length, 0),
  )

  // ── 4. an edit lands immediately, with no new session ─────────────────────
  console.log('\n── 4. an edit takes effect on the next click ──')

  await prisma.staffRole.update({
    where: { id: frontOfHouse.id },
    data: { permissions: [...restricted, PERMISSIONS.PAYMENT_COLLECT] },
  })
  const reread = await subjectFor(cashier.id)
  check(
    'switching it back on restores the permission',
    can(reread, PERMISSIONS.PAYMENT_COLLECT),
    'the JWT carries only sub and sid, so this must be a fresh read',
  )
  await prisma.staffRole.update({
    where: { id: frontOfHouse.id },
    data: { permissions: restricted },
  })

  // ── 5. a deactivated role demotes, it does not blind ──────────────────────
  console.log('\n── 5. deactivating a role falls back to the preset ──')

  await prisma.staffRole.update({ where: { id: frontOfHouse.id }, data: { isActive: false } })
  const demoted = await subjectFor(cashier.id)
  check('the custom list stops applying', demoted.rolePermissions === null)
  check(
    'and they get the preset back rather than nothing',
    can(demoted, PERMISSIONS.PAYMENT_COLLECT) && navFor(demoted).length > 0,
    'an empty screen mid-shift with no explanation is worse than a demotion',
  )
  await prisma.staffRole.update({ where: { id: frontOfHouse.id }, data: { isActive: true } })

  // ── 6. splitting permissions demoted nobody ───────────────────────────────
  console.log('\n── 6. the split brought every role with it ──')

  const SPLITS: Array<[Permission, Permission]> = [
    [PERMISSIONS.TASKS_VIEW, PERMISSIONS.DASHBOARD_VIEW],
    [PERMISSIONS.APPROVALS_VIEW, PERMISSIONS.DASHBOARD_VIEW],
    [PERMISSIONS.HANDOVER_VIEW, PERMISSIONS.ORDER_VIEW],
    [PERMISSIONS.RECIPE_VIEW, PERMISSIONS.MENU_VIEW],
    [PERMISSIONS.LOYALTY_VIEW, PERMISSIONS.SETTINGS_VIEW],
    [PERMISSIONS.QR_VIEW, PERMISSIONS.SETTINGS_VIEW],
    [PERMISSIONS.FEEDBACK_VIEW, PERMISSIONS.REVIEW_MANAGE],
    [PERMISSIONS.CUSTOMER_ANALYTICS, PERMISSIONS.CUSTOMER_VIEW],
    [PERMISSIONS.REPORT_SALES, PERMISSIONS.REPORT_VIEW],
    [PERMISSIONS.REPORT_PROFIT, PERMISSIONS.REPORT_VIEW],
    [PERMISSIONS.REPORT_INVENTORY, PERMISSIONS.REPORT_VIEW],
    [PERMISSIONS.REPORT_PURCHASING, PERMISSIONS.REPORT_VIEW],
    [PERMISSIONS.REPORT_VARIANCE, PERMISSIONS.REPORT_VIEW],
    [PERMISSIONS.REPORT_RECONCILIATION, PERMISSIONS.REPORT_VIEW],
  ]

  const demotions: string[] = []
  for (const role of Object.keys(ROLE_LABELS) as UserRole[]) {
    const held = new Set<string>(ROLE_PERMISSIONS[role])
    for (const [child, parent] of SPLITS) {
      if (held.has(parent) && !held.has(child)) demotions.push(`${role} lost ${child}`)
    }
  }
  check(
    'no role holds a parent without its split child',
    demotions.length === 0,
    demotions.join('; '),
  )
  check(
    'an accountant kept every report',
    can({ role: 'ACCOUNTANT' }, PERMISSIONS.REPORT_SALES) &&
      can({ role: 'ACCOUNTANT' }, PERMISSIONS.REPORT_PROFIT) &&
      can({ role: 'ACCOUNTANT' }, PERMISSIONS.REPORT_RECONCILIATION),
  )
  check(
    'and a kitchen account gained nothing it should not have',
    !can({ role: 'KITCHEN' }, PERMISSIONS.REPORT_SALES) &&
      !can({ role: 'KITCHEN' }, PERMISSIONS.APPROVALS_VIEW),
  )

  // ── 7. the registry covers the sidebar ────────────────────────────────────
  console.log('\n── 7. every menu entry is switchable ──')

  const navPermissions = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.permission))
  const unswitchable = [...new Set(navPermissions)].filter((p) => !REGISTERED_PERMISSIONS.has(p))
  check(
    'no sidebar item guards a permission the registry omits',
    unswitchable.length === 0,
    unswitchable.join(', '),
  )

  const seen = new Map<string, string>()
  const collisions: string[] = []
  for (const feature of FEATURES) {
    for (const route of feature.routes) {
      const prior = seen.get(route)
      if (prior) collisions.push(`${route} claimed by ${prior} and ${feature.key}`)
      seen.set(route, feature.key)
    }
  }
  check('no two features claim the same route', collisions.length === 0, collisions.join('; '))
  check(
    'the longest prefix wins',
    featureForRoute('/dashboard/reports/sales')?.key === 'reportSales' &&
      featureForRoute('/dashboard/reports')?.key === 'reports',
  )
  check(
    'enabling features yields their view permissions',
    permissionsForFeatures(['inventory', 'orders']).sort().join() ===
      [PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.ORDER_VIEW].sort().join(),
  )
  const described = describePermissions(
    permissionsFor({ role: 'CASHIER', rolePermissions: restricted }),
  )
  const paymentsRow = described.find((d) => d.feature.key === 'payments')
  const ordersRow = described.find((d) => d.feature.key === 'orders')
  check(
    'the grid reads a saved role back correctly',
    paymentsRow?.enabled === false && ordersRow?.enabled === true,
    `payments ${paymentsRow?.enabled}, orders ${ordersRow?.enabled}`,
  )
  /*
   * A cashier keeps `discount.apply` and `invoice.view` after the till is
   * switched off, and those are now unreachable. Surfacing them is what lets
   * an owner notice and tidy up, rather than the grid quietly reporting
   * Payments as ON because one stray right survived.
   */
  check(
    'and flags the rights left dangling behind a closed feature',
    (paymentsRow?.orphaned.length ?? 0) > 0,
    `${paymentsRow?.orphaned.map((a) => a.permission).join(', ')}`,
  )

  // ── 8. a custom role is still confined to its branch ──────────────────────
  console.log('\n── 8. branch isolation survives a custom role ──')

  check(
    'a custom cashier at Branch 02 sees only Branch 02',
    JSON.stringify(visibleBranchIds({ role: 'CASHIER', branchId: second.id })) ===
      JSON.stringify([second.id]),
  )
  check(
    'and never Main',
    !visibleBranchIds({ role: 'CASHIER', branchId: second.id })?.includes(main.id),
  )

  /*
   * `[]` means "sees nothing" and has been misread as "no filter" at three
   * separate call sites in this codebase. A custom role must not become a
   * fourth: permissions decide WHAT, the branch decides WHERE, and granting a
   * permission must never widen a location.
   */
  const stranded = await mkUser('stranded', 'CASHIER', null)
  await prisma.user.update({
    where: { id: stranded.id },
    data: { staffRoleId: frontOfHouse.id },
  })
  const strandedSubject = await subjectFor(stranded.id)
  const reach = visibleBranchIds(strandedSubject)
  check(
    'a confined user with no branch still sees nothing',
    Array.isArray(reach) && reach.length === 0,
    'this must never become null, which means everything',
  )
  check(
    'even though their role grants plenty',
    permissionsFor(strandedSubject).size > 5,
    'permissions decide what, the branch decides where',
  )

  // ── 9. nobody may build a role stronger than themselves ───────────────────
  console.log('\n── 9. no escalation through the role builder ──')

  /*
   * This is the load-bearing check of the whole feature. Creating roles is
   * `staff.manage`, which every MANAGER holds — so without it a manager could
   * save a role carrying `settings.manage`, assign it to an account they
   * control, and sign in holding powers their own account never had. That is
   * privilege escalation with extra steps, and it is the obvious way to attack
   * a system whose whole point is letting people define permission sets.
   */
  const siteManager = { role: 'MANAGER' as UserRole, branchId: second.id }

  refuses(
    'a manager cannot grant what they do not hold',
    () => assertNoEscalation(siteManager as never, [PERMISSIONS.SETTINGS_MANAGE]),
    /cannot grant what you do not have/i,
  )
  check(
    'but may grant what they do',
    (() => {
      try {
        assertNoEscalation(siteManager as never, [PERMISSIONS.ORDER_VIEW, PERMISSIONS.TABLE_VIEW])
        return true
      } catch {
        return false
      }
    })(),
  )
  check(
    'an owner may grant anything',
    (() => {
      try {
        assertNoEscalation({ role: 'OWNER', branchId: null } as never, [
          PERMISSIONS.SETTINGS_MANAGE,
          PERMISSIONS.PAYMENT_REFUND,
        ])
        return true
      } catch {
        return false
      }
    })(),
  )

  /*
   * Rank is not reach. ACCOUNTANT is assignable by a manager AND is
   * cross-location, so basing a role on it would hand sight of every branch to
   * somebody created by a person confined to one site — the same gap
   * `assertScopeAllowed` closes on the staff form.
   */
  refuses(
    'a site manager cannot base a role on a cross-location preset',
    () => assertPresetScopeAllowed(siteManager as never, 'ACCOUNTANT'),
    /sees every location and you do not/i,
  )
  check(
    'an owner can',
    (() => {
      try {
        assertPresetScopeAllowed({ role: 'OWNER', branchId: null } as never, 'ACCOUNTANT')
        return true
      } catch {
        return false
      }
    })(),
  )

  /*
   * A template is narrowed rather than refused, so cloning Administrator as a
   * manager gives a manager's version and they can carry on.
   */
  const managerTemplate = templateFor(siteManager as never, 'ADMIN')
  check(
    'copying a template drops what the copier cannot grant',
    !managerTemplate.includes(PERMISSIONS.SETTINGS_MANAGE) &&
      managerTemplate.includes(PERMISSIONS.ORDER_VIEW),
    `${managerTemplate.length} of ${ROLE_PERMISSIONS.ADMIN.length}`,
  )
  const ownerTemplate = templateFor({ role: 'OWNER', branchId: null } as never, 'ADMIN')
  check(
    'and an owner copying it gets the whole thing',
    ownerTemplate.length === ROLE_PERMISSIONS.ADMIN.length,
    `${ownerTemplate.length} of ${ROLE_PERMISSIONS.ADMIN.length}`,
  )

  // ── cleanup ───────────────────────────────────────────────────────────────
  await prisma.user.updateMany({
    where: { restaurantId: restaurant.id },
    data: { staffRoleId: null },
  })
  await prisma.staffRole.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
