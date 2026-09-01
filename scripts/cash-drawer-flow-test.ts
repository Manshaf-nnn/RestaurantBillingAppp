/**
 * The drawer nobody closed.
 *
 * A cashier goes home mid-shift and the till sits OPEN overnight. Nothing in
 * the app used to say so — the session just aged quietly until a manager
 * happened to open the right screen. Now loading the dashboard or the drawer
 * screen flags it to MANAGEMENT, once.
 *
 * Two properties carry the feature and both are easy to lose:
 *
 *   · "overnight" means the RESTAURANT's midnight, not the server's. This
 *     deployment runs in UTC; a Colombo till judged by server midnight would be
 *     flagged five and a half hours wrong in whichever direction hurts.
 *   · exactly ONE notification per drawer, however many times the page loads.
 *     A bell that fills with duplicates is a bell nobody reads.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/cash-drawer-flow-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { flagForgottenDrawers, forceCloseDrawer, openDrawer } from '../src/features/cashdrawer/service'
import { PERMISSIONS, permissionsFor } from '../src/lib/rbac'

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

async function main() {
  const stamp = Date.now().toString(36)

  console.log('\n0. Who may sign off a cash difference')

  /*
   * The split the owner asked for: a manager keeps every other drawer power —
   * seeing all of them, force-closing an abandoned one — but confirming a big
   * gap has been looked at is the owner's or admin's act. Still grantable from
   * the roles screen if a restaurant decides otherwise.
   */
  check('an owner holds the sign-off permission',
    permissionsFor({ role: 'OWNER' }).has(PERMISSIONS.CASH_VARIANCE_REVIEW))
  check('so does an admin',
    permissionsFor({ role: 'ADMIN' }).has(PERMISSIONS.CASH_VARIANCE_REVIEW))
  check('a manager does NOT, while keeping every other drawer power',
    !permissionsFor({ role: 'MANAGER' }).has(PERMISSIONS.CASH_VARIANCE_REVIEW) &&
      permissionsFor({ role: 'MANAGER' }).has(PERMISSIONS.CASH_DRAWER_MANAGE))
  check('and a cashier holds neither',
    !permissionsFor({ role: 'CASHIER' }).has(PERMISSIONS.CASH_VARIANCE_REVIEW) &&
      !permissionsFor({ role: 'CASHIER' }).has(PERMISSIONS.CASH_DRAWER_MANAGE))
  const TZ = 'Asia/Colombo'

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Forgot ${stamp}`, slug: `forgot-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', timezone: TZ,
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `c-${stamp}@forgot.test`, name: 'Kumar',
      role: 'CASHIER', passwordHash: 'x', staffCode: 'W-0001', branchId: branch.id,
    },
  })
  const boss = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `b-${stamp}@forgot.test`, name: 'Owner',
      role: 'OWNER', passwordHash: 'x', staffCode: 'W-0002',
    },
  })

  const notifications = () =>
    prisma.notification.count({
      where: { restaurantId: restaurant.id, type: 'SYSTEM' },
    })

  console.log('\n1. A drawer opened today is not "forgotten"')

  const fresh = await openDrawer({
    restaurantId: restaurant.id, userId: cashier.id, branchId: branch.id,
    openingFloat: 10_000_00,
  })
  const none = await flagForgottenDrawers({ restaurantId: restaurant.id, timezone: TZ })
  check('nothing is flagged', none === 0 && (await notifications()) === 0)

  console.log('\n2. One opened before the restaurant’s midnight is')

  /*
   * Backdate the session to yesterday IN COLOMBO. 30 hours ago is safely across
   * any timezone's midnight, so the assertion cannot flake on when the suite
   * happens to run.
   */
  await prisma.cashDrawerSession.update({
    where: { id: fresh.id },
    data: { openedAt: new Date(Date.now() - 30 * 60 * 60 * 1000) },
  })

  const flagged = await flagForgottenDrawers({ restaurantId: restaurant.id, timezone: TZ })
  check('exactly one notification is raised', flagged === 1 && (await notifications()) === 1)

  const note = await prisma.notification.findFirstOrThrow({
    where: { restaurantId: restaurant.id, type: 'SYSTEM' },
  })
  check('it goes to the managers', note.audience === 'MANAGEMENT', String(note.audience))
  check('it names the cashier', note.title.includes('Kumar'), note.title)
  check(
    'and carries a way to the screen that fixes it',
    (note.data as { href?: string })?.href === '/dashboard/cash-drawer',
  )

  console.log('\n3. Reloading does not nag')

  const again = await flagForgottenDrawers({ restaurantId: restaurant.id, timezone: TZ })
  const andAgain = await flagForgottenDrawers({ restaurantId: restaurant.id, timezone: TZ })
  check('five refreshes are still one bell entry',
    again === 0 && andAgain === 0 && (await notifications()) === 1)

  console.log('\n4. The owner closes it — count optional')

  const closed = await forceCloseDrawer({
    restaurantId: restaurant.id,
    sessionId: fresh.id,
    countedCash: null,
    // Deliberately no reason: "went home and forgot" is the ordinary case and
    // must not require a typed sentence at 9am.
    userId: boss.id,
    actor: {
      id: boss.id, role: 'OWNER', branchId: null,
      canManageOthers: true, canReviewVariance: true,
    },
  })
  check('it closes without a count and without a typed reason',
    closed.session.status === 'CLOSED' && closed.session.variance === null)
  check('marked as closed on the cashier’s behalf', closed.session.closedOnBehalf)

  const after = await flagForgottenDrawers({ restaurantId: restaurant.id, timezone: TZ })
  check('a closed drawer is never flagged again', after === 0 && (await notifications()) === 1)

  await prisma.notification.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.cashMovement.deleteMany({ where: { session: { restaurantId: restaurant.id } } })
  await prisma.cashDrawerSession.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.cashRegister.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
