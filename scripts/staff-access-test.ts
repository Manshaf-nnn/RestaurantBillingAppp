/**
 * Per-staff overrides, several branches per person, and the POS rename
 * (staff.A.md §3, §4, §6, §10).
 *
 * ── Why the deny half is written first ──────────────────────────────────────
 *
 * `permissionsFor` was role defaults ∪ per-user grants, and a union can only
 * ADD. Two written comments — one in the schema, one in `rbac.ts` — said a deny
 * list had been considered and rejected. Section 2 is written to fail against
 * that code: it denies a permission the role grants and asserts the person no
 * longer has it. Under the union that assertion is false, which is the point of
 * writing it first.
 *
 * The argument for reversing the decision is that `permissionsFor` is the ONLY
 * resolver — `can`, `canAny`, `canAll` and `visibleSections` are one-liners over
 * it — so section 3 proves that by checking a denial through each of them
 * rather than trusting the claim.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/staff-access-test.ts
 */
import { readFileSync } from 'node:fs'

import type { UserRole } from '@prisma/client'

import { prisma } from '../src/server/db/prisma'
import {
  PERMISSIONS,
  ROLE_HOME,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  assignableRoles,
  branchScope,
  canActOnRole,
  can,
  canAccessBranch,
  canAll,
  canAny,
  permissionsFor,
  reachOf,
  visibleBranchIds,
} from '../src/lib/rbac'
import { FEATURES, featureForRoute } from '../src/features/access/features'

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

const stamp = Date.now().toString(36)
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.userBranch.deleteMany({ where: { user: { restaurantId: id } } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.staffRole.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  console.log('\n── 1. Several people share one role, and it still says one thing ──')

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Access ${stamp}`, slug: `access-${stamp}`, email: `access-${stamp}@test.local`,
      status: 'ACTIVE', isActive: true, currency: 'LKR', timezone: 'Asia/Colombo',
    },
  })
  restaurantId = restaurant.id

  const [colombo, kandy, ampara] = await Promise.all([
    prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Colombo', code: 'COL', isDefault: true } }),
    prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KAN' } }),
    prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Ampara', code: 'AMP' } }),
  ])

  // A custom role whose list REPLACES the preset — the ordinary case.
  const seniorPos = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id,
      name: `Senior POS ${stamp}`,
      preset: 'POS',
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.ORDER_VIEW,
        PERMISSIONS.ORDER_CREATE,
        PERMISSIONS.PAYMENT_VIEW,
        PERMISSIONS.PAYMENT_COLLECT,
        PERMISSIONS.DISCOUNT_APPLY,
        PERMISSIONS.CASH_DRAWER_OPERATE,
        PERMISSIONS.POS_OPEN_DRAWER,
      ],
      isActive: true,
    },
  })

  const make = (name: string, extra: Record<string, unknown> = {}) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        email: `${name}-${stamp}@test.local`,
        name,
        passwordHash: 'x',
        role: 'POS',
        branchId: colombo.id,
        staffRoleId: seniorPos.id,
        emailVerifiedAt: new Date(),
        ...extra,
      },
    })

  const [nila, ravi] = await Promise.all([make('Nila'), make('Ravi')])

  const subjectFor = (u: { role: UserRole; permissions: string[]; deniedPermissions: string[] }) => ({
    role: u.role,
    permissions: u.permissions,
    deniedPermissions: u.deniedPermissions,
    rolePermissions: seniorPos.permissions,
  })

  check('two people can hold the same role', nila.staffRoleId === ravi.staffRoleId)
  check(
    'and it grants both of them the same thing',
    permissionsFor(subjectFor(nila)).size === permissionsFor(subjectFor(ravi)).size,
  )
  check('including the discount it lists', can(subjectFor(nila), PERMISSIONS.DISCOUNT_APPLY))
  check(
    'and not the refund it does not',
    !can(subjectFor(nila), PERMISSIONS.PAYMENT_REFUND),
  )

  console.log('\n── 2. DENY takes a permission away, and the role cannot put it back ──')
  {
    const denied = await prisma.user.update({
      where: { id: nila.id },
      data: { deniedPermissions: [PERMISSIONS.DISCOUNT_APPLY] },
    })
    const subject = subjectFor(denied)

    check('the role still lists it', seniorPos.permissions.includes(PERMISSIONS.DISCOUNT_APPLY))
    // Written to fail against the union this replaces.
    check('and she no longer has it', !can(subject, PERMISSIONS.DISCOUNT_APPLY))
    check('her colleague on the same role still does', can(subjectFor(ravi), PERMISSIONS.DISCOUNT_APPLY))
    check(
      'nothing else was taken with it',
      can(subject, PERMISSIONS.PAYMENT_COLLECT) && can(subject, PERMISSIONS.ORDER_CREATE),
    )

    /*
     * Deny beats a personal grant too. Otherwise "take this away" would be
     * undone by whatever put it there, which is not a revocation.
     */
    const both = { ...subject, permissions: [PERMISSIONS.DISCOUNT_APPLY] }
    check('deny beats an explicit per-user grant', !can(both, PERMISSIONS.DISCOUNT_APPLY))

    // And it beats the preset when there is no saved role at all.
    const presetOnly = {
      role: 'POS' as UserRole,
      permissions: [],
      deniedPermissions: [PERMISSIONS.PAYMENT_COLLECT],
    }
    check(
      'deny beats the built-in preset',
      ROLE_PERMISSIONS.POS.includes(PERMISSIONS.PAYMENT_COLLECT) &&
        !can(presetOnly, PERMISSIONS.PAYMENT_COLLECT),
    )
  }

  console.log('\n── 3. One resolver, so no check can miss the denial ──')
  {
    const subject = {
      role: 'POS' as UserRole,
      permissions: [],
      deniedPermissions: [PERMISSIONS.PAYMENT_COLLECT],
      rolePermissions: seniorPos.permissions,
    }
    check('can() sees it', !can(subject, PERMISSIONS.PAYMENT_COLLECT))
    check('canAny() sees it', !canAny(subject, [PERMISSIONS.PAYMENT_COLLECT]))
    check('canAll() sees it', !canAll(subject, [PERMISSIONS.ORDER_CREATE, PERMISSIONS.PAYMENT_COLLECT]))
    check('permissionsFor() does not contain it', !permissionsFor(subject).has(PERMISSIONS.PAYMENT_COLLECT))

    const source = readFileSync('src/lib/rbac.ts', 'utf8')
    check(
      'and the subtraction lives in exactly one place',
      (source.match(/granted\.delete\(/g) ?? []).length === 1,
    )
    check(
      'the reversed decision is written down, not silently contradicted',
      source.includes('having said there would not be'),
    )
  }

  console.log('\n── 4. An owner cannot be locked out of their own restaurant ──')
  {
    const owner = {
      role: 'OWNER' as UserRole,
      permissions: [],
      deniedPermissions: [PERMISSIONS.SETTINGS_MANAGE, PERMISSIONS.STAFF_MANAGE],
    }
    check('settings survive a denial', can(owner, PERMISSIONS.SETTINGS_MANAGE))
    check('so does staff management', can(owner, PERMISSIONS.STAFF_MANAGE))
    const operator = { role: 'SUPER_ADMIN' as UserRole, deniedPermissions: [PERMISSIONS.SETTINGS_MANAGE] }
    check('and the platform operator is exempt too', can(operator, PERMISSIONS.SETTINGS_MANAGE))
  }

  console.log('\n── 5. Effective access is exactly role ∪ allow − deny ──')
  {
    const subject = {
      role: 'POS' as UserRole,
      permissions: [PERMISSIONS.INVENTORY_VIEW],
      deniedPermissions: [PERMISSIONS.DISCOUNT_APPLY],
      rolePermissions: seniorPos.permissions,
    }
    const expected = new Set(seniorPos.permissions)
    expected.add(PERMISSIONS.INVENTORY_VIEW)
    expected.delete(PERMISSIONS.DISCOUNT_APPLY)

    const actual = permissionsFor(subject)
    check(
      'the arithmetic holds',
      actual.size === expected.size && [...expected].every((key) => actual.has(key)),
      `${actual.size} vs ${expected.size}`,
    )
  }

  console.log('\n── 6. An override outlives a change to the role ──')
  {
    await prisma.staffRole.update({
      where: { id: seniorPos.id },
      data: { permissions: [...seniorPos.permissions, PERMISSIONS.PAYMENT_REFUND] },
    })
    const after = await prisma.staffRole.findUniqueOrThrow({ where: { id: seniorPos.id } })
    const nilaNow = await prisma.user.findUniqueOrThrow({ where: { id: nila.id } })

    const subject = {
      role: nilaNow.role,
      permissions: nilaNow.permissions,
      deniedPermissions: nilaNow.deniedPermissions,
      rolePermissions: after.permissions,
    }
    check('the role gained a permission', after.permissions.includes(PERMISSIONS.PAYMENT_REFUND))
    check('and she gained it too', can(subject, PERMISSIONS.PAYMENT_REFUND))
    check('but her denial still stands', !can(subject, PERMISSIONS.DISCOUNT_APPLY))
  }

  console.log('\n── 7. Several branches per person (staff.A.md §4) ──')
  {
    await prisma.userBranch.createMany({
      data: [
        { userId: ravi.id, branchId: kandy.id },
        { userId: ravi.id, branchId: ampara.id },
      ],
    })
    const rows = await prisma.userBranch.findMany({
      where: { userId: ravi.id },
      select: { branchId: true },
    })
    const subject = { role: 'POS' as UserRole, branchId: colombo.id, branchIds: rows.map((r) => r.branchId) }

    const reach = visibleBranchIds(subject)
    check('home and extras together', reach !== null && reach.length === 3)
    check('Colombo, because it is home', canAccessBranch(subject, colombo.id))
    check('Kandy, because it was granted', canAccessBranch(subject, kandy.id))
    check('Ampara, because it was granted', canAccessBranch(subject, ampara.id))

    const stranger = await prisma.branch.create({
      data: { restaurantId: restaurant.id, name: 'Galle', code: 'GAL' },
    })
    check('and nothing else', !canAccessBranch(subject, stranger.id))

    const scope = branchScope(subject)
    check(
      'the query scope names all three',
      scope.branchId?.in?.length === 3 && scope.branchId.in.includes(kandy.id),
    )

    // Somebody with no extras is unchanged — the one-branch case must not move.
    const single = { role: 'POS' as UserRole, branchId: colombo.id }
    check('one branch still means one branch', visibleBranchIds(single)?.length === 1)
    check('and no branch still means nothing, not everything', visibleBranchIds({ role: 'POS' })?.length === 0)

    // A cross-location role is unaffected by extras.
    check(
      'an accountant still sees everything',
      visibleBranchIds({ role: 'ACCOUNTANT', branchId: colombo.id, branchIds: [kandy.id] }) === null,
    )

    // The row shape a Prisma read gives back, flattened once.
    const raw = { role: 'POS' as UserRole, branchId: colombo.id, branchAccess: [{ branchId: kandy.id }] }
    check('reachOf flattens a database row', canAccessBranch(reachOf(raw), kandy.id))
    check('and does not widen it', !canAccessBranch(reachOf(raw), ampara.id))

    await prisma.branch.delete({ where: { id: stranger.id } })
  }

  console.log('\n── 8. A closed branch drops out of everybody’s reach ──')
  {
    const doomed = await prisma.branch.create({
      data: { restaurantId: restaurant.id, name: 'Matara', code: 'MAT' },
    })
    await prisma.userBranch.create({ data: { userId: ravi.id, branchId: doomed.id } })
    check('granted', (await prisma.userBranch.count({ where: { branchId: doomed.id } })) === 1)

    await prisma.branch.delete({ where: { id: doomed.id } })
    check(
      'and the grant goes with the branch, with no sweep',
      (await prisma.userBranch.count({ where: { branchId: doomed.id } })) === 0,
    )
  }

  console.log('\n── 9. The same person cannot be granted one branch twice ──')
  {
    let refused = false
    try {
      await prisma.userBranch.create({ data: { userId: ravi.id, branchId: kandy.id } })
    } catch {
      refused = true
    }
    check('the unique index holds', refused)
  }

  console.log('\n── 10. Cashier is POS, everywhere that persists a role ──')
  {
    check('POS is a role', ROLE_LABELS.POS === 'POS')
    check('and it lands on the POS screen', ROLE_HOME.POS === '/cashier/pos?tab=cashier')
    check('CASHIER is retired, not deleted', ROLE_LABELS.CASHIER.includes('old name'))
    check(
      'a retired row still resolves to the same permissions',
      ROLE_PERMISSIONS.CASHIER.length === ROLE_PERMISSIONS.POS.length,
    )

    for (const role of ['OWNER', 'ADMIN', 'MANAGER'] as UserRole[]) {
      check(`${role} may assign POS`, assignableRoles(role).includes('POS'))
      check(`${role} may not assign the retired name`, !assignableRoles(role).includes('CASHIER'))
      /*
       * Creating a role and acting on somebody who holds one are different
       * questions, and retiring a name separated them. A leftover CASHIER row
       * is a person at a till: their password must still be resettable, their
       * sign-in code readable, their access editable. Reusing the create
       * ladder there locked an owner out of their own accounts.
       */
      check(`${role} may still act on a leftover CASHIER account`, canActOnRole(role, 'CASHIER'))
    }
    check('but a POS user still cannot act on a manager', !canActOnRole('POS', 'MANAGER'))
    check('and nobody may act on an owner through it', !canActOnRole('MANAGER', 'OWNER'))

    /*
     * Six columns persist a UserRole, and a half-moved rename is worse than
     * either name — a shift assignment saying CASHIER against a user saying
     * POS reads as two different people. So the migration is checked column by
     * column against the schema, which is the thing that would silently grow a
     * seventh.
     *
     * The migration SQL rather than a row count: a count is a statement about
     * whatever fixtures happen to be in this database, and other suites
     * deliberately create rows on the retired name to prove it still resolves.
     */
    const sql = readFileSync(
      'prisma/migrations/20260926090100_staff_access_pos_branches/migration.sql',
      'utf8',
    )
    const schema = readFileSync('prisma/schema.prisma', 'utf8')
    const persisted: Array<[table: string, column: string]> = [
      ['users', 'role'],
      ['staff_roles', 'preset'],
      ['invites', 'role'],
      ['shift_assignments', 'role'],
      ['staff_shifts', 'roleAtStart'],
      ['shift_templates', 'roles'],
    ]
    check(
      'the schema still has exactly six columns typed UserRole',
      (schema.match(/^[ \t]+\w+[ \t]+UserRole(\[\])?[ ?]?/gm) ?? []).length === persisted.length,
      `${(schema.match(/^[ \t]+\w+[ \t]+UserRole(\[\])?[ ?]?/gm) ?? []).length} found`,
    )
    for (const [table, column] of persisted) {
      check(
        `the migration moves ${table}.${column}`,
        sql.includes(`"${table}"`) && sql.includes(`"${column}"`),
      )
    }
    const applied = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM _prisma_migrations
       WHERE migration_name = '20260926090100_staff_access_pos_branches'
         AND finished_at IS NOT NULL
    `
    check('and it has been applied to this database', Number(applied[0]?.count ?? 0) === 1)

    // The edge gate and the socket server cannot read permissions, so they
    // carry the role list by hand and are the two most likely to be missed.
    const middleware = readFileSync('src/middleware.ts', 'utf8')
    check("the edge gate lets POS into /cashier", /'\/cashier':[^\]]*'POS'/.test(middleware))
    check('and into /dashboard', /'\/dashboard':[\s\S]{0,300}'POS',/.test(middleware))
    const server = readFileSync('server.mjs', 'utf8')
    check('the socket server puts POS in the till room', /POS: \['cashier'\]/.test(server))
  }

  console.log('\n── 11. Opening a till is its own permission (staff.A.md §6) ──')
  {
    const source = readFileSync('src/lib/rbac.ts', 'utf8')
    check(
      'split from the till permission, so nobody loses it on deploy day',
      source.includes('[PERMISSIONS.POS_OPEN_DRAWER, PERMISSIONS.CASH_DRAWER_OPERATE]'),
    )
    check(
      'every built-in role that works a till keeps it',
      (Object.keys(ROLE_PERMISSIONS) as UserRole[])
        .filter((role) => ROLE_PERMISSIONS[role].includes(PERMISSIONS.CASH_DRAWER_OPERATE))
        .every((role) => ROLE_PERMISSIONS[role].includes(PERMISSIONS.POS_OPEN_DRAWER)),
    )

    // Four enforcement points, because hiding a button is not access control.
    const action = readFileSync('src/features/cashdrawer/actions.ts', 'utf8')
    check(
      'the action requires it',
      /openDrawerAction[\s\S]{0,900}requirePermission\(PERMISSIONS\.POS_OPEN_DRAWER\)/.test(action),
    )
    const page = readFileSync('src/app/cashier/session/page.tsx', 'utf8')
    check('the opening-float page requires it', page.includes('PERMISSIONS.POS_OPEN_DRAWER'))
    const console_ = readFileSync('src/features/cashdrawer/components/drawer-console.tsx', 'utf8')
    check('the form is not rendered without it', console_.includes('data.canOpen'))
    const gate = readFileSync('src/features/cashdrawer/gate.ts', 'utf8')
    check(
      'and nobody is forced to a door they cannot open',
      gate.includes('PERMISSIONS.POS_OPEN_DRAWER'),
    )

    // Registered, or the role builder cannot grant it and the lint fails.
    const registered = FEATURES.flatMap((f) => f.actions.map((a) => a.permission))
    check('the role builder can grant it', registered.includes(PERMISSIONS.POS_OPEN_DRAWER))
    check(
      'and the opening-float screen belongs to the cash drawer, not payments',
      featureForRoute('/cashier/session')?.key === 'cashDrawer',
    )
  }

  console.log('\n── 12. The effective-access screen is guarded ──')
  {
    const page = readFileSync('src/app/dashboard/staff/[userId]/access/page.tsx', 'utf8')
    check('by the staff permission', page.includes('PERMISSIONS.STAFF_MANAGE'))
    check('and by the record’s own branch', page.includes('assertRecordBranch('))
    check('an owner cannot be restricted there', page.includes('untouchable'))
    check(
      'it computes the final answer with the same function every guard uses',
      page.includes('permissionsFor('),
    )

    const actions = readFileSync('src/features/staff/actions.ts', 'utf8')
    check('the write refuses self-edits', /setStaffPermissions[\s\S]{0,2600}SELF_EDIT/.test(actions))
    check(
      'refuses to grant what the grantor lacks',
      /setStaffPermissions[\s\S]{0,3000}assertNoEscalation\(admin, data\.allow\)/.test(actions),
    )
    check(
      'and records before and after',
      /setStaffPermissions[\s\S]{0,3400}AUDIT_ACTIONS\.STAFF_PERMISSIONS_SET/.test(actions),
    )
  }
}

main()
  .catch((error) => {
    failed += 1
    console.error('\n  ✗ crashed:', error)
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
