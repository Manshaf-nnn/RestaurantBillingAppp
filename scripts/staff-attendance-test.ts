/**
 * Attendance: signing in is clocking in.
 *
 * ── What this is guarding ───────────────────────────────────────────────────
 *
 * `StaffShift` sat in the schema for months with `clockInAt`, `clockOutAt` and
 * both the indexes an attendance report needs, and not one line of code read or
 * wrote it. Wiring it up is easy; wiring it up so the hours are HONEST is the
 * part worth testing, and every check below is a way it could quietly lie:
 *
 *   · a shift that ends when the browser closed rather than when the work did
 *   · a wall-mounted screen billing twelve hours because it was switched on
 *   · a morning at one branch swallowing an evening's sales at another
 *   · a shared tablet clocking in one imaginary employee for ever
 *   · a manager's correction erasing what was actually observed
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/staff-attendance-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  SHIFT_MAX_HOURS,
  autoCloseStale,
  businessDateFor,
  closeShiftForUser,
  effectiveShift,
  isSharedDevice,
  openShift,
  touchShift,
} from '../src/features/attendance/service'
import { getBranchAttendance, getBranchStaffPerformance } from '../src/features/staff/performance'
import { resolveRange } from '../src/features/reports/range'
import { due, resetPresenceThrottle } from '../src/server/auth/presence'

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

const MIN = 60_000
const HOUR = 3_600_000

async function main() {
  const stamp = Date.now().toString(36)

  const shop = await prisma.restaurant.create({
    data: {
      name: `Att ${stamp}`, slug: `att-${stamp}`, status: 'ACTIVE', isActive: true,
      timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  const colombo = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Colombo', code: 'CMB', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Kandy', code: 'KND' },
  })

  const mkUser = (name: string, extra: Record<string, unknown> = {}) =>
    prisma.user.create({
      data: {
        restaurantId: shop.id, name, email: `${name.toLowerCase()}-${stamp}@t.test`,
        passwordHash: 'x', role: 'WAITER', ...extra,
      },
    })

  const priya = await mkUser('Priya', { branchId: colombo.id })
  const screen = await mkUser('Kitchen', {
    email: `device+inv${stamp}@invites.local`, role: 'KITCHEN',
  })
  const operator = await prisma.user.create({
    data: {
      name: 'Platform', email: `ops-${stamp}@t.test`, passwordHash: 'x', role: 'SUPER_ADMIN',
    },
  })

  console.log('\n── 0. The throttle both stamps depend on ───────────────────')

  /*
   * `lastActionAt` and `Session.lastUsedAt` are both written on paths that run
   * on every request, so the throttle is the only thing standing between a
   * useful column and a write per click.
   */
  resetPresenceThrottle()
  check('the first call goes through', due('probe', 60_000))
  check('the second inside the window does not', !due('probe', 60_000))
  check('a different key is unaffected', due('probe-2', 60_000))
  check('and a zero window always allows', due('probe', 0))
  resetPresenceThrottle()
  check('resetting forgets the window', due('probe', 60_000))

  console.log('\n── 1. Signing in opens exactly one shift ───────────────────')

  const first = await openShift(priya.id)
  check('a shift is opened', first !== null)
  check('at the person’s own location', first?.branchId === colombo.id)
  check('and it is open', first?.activeShiftKey === priya.id && first?.clockOutAt === null)

  const again = await openShift(priya.id)
  // A second browser tab, or signing in again after being timed out. Two rows
  // would double a day's hours for somebody who did nothing but log in twice.
  check('signing in again reuses it', again?.id === first?.id, `${again?.id} vs ${first?.id}`)
  check(
    'so there is one row, not two',
    (await prisma.staffShift.count({ where: { userId: priya.id } })) === 1,
  )

  console.log('\n── 2. Who is not a person ──────────────────────────────────')

  check('a shared screen is recognised', isSharedDevice(`device+x@invites.local`))
  check('an ordinary address is not', !isSharedDevice('priya@example.com'))
  // One account, shared by everyone who touches that tablet, for ever. It would
  // clock in when the screen was switched on and never again.
  check('a shared screen opens no shift', (await openShift(screen.id)) === null)
  // No restaurant means no location and no rota. Structural, not a role check.
  check('a platform operator opens no shift', (await openShift(operator.id)) === null)

  console.log('\n── 3. Cover at another branch is its own segment ───────────')

  await touchShift(priya.id)
  await prisma.user.update({ where: { id: priya.id }, data: { branchId: kandy.id } })
  const second = await openShift(priya.id)

  const closedFirst = await prisma.staffShift.findUniqueOrThrow({ where: { id: first!.id } })
  check('the morning shift is closed', closedFirst.clockOutAt !== null)
  check('and says why', closedFirst.closedBy === 'BRANCH_CHANGE', `${closedFirst.closedBy}`)
  check('its key is released', closedFirst.activeShiftKey === null)
  check('a new shift opens at the other branch', second?.branchId === kandy.id)
  check('two segments, not one', (await prisma.staffShift.count({ where: { userId: priya.id } })) === 2)
  // The point of the whole rule: Kandy's evening must not land on Colombo's day.
  check('and they do not overlap', closedFirst.clockOutAt! <= second!.clockInAt)

  console.log('\n── 4. A shift ends when the work did ───────────────────────')

  const workedUntil = new Date(Date.now() - 4 * HOUR)
  await prisma.staffShift.update({
    where: { id: second!.id },
    data: { clockInAt: new Date(Date.now() - 6 * HOUR), lastActionAt: workedUntil },
  })
  await autoCloseStale({ restaurantId: shop.id })

  const idle = await prisma.staffShift.findUniqueOrThrow({ where: { id: second!.id } })
  check('an idle shift is closed', idle.clockOutAt !== null)
  check('marked AUTO_IDLE', idle.closedBy === 'AUTO_IDLE', `${idle.closedBy}`)
  // Not at the moment we noticed: the four silent hours afterwards were not work.
  check(
    'at the last action, not at now',
    Math.abs(idle.clockOutAt!.getTime() - workedUntil.getTime()) < 2000,
    `${idle.clockOutAt?.toISOString()} vs ${workedUntil.toISOString()}`,
  )
  check('which is two hours, not six', effectiveShift(idle).minutes === 120, `${effectiveShift(idle).minutes}`)

  console.log('\n── 5. Nobody works twenty hours ────────────────────────────')

  const marathon = await openShift(priya.id)
  await prisma.staffShift.update({
    where: { id: marathon!.id },
    data: {
      clockInAt: new Date(Date.now() - 20 * HOUR),
      // Still trickling: a screen somebody keeps touching would never look idle.
      lastActionAt: new Date(Date.now() - 1 * MIN),
    },
  })
  await autoCloseStale({ restaurantId: shop.id })
  const capped = await prisma.staffShift.findUniqueOrThrow({ where: { id: marathon!.id } })
  check('a runaway shift is capped', capped.closedBy === 'AUTO_CAP', `${capped.closedBy}`)
  check(
    `at exactly ${SHIFT_MAX_HOURS} hours`,
    Math.abs(capped.clockOutAt!.getTime() - (capped.clockInAt.getTime() + SHIFT_MAX_HOURS * HOUR)) < 2000,
  )

  console.log('\n── 6. Signing out ends it at the last action ───────────────')

  const evening = await openShift(priya.id)
  const stopped = new Date(Date.now() - 30 * MIN)
  await prisma.staffShift.update({
    where: { id: evening!.id },
    data: { clockInAt: new Date(Date.now() - 2 * HOUR), lastActionAt: stopped },
  })
  await closeShiftForUser(priya.id)
  const signedOut = await prisma.staffShift.findUniqueOrThrow({ where: { id: evening!.id } })
  check('closed on sign-out', signedOut.closedBy === 'SIGN_OUT', `${signedOut.closedBy}`)
  // Finishing at ten and signing out at eleven is nine and a half hours, not ten
  // and a half.
  check(
    'at the last action, not at the click',
    Math.abs(signedOut.clockOutAt!.getTime() - stopped.getTime()) < 2000,
  )

  console.log('\n── 7. Past midnight is one shift, on one day ───────────────')

  // 20:00 UTC is 01:30 the next morning in Colombo — so a shift OPENED then
  // belongs to that new day, and one opened at 18:00 local stays on the day it
  // began however late it runs.
  const lateNight = businessDateFor(new Date('2026-08-20T20:00:00.000Z'), 'Asia/Colombo')
  check('the business day is the local one', lateNight.toISOString().slice(0, 10) === '2026-08-21', lateNight.toISOString())
  const teatime = businessDateFor(new Date('2026-08-20T12:30:00.000Z'), 'Asia/Colombo')
  check('an evening start keeps its own day', teatime.toISOString().slice(0, 10) === '2026-08-20')
  check(
    'and UTC would have got it wrong',
    new Date('2026-08-20T20:00:00.000Z').toISOString().slice(0, 10) !== '2026-08-21',
  )

  console.log('\n── 8. A sign-in nobody followed up on is not time worked ───')

  const phantom = await prisma.staffShift.create({
    data: {
      restaurantId: shop.id, userId: priya.id, branchId: colombo.id,
      clockInAt: new Date(Date.now() - 3 * MIN),
      businessDate: businessDateFor(new Date(), 'Asia/Colombo'),
    },
  })
  const eff = effectiveShift(phantom)
  check('it counts as nought minutes', eff.minutes === 0, `${eff.minutes}`)
  check('and is flagged as idle-only', eff.idleOnly)

  console.log('\n── 9. Corrections keep the original ────────────────────────')

  const observedIn = new Date(Date.now() - 5 * HOUR)
  const observedOut = new Date(Date.now() - 4 * HOUR)
  const corrected = await prisma.staffShift.create({
    data: {
      restaurantId: shop.id, userId: priya.id, branchId: colombo.id,
      clockInAt: observedIn, clockOutAt: observedOut, lastActionAt: observedOut,
      businessDate: businessDateFor(observedIn, 'Asia/Colombo'),
      adjustedClockInAt: new Date(Date.now() - 8 * HOUR),
      adjustedClockOutAt: new Date(Date.now() - 4 * HOUR),
      adjustReason: 'Worked the morning, forgot to sign in',
    },
  })
  const fixed = effectiveShift(corrected)
  check('the timesheet uses the correction', fixed.minutes === 240, `${fixed.minutes}`)
  check('it is marked as corrected', fixed.corrected)
  // The whole value of an attendance record is that it cannot be quietly
  // rewritten — both versions survive.
  check('the observed start is untouched', corrected.clockInAt.getTime() === observedIn.getTime())
  check('and so is the observed end', corrected.clockOutAt!.getTime() === observedOut.getTime())

  console.log('\n── 10. The branch tab shows this branch ────────────────────')

  const range = resolveRange({ preset: 'LAST_30', timeZone: 'Asia/Colombo' })
  const atColombo = await getBranchAttendance({
    restaurantId: shop.id, branchId: colombo.id, range,
  })
  const atKandy = await getBranchAttendance({
    restaurantId: shop.id, branchId: kandy.id, range,
  })
  check('Colombo has shifts', atColombo.rows.length > 0)
  check('Kandy has its own', atKandy.rows.length > 0)
  check(
    'and Kandy’s hours are not Colombo’s',
    atColombo.rows[0].totalMinutes !== atKandy.rows[0].totalMinutes,
    `${atColombo.rows[0].totalMinutes} vs ${atKandy.rows[0].totalMinutes}`,
  )
  const onlyMine = await getBranchAttendance({
    restaurantId: shop.id, branchId: colombo.id, range, userId: screen.id,
  })
  check('and one person can be asked for alone', onlyMine.rows.length === 0)

  console.log('\n── 11. Sales attribution ───────────────────────────────────')

  const mkOrder = (channel: 'COUNTER' | 'STAFF' | 'QR', extra: Record<string, unknown>) =>
    prisma.order.create({
      data: {
        restaurantId: shop.id, branchId: colombo.id, orderNumber: `O-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
        type: channel === 'COUNTER' ? 'TAKEAWAY' : 'DINE_IN',
        channel, status: 'COMPLETED', paymentStatus: 'PAID',
        customerName: 'X', customerPhone: '', subtotal: 50_000, grandTotal: 50_000,
        placedAt: new Date(), ...extra,
      },
    })

  await mkOrder('STAFF', { servedById: priya.id, createdById: priya.id })
  await mkOrder('COUNTER', { servedById: priya.id, createdById: priya.id })
  await mkOrder('QR', {})

  const perf = await getBranchStaffPerformance({
    restaurantId: shop.id, branchIds: [colombo.id], range,
  })
  const row = perf.rows.find((r) => r.userId === priya.id)
  // A busy counter would otherwise top a list of the best waiters.
  check('a counter sale is rung, not served', row?.ordersServed === 1 && row?.ordersRung === 2,
    `served ${row?.ordersServed}, rung ${row?.ordersRung}`)
  // A guest ordering from their own phone has no server. The money is real, so
  // it is shown rather than quietly dropped.
  check('a QR order belongs to nobody', perf.unattributed.orders === 1, `${perf.unattributed.orders}`)
  check(
    'and the parts add up to the branch total',
    perf.rows.reduce((sum, r) => sum + r.rungRevenue, 0) + perf.unattributed.revenue ===
      perf.total.revenue,
    `${perf.total.revenue}`,
  )

  console.log('\n── 12. One open shift per person, enforced by the database ──')

  await prisma.staffShift.updateMany({
    where: { userId: priya.id, activeShiftKey: { not: null } },
    data: { activeShiftKey: null, clockOutAt: new Date() },
  })
  const live = await prisma.staffShift.create({
    data: {
      restaurantId: shop.id, userId: priya.id, branchId: colombo.id,
      businessDate: businessDateFor(new Date(), 'Asia/Colombo'),
      activeShiftKey: priya.id,
    },
  })
  let refused = false
  try {
    await prisma.staffShift.create({
      data: {
        restaurantId: shop.id, userId: priya.id, branchId: kandy.id,
        businessDate: businessDateFor(new Date(), 'Asia/Colombo'),
        activeShiftKey: priya.id,
      },
    })
  } catch {
    refused = true
  }
  check('a second open shift is refused by the unique index', refused)
  check('the first is still the live one', (await prisma.staffShift.findUniqueOrThrow({
    where: { activeShiftKey: priya.id },
  })).id === live.id)

  await prisma.order.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.staffShift.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.user.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.user.delete({ where: { id: operator.id } }).catch(() => {})
  await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurant.delete({ where: { id: shop.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
