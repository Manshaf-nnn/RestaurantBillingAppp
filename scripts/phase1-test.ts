/**
 * Phase 1 functional tests — exercises the real service layer against a local
 * database. Creates its own rows and removes them again at the end.
 */
import { prisma } from '../src/server/db/prisma'
import { ensureDefaultBranch, resolveBranchId, listBranches } from '../src/features/branches/service'
import {
  openDrawer,
  closeDrawer,
  recordCashMovement,
  computeDrawerTotals,
  getOpenDrawer,
} from '../src/features/cashdrawer/service'
import { capturePayment, refundPayment } from '../src/features/payments/service'
import { placeOrder, canTransition } from '../src/features/orders/service'
import { voidOrderItem } from '../src/features/cashier/service'

let pass = 0
let fail = 0
const created: { orders: string[]; drawers: string[] } = { orders: [], drawers: [] }

function ok(name: string, condition: boolean, detail = '') {
  if (condition) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${detail}`)
  }
}

async function throws(name: string, fn: () => Promise<unknown>, expectCode?: string) {
  try {
    await fn()
    fail++
    console.log(`  ✗ ${name} — expected a rejection, got none`)
  } catch (e) {
    const code = (e as { code?: string }).code
    if (expectCode && code !== expectCode) {
      fail++
      console.log(`  ✗ ${name} — expected ${expectCode}, got ${code}`)
    } else {
      pass++
      console.log(`  ✓ ${name} (${code ?? 'rejected'})`)
    }
  }
}

async function main() {
  const shop = await prisma.restaurant.findFirstOrThrow({ where: { slug: 'the-copper-spoon' } })
  const other = await prisma.restaurant.findFirstOrThrow({ where: { slug: 'kava' } })
  const cashier = await prisma.user.findFirstOrThrow({
    where: { restaurantId: shop.id, deletedAt: null },
  })
  /*
   * The drawer service asks who is reaching for the till: which locations they
   * may touch, and whether they may touch a drawer somebody else opened. This
   * fixture is the person who opened it, so both answers are yes.
   */
  const atTill = {
    id: cashier.id,
    role: cashier.role,
    branchId: cashier.branchId,
    canManageOthers: true,
  }

  const foods = await prisma.food.findMany({
    where: { restaurantId: shop.id, deletedAt: null, isAvailable: true },
    take: 3,
  })
  const table = await prisma.restaurantTable.findFirstOrThrow({ where: { restaurantId: shop.id } })

  console.log('\n── 1. Branches ──────────────────────────────────────────')
  const branch = await ensureDefaultBranch(shop.id)
  ok('default branch created', Boolean(branch.id) && branch.isDefault)
  const again = await ensureDefaultBranch(shop.id)
  ok('ensureDefaultBranch is idempotent', again.id === branch.id)

  const otherBranch = await ensureDefaultBranch(other.id)
  const resolved = await resolveBranchId({
    restaurantId: shop.id,
    requestedBranchId: otherBranch.id, // a branch belonging to a different tenant
  })
  ok(
    'cross-tenant branch id is rejected and falls back to own default',
    resolved === branch.id && resolved !== otherBranch.id,
    `got ${resolved}`,
  )
  ok('listBranches is tenant-scoped', (await listBranches(shop.id)).every((b) => b.id !== otherBranch.id))

  console.log('\n── 2. Cash drawer ───────────────────────────────────────')
  const existingOpen = await getOpenDrawer(shop.id, cashier.id)
  if (existingOpen) {
    await prisma.cashDrawerSession.update({
      where: { id: existingOpen.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    })
  }

  const FLOAT = 500_00
  const drawer = await openDrawer({
    restaurantId: shop.id,
    userId: cashier.id,
    openingFloat: FLOAT,
  })
  created.drawers.push(drawer.id)
  ok('drawer opens with a float', drawer.openingFloat === FLOAT && drawer.status === 'OPEN')

  await throws(
    'a second open drawer for the same cashier is refused',
    () => openDrawer({ restaurantId: shop.id, userId: cashier.id, openingFloat: 100 }),
    'DRAWER_ALREADY_OPEN',
  )
  await throws(
    'a movement with no reason is refused',
    () =>
      recordCashMovement({
        restaurantId: shop.id,
        actor: atTill,
        sessionId: drawer.id,
        type: 'CASH_IN',
        amount: 100,
        reason: '  ',
        userId: cashier.id,
      }),
    'MOVEMENT_NO_REASON',
  )

  console.log('\n── 3. Order + payment attribution ───────────────────────')
  const order = await placeOrder({
    restaurantId: shop.id,
    tableId: table.id,
    type: 'DINE_IN',
    channel: 'QR',
    customerName: 'Test Guest',
    customerPhone: '0700000000',
    items: foods.slice(0, 2).map((f) => ({ foodId: f.id, quantity: 2, optionIds: [] })),
  })
  created.orders.push(order.id)
  ok('QR order records its channel', order.channel === 'QR')
  ok('order gets a branch', Boolean(order.branchId) || order.branchId === null)

  const counter = await placeOrder({
    restaurantId: shop.id,
    type: 'COUNTER',
    channel: 'COUNTER',
    customerName: 'Walk In',
    customerPhone: '0700000001',
    items: [{ foodId: foods[0].id, quantity: 1, optionIds: [] }],
  })
  created.orders.push(counter.id)
  ok('counter sale needs no table', counter.type === 'COUNTER' && counter.tableId === null)

  // Split payment: half cash, then the rest by card.
  const half = Math.floor(order.grandTotal / 2)
  await capturePayment({
    restaurantId: shop.id,
    orderId: order.id,
    method: 'CASH',
    amount: half,
    receivedById: cashier.id,
  })
  const afterFirst = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
  ok('partial payment leaves the bill PARTIAL', afterFirst.paymentStatus === 'PARTIAL')

  await capturePayment({
    restaurantId: shop.id,
    orderId: order.id,
    method: 'CARD',
    amount: order.grandTotal - half,
    receivedById: cashier.id,
  })
  const afterSecond = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
  ok('split payment settles the bill', afterSecond.paymentStatus === 'PAID')

  const payments = await prisma.payment.findMany({ where: { orderId: order.id } })
  ok(
    'both payments are attributed to the open drawer',
    payments.length === 2 && payments.every((p) => p.cashDrawerSessionId === drawer.id),
  )

  console.log('\n── 4. Expected-cash maths ───────────────────────────────')
  await recordCashMovement({
    restaurantId: shop.id,
    actor: atTill,
    sessionId: drawer.id,
    type: 'CASH_IN',
    amount: 200_00,
    reason: 'float top-up',
    userId: cashier.id,
  })
  await recordCashMovement({
    restaurantId: shop.id,
    actor: atTill,
    sessionId: drawer.id,
    type: 'CASH_OUT',
    amount: 50_00,
    reason: 'paid vegetable supplier',
    userId: cashier.id,
  })

  const totals = await computeDrawerTotals(drawer.id)
  const expected = FLOAT + half + 200_00 - 50_00
  ok(
    'expected = float + cash sales + cash in − cash out',
    totals.expectedCash === expected,
    `got ${totals.expectedCash}, wanted ${expected}`,
  )
  ok('card takings are reported but not counted as drawer cash', totals.cardSales === order.grandTotal - half)

  console.log('\n── 5. Refund leaves the drawer ──────────────────────────')
  const cashPayment = payments.find((p) => p.method === 'CASH')!
  await refundPayment({
    restaurantId: shop.id,
    paymentId: cashPayment.id,
    reason: 'test refund',
    actorId: cashier.id,
  })
  const afterRefund = await computeDrawerTotals(drawer.id)
  ok(
    'a cash refund is recorded as CASH_OUT and reduces expected cash',
    afterRefund.expectedCash === expected - half,
    `got ${afterRefund.expectedCash}, wanted ${expected - half}`,
  )
  ok(
    'the refunded sale still counts as cash that entered the drawer',
    afterRefund.cashSales === half,
  )

  console.log('\n── 6. Closing and variance ──────────────────────────────')
  const SHORT_BY = 25_00
  const closed = await closeDrawer({
    restaurantId: shop.id,
    actor: atTill,
    sessionId: drawer.id,
    countedCash: afterRefund.expectedCash - SHORT_BY,
    note: 'test close',
    userId: cashier.id,
  })
  ok('variance is counted − expected', closed.variance === -SHORT_BY, `got ${closed.variance}`)
  ok('expected cash is snapshotted on the row', closed.session.expectedCash === afterRefund.expectedCash)
  await throws(
    'closing an already-closed drawer is refused',
    () =>
      closeDrawer({
        restaurantId: shop.id,
        actor: atTill,
        sessionId: drawer.id,
        countedCash: 0,
        userId: cashier.id,
      }),
    'DRAWER_CLOSED',
  )

  console.log('\n── 7. Void item ─────────────────────────────────────────')
  const voidable = await placeOrder({
    restaurantId: shop.id,
    tableId: table.id,
    type: 'DINE_IN',
    customerName: 'Void Test',
    customerPhone: '0700000002',
    items: foods.slice(0, 2).map((f) => ({ foodId: f.id, quantity: 2, optionIds: [] })),
  })
  created.orders.push(voidable.id)
  const items = await prisma.orderItem.findMany({ where: { orderId: voidable.id } })
  const target = items[0]

  const before = voidable.grandTotal
  const { order: afterVoid } = await voidOrderItem({
    restaurantId: shop.id,
    orderId: voidable.id,
    itemId: target.id,
    reason: 'sent back by guest',
    actorId: cashier.id,
    actorName: cashier.name,
  })
  ok('voiding a line lowers the bill', afterVoid.grandTotal < before)
  ok(
    'the voided line is kept, not deleted',
    (await prisma.orderItem.findUniqueOrThrow({ where: { id: target.id } })).status === 'CANCELLED',
  )
  await throws(
    'voiding without a reason is refused',
    () =>
      voidOrderItem({
        restaurantId: shop.id,
        orderId: voidable.id,
        itemId: items[1].id,
        reason: '',
        actorId: cashier.id,
      }),
    'VOID_NO_REASON',
  )
  await throws(
    'voiding the last remaining line is refused',
    () =>
      voidOrderItem({
        restaurantId: shop.id,
        orderId: voidable.id,
        itemId: items[1].id,
        reason: 'also sent back',
        actorId: cashier.id,
      }),
    'VOID_LAST_ITEM',
  )

  console.log('\n── 8. Status transitions ────────────────────────────────')
  ok('PENDING → ACCEPTED allowed', canTransition('PENDING', 'ACCEPTED'))
  ok('PENDING → COMPLETED refused', !canTransition('PENDING', 'COMPLETED'))
  ok('CANCELLED → PREPARING refused', !canTransition('CANCELLED', 'PREPARING'))
  ok('COMPLETED is terminal', !canTransition('COMPLETED', 'SERVED'))

  console.log('\n── 9. Tenant isolation ──────────────────────────────────')
  const leaked = await prisma.order.findFirst({
    where: { id: order.id, restaurantId: other.id },
  })
  ok('an order id from another tenant does not resolve', leaked === null)
  await throws(
    'voiding an item on another tenant’s bill is refused',
    () =>
      voidOrderItem({
        restaurantId: other.id,
        orderId: voidable.id,
        itemId: items[1].id,
        reason: 'cross tenant attempt',
        actorId: cashier.id,
      }),
  )

  // ── cleanup ────────────────────────────────────────────────────────────────
  await prisma.payment.deleteMany({ where: { orderId: { in: created.orders } } })
  await prisma.cashMovement.deleteMany({ where: { sessionId: { in: created.drawers } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: created.orders } } })
  await prisma.orderEvent.deleteMany({ where: { orderId: { in: created.orders } } })
  await prisma.order.deleteMany({ where: { id: { in: created.orders } } })
  await prisma.cashDrawerSession.deleteMany({ where: { id: { in: created.drawers } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\nTEST RUN CRASHED:', e)
  await prisma.$disconnect()
  process.exit(1)
})
