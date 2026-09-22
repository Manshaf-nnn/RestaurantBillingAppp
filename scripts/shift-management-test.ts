/**
 * Shift management and the rebuilt handover (shifthandover.md).
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *
 *   §1 templates — who may define them, the overnight window, name clashes
 *   §2 the rota — branch isolation, the role fits the shift, no duplicates,
 *      no overlaps, cancel with a reason, two concurrent assigns → one row
 *   §3 starting a shift — links the sign-in session or opens one; only your
 *      own, only PLANNED, only today; two concurrent starts → one session;
 *      one active shift at a time
 *   §4 the till is counted blind — expected cash is null on the wire to the
 *      cashier and a number to a manager; counts become the total; no
 *      reason is demanded; over the threshold stops for review; the stored
 *      snapshot carries the reconciliation
 *   §5 accept ends the outgoing shift (HANDOVER), completes its assignment,
 *      links the receiver's rostered shift, and rewrites no history
 *   §6 one pending handover per person, enforced by the database
 *   §7 histories filter and never cross a branch; the Shift card
 *   §8 the exports carry the same rows
 *   §9 source pins — one panel at two doors, the blind count, the deliberate
 *      change
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/shift-management-test.ts
 */
import { readFileSync, existsSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { PERMISSIONS, can } from '../src/lib/rbac'
import { openDrawer } from '../src/features/cashdrawer/service'
import { denominationsFor } from '../src/features/cashdrawer/denominations'
import { openShift } from '../src/features/attendance/service'
import {
  acceptShiftHandover,
  buildHandoverSummary,
  listShiftHandovers,
  startShiftHandover,
} from '../src/features/handover/shift-service'
import type { HandoverSummary } from '../src/features/handover/shift-types'
import {
  assignShift,
  cancelShiftAssignment,
  createShiftTemplate,
  scheduledWindow,
  setShiftTemplateActive,
  startAssignedShift,
  updateShiftTemplate,
  zonedToUtc,
} from '../src/features/shifts/service'
import { getCurrentShift, listShiftHistory, listShiftTemplates } from '../src/features/shifts/queries'
import { buildShiftExport } from '../src/features/shifts/export'

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

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(`${code} ${message}`), `wrong reason: ${code} ${message}`)
  }
}

const stamp = Date.now().toString(36)
const TZ = 'Asia/Colombo'
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.shiftHandover.deleteMany({ where: { restaurantId: id } })
  await prisma.notification.deleteMany({ where: { restaurantId: id } })
  await prisma.cashHandover.deleteMany({ where: { restaurantId: id } })
  await prisma.cashMovement.deleteMany({ where: { session: { restaurantId: id } } })
  await prisma.cashDrawerSession.deleteMany({ where: { restaurantId: id } })
  await prisma.staffShift.deleteMany({ where: { restaurantId: id } })
  await prisma.shiftAssignment.deleteMany({ where: { restaurantId: id } })
  await prisma.shiftTemplate.deleteMany({ where: { restaurantId: id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

function hourIn(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' }).format(at))
}

function todayKey(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** A denomination map that sums to exactly `total`, greedy from the largest. */
function countsFor(currency: string, total: number): Record<string, number> {
  const out: Record<string, number> = {}
  let left = total
  for (const d of denominationsFor(currency)) {
    const n = Math.floor(left / d.value)
    if (n > 0) {
      out[String(d.value)] = n
      left -= n * d.value
    }
  }
  if (left !== 0) throw new Error(`cannot make ${total} from ${currency} denominations`)
  return out
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Rota Co', slug: `rota-${stamp}`, email: `rota-${stamp}@test.local`, timezone: TZ, currency: 'LKR' },
  })
  restaurantId = restaurant.id
  const kandy = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true } })
  const jaffna = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Jaffna', code: 'JAF' } })

  type Role = 'OWNER' | 'MANAGER' | 'WAITER' | 'KITCHEN' | 'CASHIER'
  const mk = (name: string, role: Role, branchId: string | null) =>
    prisma.user.create({
      data: { restaurantId: restaurant.id, email: `${name.toLowerCase()}-${stamp}@test.local`, name, passwordHash: 'x', role, branchId },
    })
  const owner = await mk('Owner', 'OWNER', null)
  const mira = await mk('Mira', 'MANAGER', kandy.id)
  const jai = await mk('Jai', 'MANAGER', jaffna.id)
  const cal = await mk('Cal', 'CASHIER', kandy.id)
  const cleo = await mk('Cleo', 'CASHIER', kandy.id)
  const wanda = await mk('Wanda', 'WAITER', kandy.id)
  const will = await mk('Will', 'WAITER', kandy.id)
  const wes = await mk('Wes', 'WAITER', kandy.id)
  const kim = await mk('Kim', 'KITCHEN', kandy.id)
  const wren = await mk('Wren', 'WAITER', jaffna.id)

  type U = typeof owner
  const actor = (u: U) => ({ id: u.id, role: u.role, branchId: u.branchId })
  const person = (u: U) => ({ id: u.id, name: u.name, role: u.role, branchId: u.branchId })
  const drawerActor = (u: U) => ({ id: u.id, role: u.role, branchId: u.branchId, canManageOthers: u.role === 'MANAGER' || u.role === 'OWNER' })
  const today = todayKey()

  console.log('\n── 1. Templates: the kinds of shift ──')
  const day = await createShiftTemplate({
    restaurantId: restaurant.id, actor: actor(owner), name: 'Day', startTime: '08:00', endTime: '16:00',
    roles: ['CASHIER', 'WAITER'], branchId: null,
  })
  check('the owner defines a Day shift for every location', day.branchId === null && day.roles.length === 2 && day.isActive)
  const night = await createShiftTemplate({
    restaurantId: restaurant.id, actor: actor(owner), name: 'Night', startTime: '18:00', endTime: '02:00',
    roles: ['CASHIER', 'WAITER', 'KITCHEN'], branchId: kandy.id,
  })
  {
    const win = scheduledWindow(night, today, TZ)
    check('an overnight shift ends the next day, eight hours later', win.end.getTime() - win.start.getTime() === 8 * 3600_000)
    check('and starts at 18:00 on the restaurant\'s own clock', hourIn(win.start, TZ) === 18 && hourIn(win.end, TZ) === 2)
    check('the day window is on the right day', zonedToUtc(today, '08:00', TZ).getTime() === scheduledWindow(day, today, TZ).start.getTime())
  }
  await refuses('the same name twice for every location', () =>
    createShiftTemplate({ restaurantId: restaurant.id, actor: actor(owner), name: 'day', startTime: '09:00', endTime: '17:00', roles: ['WAITER'], branchId: null }),
    /SHIFT_TEMPLATE_EXISTS/)
  await refuses('a shift nobody can work', () =>
    createShiftTemplate({ restaurantId: restaurant.id, actor: actor(owner), name: 'Ghost', startTime: '09:00', endTime: '17:00', roles: [], branchId: null }),
    /SHIFT_TEMPLATE_ROLES/)
  await refuses('a time that is not a time', () =>
    createShiftTemplate({ restaurantId: restaurant.id, actor: actor(owner), name: 'Odd', startTime: '9am', endTime: '17:00', roles: ['WAITER'], branchId: null }),
    /SHIFT_BAD_TIME/)
  await refuses('a manager at another site cannot define a shift here', () =>
    createShiftTemplate({ restaurantId: restaurant.id, actor: actor(jai), name: 'Jaffna Day', startTime: '08:00', endTime: '16:00', roles: ['WAITER'], branchId: kandy.id }),
    /another|not yours|Forbidden/i)
  check('templates are the owner\'s to define, not the manager\'s',
    can({ role: 'OWNER' }, PERMISSIONS.SHIFT_TEMPLATE_MANAGE) && can({ role: 'ADMIN' }, PERMISSIONS.SHIFT_TEMPLATE_MANAGE) && !can({ role: 'MANAGER' }, PERMISSIONS.SHIFT_TEMPLATE_MANAGE))
  check('the rota is the manager\'s too', can({ role: 'MANAGER' }, PERMISSIONS.SHIFT_ASSIGN) && !can({ role: 'CASHIER' }, PERMISSIONS.SHIFT_ASSIGN))
  check('everyone who hands a shift on can see their own shift', can({ role: 'CASHIER' }, PERMISSIONS.SHIFT_VIEW) && can({ role: 'KITCHEN' }, PERMISSIONS.SHIFT_VIEW) && can({ role: 'STOCK_KEEPER' }, PERMISSIONS.SHIFT_VIEW))
  {
    const { after } = await updateShiftTemplate({
      restaurantId: restaurant.id, actor: actor(owner), templateId: day.id, name: 'Day', startTime: '08:00', endTime: '16:30',
      roles: ['CASHIER', 'WAITER'], branchId: null,
    })
    check('editing changes the template', after.endTime === '16:30')
    const seen = await listShiftTemplates({ restaurantId: restaurant.id, branchIds: [jaffna.id] })
    check('Jaffna sees the group-wide Day shift and not Kandy\'s Night', seen.some((t) => t.id === day.id) && !seen.some((t) => t.id === night.id))
  }

  console.log('\n── 2. The rota ──')
  const calDay = await assignShift({
    restaurantId: restaurant.id, actor: actor(mira), userId: cal.id, templateId: day.id, branchId: kandy.id, dateKey: today, timeZone: TZ,
  })
  check('a manager rosters a cashier onto Day today', calDay.status === 'PLANNED' && calDay.role === 'CASHIER' && calDay.createdById === mira.id)
  check('with the scheduled instants snapshotted', hourIn(calDay.scheduledStartAt, TZ) === 8 && calDay.scheduledEndAt > calDay.scheduledStartAt)
  await refuses('a cook is not a role the Day shift is for', () =>
    assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: kim.id, templateId: day.id, branchId: kandy.id, dateKey: today, timeZone: TZ }),
    /SHIFT_ROLE_MISMATCH/)
  await refuses('somebody from Jaffna cannot be rostered at Kandy', () =>
    assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: wren.id, templateId: day.id, branchId: kandy.id, dateKey: today, timeZone: TZ }),
    /SHIFT_CROSSES_BRANCH/)
  await refuses('the Jaffna manager cannot roster at Kandy', () =>
    assignShift({ restaurantId: restaurant.id, actor: actor(jai), userId: wanda.id, templateId: day.id, branchId: kandy.id, dateKey: today, timeZone: TZ }),
    /not yours|Forbidden/i)
  await refuses('Kandy\'s Night shift cannot be used at Jaffna', () =>
    assignShift({ restaurantId: restaurant.id, actor: actor(owner), userId: wren.id, templateId: night.id, branchId: jaffna.id, dateKey: today, timeZone: TZ }),
    /SHIFT_TEMPLATE_OTHER_BRANCH/)
  await refuses('the same person on the same shift twice', () =>
    assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: cal.id, templateId: day.id, branchId: kandy.id, dateKey: today, timeZone: TZ }),
    /SHIFT_OVERLAP|SHIFT_DUPLICATE/)
  await refuses('the database refuses the duplicate on its own', async () => {
    await prisma.shiftAssignment.create({
      data: {
        restaurantId: restaurant.id, branchId: kandy.id, userId: cal.id, role: 'CASHIER', templateId: day.id,
        date: new Date(`${today}T00:00:00.000Z`), scheduledStartAt: calDay.scheduledStartAt, scheduledEndAt: calDay.scheduledEndAt,
      },
    })
  }, /P2002|Unique/)
  const evening = await createShiftTemplate({
    restaurantId: restaurant.id, actor: actor(owner), name: 'Evening', startTime: '14:00', endTime: '22:00', roles: ['CASHIER', 'WAITER'], branchId: null,
  })
  await refuses('an overlapping second shift', () =>
    assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: cal.id, templateId: evening.id, branchId: kandy.id, dateKey: today, timeZone: TZ }),
    /SHIFT_OVERLAP/)
  {
    const results = await Promise.allSettled([
      assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: wanda.id, templateId: day.id, branchId: kandy.id, dateKey: today, timeZone: TZ }),
      assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: wanda.id, templateId: day.id, branchId: kandy.id, dateKey: today, timeZone: TZ }),
    ])
    const rows = await prisma.shiftAssignment.count({ where: { userId: wanda.id, templateId: day.id } })
    check('two concurrent assigns leave exactly one row', results.filter((r) => r.status === 'fulfilled').length === 1 && rows === 1)
  }
  {
    const wesDay = await assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: wes.id, templateId: day.id, branchId: kandy.id, dateKey: today, timeZone: TZ })
    await refuses('cancelling needs a reason', () => cancelShiftAssignment({ restaurantId: restaurant.id, actor: actor(mira), assignmentId: wesDay.id, reason: ' ' }), /SHIFT_NO_REASON/)
    const gone = await cancelShiftAssignment({ restaurantId: restaurant.id, actor: actor(mira), assignmentId: wesDay.id, reason: 'called in sick' })
    check('cancelled with the reason kept', gone.status === 'CANCELLED' && gone.cancelReason === 'called in sick' && gone.cancelledById === mira.id)
    await refuses('cancelling twice', () => cancelShiftAssignment({ restaurantId: restaurant.id, actor: actor(mira), assignmentId: wesDay.id, reason: 'again' }), /SHIFT_NOT_PLANNED/)
    await refuses('a manager at another site cannot cancel it', () => cancelShiftAssignment({ restaurantId: restaurant.id, actor: actor(jai), assignmentId: calDay.id, reason: 'no' }), /another|Forbidden/i)
    const retired = await setShiftTemplateActive({ restaurantId: restaurant.id, actor: actor(owner), templateId: evening.id, isActive: false })
    check('a template is retired, never deleted', !retired.isActive)
    await refuses('nobody new goes onto a retired shift', () =>
      assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: will.id, templateId: evening.id, branchId: kandy.id, dateKey: today, timeZone: TZ }),
      /SHIFT_TEMPLATE_INACTIVE/)
    await setShiftTemplateActive({ restaurantId: restaurant.id, actor: actor(owner), templateId: evening.id, isActive: true })
  }

  console.log('\n── 3. Starting the shift you were rostered on ──')
  {
    const { shift, assignment } = await startAssignedShift({ restaurantId: restaurant.id, user: actor(cal), assignmentId: calDay.id, timeZone: TZ })
    check('Cal starts Day: a session opens, linked to the rota', shift.assignmentId === calDay.id && shift.activeShiftKey === cal.id && shift.source === 'MANUAL' && assignment.status === 'STARTED')
    check('with the role and the scheduled times snapshotted', shift.roleAtStart === 'CASHIER' && shift.scheduledStartAt?.getTime() === calDay.scheduledStartAt.getTime())
    await refuses('starting it twice', () => startAssignedShift({ restaurantId: restaurant.id, user: actor(cal), assignmentId: calDay.id, timeZone: TZ }), /SHIFT_NOT_PLANNED/)
    const calNight = await assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: cal.id, templateId: night.id, branchId: kandy.id, dateKey: today, timeZone: TZ })
    await refuses('one active shift at a time', () => startAssignedShift({ restaurantId: restaurant.id, user: actor(cal), assignmentId: calNight.id, timeZone: TZ }), /SHIFT_ALREADY_ACTIVE/)
    await cancelShiftAssignment({ restaurantId: restaurant.id, actor: actor(mira), assignmentId: calNight.id, reason: 'not tonight' })
  }
  {
    const wandaDay = await prisma.shiftAssignment.findFirstOrThrow({ where: { userId: wanda.id, templateId: day.id } })
    await refuses('somebody else cannot start your shift', () => startAssignedShift({ restaurantId: restaurant.id, user: actor(will), assignmentId: wandaDay.id, timeZone: TZ }), /somebody else|Forbidden/i)
    const signedIn = await openShift(wanda.id)
    const { shift } = await startAssignedShift({ restaurantId: restaurant.id, user: actor(wanda), assignmentId: wandaDay.id, timeZone: TZ })
    check('signing in first, then starting: the same session is linked, not a second one', signedIn !== null && shift.id === signedIn.id && shift.assignmentId === wandaDay.id && shift.source === 'LOGIN')
    check('and there is still one open shift for her', (await prisma.staffShift.count({ where: { userId: wanda.id, activeShiftKey: { not: null } } })) === 1)
  }
  {
    const tomorrow = await assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: will.id, templateId: day.id, branchId: kandy.id, dateKey: addDays(today, 1), timeZone: TZ })
    await refuses('tomorrow\'s shift cannot be started today', () => startAssignedShift({ restaurantId: restaurant.id, user: actor(will), assignmentId: tomorrow.id, timeZone: TZ }), /SHIFT_NOT_TODAY/)
  }
  {
    const kimNight = await assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: kim.id, templateId: night.id, branchId: kandy.id, dateKey: today, timeZone: TZ })
    const results = await Promise.allSettled([
      startAssignedShift({ restaurantId: restaurant.id, user: actor(kim), assignmentId: kimNight.id, timeZone: TZ }),
      startAssignedShift({ restaurantId: restaurant.id, user: actor(kim), assignmentId: kimNight.id, timeZone: TZ }),
    ])
    const sessions = await prisma.staffShift.count({ where: { userId: kim.id } })
    check('two concurrent starts leave exactly one session', results.filter((r) => r.status === 'fulfilled').length === 1 && sessions === 1)
  }

  console.log('\n── 4. The till is counted blind ──')
  await openDrawer({ restaurantId: restaurant.id, branchId: kandy.id, openingFloat: 5_000_00, userId: cal.id, userBranchId: cal.branchId })
  const calSession = await prisma.cashDrawerSession.findFirstOrThrow({ where: { restaurantId: restaurant.id, openedById: cal.id, status: 'OPEN' } })
  {
    const blind = await buildHandoverSummary({ restaurantId: restaurant.id, branchId: kandy.id, user: person(cal), timeZone: TZ, revealExpected: false })
    check('the cashier\'s preview carries no expected figure — null on the wire', blind.summary.drawer !== null && blind.summary.drawer!.expectedCash === null && blind.summary.drawer!.variance === null)
    check('but does carry the opening cash and the sales so far', blind.summary.drawer!.openingFloat === 5_000_00 && blind.summary.drawer!.cashSales === 0)
    check('and the rostered shift', blind.summary.shift?.templateName === 'Day')
    const seen = await buildHandoverSummary({ restaurantId: restaurant.id, branchId: kandy.id, user: person(cal), timeZone: TZ, revealExpected: true })
    check('a manager\'s view of the same shift has the number', seen.summary.drawer!.expectedCash === 5_000_00)
    check('the summary counts what is waiting — orders, transfers, deliveries', seen.summary.orders.pending === 0 && seen.summary.transfers?.toDispatch === 0 && seen.summary.deliveriesToReceive === 0)
  }
  // Cleo takes over: she is rostered on Evening today, not yet started.
  const cleoEvening = await assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: cleo.id, templateId: evening.id, branchId: kandy.id, dateKey: today, timeZone: TZ })
  const counts = countsFor('LKR', 4_400_00)
  const before = {
    orders: await prisma.order.count({ where: { restaurantId: restaurant.id } }),
    payments: await prisma.payment.count({ where: { restaurantId: restaurant.id } }),
    movements: await prisma.cashMovement.count({ where: { session: { restaurantId: restaurant.id } } }),
  }
  const handover = await startShiftHandover({
    restaurantId: restaurant.id, from: person(cal), actor: drawerActor(cal), branchId: kandy.id, toUserId: cleo.id, timeZone: TZ, counts,
  })
  {
    const cash = await prisma.cashHandover.findUniqueOrThrow({ where: { id: handover.cashHandoverId! } })
    check('the counts became the total; short by 600 with no reason asked for', cash.countedAmount === 4_400_00 && cash.variance === -600_00)
    const closed = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: calSession.id } })
    check('the outgoing session closed with the counts on it', closed.status !== 'OPEN' && closed.countedCash === 4_400_00 && JSON.stringify(closed.closingCounts) === JSON.stringify(counts))
    check('over the threshold, it stops for a manager — exactly as a normal close', closed.status === 'PENDING_REVIEW' && closed.varianceReason === null)
    const stored = handover.summary as unknown as HandoverSummary
    check('the stored snapshot carries the reconciliation, written after submission',
      stored.drawer?.expectedCash === 5_000_00 && stored.drawer.countedCash === 4_400_00 && stored.drawer.variance === -600_00 && stored.drawer.needsReview === true)
    check('one in flight per person, keyed', handover.pendingFromKey === cal.id && handover.pendingToKey === cleo.id && handover.fromShiftId !== null)
  }

  console.log('\n── 5. Accepting ends the outgoing shift and rewrites nothing ──')
  {
    const { handover: done, sessionId, linkedAssignmentId } = await acceptShiftHandover({
      restaurantId: restaurant.id, handoverId: handover.id, user: person(cleo), actor: drawerActor(cleo), timeZone: TZ,
    })
    check('accepted; the till is Cleo\'s', done.status === 'COMPLETED' && sessionId !== null && done.pendingFromKey === null && done.pendingToKey === null)
    const calShift = await prisma.staffShift.findFirstOrThrow({ where: { userId: cal.id } })
    check('Cal\'s shift ended by the handover', calShift.closedBy === 'HANDOVER' && calShift.activeShiftKey === null && calShift.clockOutAt !== null)
    check('and his rostered Day is complete', (await prisma.shiftAssignment.findUniqueOrThrow({ where: { id: calDay.id } })).status === 'COMPLETED')
    const cleoShift = await prisma.staffShift.findFirst({ where: { userId: cleo.id, activeShiftKey: cleo.id } })
    check('Cleo\'s rostered Evening started as she took over', linkedAssignmentId === cleoEvening.id && cleoShift?.assignmentId === cleoEvening.id)
    const after = {
      orders: await prisma.order.count({ where: { restaurantId: restaurant.id } }),
      payments: await prisma.payment.count({ where: { restaurantId: restaurant.id } }),
      movements: await prisma.cashMovement.count({ where: { session: { restaurantId: restaurant.id } } }),
    }
    const closed = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: calSession.id } })
    check('history untouched: orders, payments, movements, the closed count', JSON.stringify(before) === JSON.stringify(after) && closed.countedCash === 4_400_00 && closed.expectedCash === 5_000_00)
    await refuses('accepting twice', () => acceptShiftHandover({ restaurantId: restaurant.id, handoverId: handover.id, user: person(cleo), actor: drawerActor(cleo), timeZone: TZ }), /HANDOVER_SETTLED/)
  }

  console.log('\n── 6. One pending handover per person, in the database ──')
  {
    const pending = await startShiftHandover({ restaurantId: restaurant.id, from: person(wanda), actor: drawerActor(wanda), branchId: kandy.id, toUserId: will.id, timeZone: TZ })
    await refuses('a second one to the same receiver', () =>
      startShiftHandover({ restaurantId: restaurant.id, from: person(wes), actor: drawerActor(wes), branchId: kandy.id, toUserId: will.id, timeZone: TZ }),
      /HANDOVER_ALREADY_PENDING/)
    await refuses('and the database refuses it even past the check', async () => {
      await prisma.shiftHandover.create({
        data: {
          restaurantId: restaurant.id, branchId: kandy.id, fromUserId: wes.id, toUserId: will.id,
          pendingFromKey: wes.id, pendingToKey: will.id, summary: {},
        },
      })
    }, /P2002|Unique/)
    check('the pending one is intact', (await prisma.shiftHandover.findUniqueOrThrow({ where: { id: pending.id } })).status === 'PENDING_ACCEPTANCE')
  }

  console.log('\n── 7. Histories and the Shift card ──')
  {
    const kandyRows = await listShiftHistory({ restaurantId: restaurant.id, branchIds: [kandy.id] })
    check('Kandy\'s shift history has Cal\'s Day, ended by handover', kandyRows.some((r) => r.userId === cal.id && r.templateName === 'Day' && r.closedBy === 'HANDOVER' && !r.onShift))
    check('and Cleo still on Evening', kandyRows.some((r) => r.userId === cleo.id && r.templateName === 'Evening' && r.onShift))
    check('Jaffna sees none of it', (await listShiftHistory({ restaurantId: restaurant.id, branchIds: [jaffna.id] })).length === 0)
    check('filtered to one person', (await listShiftHistory({ restaurantId: restaurant.id, branchIds: null, userId: cal.id })).every((r) => r.userId === cal.id))
    check('searched by name', (await listShiftHistory({ restaurantId: restaurant.id, branchIds: null, q: 'cle' })).every((r) => r.userName === 'Cleo'))
    check('filtered to a shift', (await listShiftHistory({ restaurantId: restaurant.id, branchIds: null, templateId: day.id })).every((r) => r.templateName === 'Day'))
    const handovers = await listShiftHandovers({ restaurantId: restaurant.id, branchIds: [kandy.id], q: 'cleo' })
    check('handover history searches either name and names the shift', handovers.length === 1 && handovers[0].templateName === 'Day' && handovers[0].cash?.expectedAmount === 5_000_00)
    check('and filters by the outgoing shift', (await listShiftHandovers({ restaurantId: restaurant.id, templateId: evening.id })).length === 0)
    check('and by status', (await listShiftHandovers({ restaurantId: restaurant.id, status: 'PENDING_ACCEPTANCE' })).every((r) => r.status === 'PENDING_ACCEPTANCE'))

    const cleoCard = await getCurrentShift({ restaurantId: restaurant.id, user: actor(cleo), branchId: kandy.id, timeZone: TZ })
    check('Cleo\'s card: on shift, Evening, drawer open, nothing to start', cleoCard.status === 'ON_SHIFT' && cleoCard.session?.templateName === 'Evening' && cleoCard.drawer.status === 'OPEN' && cleoCard.toStart.length === 0)
    check('assigned staff today lists Cal as done and Cleo working', cleoCard.assignedStaff.some((r) => r.userId === cal.id && r.status === 'COMPLETED') && cleoCard.assignedStaff.some((r) => r.userId === cleo.id && r.working))
    const willCard = await getCurrentShift({ restaurantId: restaurant.id, user: actor(will), branchId: kandy.id, timeZone: TZ })
    check('Will\'s card: a handover waiting on him', willCard.handover.status === 'WAITING_ON_YOU' && willCard.handover.withName === 'Wanda')
    const wesDay2 = await assignShift({ restaurantId: restaurant.id, actor: actor(mira), userId: wes.id, templateId: evening.id, branchId: kandy.id, dateKey: today, timeZone: TZ })
    const wesCard = await getCurrentShift({ restaurantId: restaurant.id, user: actor(wes), branchId: kandy.id, timeZone: TZ })
    check('Wes\'s card prompts him to start — and nothing blocks him', wesCard.status === 'NOT_STARTED' && wesCard.toStart.some((r) => r.id === wesDay2.id))
  }

  console.log('\n── 8. The exports carry the same rows ──')
  {
    const from = zonedToUtc(addDays(today, -1), '00:00', TZ)
    const to = zonedToUtc(addDays(today, 2), '00:00', TZ)
    const money = (v: number) => `Rs ${(v / 100).toFixed(2)}`
    const rota = await buildShiftExport({ type: 'shift-assignments', restaurantId: restaurant.id, timeZone: TZ, from, to, branchIds: [kandy.id], money })
    check('the rota export has every Kandy entry, with status and scheduled times', rota.rows.length >= 5 && rota.columns.some((c) => c.header === 'Scheduled start') && rota.rows.some((r) => r.status === 'CANCELLED'))
    const sessions = await buildShiftExport({ type: 'shift-sessions', restaurantId: restaurant.id, timeZone: TZ, from, to, branchIds: null, staffId: cal.id, money })
    check('the sessions export honours the staff filter and says how it ended', sessions.rows.length === 1 && sessions.rows[0].closedBy === 'HANDOVER')
    const hand = await buildShiftExport({ type: 'shift-handovers', restaurantId: restaurant.id, timeZone: TZ, from, to, branchIds: null, status: 'COMPLETED', money })
    check('the handover export carries the reconciliation', hand.rows.length === 1 && hand.rows[0].variance === money(-600_00) && hand.rows[0].expected === money(5_000_00))
    check('Jaffna\'s export is empty', (await buildShiftExport({ type: 'shift-handovers', restaurantId: restaurant.id, timeZone: TZ, from, to, branchIds: [jaffna.id], money })).rows.length === 0)
  }

  console.log('\n── 9. Source pins ──')
  {
    const tabs = readFileSync('src/features/cashier/pos-tabs.ts', 'utf8')
    check('the POS tab is called Shift', tabs.includes("handover: 'Shift',"))
    const pos = readFileSync('src/app/cashier/pos/page.tsx', 'utf8')
    const dash = readFileSync('src/app/dashboard/handover/page.tsx', 'utf8')
    check('one panel, one loader, two doors', [pos, dash].every((s) => s.includes('<ShiftPanel') && s.includes("from '@/features/shifts/panel-data'")))
    const wizard = readFileSync('src/features/handover/components/shift-handover.tsx', 'utf8')
    check('the wizard counts with the shared denomination grid', wizard.includes('<DenominationGrid') && wizard.includes('worked out when you confirm'))
    check('and posts counts, never a total', wizard.includes('counts: preview.hasDrawer ? countsToNumbers(counts) : null') && !wizard.includes('countedAmount:'))
    const console_ = readFileSync('src/features/cashdrawer/components/drawer-console.tsx', 'utf8')
    check('the drawer\'s own Close uses the same grid', console_.includes("from './denomination-grid'"))
    const actions = readFileSync('src/features/handover/shift-actions.ts', 'utf8')
    check('the preview reveals expected cash only to somebody who manages drawers', actions.includes('revealExpected: can(user, PERMISSIONS.CASH_DRAWER_MANAGE)'))
    const cash = readFileSync('src/features/handover/cash-service.ts', 'utf8')
    check('dropping the pre-submission reason is a recorded, deliberate change', cash.includes('DELIBERATE behaviour change 2026-09') && !cash.includes('DRAWER_NO_VARIANCE_REASON'))
    check('the two migrations exist and the enum value is on its own', existsSync('prisma/migrations/20260925090000_shift_close_reason_handover/migration.sql') && existsSync('prisma/migrations/20260925090100_shift_management/migration.sql'))
    const panel = readFileSync('src/features/shifts/components/shift-panel.tsx', 'utf8')
    check('the Shift tab shows what the spec lists', ['Current shift', 'Assigned staff today', 'Cash drawer', 'Handover', 'Pending responsibilities', 'Shift history', 'Handover history'].every((s) => panel.includes(s)))
    check('starting a shift is a prompt, never a gate', panel.includes('Start this shift') && !readFileSync('src/features/cashdrawer/gate.ts', 'utf8').includes('shiftAssignment'))
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
