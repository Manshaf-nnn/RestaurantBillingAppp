/**
 * Structural entities (AUDIT.md Slice 5).
 *
 *   • A sitting is a TableSession: orders at one table share it, and it closes
 *     when the table clears — "what does table 4 owe" finally has a subject.
 *   • Splitting a discounted bill carries the discounts pro-rata; merging
 *     absorbs them. The halves always sum back to the whole.
 *   • The waiter's serve-all works from PREPARING, stamping every timestamp
 *     on the way — the board's primary button used to throw on its most
 *     common case.
 *   • Invoices exist from presentation, and the number never changes.
 *   • closeDay freezes the §51 report; a sealed AccountingPeriod refuses
 *     cancellation of the orders inside it, and reopening lifts that (§59).
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/structural-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { cancelOrder, placeOrder, serveWholeOrder, updateOrderStatus } from '../src/features/orders/service'
import { capturePayment, ensureInvoice } from '../src/features/payments/service'
import { splitBill, mergeBills } from '../src/features/cashier/service'
import { businessDateOf, closeDay, closePeriod, reopenPeriod } from '../src/features/accounting/service'

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

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Struct ${stamp}`, slug: `struct-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      timezone: 'Asia/Colombo',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const table = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, number: '4' },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: `Kottu ${stamp}`,
      slug: `kottu-${stamp}`, price: 100_000, isAvailable: true,
    },
  })
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, foodId: dish.id, isAvailable: true },
  })
  const cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `struct-${stamp}@test.local`, name: 'Cashier',
      passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
    },
  })

  const order = (extra: Partial<Parameters<typeof placeOrder>[0]> = {}) =>
    placeOrder({
      restaurantId: restaurant.id, branchId: branch.id,
      type: extra.tableId ? 'DINE_IN' : 'TAKEAWAY',
      customerName: 'Guest', customerPhone: '',
      items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
      ...extra,
    })

  console.log('\n── 1. A sitting is a session ──')
  {
    const first = await order({ tableId: table.id })
    const second = await order({ tableId: table.id })
    const a = await prisma.order.findUniqueOrThrow({ where: { id: first.id } })
    const b = await prisma.order.findUniqueOrThrow({ where: { id: second.id } })
    check('two orders at one table share a session',
      a.tableSessionId !== null && a.tableSessionId === b.tableSessionId,
      `${a.tableSessionId} vs ${b.tableSessionId}`)

    for (const o of [a, b]) {
      await updateOrderStatus({ restaurantId: restaurant.id, orderId: o.id, status: 'ACCEPTED' })
      await serveWholeOrder({ restaurantId: restaurant.id, orderId: o.id })
      // Settling a SERVED order completes it; the last completion clears the
      // table, and clearing the table is what ends the sitting.
      await capturePayment({
        restaurantId: restaurant.id, orderId: o.id, method: 'CASH',
        amount: 100_000, tenderedAmount: 100_000, receivedById: cashier.id,
      })
    }
    const session = await prisma.tableSession.findUniqueOrThrow({ where: { id: a.tableSessionId! } })
    check('settling everything closes the sitting', session.status === 'CLOSED' && session.closedAt !== null)

    const third = await order({ tableId: table.id })
    const c = await prisma.order.findUniqueOrThrow({ where: { id: third.id } })
    check('the next guest at the table starts a NEW session',
      c.tableSessionId !== null && c.tableSessionId !== a.tableSessionId)
    await cancelOrder({ restaurantId: restaurant.id, orderId: c.id, reason: 'test cleanup' })
  }

  console.log('\n── 2. Splitting carries the discounts with the food ──')
  {
    const bill = await order({
      items: [
        { foodId: dish.id, quantity: 3, optionIds: [] },
        { foodId: dish.id, quantity: 1, optionIds: [] },
      ],
    })
    await prisma.order.update({
      where: { id: bill.id },
      data: { manualDiscount: 40_000, discountTotal: 40_000 },
    })
    const items = await prisma.orderItem.findMany({ where: { orderId: bill.id } })
    const { source, target } = await splitBill({
      restaurantId: restaurant.id, orderId: bill.id,
      selections: [{ itemId: items[0].id, quantity: 1 }],
      actorId: cashier.id, actorName: 'Cashier',
    })
    check('the discounts sum back to the original',
      source.manualDiscount + target.manualDiscount === 40_000,
      `${source.manualDiscount} + ${target.manualDiscount}`)
    check('each side is discounted in proportion to what it holds',
      target.manualDiscount === 10_000 && source.manualDiscount === 30_000,
      `${source.manualDiscount}/${target.manualDiscount}`)
    check('…and each side’s bill reflects its own share',
      source.grandTotal === 270_000 && target.grandTotal === 90_000,
      `${source.grandTotal}/${target.grandTotal}`)

    const merged = await mergeBills({
      restaurantId: restaurant.id, targetId: source.id, sourceIds: [target.id],
      actorId: cashier.id, actorName: 'Cashier',
    })
    check('merging absorbs the discount back', merged.manualDiscount === 40_000, `${merged.manualDiscount}`)
    check('and the whole is the original bill again', merged.grandTotal === 360_000, `${merged.grandTotal}`)
    await cancelOrder({ restaurantId: restaurant.id, orderId: merged.id, reason: 'test cleanup' })
  }

  console.log('\n── 3. Serve-all works mid-cooking ──')
  {
    const o = await order()
    await updateOrderStatus({ restaurantId: restaurant.id, orderId: o.id, status: 'ACCEPTED' })
    await updateOrderStatus({ restaurantId: restaurant.id, orderId: o.id, status: 'PREPARING' })
    const served = await serveWholeOrder({ restaurantId: restaurant.id, orderId: o.id })
    check('the order lands on SERVED from PREPARING', served.status === 'SERVED')
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    check('every intervening timestamp was stamped',
      row.readyAt !== null && row.servedAt !== null,
      `readyAt ${row.readyAt}, servedAt ${row.servedAt}`)
  }

  console.log('\n── 4. The invoice exists when the bill is presented ──')
  {
    const o = await order()
    const number = await prisma.$transaction((tx) =>
      ensureInvoice(tx, { restaurantId: restaurant.id, orderId: o.id }),
    )
    check('an unpaid bill has a numbered invoice', /^INV-\d{4}-\d{5}$/.test(number), number)

    const captured = await capturePayment({
      restaurantId: restaurant.id, orderId: o.id, method: 'CASH',
      amount: 100_000, tenderedAmount: 100_000, receivedById: cashier.id,
    })
    check('settlement keeps the number the guest already saw',
      captured.invoiceNumber === number,
      `${captured.invoiceNumber} vs ${number}`)
  }

  console.log('\n── 5. Days close, periods seal (§50–51, §59) ──')
  {
    const yesterday = new Date(businessDateOf(new Date(), restaurant.timezone).getTime() - 86_400_000)

    const closed = await closeDay({
      restaurantId: restaurant.id, businessDate: yesterday,
      timeZone: restaurant.timezone, userId: cashier.id,
    })
    const snapshot = closed.snapshot as { sales?: { netSales?: number } }
    check('the close froze a snapshot with the §51 shape',
      typeof snapshot.sales?.netSales === 'number')
    await refuses(
      'closing the same day twice is refused',
      () => closeDay({
        restaurantId: restaurant.id, businessDate: yesterday,
        timeZone: restaurant.timezone, userId: cashier.id,
      }),
      /already closed/,
    )
    await refuses(
      'today cannot be closed while it is still trading',
      () => closeDay({
        restaurantId: restaurant.id,
        businessDate: businessDateOf(new Date(), restaurant.timezone),
        timeZone: restaurant.timezone, userId: cashier.id,
      }),
      /once it is over/,
    )

    // An order backdated into yesterday, then the period sealed over it.
    const old = await order()
    await prisma.order.update({
      where: { id: old.id },
      data: { placedAt: new Date(yesterday.getTime() + 12 * 3_600_000) },
    })
    const period = await closePeriod({
      restaurantId: restaurant.id,
      from: yesterday,
      to: new Date(yesterday.getTime() + 86_400_000),
      userId: cashier.id,
    })
    await refuses(
      'cancelling an order inside a sealed period is refused',
      () => cancelOrder({ restaurantId: restaurant.id, orderId: old.id, reason: 'trying anyway' }),
      /closed accounting period/,
    )
    await reopenPeriod({ restaurantId: restaurant.id, periodId: period.id, userId: cashier.id })
    await cancelOrder({ restaurantId: restaurant.id, orderId: old.id, reason: 'allowed after reopen' })
    const cancelled = await prisma.order.findUniqueOrThrow({ where: { id: old.id } })
    check('reopening the period lifts the seal, on the record', cancelled.status === 'CANCELLED')
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
