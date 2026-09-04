/**
 * Cross-RESTAURANT isolation, swept the way branch isolation already is.
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 *
 * `branch-isolation-test.ts` and `branch-isolation-2-test.ts` sweep branch
 * boundaries thoroughly, and their opening comment draws the distinction that
 * matters: *filtered* is what a UI does, *enforced* is what a service does, and
 * only the second survives somebody pasting an id.
 *
 * Nothing swept the tenant boundary the same way. Cross-restaurant assertions
 * existed, but as one-line asides inside suites about something else —
 * `catalog-test` ("another restaurant sees none of it"), `search-test`
 * ("another restaurant is invisible"), `phase6-test`, `staff-login-test`. Four
 * incidental checks across a system where the tenant boundary is the single
 * most consequential line there is: a branch leak embarrasses one business, a
 * tenant leak shows one restaurant another restaurant's takings.
 *
 * production.md §3 lists exactly what must never cross — orders, customers,
 * inventory, payments, reports, accounting, audit logs — and asks for it to be
 * tested aggressively. This walks that list.
 *
 * ── The method ──────────────────────────────────────────────────────────────
 *
 * Two complete restaurants are built, each with its own branch, staff, menu,
 * stock, orders and money. Then every service is called the way an attacker
 * would: with restaurant A's id and restaurant B's record id — the shape of a
 * pasted URL or a tampered form field. A service that reads its id from the
 * caller and forgets to scope by tenant hands over the row; one that scopes
 * correctly returns nothing or refuses.
 *
 * Reads must come back EMPTY. Writes must be REFUSED. Both are failures of the
 * same rule and both are checked, because a service that lets you read a
 * foreign order is a leak and one that lets you cancel it is worse.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/tenant-isolation-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder, cancelOrder } from '../src/features/orders/service'
import {
  getOrderForStaff, listOrders, getKitchenQueue, getCashierQueue,
} from '../src/features/orders/queries'
import { capturePayment, refundPayment } from '../src/features/payments/service'
import { postMovement, recomputeBalance } from '../src/features/inventory/ledger'
import { getSalesReport } from '../src/features/reports/sales'
import { customRange } from '../src/features/reports/range'
import { runIntegrityChecks } from '../src/features/accounting/integrity'
import { globalSearch } from '../src/features/search/service'
import { getPublicMenu } from '../src/features/menu/queries'

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

/** A write across the tenant line must be refused, not merely filtered. */
async function refuses(name: string, run: () => Promise<unknown>) {
  try {
    await run()
    check(name, false, 'the service allowed it')
  } catch {
    // Any refusal is correct here: NotFound is the right answer to "whose is
    // this", and telling the caller the row exists but is not theirs would
    // itself leak that the record exists.
    check(name, true)
  }
}

/** Build one complete, self-contained restaurant. */
async function buildTenant(label: string, stamp: string) {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `${label} ${stamp}`, slug: `${label.toLowerCase()}-${stamp}`,
      status: 'ACTIVE', isActive: true, currency: 'LKR',
      taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const staff = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `${label.toLowerCase()}-${stamp}@test.local`,
      name: `${label} cashier`, passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
    },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${label}-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id,
      name: `${label} Signature Dish`, slug: `dish-${label}-${stamp}`,
      price: 100_000, isAvailable: true,
    },
  })
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, foodId: dish.id, isAvailable: true },
  })
  const item = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id, name: `${label} Flour`, unit: 'KG',
      quantity: 0, costPerUnit: 500_00, branchId: branch.id,
    },
  })
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: item.id, type: 'PURCHASE',
      quantity: 100, unitCost: 500_00, branchId: branch.id, userId: staff.id,
    }),
  )
  const customer = await prisma.customer.create({
    data: {
      restaurantId: restaurant.id, name: `${label} Regular`,
      phone: `07${label === 'Alpha' ? '1' : '2'}${stamp.slice(-7)}`,
    },
  })

  const order = await placeOrder({
    restaurantId: restaurant.id,
    branchId: branch.id,
    type: 'TAKEAWAY',
    customerName: `${label} Guest`,
    customerPhone: '',
    items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
  })
  const paid = await capturePayment({
    restaurantId: restaurant.id, orderId: order.id, method: 'CASH',
    amount: 100_000, tenderedAmount: 100_000, receivedById: staff.id,
  })
  await prisma.auditLog.create({
    data: {
      restaurantId: restaurant.id, userId: staff.id, action: 'test.secret',
      entity: 'Order', entityId: order.id,
      before: {}, after: { note: `${label} private note` },
    },
  })

  return { restaurant, branch, staff, dish, item, customer, order, payment: paid.payment }
}

async function main() {
  const stamp = Date.now().toString(36)

  const a = await buildTenant('Alpha', stamp)
  const b = await buildTenant('Beta', stamp)

  console.log('\n── 1. Orders ──')
  {
    const staffRead = await getOrderForStaff(a.restaurant.id, b.order.id)
    check('A cannot read B\'s order by id', staffRead === null, JSON.stringify(staffRead)?.slice(0, 60))

    /*
     * The guest reader (`getOrderForGuest`) is deliberately NOT exercised here:
     * it reads the anonymous session cookie, so it only means anything inside a
     * request scope. `guest-edit-test` covers it over real HTTP in the runtime
     * tier, which is the only place the cookie check can actually be tested.
     */

    const list = await listOrders(a.restaurant.id, {})
    const leaked = list.orders?.some((o: { id: string }) => o.id === b.order.id) ?? false
    check('B\'s order is not in A\'s order list', !leaked)

    /*
     * Asserted on the order ID, not the order NUMBER.
     *
     * Order numbers are per-restaurant sequences in the restaurant's own
     * timezone, so two tenants opening on the same day both legitimately have
     * a `260903-001`. A substring check on the number therefore reports a leak
     * that is not there — which it did, on the first run of this suite. The id
     * is globally unique and is the only honest thing to search for.
     */
    const kitchen = await getKitchenQueue(a.restaurant.id)
    check('…nor in A\'s kitchen queue',
      !JSON.stringify(kitchen).includes(b.order.id))

    const cashier = await getCashierQueue(a.restaurant.id)
    check('…nor in A\'s cashier queue',
      !JSON.stringify(cashier).includes(b.order.id))

    await refuses('A cannot cancel B\'s order', () =>
      cancelOrder({
        restaurantId: a.restaurant.id, orderId: b.order.id,
        reason: 'not mine to cancel', actorId: a.staff.id,
      }))
    const survived = await prisma.order.findUniqueOrThrow({ where: { id: b.order.id } })
    check('…and B\'s order is untouched', survived.status !== 'CANCELLED', survived.status)
  }

  console.log('\n── 2. Payments and refunds ──')
  {
    await refuses('A cannot settle a bill belonging to B', () =>
      capturePayment({
        restaurantId: a.restaurant.id, orderId: b.order.id,
        method: 'CASH', amount: 1_000, receivedById: a.staff.id,
      }))

    await refuses('A cannot refund B\'s payment', () =>
      refundPayment({
        restaurantId: a.restaurant.id, paymentId: b.payment.id,
        reason: 'taking B\'s money back', actorId: a.staff.id,
      }))

    const refunds = await prisma.refund.count({ where: { paymentId: b.payment.id } })
    check('…and no refund row was created against it', refunds === 0, `${refunds}`)

    const stillPaid = await prisma.payment.findUniqueOrThrow({ where: { id: b.payment.id } })
    check('B\'s payment is untouched', stillPaid.status === 'PAID' && stillPaid.amount === 100_000)
  }

  console.log('\n── 3. Inventory ──')
  {
    await refuses('A cannot move stock belonging to B', () =>
      prisma.$transaction((tx) =>
        postMovement(tx, {
          restaurantId: a.restaurant.id, itemId: b.item.id, type: 'ADJUSTMENT_OUT',
          quantity: 50, branchId: a.branch.id, userId: a.staff.id,
        }),
      ))
    const held = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: b.item.id } })
    check('…and B still holds all of it', held.quantity === 100, `${held.quantity}`)

    await refuses('A cannot replay B\'s ledger', () =>
      recomputeBalance(a.restaurant.id, b.item.id))

    const aItems = await prisma.inventoryItem.findMany({
      where: { restaurantId: a.restaurant.id }, select: { id: true },
    })
    check('B\'s stock item is not in A\'s inventory',
      !aItems.some((i) => i.id === b.item.id))
  }

  console.log('\n── 4. Reports and accounting ──')
  {
    const range = customRange(
      new Date(Date.now() - 86_400_000),
      new Date(Date.now() + 86_400_000),
      'Asia/Colombo',
    )
    const sales = await getSalesReport({ restaurantId: a.restaurant.id, range })

    /*
     * The sharpest check in this suite. Both tenants took exactly 100,000 in
     * the window, so a report that ignored restaurantId would read 200,000 and
     * look entirely plausible — no error, no empty screen, just one
     * restaurant's revenue quietly including another's.
     */
    check('A\'s net sales count A\'s takings only, not A + B',
      sales.totals.netSales === 100_000,
      `${sales.totals.netSales} (each tenant took 100,000)`)
    check('…and so does what A actually collected',
      sales.totals.collected === 100_000, `${sales.totals.collected}`)
    check('A booked one order, not two', sales.totals.orders === 1, `${sales.totals.orders}`)

    check('B\'s order appears nowhere in A\'s report',
      !JSON.stringify(sales).includes(b.order.id))

    const integrity = await runIntegrityChecks(a.restaurant.id)
    const names = JSON.stringify(integrity)
    check('A\'s integrity report names none of B\'s records',
      !names.includes(b.order.id) && !names.includes(b.payment.id) && !names.includes(b.item.id))
  }

  console.log('\n── 5. Customers, search and the menu ──')
  {
    const found = await globalSearch({
      user: {
        id: a.staff.id, restaurantId: a.restaurant.id,
        role: 'OWNER', branchId: null,
      } as Parameters<typeof globalSearch>[0]['user'],
      term: 'Beta',
    })
    const text = JSON.stringify(found)
    check('searching A for "Beta" finds none of B\'s records',
      !text.includes(b.customer.id) && !text.includes(b.dish.id) && !text.includes(b.order.id),
      text.slice(0, 120))

    const customers = await prisma.customer.findMany({
      where: { restaurantId: a.restaurant.id }, select: { id: true },
    })
    check('B\'s regular is not one of A\'s customers',
      !customers.some((c) => c.id === b.customer.id))

    const menu = await getPublicMenu(a.restaurant.slug)
    check('A\'s public menu does not serve B\'s dish',
      !JSON.stringify(menu).includes(b.dish.name))
  }

  console.log('\n── 6. Audit logs ──')
  {
    const logs = await prisma.auditLog.findMany({
      where: { restaurantId: a.restaurant.id },
      select: { id: true, after: true },
    })
    const text = JSON.stringify(logs)
    check('A\'s audit trail contains none of B\'s entries',
      !text.includes('Beta private note'),
      text.slice(0, 120))

    const bLogs = await prisma.auditLog.count({ where: { restaurantId: b.restaurant.id } })
    check('…while B\'s own trail is intact', bLogs > 0, `${bLogs}`)
  }

  console.log('\n── 7. Deleting one tenant leaves the other whole ──')
  {
    const beforeOrders = await prisma.order.count({ where: { restaurantId: a.restaurant.id } })
    await prisma.restaurant.delete({ where: { id: b.restaurant.id } })
    const afterOrders = await prisma.order.count({ where: { restaurantId: a.restaurant.id } })
    check('removing B changes nothing of A\'s', beforeOrders === afterOrders,
      `${beforeOrders} → ${afterOrders}`)

    const aItem = await prisma.inventoryItem.findUnique({ where: { id: a.item.id } })
    check('…and A\'s stock is still there', aItem?.quantity === 100, `${aItem?.quantity}`)
  }

  await prisma.restaurant.delete({ where: { id: a.restaurant.id } })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
