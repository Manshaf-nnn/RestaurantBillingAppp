/**
 * A shift handover for every role (recorrection.md §2).
 *
 *   Start → Select → Review → Confirm → PENDING_ACCEPTANCE
 *     → Accept (COMPLETED) · Reject with a reason (REJECTED) · Withdraw (CANCELLED)
 *
 * What is pinned, and why:
 *
 *   - anybody can hand their shift on, not only a cashier, and the summary on
 *     the record is built by the server from the ledger, the orders, the open
 *     tasks and notes — never posted;
 *   - who may take over is a role table plus the site: a waiter's shift goes
 *     to a waiter or a manager at the same location, never to the kitchen;
 *   - the guards: self, role, site, one in flight per outgoing person, one
 *     waiting per receiver, tenant, and only the receiver decides;
 *   - a rejection carries its reason — the decline that recorded nothing was
 *     the defect — and the person who handed over is told;
 *   - a cashier's handover nests the existing cash handover, unchanged:
 *     confirm requests the till, accept takes it (their session opens with the
 *     counted float), reject declines it, withdraw cancels it and re-opens the
 *     outgoing drawer so the cash is never in no session;
 *   - the history is scoped to the people in it unless the reader manages.
 *
 * `cash-drawer-test` §8 and `handover-flow-test` pin the cash path itself and
 * are untouched: this calls it, it does not change it.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/shift-handover-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { openDrawer } from '../src/features/cashdrawer/service'
import {
  RECEIVER_ROLES,
  acceptShiftHandover,
  cancelShiftHandover,
  listEligibleReceivers,
  listShiftHandovers,
  rejectShiftHandover,
  startShiftHandover,
} from '../src/features/handover/shift-service'

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
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Shift Co', slug: `shift-${stamp}`, email: `shift-${stamp}@test.local`, timezone: TZ },
  })
  restaurantId = restaurant.id
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true },
  })
  const jaffna = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Jaffna', code: 'JAF' },
  })

  type Role = 'OWNER' | 'MANAGER' | 'WAITER' | 'KITCHEN' | 'CASHIER'
  const mk = (name: string, role: Role, branchId: string | null) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        email: `${name.toLowerCase()}-${stamp}@test.local`,
        name, passwordHash: 'x', role, branchId,
      },
    })
  const w1 = await mk('Wanda', 'WAITER', kandy.id)
  const w2 = await mk('Will', 'WAITER', kandy.id)
  const w4 = await mk('Wes', 'WAITER', kandy.id)
  const k1 = await mk('Kim', 'KITCHEN', kandy.id)
  const m1 = await mk('Mira', 'MANAGER', kandy.id)
  const c1 = await mk('Cal', 'CASHIER', kandy.id)
  const c2 = await mk('Cleo', 'CASHIER', kandy.id)
  const w3 = await mk('Wren', 'WAITER', jaffna.id)
  const owner = await mk('Owner', 'OWNER', null)

  type U = typeof w1
  const person = (u: U) => ({ id: u.id, name: u.name, role: u.role, branchId: u.branchId })
  const actor = (u: U) => ({ id: u.id, role: u.role, branchId: u.branchId, canManageOthers: u.role === 'MANAGER' || u.role === 'OWNER' })
  const start = (from: U, to: U, extra: { countedAmount?: number | null; notes?: string } = {}) =>
    startShiftHandover({
      restaurantId: restaurant.id, from: person(from), actor: actor(from), branchId: kandy.id,
      toUserId: to.id, timeZone: TZ, ...extra,
    })
  const accept = (by: U, id: string) =>
    acceptShiftHandover({ restaurantId: restaurant.id, handoverId: id, user: person(by), actor: actor(by) })
  const reject = (by: U, id: string, reason: string) =>
    rejectShiftHandover({ restaurantId: restaurant.id, handoverId: id, user: person(by), actor: actor(by), reason })
  const cancel = (by: U, id: string, mayCancelOthers = false) =>
    cancelShiftHandover({ restaurantId: restaurant.id, handoverId: id, user: person(by), actor: actor(by), mayCancelOthers })
  const told = (userId: string, title: RegExp) =>
    prisma.notification.findFirst({ where: { restaurantId: restaurant.id, userId, title: { contains: title.source.replace(/\\/g, '') } } })

  console.log('\n── 1. Anybody can hand their shift on; the summary is the server\'s ──')
  const first = await start(w1, w2, { notes: 'Table 6 still owes for two drinks' })
  {
    check('a waiter\'s handover exists, pending acceptance', first.status === 'PENDING_ACCEPTANCE')
    const summary = first.summary as { branchName: string; drawer: unknown; orders: { today: number; open: number }; tasks: unknown[]; notes: unknown[] }
    check('the summary names the site', summary.branchName === 'Kandy')
    check('no till — a waiter has none', summary.drawer === null)
    check('orders, tasks and notes are counted, not posted', typeof summary.orders.today === 'number' && Array.isArray(summary.tasks) && Array.isArray(summary.notes))
    check('the notes travel', first.notes === 'Table 6 still owes for two drinks')
    check('the receiver is told', (await prisma.notification.findFirst({ where: { restaurantId: restaurant.id, userId: w2.id, title: { contains: 'handing their shift to you' } } })) !== null)
  }

  console.log('\n── 2. Who may take over ──')
  {
    const forWaiter = await listEligibleReceivers({ restaurantId: restaurant.id, from: person(w1), branchId: kandy.id, withTill: false })
    const ids = new Set(forWaiter.map((r) => r.id))
    check('a waiter, a manager and the owner may take a waiter\'s shift', ids.has(w2.id) && ids.has(m1.id) && ids.has(owner.id))
    check('the kitchen may not', !ids.has(k1.id))
    check('nor a waiter at another site', !ids.has(w3.id))
    check('nor yourself', !ids.has(w1.id))
    check('somebody with a handover already waiting is listed but not available', forWaiter.find((r) => r.id === w2.id)?.available === false)
    check('each option names role and site', forWaiter.every((r) => r.roleLabel.length > 0))
    check('the kitchen\'s shift goes to the kitchen or a manager, never a waiter', RECEIVER_ROLES.KITCHEN.includes('KITCHEN') && RECEIVER_ROLES.KITCHEN.includes('MANAGER') && !RECEIVER_ROLES.KITCHEN.includes('WAITER'))
    const withTill = await listEligibleReceivers({ restaurantId: restaurant.id, from: person(c1), branchId: kandy.id, withTill: true })
    check('with a till going, only people who work a till are offered', withTill.every((r) => ['CASHIER', 'MANAGER', 'ADMIN', 'OWNER'].includes(r.role)) && withTill.some((r) => r.id === c2.id))
  }

  console.log('\n── 3. The refusals ──')
  {
    await refuses('handing to yourself', () => start(w1, w1), /HANDOVER_SELF/)
    await refuses('a waiter\'s shift to the kitchen', () => start(k1, w2), /HANDOVER_ROLE_MISMATCH/)
    await refuses('across sites', () => start(w1, w3), /HANDOVER_CROSSES_BRANCH/)
    await refuses('a second one while yours is in flight', () => start(w1, m1), /HANDOVER_ALREADY_PENDING/)
    await refuses('to somebody who already has one waiting', () => start(w4, w2), /HANDOVER_ALREADY_PENDING/)
    await refuses('another restaurant cannot see it', () => acceptShiftHandover({ restaurantId: 'someone-else', handoverId: first.id, user: person(w2), actor: actor(w2) }), /not found|Handover/i)
    await refuses('another site cannot see it', () => accept(w3, first.id), /another location|Forbidden/i)
    await refuses('only the receiver accepts', () => accept(m1, first.id), /somebody else/i)
  }

  console.log('\n── 4. Accept ──')
  {
    const { handover, sessionId } = await accept(w2, first.id)
    check('completed', handover.status === 'COMPLETED' && handover.decidedById === w2.id && handover.decidedAt !== null)
    check('no till was involved', sessionId === null)
    check('the outgoing person is told', (await told(w1.id, /accepted your shift handover/)) !== null)
    await refuses('accepting twice', () => accept(w2, first.id), /HANDOVER_SETTLED/)
  }

  console.log('\n── 5. Reject, with a reason ──')
  {
    const h = await start(k1, m1)
    await refuses('a rejection needs a reason', () => reject(m1, h.id, ' '), /HANDOVER_NO_REASON/)
    const rejected = await reject(m1, h.id, 'Not on tonight')
    check('rejected, with the reason on the record', rejected.status === 'REJECTED' && rejected.rejectReason === 'Not on tonight')
    const note = await prisma.notification.findFirst({ where: { restaurantId: restaurant.id, userId: k1.id, title: { contains: 'did not accept' } } })
    check('the outgoing person is told why', note?.body === 'Not on tonight')
  }

  console.log('\n── 6. Withdraw ──')
  {
    const h = await start(w1, m1)
    await refuses('not by a bystander', () => cancel(w4, h.id), /Only the person|Forbidden/i)
    const own = await cancel(w1, h.id)
    check('by the person handing over', own.handover.status === 'CANCELLED')
    check('the receiver is told', (await told(m1.id, /withdrawn/)) !== null)

    const stale = await start(w4, m1)
    const byManager = await cancel(m1, stale.id, true)
    check('or by a manager clearing a stale one', byManager.handover.status === 'CANCELLED' && byManager.handover.decidedById === m1.id)
    await refuses('withdrawing twice', () => cancel(w4, stale.id), /HANDOVER_SETTLED/)
  }

  console.log('\n── 7. The till goes with the shift ──')
  {
    await openDrawer({ restaurantId: restaurant.id, branchId: kandy.id, openingFloat: 5_000_00, userId: c1.id, userBranchId: c1.branchId })
    const c1Session = await prisma.cashDrawerSession.findFirstOrThrow({ where: { restaurantId: restaurant.id, openedById: c1.id, status: 'OPEN' } })

    await refuses('a cashier must count the drawer first', () => start(c1, c2), /HANDOVER_NO_COUNT/)
    const h = await start(c1, c2, { countedAmount: 5_000_00 })
    check('the cash handover is nested', h.cashHandoverId !== null)
    const cash = await prisma.cashHandover.findUniqueOrThrow({ where: { id: h.cashHandoverId! } })
    check('requested through the existing path — pending, counted, balanced', cash.status === 'PENDING' && cash.countedAmount === 5_000_00 && cash.variance === 0)
    const closed = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: c1Session.id } })
    check('the outgoing session is closed with the count on it', closed.status === 'CLOSED' && closed.countedCash === 5_000_00)
    const summary = h.summary as { drawer: { openingFloat: number; countedCash: number; variance: number } }
    check('and the summary carries the count', summary.drawer.countedCash === 5_000_00 && summary.drawer.variance === 0)
    check('and what the drawer opened with — the review screen\'s "opening cash"', summary.drawer.openingFloat === 5_000_00)

    const { handover, sessionId } = await accept(c2, h.id)
    check('accepting takes the till', handover.status === 'COMPLETED' && sessionId !== null)
    const c2Session = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: sessionId! } })
    check('the receiver\'s session opens with the counted float', c2Session.status === 'OPEN' && c2Session.openedById === c2.id && c2Session.openingFloat === 5_000_00)
    check('the cash handover is accepted', (await prisma.cashHandover.findUniqueOrThrow({ where: { id: cash.id } })).status === 'ACCEPTED')

    console.log('\n   withdraw with a till: the outgoing drawer re-opens')
    const back = await start(c2, c1, { countedAmount: 5_000_00 })
    const backCash = await prisma.cashHandover.findUniqueOrThrow({ where: { id: back.cashHandoverId! } })
    check('the receiver\'s own session closed on request', (await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: c2Session.id } })).status === 'CLOSED')
    const withdrawn = await cancel(c2, back.id)
    check('withdrawn', withdrawn.handover.status === 'CANCELLED' && withdrawn.reopenedSessionId !== null)
    check('the cash handover is cancelled, not declined', (await prisma.cashHandover.findUniqueOrThrow({ where: { id: backCash.id } })).status === 'CANCELLED')
    const reopened = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: withdrawn.reopenedSessionId! } })
    check('a new session is open for the outgoing cashier with the counted amount as float', reopened.status === 'OPEN' && reopened.openedById === c2.id && reopened.openingFloat === 5_000_00 && reopened.id !== c2Session.id)
    check('the closed one stays closed — the chain reads close → withdraw → re-open', (await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: c2Session.id } })).status === 'CLOSED')

    console.log('\n   reject with a till: declined, and management is told')
    const again = await start(c2, c1, { countedAmount: 5_000_00 })
    const rejected = await reject(c1, again.id, 'The count is off by a note')
    check('rejected with the reason', rejected.status === 'REJECTED' && rejected.rejectReason === 'The count is off by a note')
    check('the cash handover is declined — the existing semantics stand', (await prisma.cashHandover.findUniqueOrThrow({ where: { id: again.cashHandoverId! } })).status === 'DECLINED')
    check('management is told the drawer needs a hand', (await prisma.notification.findFirst({ where: { restaurantId: restaurant.id, audience: 'MANAGEMENT', title: { contains: 'till handover was refused' } } })) !== null)
    check('and so is the person who handed over', (await told(c2.id, /did not accept/)) !== null)
  }

  console.log('\n── 8. Who sees the history ──')
  {
    const all = await listShiftHandovers({ restaurantId: restaurant.id })
    const mine = await listShiftHandovers({ restaurantId: restaurant.id, participantId: w1.id })
    check('a manager\'s view has every handover', all.length >= 7, String(all.length))
    check('a participant\'s view has only theirs', mine.length > 0 && mine.every((row) => row.fromId === w1.id || row.toId === w1.id))
    check('rows carry the decision and the till figures', all.some((row) => row.status === 'REJECTED' && row.rejectReason) && all.some((row) => row.cash?.countedAmount === 5_000_00))
    const pending = await listShiftHandovers({ restaurantId: restaurant.id, status: 'PENDING_ACCEPTANCE' })
    check('nothing is left in flight', pending.length === 0)
  }
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
