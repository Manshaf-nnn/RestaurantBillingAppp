/**
 * A waiter call is one event per table and need, seen through to done
 * (abc.md §7).
 *
 *   - calling creates one row carrying restaurant, branch (from the table),
 *     table and who called; a second call for the same table and need while
 *     the first is active returns the same row — the rule is a partial
 *     unique index, not a timing window, so a raw duplicate is refused too;
 *   - a different need at the same table is its own row;
 *   - Acknowledge stamps who is on the way and when; a call stays one row
 *     while acknowledged; Resolve stamps who came and when, and resolving an
 *     unacknowledged call records the acknowledgement as well;
 *   - after Resolve the next call is a new row;
 *   - waiters and management are told, at the table's branch; the history
 *     lists open, acknowledged and resolved calls for a period, per branch;
 *   - the guest's, the till's, the KDS's and the floor's buttons all go
 *     through the same door; the actions are gated and audited; the waiter
 *     station shows a popup.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/waiter-call-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import {
  acknowledgeServiceRequest,
  listServiceRequests,
  openServiceRequest,
  resolveServiceRequestRecord,
} from '../src/features/floor/service-requests'

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
const MIN = 60_000
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.notification.deleteMany({ where: { restaurantId: id } })
  await prisma.serviceRequest.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Bell ${stamp}`, slug: `bell-${stamp}`, status: 'ACTIVE', isActive: true,
      timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  restaurantId = restaurant.id
  const main_ = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Other', code: 'OTH' },
  })
  const t1 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main_.id, number: '1', capacity: 4 },
  })
  const t2 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: other.id, number: '2', capacity: 4 },
  })
  const waiter = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `bell-${stamp}@test.local`, name: 'Nimal', passwordHash: 'x', role: 'WAITER', branchId: main_.id },
  })
  const call = (tableId: string, type: 'CALL_WAITER' | 'WATER' | 'BILL' = 'CALL_WAITER', extra: { requestedByName?: string; createdById?: string; note?: string } = {}) =>
    openServiceRequest({ restaurantId: restaurant.id, tableId, type, ...extra })

  console.log('\n── 1. One call, one row ──')
  const first = await call(t1.id)
  {
    check('created, open', first.created && first.request.status === 'OPEN')
    check('it knows its restaurant, branch and table', first.request.restaurantId === restaurant.id && first.request.branchId === main_.id && first.request.tableId === t1.id)
    check('and who called — the table, for a guest', first.request.requestedByName === 'Table 1')

    const again = await call(t1.id)
    check('a second call from the same table is the same row', !again.created && again.request.id === first.request.id)
    check('there is still one row', (await prisma.serviceRequest.count({ where: { tableId: t1.id, type: 'CALL_WAITER' } })) === 1)

    const water = await call(t1.id, 'WATER')
    check('a different need at the same table is its own row', water.created && water.request.id !== first.request.id)

    await refuses(
      'the database refuses a raw duplicate — the rule is the index, not a timer',
      () => prisma.serviceRequest.create({ data: { restaurantId: restaurant.id, branchId: main_.id, tableId: t1.id, type: 'CALL_WAITER' } }),
      /Unique constraint|unique/i,
    )
    await refuses('a table that is not here is not found', () => call('cknotatable0000000000000'), /not found/i)
  }

  console.log('\n── 2. Acknowledged, then resolved ──')
  {
    const ack = await acknowledgeServiceRequest({ restaurantId: restaurant.id, requestId: first.request.id, userId: waiter.id, userName: waiter.name })
    check('acknowledged, stamped with who and when', ack.status === 'ACKNOWLEDGED' && ack.acknowledgedById === waiter.id && ack.acknowledgedAt !== null)
    const twice = await acknowledgeServiceRequest({ restaurantId: restaurant.id, requestId: first.request.id, userId: waiter.id, userName: waiter.name })
    check('acknowledging again changes nothing', twice.acknowledgedAt?.getTime() === ack.acknowledgedAt?.getTime())

    const whileAck = await call(t1.id)
    check('a call while acknowledged is still the same row', !whileAck.created && whileAck.request.id === first.request.id)

    const done = await resolveServiceRequestRecord({ restaurantId: restaurant.id, requestId: first.request.id, userId: waiter.id })
    check('resolved, stamped with who came and when', done.status === 'RESOLVED' && done.handledById === waiter.id && done.resolvedAt !== null)
    await refuses('a resolved call cannot be acknowledged', () => acknowledgeServiceRequest({ restaurantId: restaurant.id, requestId: first.request.id, userId: waiter.id, userName: waiter.name }), /REQUEST_RESOLVED/)

    const next = await call(t1.id)
    check('after resolve, the next call is a new row', next.created && next.request.id !== first.request.id)
    const straight = await resolveServiceRequestRecord({ restaurantId: restaurant.id, requestId: next.request.id, userId: waiter.id })
    check('resolving an unacknowledged call records the acknowledgement too', straight.acknowledgedById === waiter.id && straight.acknowledgedAt !== null)
  }

  console.log('\n── 3. Called by a colleague, at another site ──')
  {
    const byStaff = await call(t2.id, 'CALL_WAITER', { requestedByName: 'Till — Kamal', createdById: waiter.id, note: 'Bill query' })
    check('who called is the colleague, not the table', byStaff.request.requestedByName === 'Till — Kamal' && byStaff.request.createdById === waiter.id)
    check('the branch is the table’s', byStaff.request.branchId === other.id)
    check('the note travels', byStaff.request.note === 'Bill query')
  }

  console.log('\n── 4. Who is told ──')
  {
    const rows = await prisma.notification.findMany({ where: { restaurantId: restaurant.id, type: 'SERVICE_REQUEST' } })
    const forFirst = rows.filter((n) => (n.data as { requestId?: string } | null)?.requestId === first.request.id)
    check('waiters and management, once each', forFirst.some((n) => n.audience === 'WAITER') && forFirst.some((n) => n.audience === 'MANAGEMENT') && forFirst.length === 2)
    check('at the table’s branch', forFirst.every((n) => n.branchId === main_.id))
    check('saying the table is calling a waiter', forFirst.every((n) => n.title === 'Table 1 is calling a waiter'))
    check('a repeat tap told nobody twice', rows.filter((n) => n.audience === 'WAITER' && (n.data as { tableId?: string } | null)?.tableId === t1.id && (n.data as { type?: string } | null)?.type === 'CALL_WAITER').length === 2)
  }

  console.log('\n── 5. History ──')
  {
    const range = { start: new Date(Date.now() - 10 * MIN), end: new Date(Date.now() + 10 * MIN) }
    const all = await listServiceRequests({ restaurantId: restaurant.id, branchIds: null, range })
    check('every call is listed, resolved ones included', all.length === 4 && all.some((r) => r.status === 'RESOLVED') && all.some((r) => r.status === 'OPEN'))
    check('with who acknowledged and who resolved', all.find((r) => r.id === first.request.id)?.acknowledgedByName === 'Nimal' && all.find((r) => r.id === first.request.id)?.handledByName === 'Nimal')
    const mainOnly = await listServiceRequests({ restaurantId: restaurant.id, branchIds: [main_.id], range })
    check('narrowed to a site', mainOnly.length === 3 && mainOnly.every((r) => r.branchId === main_.id))
    const none = await listServiceRequests({ restaurantId: restaurant.id, branchIds: [], range })
    check('an empty site list is nothing, never everything', none.length === 0)
    const past = await listServiceRequests({ restaurantId: restaurant.id, branchIds: null, range: { start: new Date(Date.now() - 60 * MIN), end: new Date(Date.now() - 30 * MIN) } })
    check('outside the period, nothing', past.length === 0)
  }

  console.log('\n── 6. Doors, guards, the popup ──')
  {
    const orders = readFileSync('src/features/orders/actions.ts', 'utf8')
    const guest = orders.slice(orders.indexOf('export async function createServiceRequest'), orders.indexOf('// ── staff surface'))
    check('the guest’s button goes through the same door', guest.includes('openServiceRequest('))
    check('and the guest can call a waiter, not only ask for help', readFileSync('src/features/orders/schema.ts', 'utf8').includes("'CALL_WAITER'"))
    const floor = readFileSync('src/features/floor/actions.ts', 'utf8')
    const staff = floor.slice(floor.indexOf('export async function callWaiterAction'))
    check('a colleague’s call is gated and scoped to the table’s site', staff.includes('PERMISSIONS.ORDER_VIEW') && staff.includes("assertRecordBranch(user, table, 'table')"))
    check('and audited', staff.includes('AUDIT_ACTIONS.SERVICE_REQUEST_CREATED'))
    const ack = orders.slice(orders.indexOf('export async function acknowledgeServiceRequestAction'))
    check('acknowledge and resolve are floor work, audited', ack.includes('PERMISSIONS.WAITER_VIEW') && orders.includes('AUDIT_ACTIONS.SERVICE_REQUEST_ACKNOWLEDGED') && orders.includes('AUDIT_ACTIONS.SERVICE_REQUEST_RESOLVED'))

    const board = readFileSync('src/features/waiter/components/waiter-board.tsx', 'utf8')
    check('the waiter station still chimes on a call', board.includes("play('alert')"))
    check('and can acknowledge from the queue', board.includes('acknowledgeServiceRequestAction'))
    /*
     * pro.A.md §17 — the popup moved OUT of the waiter screen and into the
     * shell both staff families mount, so a cashier at the till and a manager
     * on the dashboard see a table calling too. It used to exist on exactly
     * one page, which is why nobody else ever answered.
     */
    const alerts = readFileSync('src/components/staff-alerts.tsx', 'utf8')
    check('one popup, for every staff screen', alerts.includes('EVENTS.SERVICE_REQUEST_CREATED') && alerts.includes('data-testid="staff-call-popup"'))
    check('with Acknowledge and Resolve on it', alerts.includes('acknowledgeServiceRequestAction') && alerts.includes('resolveServiceRequest'))
    check('and it ignores another branch\'s call', alerts.includes('isOurs(payload.branchId)'))
    for (const [shell, label] of [
      ['src/components/ops-shell.tsx', 'the kitchen, waiter and till shell'],
      ['src/features/dashboard/components/dashboard-shell.tsx', 'the dashboard shell'],
    ] as const) {
      check(`${label} mounts it`, readFileSync(shell, 'utf8').includes('<StaffAlerts'))
    }
    for (const [file, label] of [
      ['src/features/cashier/components/cashier-board.tsx', 'the till'],
      ['src/features/kitchen/components/kitchen-board.tsx', 'the KDS'],
      ['src/features/live/components/live-board.tsx', 'the live floor'],
      ['src/features/floor/components/tables-manager.tsx', 'the tables page'],
    ] as const) {
      check(`${label} can call a waiter`, readFileSync(file, 'utf8').includes('callWaiterAction'))
    }
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
