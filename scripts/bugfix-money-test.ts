/**
 * The money and data defects the 2026-09-13 audit found (bugfix.md).
 *
 * Every section below failed against the code as it was and passes against
 * the fix — TESTING.md's rule. Where the defect was a race, the race is run
 * with Promise.all rather than hoping a lock comment is right. Money is minor
 * units throughout.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/bugfix-money-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder, updateOrderStatus, settleLoyalty } from '../src/features/orders/service'
import { derivePaymentStatus, localMinutes } from '../src/features/orders/pricing'
import { capturePayment, refundPayment } from '../src/features/payments/service'
import { mergeBills, recalculateOrderTotals, splitBill, voidOrderItem } from '../src/features/cashier/service'
import { closePeriod } from '../src/features/accounting/service'
import { monthBounds } from '../src/features/accounting/month-close'
import { runIntegrityChecks } from '../src/features/accounting/integrity'
import { buildJournal } from '../src/features/ledger/journal'
import { foldTrialBalance } from '../src/features/ledger/queries'
import { getSalesReport } from '../src/features/reports/sales'
import { getProfitReport } from '../src/features/reports/profit'
import { resolveRange } from '../src/features/reports/range'
import { createPurchaseOrder, setPurchaseStatus } from '../src/features/purchasing/service'
import { receiveGoods } from '../src/features/purchasing/receiving'
import { closeDrawer, openDrawer, type DrawerActor } from '../src/features/cashdrawer/service'
import { ensureRegister } from '../src/features/cashdrawer/registers'
import { recordWastage } from '../src/features/inventory/wastage'
import { evaluate } from '../src/features/customers/discounts'
import { enqueue, runJobs } from '../src/server/jobs/runner'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

const stamp = Date.now().toString(36)

/**
 * Purchases hold their inventory items with a RESTRICT key, so a tenant with
 * stock history cannot be dropped in one statement; this walks the same order
 * purchasing-test does. Sweeps this run's shops and any a crashed run left.
 */
async function teardown() {
  const shops = await prisma.restaurant.findMany({
    where: { slug: { startsWith: 'fix-' }, name: { startsWith: 'Fix ' } },
    select: { id: true },
  })
  for (const { id } of shops) {
    const of = { where: { restaurantId: id } }
    await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { restaurantId: id } } })
    await prisma.goodsReceipt.deleteMany(of)
    await prisma.purchasePriceHistory.deleteMany(of)
    await prisma.purchaseItem.deleteMany({ where: { purchase: { restaurantId: id } } })
    await prisma.purchase.deleteMany(of)
    await prisma.wastageRecord.deleteMany(of)
    await prisma.stockMovement.deleteMany(of)
    await prisma.stockBatch.deleteMany(of)
    await prisma.inventoryStock.deleteMany(of)
    await prisma.inventoryItem.deleteMany(of)
    await prisma.supplier.deleteMany(of)
    await prisma.restaurant.delete({ where: { id } })
  }
}

async function main() {
  const tz = 'Asia/Colombo'

  /** A restaurant with two branches, two dishes, one table, a till and stock. */
  async function shop(label: string, taxInclusive: boolean) {
    const restaurant = await prisma.restaurant.create({
      data: {
        name: `Fix ${label} ${stamp}`, slug: `fix-${label}-${stamp}`, status: 'ACTIVE', isActive: true,
        currency: 'LKR', taxRateBps: 1_000, serviceChargeBps: 0, taxInclusive, timezone: tz,
        loyaltyEnabled: true, loyaltyEarnRateX100: 100, loyaltyPointValue: 1_000,
      },
    })
    const main = await prisma.branch.create({
      data: { restaurantId: restaurant.id, name: 'Main', code: `F${label}M`, isDefault: true },
    })
    const kandy = await prisma.branch.create({
      data: { restaurantId: restaurant.id, name: 'Kandy', code: `F${label}K` },
    })
    const category = await prisma.category.create({
      data: { restaurantId: restaurant.id, name: 'Mains', slug: `fix-${label}-mains-${stamp}` },
    })
    const dish = async (name: string, price: number) =>
      prisma.food.create({
        data: {
          restaurantId: restaurant.id, categoryId: category.id, name, slug: `fix-${label}-${name.toLowerCase()}-${stamp}`,
          price, isAvailable: true,
          branches: { create: [
            { restaurantId: restaurant.id, branchId: main.id },
            { restaurantId: restaurant.id, branchId: kandy.id },
          ] },
        },
      })
    const a = await dish('Kottu', 150_000)
    const b = await dish('Rice', 150_000)
    const user = async (label: string, role: 'OWNER' | 'CASHIER' | 'MANAGER', branchId?: string) =>
      prisma.user.create({
        data: {
          restaurantId: restaurant.id, email: `${label}-${stamp}@test.local`, name: label,
          passwordHash: 'x', role, ...(branchId ? { branchId } : {}),
        },
      })
    const owner = await user(`own${label}`, 'OWNER')
    const cashier = await user(`csh${label}`, 'CASHIER', main.id)
    const table = await prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, branchId: main.id, number: '4', capacity: 4 },
    })
    return { restaurant, main, kandy, a, b, owner, cashier, table }
  }

  const S = await shop('a', false)
  const I = await shop('i', true)
  const actor = (u: { id: string; role: string; branchId?: string | null }): DrawerActor => ({
    id: u.id, role: u.role as DrawerActor['role'], branchId: u.branchId ?? null,
    canManageOthers: true, canReviewVariance: true,
  })
  const order = (over: Partial<Parameters<typeof placeOrder>[0]> = {}, s = S) =>
    placeOrder({
      restaurantId: s.restaurant.id, branchId: s.main.id, tableId: null, type: 'TAKEAWAY', channel: 'COUNTER',
      customerName: 'Walk-in', customerPhone: '', items: [{ foodId: s.a.id, quantity: 1, optionIds: [] }],
      ...over,
    })
  const settle = (orderId: string, amount: number, s = S) =>
    capturePayment({ restaurantId: s.restaurant.id, orderId, method: 'CASH', amount, receivedById: s.cashier.id })
  const today = resolveRange({ preset: 'TODAY', timeZone: tz })

  console.log('\n── M10 + M1. A tax-inclusive bill keeps its rule, and the books balance ──')
  {
    const bill = await order({ items: [{ foodId: I.a.id, quantity: 1, optionIds: [] }, { foodId: I.b.id, quantity: 1, optionIds: [] }] }, I)
    check('the bill snapshots the tax rule it was priced under', bill.taxInclusive === true)
    check('inclusive: the total is the menu price, tax inside it', bill.grandTotal === 300_000 && bill.taxTotal === 27_273, `${bill.grandTotal} / ${bill.taxTotal}`)

    // The owner flips the switch in Settings while the bill is open.
    await prisma.restaurant.update({ where: { id: I.restaurant.id }, data: { taxInclusive: false } })
    const rice = bill.items.find((line) => line.foodId === I.b.id)!
    const { order: after } = await voidOrderItem({ restaurantId: I.restaurant.id, orderId: bill.id, itemId: rice.id, reason: 'sent back' })
    check('voiding a line recomputes under the bill’s OWN rule, not today’s setting',
      after.grandTotal === 150_000, `${after.grandTotal} (would be 165,000 under the flipped setting)`)
    await prisma.restaurant.update({ where: { id: I.restaurant.id }, data: { taxInclusive: true } })

    await settle(bill.id, 150_000, I)
    const entries = await buildJournal({ restaurantId: I.restaurant.id, range: today })
    const sale = entries.find((entry) => entry.id === `sale:${bill.id}`)!
    check('the sale entry needed no plug — it balanced on its own', sale !== undefined && !sale.warning, sale?.warning ?? 'no entry')
    const revenue = sale.lines.find((line) => line.account === '4000')!
    check('revenue is credited net of the tax the price contained', revenue.credit === 150_000 - 13_636, `${revenue.credit}`)

    const sales = await getSalesReport({ restaurantId: I.restaurant.id, range: today })
    const trial = foldTrialBalance(entries)
    const bal = (code: string) => trial.rows.find((row) => row.code === code)?.balance ?? 0
    check('the sales report reports revenue ex-tax too', sales.totals.grossSales === 150_000 - 13_636, `${sales.totals.grossSales}`)
    check('…and the ledger’s revenue IS the sales report’s net sales',
      bal('4000') - bal('4100') - bal('4110') === sales.totals.netSales, `${bal('4000') - bal('4100') - bal('4110')} vs ${sales.totals.netSales}`)
    check('collected = net + tax + service, in both tax modes',
      sales.totals.collected === sales.totals.netSales + sales.totals.tax + sales.totals.serviceCharge)
    check('no entry in the period was plugged into 4910 — the warning field is the record of that',
      entries.every((e) => !e.warning), JSON.stringify(entries.filter((e) => e.warning).map((e) => e.warning)))
  }

  console.log('\n── M2. Points are earned once per bill, and taken back when every rupee is ──')
  {
    const customer = await prisma.customer.create({
      data: { restaurantId: S.restaurant.id, name: 'Regular', phone: `077${stamp.slice(-5)}1`, loyaltyPoints: 0 },
    })
    const bill = await order({ customerName: 'Regular', customerPhone: customer.phone })
    await settle(bill.id, bill.grandTotal)
    await Promise.all([settleLoyalty(bill.id), settleLoyalty(bill.id)])
    const first = await refundPayment({
      restaurantId: S.restaurant.id, paymentId: (await prisma.payment.findFirstOrThrow({ where: { orderId: bill.id } })).id,
      amount: 50_000, reason: 'a little back', actorId: S.owner.id,
    })
    await settle(bill.id, 50_000) // fully settled again → the old code earned again here
    const earned = await prisma.loyaltyEntry.count({ where: { orderId: bill.id, kind: 'EARNED' } })
    const holder = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })
    check('however many times settlement runs, the bill earns once', earned === 1, `${earned} EARNED entries`)
    check('lifetime spend counts the bill once', holder.totalSpent === bill.grandTotal, `${holder.totalSpent}`)
    check('the refund left the balance untouched — the money came back, not the points, yet', holder.loyaltyPoints === 1_650, `${holder.loyaltyPoints}`)
    void first

    const payments = await prisma.payment.findMany({ where: { orderId: bill.id, status: 'PAID' } })
    for (const payment of payments) {
      await refundPayment({ restaurantId: S.restaurant.id, paymentId: payment.id, reason: 'all of it', actorId: S.owner.id })
    }
    const emptied = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })
    /*
     * DELIBERATE behaviour change 2026-09 (loyalty): the refund reversal is a
     * RETURNED entry, not an ADJUSTED one. ADJUSTED is a hand correction — the
     * kind a manager makes — and overloading it here meant the guard against a
     * double reversal had to be the opening words of the note, which any
     * rewording would have switched off. It is a kind plus a marker now.
     */
    const reversal = await prisma.loyaltyEntry.findFirst({ where: { orderId: bill.id, kind: 'RETURNED' } })
    check('every rupee back: the points it earned go back too', emptied.loyaltyPoints === 0 && reversal?.points === -1_650, `${emptied.loyaltyPoints} / ${reversal?.points}`)
    check('…and the reversal happens once, whatever the refund count', (await prisma.loyaltyEntry.count({ where: { orderId: bill.id, kind: 'RETURNED' } })) === 1)
  }

  console.log('\n── M3. Money on the bill means the bill does not change shape ──')
  {
    const bill = await order({ items: [{ foodId: S.a.id, quantity: 1, optionIds: [] }, { foodId: S.b.id, quantity: 1, optionIds: [] }] })
    await settle(bill.id, 100_000) // PARTIAL
    const line = bill.items[0]
    await refuses('a partly paid bill cannot be voided below what was collected',
      () => voidOrderItem({ restaurantId: S.restaurant.id, orderId: bill.id, itemId: line.id, reason: 'oops' }), /money on it/)
    const other = await order()
    await refuses('…nor merged into', () => mergeBills({ restaurantId: S.restaurant.id, targetId: bill.id, sourceIds: [other.id] }), /payment on it/)

    // The class the integrity checker now names: a row where paid exceeds the bill.
    await prisma.order.update({ where: { id: other.id }, data: { paidTotal: other.grandTotal + 1 } })
    const dirty = await runIntegrityChecks(S.restaurant.id)
    check('the integrity checker flags a bill holding more than it charged', dirty.checks.find((c) => c.key === 'paid-over-billed')?.status === 'ERROR')
    await prisma.order.update({ where: { id: other.id }, data: { paidTotal: 0 } })
  }

  console.log('\n── M4. A shrinking bill gives back the points it can no longer absorb ──')
  {
    const customer = await prisma.customer.create({
      data: { restaurantId: S.restaurant.id, name: 'Saver', phone: `077${stamp.slice(-5)}2`, loyaltyPoints: 300 },
    })
    // Kottu ×1 + Rice ×2 = 450,000; points may settle at most half a bill.
    const bill = await order({
      customerName: 'Saver', customerPhone: customer.phone, redeemPoints: 225,
      items: [{ foodId: S.a.id, quantity: 1, optionIds: [] }, { foodId: S.b.id, quantity: 2, optionIds: [] }],
    })
    check('225 points at 10.00 each took 225,000 off a 450,000 bill', bill.loyaltyDiscount === 225_000, `${bill.loyaltyDiscount}`)
    const rice = bill.items.find((l) => l.foodId === S.b.id)!
    const { order: after } = await voidOrderItem({ restaurantId: S.restaurant.id, orderId: bill.id, itemId: rice.id, reason: 'sent back' })
    const saver = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })
    check('the discount is clamped to the 150,000 that is left', after.loyaltyDiscount === 150_000, `${after.loyaltyDiscount}`)
    check('…and the 75 points that no longer buy anything are back with the guest', saver.loyaltyPoints === 150, `${saver.loyaltyPoints}`)
    check('with a ledger entry saying so', (await prisma.loyaltyEntry.findFirst({ where: { orderId: bill.id, kind: 'RETURNED' } }))?.points === 75)
  }

  console.log('\n── M5. paymentStatus is derived from the money, once ──')
  {
    check('nothing paid is UNPAID', derivePaymentStatus({ paidTotal: 0, grandTotal: 100, tipAmount: 0 }) === 'UNPAID')
    check('less than the bill plus tip is PARTIAL', derivePaymentStatus({ paidTotal: 100, grandTotal: 100, tipAmount: 10 }) === 'PARTIAL')
    check('the bill plus tip is PAID', derivePaymentStatus({ paidTotal: 110, grandTotal: 100, tipAmount: 10 }) === 'PAID')
    check('a refunded bill stays REFUNDED', derivePaymentStatus({ paidTotal: 0, grandTotal: 100, tipAmount: 0, current: 'REFUNDED' }) === 'REFUNDED')

    const bill = await order()
    await settle(bill.id, bill.grandTotal)
    await prisma.orderItem.create({ data: { orderId: bill.id, foodId: S.b.id, name: 'Rice', unitPrice: 150_000, quantity: 1, lineTotal: 150_000 } })
    const grown = await prisma.$transaction((tx) => recalculateOrderTotals(tx, bill.id))
    check('a paid bill that grew reads PARTIAL again, not PAID with money owed', grown.paymentStatus === 'PARTIAL' && grown.paidTotal < grown.grandTotal, grown.paymentStatus)
  }

  console.log('\n── M6. A refund is booked on the day it is given ──')
  {
    const bill = await order()
    await settle(bill.id, bill.grandTotal)
    const yesterday = new Date(Date.now() - 86_400_000)
    await prisma.order.update({ where: { id: bill.id }, data: { placedAt: yesterday } })
    const yRange = resolveRange({ preset: 'YESTERDAY', timeZone: tz })
    const before = await getSalesReport({ restaurantId: S.restaurant.id, range: yRange })
    // The accountant seals yesterday. A refund of yesterday's bill given today
    // is today's business (owner decision, 2026-09-13): it is allowed, and the
    // sealed day's signed figures cannot move.
    const sealed = await closePeriod({ restaurantId: S.restaurant.id, from: yRange.from, to: yRange.to, userId: S.owner.id })
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: bill.id } })
    let allowed = ''
    try {
      await refundPayment({ restaurantId: S.restaurant.id, paymentId: payment.id, amount: 40_000, reason: 'cold', actorId: S.owner.id })
    } catch (error) { allowed = error instanceof Error ? error.message : String(error) }
    check('refunding a sealed day’s bill today is allowed — it is today’s business', allowed === '', allowed)
    const [yest, tod] = await Promise.all([
      getSalesReport({ restaurantId: S.restaurant.id, range: yRange }),
      getSalesReport({ restaurantId: S.restaurant.id, range: today }),
    ])
    check('the sealed day’s signed figures do not move', yest.totals.netSales === before.totals.netSales && yest.totals.refunds === 0, `${yest.totals.refunds}`)
    check('today’s report carries the refund given today', tod.totals.refunds >= 40_000, `${tod.totals.refunds}`)
    await prisma.accountingPeriod.delete({ where: { id: sealed.id } })
  }

  console.log('\n── M7. The profit report sees a partial refund ──')
  {
    const profit = await getProfitReport({ restaurantId: S.restaurant.id, range: today })
    const sales = await getSalesReport({ restaurantId: S.restaurant.id, range: today })
    check('profit revenue IS the sales report’s net sales, discounts and refunds included',
      profit.totals.revenue === sales.totals.netSales,
      `${profit.totals.revenue} vs ${sales.totals.netSales} — sales ${JSON.stringify(sales.totals)}`)
    const sumOf = (rows: Array<{ revenue: number }>) => rows.reduce((sum, row) => sum + row.revenue, 0)
    check('…and the dish, category and branch tables all sum to one figure',
      sumOf(profit.byFood) === sumOf(profit.byCategory) && sumOf(profit.byCategory) === sumOf(profit.byBranch),
      `${sumOf(profit.byFood)} / ${sumOf(profit.byCategory)} / ${sumOf(profit.byBranch)}`)
  }

  console.log('\n── M8. Receiving in a bigger unit loses nothing ──')
  {
    const supplier = await prisma.supplier.create({ data: { restaurantId: S.restaurant.id, name: `Mill ${stamp}` } })
    const flour = await prisma.inventoryItem.create({ data: { restaurantId: S.restaurant.id, name: `Flour ${stamp}`, unit: 'GRAM', quantity: 0, costPerUnit: 0 } })
    const po = await createPurchaseOrder({
      restaurantId: S.restaurant.id, supplierId: supplier.id, branchId: S.main.id,
      lines: [{ itemId: flour.id, quantity: 1, unit: 'KG', unitCost: 650 }],
    })
    await setPurchaseStatus({ restaurantId: S.restaurant.id, purchaseId: po.id, status: 'APPROVED' })
    const line = await prisma.purchaseItem.findFirstOrThrow({ where: { purchaseId: po.id } })
    await receiveGoods({ restaurantId: S.restaurant.id, purchaseId: po.id, lines: [{ purchaseItemId: line.id, acceptedQty: 1 }] })
    const stocked = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour.id } })
    check('1 kg at 6.50 is worth 6.50 on the shelf, not 0.65/g rounded to 1 → 10.00',
      Math.round(Number(stocked.stockValue)) === 650, `${stocked.stockValue}`)
  }

  console.log('\n── M9. A drawer closes once, under a lock ──')
  {
    const till = await ensureRegister({ restaurantId: S.restaurant.id, branchId: S.main.id })
    const session = await openDrawer({ restaurantId: S.restaurant.id, userId: S.cashier.id, branchId: S.main.id, registerId: till.id, openingFloat: 100_000 })
    const outcomes = await Promise.allSettled([
      closeDrawer({ restaurantId: S.restaurant.id, sessionId: session.id, countedCash: 100_000, userId: S.cashier.id, actor: actor(S.cashier) }),
      closeDrawer({ restaurantId: S.restaurant.id, sessionId: session.id, countedCash: 100_000, userId: S.cashier.id, actor: actor(S.cashier) }),
    ])
    const won = outcomes.filter((o) => o.status === 'fulfilled').length
    check('two simultaneous closes: exactly one closes it', won === 1, `${won} succeeded`)
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult | undefined
    check('…and the other is told it was closed a moment ago', /closed a moment ago/.test(String(loser?.reason?.message)), String(loser?.reason?.message))
  }

  console.log('\n── M11 + D4. A split is the same sitting; two first orders open one sitting ──')
  {
    /*
     * DELIBERATE behaviour change 2026-09 (aO.md §2). Two strangers scanning
     * one table at once no longer both get an order — the second is told the
     * table is in use. The race this pins (two first orders opening ONE
     * sitting, never two) is run with till orders, which may always seat a
     * table; the QR refusal is pinned right after.
     */
    const [one, two] = await Promise.all([
      order({ type: 'DINE_IN', channel: 'STAFF', tableId: S.table.id }),
      order({ type: 'DINE_IN', channel: 'STAFF', tableId: S.table.id, items: [{ foodId: S.b.id, quantity: 2, optionIds: [] }] }),
    ])
    check('two first orders at one table at once share ONE sitting', one.tableSessionId !== null && one.tableSessionId === two.tableSessionId)
    await refuses('a QR guest scanning the now-occupied table is refused', () => order({ type: 'DINE_IN', channel: 'QR', tableId: S.table.id, guestSessionId: `stranger-${stamp}` }), /currently in use/)
    check('…and the table has exactly one open sitting', (await prisma.tableSession.count({ where: { tableId: S.table.id, status: 'OPEN' } })) === 1)

    const rice = two.items[0]
    const { source, target } = await splitBill({ restaurantId: S.restaurant.id, orderId: two.id, selections: [{ itemId: rice.id, quantity: 1 }] })
    check('the split half keeps the table, the channel and the sitting',
      target.tableNumber === source.tableNumber && target.channel === source.channel && target.tableSessionId === source.tableSessionId && target.taxInclusive === source.taxInclusive,
      JSON.stringify({ t: target.tableNumber, c: target.channel, s: target.tableSessionId }))

    const three = await order({ items: [{ foodId: S.a.id, quantity: 3, optionIds: [] }, { foodId: S.b.id, quantity: 3, optionIds: [] }] })
    const [x, y] = three.items
    const splits = await Promise.allSettled([
      splitBill({ restaurantId: S.restaurant.id, orderId: three.id, selections: [{ itemId: x.id, quantity: 1 }] }),
      splitBill({ restaurantId: S.restaurant.id, orderId: three.id, selections: [{ itemId: y.id, quantity: 1 }] }),
    ])
    const outcomes = splits.map((s) => (s.status === 'fulfilled' ? s.value.target.orderNumber : `✗ ${String(s.reason?.message)}`))
    const numbers = outcomes.filter((n) => !n.startsWith('✗'))
    check('two simultaneous splits both succeed with distinct suffixes', numbers.length === 2 && new Set(numbers).size === 2, JSON.stringify(outcomes))
  }

  console.log('\n── M14. Two cooks accept the same ticket once ──')
  {
    const bill = await order()
    await Promise.allSettled([
      updateOrderStatus({ restaurantId: S.restaurant.id, orderId: bill.id, status: 'ACCEPTED' }),
      updateOrderStatus({ restaurantId: S.restaurant.id, orderId: bill.id, status: 'ACCEPTED' }),
    ])
    check('one ACCEPTED event, not two', (await prisma.orderEvent.count({ where: { orderId: bill.id, status: 'ACCEPTED' } })) === 1)
  }

  console.log('\n── M16. A period is sealed once ──')
  {
    const from = new Date('2026-01-01T00:00:00Z'), to = new Date('2026-01-31T23:59:59Z')
    const outcomes = await Promise.allSettled([
      closePeriod({ restaurantId: S.restaurant.id, from, to, userId: S.owner.id }),
      closePeriod({ restaurantId: S.restaurant.id, from, to, userId: S.owner.id }),
    ])
    check('two accountants sealing at once seal it once', outcomes.filter((o) => o.status === 'fulfilled').length === 1)
    check('…and there is one sealed row, not two overlapping ones', (await prisma.accountingPeriod.count({ where: { restaurantId: S.restaurant.id, periodStart: from } })) === 1)
  }

  console.log('\n── M18. A claimed payment must be this bill’s ──')
  {
    const x = await order(); const y = await order()
    const claim = await prisma.payment.create({ data: { restaurantId: S.restaurant.id, orderId: x.id, method: 'QR', status: 'UNPAID', amount: x.grandTotal } })
    await refuses('an intent raised on bill X cannot settle bill Y',
      () => capturePayment({ restaurantId: S.restaurant.id, orderId: y.id, method: 'QR', amount: y.grandTotal, paymentId: claim.id }), /Payment/)
    const still = await prisma.payment.findUniqueOrThrow({ where: { id: claim.id } })
    check('…and X’s intent is untouched', still.status === 'UNPAID')
  }

  console.log('\n── M19. Merging keeps the coupon on the books ──')
  {
    const coupon = await prisma.coupon.create({ data: { restaurantId: S.restaurant.id, code: `FIX${stamp.toUpperCase().slice(-5)}`, type: 'FIXED', value: 20_000, minOrderAmount: 0, isActive: true } })
    const target = await order()
    const source = await order({ couponCode: coupon.code })
    check('the source bill redeemed it', source.couponDiscount === 20_000)
    await mergeBills({ restaurantId: S.restaurant.id, targetId: target.id, sourceIds: [source.id] })
    const moved = await prisma.couponRedemption.findFirst({ where: { orderId: target.id, couponId: coupon.id } })
    const merged = await prisma.order.findUniqueOrThrow({ where: { id: target.id } })
    check('the redemption now sits on the merged bill', moved !== null && moved.amount === 20_000)
    check('and the merged bill carries the discount with its total in step', merged.couponDiscount === 20_000 && merged.discountTotal === merged.couponDiscount + merged.manualDiscount)
  }

  console.log('\n── D5. The month is the restaurant’s month ──')
  {
    const april = monthBounds('2026-04', tz)
    check('April in Colombo starts at 18:30Z on 31 March', april.from.toISOString() === '2026-03-31T18:30:00.000Z', april.from.toISOString())
    check('…and ends at 18:29:59.999Z on 30 April', april.to.toISOString() === '2026-04-30T18:29:59.999Z', april.to.toISOString())
    check('business dates are compared against the calendar month', april.dateFrom.toISOString() === '2026-04-01T00:00:00.000Z' && april.dateTo.toISOString() === '2026-04-30T23:59:59.999Z')
  }

  console.log('\n── D6. A runner that died mid-job is reclaimed; two schedulers enqueue one row ──')
  {
    const stale = await prisma.job.create({ data: { kind: 'outbox-trim', status: 'RUNNING', startedAt: new Date(Date.now() - 20 * 60_000), runAt: new Date(Date.now() - 30 * 60_000), attempts: 1 } })
    await runJobs(10)
    const after = await prisma.job.findUniqueOrThrow({ where: { id: stale.id } })
    check('a job stuck RUNNING for twenty minutes is picked up again', after.status !== 'RUNNING' && after.attempts === 2, `${after.status} / ${after.attempts}`)
    const key = `fix-${stamp}`
    const both = await Promise.all([enqueue({ kind: 'outbox-trim', dedupeKey: key }), enqueue({ kind: 'outbox-trim', dedupeKey: key })])
    check('two schedulers asking for the same job get one row, no crash', both.filter((r) => r.created).length === 1 && both[0].id === both[1].id)
    await prisma.job.deleteMany({ where: { OR: [{ id: stale.id }, { dedupeKey: key }] } })
  }

  console.log('\n── D7. A coupon’s hours are the restaurant’s hours, in basis points ──')
  {
    const coupon = await prisma.coupon.create({ data: { restaurantId: S.restaurant.id, code: `HH${stamp.toUpperCase().slice(-5)}`, type: 'PERCENT', value: 1_000, minOrderAmount: 0, isActive: true, startHour: 18, endHour: 22 } })
    const ctx = { restaurantId: S.restaurant.id, subtotal: 100_000, lines: [], now: new Date('2026-09-13T04:30:00Z') }
    const kiritimati = await evaluate(coupon, { ...ctx, timeZone: 'Pacific/Kiritimati' }) // 18:30 local
    const utc = await evaluate(coupon, { ...ctx, timeZone: 'UTC' })                        // 04:30
    check('18:30 in the restaurant’s zone is inside 18:00–22:00', kiritimati.ok === true, kiritimati.reason)
    check('…and 04:30 is not', utc.ok === false)
    check('10% stored as 1000 bps takes 10,000 off 100,000 — not 1000%', kiritimati.amount === 10_000, `${kiritimati.amount}`)

    // Two live offers around this very hour in the restaurant's clock: one
    // whose window covers it, one whose window does not. The order path never
    // consulted the window at all before.
    const hour = Math.floor(localMinutes(new Date(), tz).minutes / 60)
    const open = await prisma.coupon.create({ data: { restaurantId: S.restaurant.id, code: `IN${stamp.toUpperCase().slice(-5)}`, type: 'PERCENT', value: 1_000, minOrderAmount: 0, isActive: true, startHour: hour, endHour: (hour + 2) % 24 } })
    const shut = await prisma.coupon.create({ data: { restaurantId: S.restaurant.id, code: `OUT${stamp.toUpperCase().slice(-5)}`, type: 'PERCENT', value: 1_000, minOrderAmount: 0, isActive: true, startHour: (hour + 3) % 24, endHour: (hour + 5) % 24 } })
    const inside = await order({ couponCode: open.code })
    check('an offer whose hours cover now, in the restaurant’s clock, is applied to the order', inside.couponDiscount === 15_000, `${inside.couponDiscount}`)
    await refuses('…and one whose hours do not is refused at ordering', () => order({ couponCode: shut.code }), /runs between/)
  }

  console.log('\n── D8. Receipts and wastage submitted twice post once ──')
  {
    const supplier = await prisma.supplier.create({ data: { restaurantId: S.restaurant.id, name: `Twice ${stamp}` } })
    const item = await prisma.inventoryItem.create({ data: { restaurantId: S.restaurant.id, name: `Oil ${stamp}`, unit: 'KG', quantity: 0, costPerUnit: 1_000 } })
    const po = await createPurchaseOrder({ restaurantId: S.restaurant.id, supplierId: supplier.id, branchId: S.main.id, lines: [{ itemId: item.id, quantity: 100, unit: 'KG', unitCost: 1_000 }] })
    await setPurchaseStatus({ restaurantId: S.restaurant.id, purchaseId: po.id, status: 'APPROVED' })
    const line = await prisma.purchaseItem.findFirstOrThrow({ where: { purchaseId: po.id } })
    const key = `grn-${stamp}`
    await Promise.all([
      receiveGoods({ restaurantId: S.restaurant.id, purchaseId: po.id, clientRequestId: key, lines: [{ purchaseItemId: line.id, acceptedQty: 50 }] }),
      receiveGoods({ restaurantId: S.restaurant.id, purchaseId: po.id, clientRequestId: key, lines: [{ purchaseItemId: line.id, acceptedQty: 50 }] }),
    ])
    check('the same delivery tapped twice is one GRN and 50 in stock, not 100',
      (await prisma.goodsReceipt.count({ where: { purchaseId: po.id } })) === 1 && (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantity === 50)

    const wkey = `waste-${stamp}`
    await Promise.all([
      recordWastage({ restaurantId: S.restaurant.id, itemId: item.id, quantity: 5, reason: 'SPOILED', branchId: S.main.id, clientRequestId: wkey }),
      recordWastage({ restaurantId: S.restaurant.id, itemId: item.id, quantity: 5, reason: 'SPOILED', branchId: S.main.id, clientRequestId: wkey }),
    ])
    check('the same write-off tapped twice is one record and 45 left, not 40',
      (await prisma.wastageRecord.count({ where: { clientRequestId: wkey } })) === 1 && (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantity === 45)
  }

  console.log('\n── Integrity. Duplicate earnings are named ──')
  {
    const bill = await order()
    const customer = await prisma.customer.create({ data: { restaurantId: S.restaurant.id, name: 'Dup', phone: `077${stamp.slice(-5)}3` } })
    await prisma.loyaltyEntry.createMany({ data: [1, 2].map(() => ({ restaurantId: S.restaurant.id, customerId: customer.id, orderId: bill.id, points: 5, kind: 'EARNED' as const })) })
    const dirty = await runIntegrityChecks(S.restaurant.id)
    check('two EARNED entries on one order are an ERROR the accountant sees', dirty.checks.find((c) => c.key === 'loyalty-earned-once')?.status === 'ERROR')
    await prisma.loyaltyEntry.deleteMany({ where: { orderId: bill.id } })
  }

  await teardown()
  console.log(`\n${passed} passed, ${failed} failed`)
  await prisma.$disconnect()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  await teardown().catch(() => undefined)
  await prisma.$disconnect()
  process.exit(1)
})
