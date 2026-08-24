/**
 * The bill the till prints has to be the bill the restaurant charges.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * The POS knew one number: `price × quantity`. No tax, no service charge, no
 * discount, no rounding — its own screen said so, "Tax and service charge are
 * added on the bill". That was fine while the button only sent food to the
 * kitchen. The moment it prints a bill, that number becomes a total the guest
 * is asked to pay and the restaurant does not charge, and the gap turns up
 * later as an unexplained difference between the till and the takings.
 *
 * `createStaffOrder` now returns what `placeOrder` actually wrote. Section 2 is
 * written to fail against the naive sum: on a restaurant with 10% service and
 * 5% tax it asserts the returned total is NOT the line-sum, and IS the row.
 *
 * ── And the cashier board showed the same wrong number ──────────────────────
 *
 * Its optimistic queue row inserted `serviceCharge: 0, taxTotal: 0, grandTotal:
 * <line-sum>` until the next poll corrected it. A cashier settling in that
 * window took the wrong money. Same fix, same source.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/pos-billing-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder } from '../src/features/orders/service'
import { buildReceipt } from '../src/features/printing/receipt'
import { readOptions } from '../src/features/orders/queries'
import { formatMoney } from '../src/lib/money'
import { PERMISSIONS } from '../src/lib/rbac'
import { FEATURES, featureForRoute } from '../src/features/access/features'
import { NAV_SECTIONS } from '../src/features/dashboard/nav'

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

/** What the till used to compute on its own, and print. */
const naiveSum = (lines: Array<{ price: number; quantity: number }>) =>
  lines.reduce((total, l) => total + l.price * l.quantity, 0)

async function main() {
  const stamp = Date.now().toString(36)

  /*
   * A restaurant that charges both, because a bill only diverges from the
   * line-sum when something is added to it. With tax and service at zero the
   * bug under test is invisible.
   */
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Till ${stamp}`,
      slug: `till-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      currency: 'LKR',
      taxLabel: 'VAT',
      taxRateBps: 500, // 5%
      serviceChargeBps: 1000, // 10%
      taxInclusive: false,
    },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const second = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Branch 02', code: 'BR02' },
  })
  const table = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: '4' },
  })

  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })
  const curry = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Beef Curry',
      slug: `curry-${stamp}`,
      price: 19_900,
      imageUrl: '/api/media/curry.jpg',
      isAvailable: true,
    },
  })
  const food2 = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Burger',
      slug: `burger-${stamp}`,
      price: 60_000,
      isAvailable: true,
    },
  })

  /*
   * A dish is on a branch's menu only when a `FoodBranch` row says so — the
   * shared-catalogue pattern. Without these, `buildDraft` refuses with "not on
   * the menu here", which is exactly what it should do.
   */
  await prisma.foodBranch.createMany({
    data: [main, second].flatMap((branch) =>
      [curry, food2].map((food) => ({
        restaurantId: restaurant.id,
        branchId: branch.id,
        foodId: food.id,
        isAvailable: true,
      })),
    ),
  })

  const staff = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `till-${stamp}@test.local`,
      name: 'Cashier',
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: main.id,
    },
  })

  // ── 1. an order places, and the row carries real totals ───────────────────
  console.log('\n── 1. the order carries the real totals ──')

  const cart = [
    { price: curry.price, quantity: 2 },
    { price: food2.price, quantity: 1 },
  ]
  const expectedSubtotal = naiveSum(cart) // 2 × 19900 + 60000 = 99800

  const order = await placeOrder({
    restaurantId: restaurant.id,
    type: 'COUNTER',
    channel: 'COUNTER',
    branchId: main.id,
    tableId: null,
    servedById: staff.id,
    createdById: staff.id,
    customerName: 'Walk-in',
    customerPhone: '',
    items: [
      { foodId: curry.id, quantity: 2, optionIds: [] },
      { foodId: food2.id, quantity: 1, optionIds: [] },
    ],
  })

  check('the lines come back with the order', order.items.length === 2, `${order.items.length}`)
  check('subtotal is the line sum', order.subtotal === expectedSubtotal, `${order.subtotal}`)
  check('service charge is 10%', order.serviceCharge === 9_980, `${order.serviceCharge}`)
  check(
    'tax is 5% of subtotal plus service',
    order.taxTotal === Math.round((expectedSubtotal + 9_980) * 0.05),
    `${order.taxTotal}`,
  )

  // ── 2. the bill is NOT the naive sum ──────────────────────────────────────
  console.log('\n── 2. the number the till used to print was wrong ──')

  check(
    'the grand total differs from price × quantity',
    order.grandTotal !== expectedSubtotal,
    'with tax and service set, printing the line sum under-charges',
  )
  /*
   * Subtotal + service + tax + ROUNDING.
   *
   * The rounding adjustment is the fourth thing the till could never have
   * known: this restaurant rounds to the nearest whole unit, so the arithmetic
   * total of 115269 is charged as 115300. A client-side sum is wrong by the
   * tax, by the service charge, and then by this on top.
   */
  check(
    'and is subtotal + service + tax + rounding',
    order.grandTotal ===
      expectedSubtotal + order.serviceCharge + order.taxTotal + order.roundingAdj,
    `${order.grandTotal} vs ${expectedSubtotal + order.serviceCharge + order.taxTotal + order.roundingAdj}`,
  )
  check(
    'and the naive sum is short by more than the tax alone',
    order.grandTotal - expectedSubtotal === order.serviceCharge + order.taxTotal + order.roundingAdj,
    `short by ${order.grandTotal - expectedSubtotal}`,
  )

  /*
   * The number that would actually reach a guest. Built the way the till builds
   * it — from what the action returns — and compared against the database row,
   * so the printed copy and the books cannot disagree.
   */
  const stored = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    include: { items: true },
  })
  const receipt = buildReceipt(
    {
      orderNumber: stored.orderNumber,
      placedAt: stored.placedAt.toISOString(),
      tableNumber: stored.tableNumber,
      customerName: stored.customerName,
      items: stored.items.map((item) => ({
        name: item.name,
        optionsLabel: readOptions(item.options).map((o) => o.name).join(', ') || undefined,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
      })),
      subtotal: stored.subtotal,
      discountTotal: stored.discountTotal,
      serviceCharge: stored.serviceCharge,
      taxTotal: stored.taxTotal,
      grandTotal: stored.grandTotal,
    },
    {
      name: restaurant.name,
      currency: restaurant.currency,
      locale: 'en-IN',
      taxLabel: restaurant.taxLabel,
      paper: { receipt: 58, kitchen: 80 },
      addressLine: null,
      phone: null,
    },
  )

  const total = receipt.totals.find((row) => row.label === 'TOTAL')
  check('the printed TOTAL row is bold', total?.strong === true)
  /*
   * Compared against the row, formatted the same way — not against a string
   * typed into this test. A hardcoded expectation would only prove that the
   * test author and the formatter agreed, which is not the question.
   */
  check(
    'and reads exactly the stored grand total',
    total?.value === formatMoney(stored.grandTotal, restaurant.currency, 'en-IN'),
    `${total?.value} vs stored ${stored.grandTotal}`,
  )
  check(
    'which is NOT what the till would have printed on its own',
    total?.value !== formatMoney(expectedSubtotal, restaurant.currency, 'en-IN'),
    'the bug this whole change exists to fix',
  )
  check(
    'the tax row is labelled as the restaurant labels it',
    receipt.totals.some((row) => row.label === 'VAT'),
    receipt.totals.map((r) => r.label).join(', '),
  )
  check('every line is priced', receipt.lines.length === 2 && receipt.lines.every((l) => l.lineTotal))
  check(
    'no invoice number before the bill is settled',
    receipt.invoiceNumber === null,
    'invoices are issued by the payment, not by placing the order',
  )
  check(
    'and no "paid via" line on an unpaid bill',
    receipt.paymentMethod === undefined || receipt.paymentMethod === null,
  )

  // ── 3. zero rows are omitted ──────────────────────────────────────────────
  console.log('\n── 3. a narrow receipt omits what is zero ──')

  const plain = buildReceipt(
    {
      orderNumber: 'A-1',
      placedAt: new Date().toISOString(),
      tableNumber: null,
      customerName: 'Walk-in',
      items: [{ name: 'Tea', quantity: 1, lineTotal: 10_000 }],
      subtotal: 10_000,
      discountTotal: 0,
      serviceCharge: 0,
      taxTotal: 0,
      grandTotal: 10_000,
    },
    {
      name: 'X',
      currency: 'LKR',
      locale: 'en-IN',
      taxLabel: 'VAT',
      paper: { receipt: 58, kitchen: 80 },
      addressLine: null,
      phone: null,
    },
  )
  check(
    'no Discount, Service or tax row when they are zero',
    plain.totals.length === 2 && plain.totals[0].label === 'Subtotal',
    plain.totals.map((r) => r.label).join(', '),
  )
  check('TOTAL is still there', plain.totals[1].label === 'TOTAL')

  // ── 4. every order type places ────────────────────────────────────────────
  console.log('\n── 4. all four order types ──')

  for (const type of ['COUNTER', 'TAKEAWAY', 'DELIVERY'] as const) {
    const placed = await placeOrder({
      restaurantId: restaurant.id,
      type,
      channel: type === 'COUNTER' ? 'COUNTER' : 'STAFF',
      branchId: main.id,
      tableId: null,
      servedById: staff.id,
      createdById: staff.id,
      customerName: 'Walk-in',
      customerPhone: '0770000000',
      items: [{ foodId: curry.id, quantity: 1, optionIds: [] }],
    })
    check(`${type} places`, placed.type === type && placed.items.length === 1)
  }

  const seated = await placeOrder({
    restaurantId: restaurant.id,
    type: 'DINE_IN',
    channel: 'STAFF',
    branchId: null,
    tableId: table.id,
    servedById: staff.id,
    createdById: staff.id,
    customerName: 'Walk-in',
    customerPhone: '',
    items: [{ foodId: curry.id, quantity: 1, optionIds: [] }],
  })
  check('DINE_IN places and remembers the table', seated.tableNumber === '4', `${seated.tableNumber}`)

  await refuses(
    'DINE_IN without a table is still refused',
    () =>
      placeOrder({
        restaurantId: restaurant.id,
        type: 'DINE_IN',
        channel: 'STAFF',
        branchId: main.id,
        tableId: null,
        servedById: staff.id,
        createdById: staff.id,
        customerName: 'Walk-in',
        customerPhone: '',
        items: [{ foodId: curry.id, quantity: 1, optionIds: [] }],
      }),
    /table is required/i,
  )

  // ── 5. a double tap places one order ──────────────────────────────────────
  console.log('\n── 5. the same cart twice is one order ──')

  const key = `pos-test-${stamp}`
  const first = await placeOrder({
    restaurantId: restaurant.id,
    type: 'COUNTER',
    channel: 'COUNTER',
    branchId: main.id,
    tableId: null,
    servedById: staff.id,
    createdById: staff.id,
    customerName: 'Walk-in',
    customerPhone: '',
    idempotencyKey: key,
    items: [{ foodId: food2.id, quantity: 1, optionIds: [] }],
  })
  const again = await placeOrder({
    restaurantId: restaurant.id,
    type: 'COUNTER',
    channel: 'COUNTER',
    branchId: main.id,
    tableId: null,
    servedById: staff.id,
    createdById: staff.id,
    customerName: 'Walk-in',
    customerPhone: '',
    idempotencyKey: key,
    items: [{ foodId: food2.id, quantity: 1, optionIds: [] }],
  })
  check('the second tap returns the first order', first.id === again.id, `${first.id} vs ${again.id}`)
  check(
    'and it still carries its lines, so the bill can be reprinted',
    again.items.length === 1,
    `${again.items.length}`,
  )
  const count = await prisma.order.count({
    where: { restaurantId: restaurant.id, idempotencyKey: key },
  })
  check('exactly one order exists for that key', count === 1, `${count}`)

  // ── 6. the branch the till is at owns the sale ────────────────────────────
  console.log('\n── 6. branch isolation ──')

  const atSecond = await placeOrder({
    restaurantId: restaurant.id,
    type: 'COUNTER',
    channel: 'COUNTER',
    branchId: second.id,
    tableId: null,
    servedById: staff.id,
    createdById: staff.id,
    customerName: 'Walk-in',
    customerPhone: '',
    items: [{ foodId: curry.id, quantity: 1, optionIds: [] }],
  })
  check('an order rung up at Branch 02 belongs to Branch 02', atSecond.branchId === second.id)
  check('and not to Main', atSecond.branchId !== main.id)

  // ── 7. one POS entry in the sidebar ──────────────────────────────────────
  console.log('\n── 7. one tab, not three ──')

  const tillItems = NAV_SECTIONS.flatMap((section) =>
    section.items.filter((item) => item.href.startsWith('/cashier')),
  )
  check(
    'only two /cashier entries remain — POS and Cashier',
    tillItems.length === 2,
    tillItems.map((i) => `${i.label} → ${i.href}`).join(' | '),
  )
  check(
    'and neither carries a query string',
    tillItems.every((item) => !item.href.includes('?')),
    'a ?type= href can never highlight, because usePathname drops the query',
  )
  check('the POS entry is labelled POS', tillItems.some((item) => item.label === 'POS'))
  check(
    'the Cashier entry is exact, so it does not light up on /cashier/pos',
    tillItems.find((item) => item.href === '/cashier')?.exact === true,
  )
  check(
    'the till is still switchable as a feature',
    featureForRoute('/cashier')?.actions.some((a) => a.permission === PERMISSIONS.PAYMENT_VIEW) ??
      false,
  )
  check(
    'and the registry still covers every nav permission',
    NAV_SECTIONS.flatMap((s) => s.items).every((item) =>
      FEATURES.some((f) => f.actions.some((a) => a.permission === item.permission)),
    ),
  )

  // ── cleanup ───────────────────────────────────────────────────────────────
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.food.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.customer.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
