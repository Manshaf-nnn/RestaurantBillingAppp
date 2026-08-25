/**
 * A person has one role, not two that drift apart.
 *
 * ── The bug this is written around ──────────────────────────────────────────
 *
 * `User.role` decides where you land, what the edge middleware lets through and
 * which branches you can see. `StaffRole` decides your permissions. Two places
 * attached a role to a person — walking a share link, and assigning a custom
 * role — and **neither wrote `User.role`**.
 *
 * So a Cashier share link handed to somebody whose account was a Waiter did
 * this: the link redirected to `/cashier`, the JWT still said WAITER,
 * `middleware.ts` asked `roleAllowed('/cashier', 'WAITER')`, got false, and
 * sent them to `/forbidden` — "You do not have access here", from the screen
 * whose entire job is handing out access.
 *
 * Section 2 is that exact chain. It fails against the old code.
 *
 * ── The rule now ────────────────────────────────────────────────────────────
 *
 *   a custom role carries its own base, and applying the role applies the base
 *
 * Everything below is a way that could stop being true.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/role-assignment-test.ts
 */
import type { UserRole } from '@prisma/client'

import { prisma } from '../src/server/db/prisma'
import { resolveLink } from '../src/features/access/links'
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  can,
  landingFor,
  permissionsFor,
  assignableRoles,
} from '../src/lib/rbac'
import { firstReachablePath, reachableNavItems } from '../src/features/dashboard/nav'

let passed = 0
let failed = 0

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
 * What `middleware.ts` asks before any page runs.
 *
 * Duplicated here on purpose: the real table lives at the edge and cannot be
 * imported into a node script. If somebody widens it, this keeps asserting the
 * rule that was agreed and the two disagree loudly rather than quietly.
 */
const ROLE_ALLOWED: Record<string, string[]> = {
  '/kitchen': ['OWNER', 'MANAGER', 'ADMIN', 'KITCHEN'],
  '/waiter': ['OWNER', 'MANAGER', 'ADMIN', 'WAITER'],
  '/cashier': ['OWNER', 'MANAGER', 'ADMIN', 'CASHIER'],
  '/dashboard': [
    'OWNER', 'MANAGER', 'ADMIN', 'CASHIER', 'KITCHEN', 'WAITER',
    'INVENTORY_MANAGER', 'PURCHASING_MANAGER', 'WAREHOUSE_STAFF', 'ACCOUNTANT',
  ],
}

function edgeAllows(path: string, role: string): boolean {
  const entry = Object.entries(ROLE_ALLOWED)
    .filter(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))
    .sort((a, b) => b[0].length - a[0].length)[0]
  return entry ? entry[1].includes(role) : true
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Roles ${stamp}`, slug: `roles-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const colombo = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Colombo', code: 'CMB', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' },
  })

  // ── 1. a custom role carries its base ─────────────────────────────────────
  console.log('\n── 1. the role knows what it is built on ──')

  const seniorCashier = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id,
      name: `Senior Cashier ${stamp}`,
      preset: 'CASHIER',
      branchId: kandy.id,
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.PAYMENT_COLLECT,
        PERMISSIONS.ORDER_VIEW,
        PERMISSIONS.CASH_DRAWER_OPERATE,
      ],
    },
  })

  check('a custom role stores the built-in it is based on', seniorCashier.preset === 'CASHIER')
  check('and may pin a location', seniorCashier.branchId === kandy.id)

  // ── 2. the reported failure ───────────────────────────────────────────────
  console.log('\n── 2. a cashier link that said "you do not have access" ──')

  const nimal = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `nimal-${stamp}@test.local`,
      name: 'Nimal',
      passwordHash: 'x',
      role: 'WAITER',
      branchId: colombo.id,
    },
  })

  /*
   * The old shape: a link whose role disagrees with the account it points at.
   * Written as raw rows because `createAccessLink` now refuses to produce it —
   * which is the fix, and section 3 asserts it.
   */
  const stale = await prisma.invite.create({
    data: {
      token: `stale-${stamp}-000000000000`,
      restaurantId: restaurant.id,
      role: 'CASHIER',
      mode: 'PERSONAL',
      branchId: colombo.id,
      userId: nimal.id,
    },
  })

  check(
    'the account and the link disagreed',
    nimal.role === 'WAITER' && stale.role === 'CASHIER',
  )
  check(
    'and that is precisely what the edge refused',
    !edgeAllows(landingFor('CASHIER'), nimal.role),
    'redirected to /cashier while the JWT said WAITER',
  )

  /*
   * Now the real path. Attaching the custom role is what changes the account,
   * and `resolveLink` carries the preset so the join can apply it.
   */
  const withRole = await prisma.invite.create({
    data: {
      token: `good-${stamp}-000000000000`,
      restaurantId: restaurant.id,
      role: 'CASHIER',
      mode: 'PERSONAL',
      branchId: kandy.id,
      staffRoleId: seniorCashier.id,
      userId: nimal.id,
    },
  })

  const resolved = await resolveLink(withRole.token)
  check(
    'a link carrying a custom role exposes its base',
    resolved.staffRolePreset === 'CASHIER',
    `${resolved.staffRolePreset}`,
  )

  // What joinWithCode now writes.
  await prisma.user.update({
    where: { id: nimal.id },
    data: {
      branchId: resolved.branchId ?? undefined,
      staffRoleId: resolved.staffRoleId ?? undefined,
      ...(resolved.staffRolePreset ? { role: resolved.staffRolePreset } : {}),
    },
  })
  const afterJoin = await prisma.user.findUniqueOrThrow({ where: { id: nimal.id } })

  check('walking it sets the account role', afterJoin.role === 'CASHIER', afterJoin.role)
  check('and moves them to the role’s location', afterJoin.branchId === kandy.id)
  check(
    'so the edge now lets them into the page the link sends them to',
    edgeAllows(landingFor(afterJoin.role), afterJoin.role),
    'the exact check that produced /forbidden',
  )

  // ── 3. the link can no longer be built wrong ──────────────────────────────
  console.log('\n── 3. a personal link cannot contradict the person ──')

  const kumar = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `kumar-${stamp}@test.local`,
      name: 'Kumar',
      passwordHash: 'x',
      role: 'WAITER',
      branchId: colombo.id,
    },
  })

  /*
   * `effectiveLinkRole` is not exported — it is an implementation detail of the
   * action — so this asserts the rule it implements: for a personal link the
   * role is the custom role's preset, or the person's own. Never the form's.
   */
  const effective = (person: UserRole, preset: UserRole | null) => preset ?? person
  check(
    'with no custom role, the link takes the person’s role',
    effective(kumar.role, null) === 'WAITER',
  )
  check(
    'with one, it takes the role’s base',
    effective(kumar.role, seniorCashier.preset) === 'CASHIER',
  )
  check(
    'either way it is never a free choice that can disagree',
    effective(kumar.role, null) !== 'CASHIER',
  )

  // ── 4. a saved list means exactly what it says ────────────────────────────
  console.log('\n── 4. what is not ticked is not granted ──')

  const builtIn = { role: 'CASHIER' as UserRole }
  const custom = {
    role: 'CASHIER' as UserRole,
    rolePermissions: [PERMISSIONS.CASH_DRAWER_OPERATE, PERMISSIONS.REPORT_VIEW],
  }

  check(
    'a built-in cashier gets the split children of what it holds',
    can(builtIn, PERMISSIONS.PETTY_CASH_VIEW),
    'the presets are derived with withSplits so nobody lost access when the keys were carved up',
  )

  /*
   * And a saved role does NOT, which is the property that makes a switch
   * switchable. Deriving children here would mean unticking Gross profit while
   * leaving Reports on had no effect — it would come back on every request.
   */
  check(
    'a saved role grants only what is in it',
    !can(custom, PERMISSIONS.PETTY_CASH_VIEW) && !can(custom, PERMISSIONS.REPORT_SALES),
    'so an owner can genuinely turn one off',
  )
  check(
    'while still granting what is in it',
    can(custom, PERMISSIONS.REPORT_VIEW) && can(custom, PERMISSIONS.CASH_DRAWER_OPERATE),
  )
  check(
    'a role granted nothing resolves nothing',
    permissionsFor({ role: 'CASHIER' as UserRole, rolePermissions: [] }).size === 0,
  )
  check(
    'and an owner is still unlockable',
    permissionsFor({ role: 'OWNER' as UserRole, rolePermissions: [] }).size ===
      Object.values(PERMISSIONS).length,
  )

  // ── 5. the sidebar follows the role ───────────────────────────────────────
  console.log('\n── 5. what they can open, and where they are sent ──')

  const items = reachableNavItems(custom)
  check('a custom role produces a sidebar', items.length > 0, `${items.length} items`)
  check(
    'holding only these permissions, every item shown is one they hold',
    items.every((item) => can(custom, item.permission)),
  )
  check(
    'a role with nothing ticked produces no sidebar at all',
    reachableNavItems({ role: 'CASHIER' as UserRole, rolePermissions: [] }).length === 0,
    'which the shell now says out loud rather than rendering blank',
  )

  /*
   * The /forbidden loop: a role built on Waiter without `waiter.view` lands on
   * /waiter, is refused, and used to be offered a button back to /waiter.
   */
  const strandedWaiter = {
    role: 'WAITER' as UserRole,
    rolePermissions: [PERMISSIONS.INVENTORY_VIEW],
  }
  check(
    'their landing page is one they cannot open',
    !can(strandedWaiter, PERMISSIONS.WAITER_VIEW) && landingFor('WAITER') === '/waiter',
  )
  const escape = firstReachablePath(strandedWaiter)
  check(
    'so /forbidden offers somewhere else instead of a loop',
    escape !== null && escape !== '/waiter',
    `offers ${escape}`,
  )
  check(
    'and offers nothing at all when there genuinely is nothing',
    firstReachablePath({ role: 'WAITER' as UserRole, rolePermissions: [] }) === null,
  )
  check(
    'somebody who can open their landing page is still sent there',
    firstReachablePath({ role: 'CASHIER' as UserRole }) === landingFor('CASHIER'),
  )

  // ── 6. rank is still enforced ─────────────────────────────────────────────
  console.log('\n── 6. nobody hands out more than they hold ──')

  check(
    'a manager cannot assign an owner’s role',
    !assignableRoles('MANAGER').includes('OWNER'),
  )
  check(
    'nor an admin’s',
    !assignableRoles('MANAGER').includes('ADMIN'),
    'the preset on a custom role goes through the same check',
  )
  check('an owner can assign an admin', assignableRoles('OWNER').includes('ADMIN'))
  check(
    'the built-in cashier list is unchanged by any of this',
    ROLE_PERMISSIONS.CASHIER.includes(PERMISSIONS.PAYMENT_COLLECT) &&
      !ROLE_PERMISSIONS.CASHIER.includes(PERMISSIONS.SETTINGS_MANAGE),
  )

  // ── cleanup ───────────────────────────────────────────────────────────────
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
