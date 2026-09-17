/**
 * The invoices list: a period, a status, rows per page, and totals that are
 * true for the whole filtered set (abc.md §2).
 *
 *   - rows and totals come from ONE predicate: issued in the period, at the
 *     chosen locations, with the chosen settlement status — the screen used
 *     to take the newest 200 invoices and add them up in the browser, so a
 *     busy month's "still to collect" was the newest 200's, not the month's;
 *   - Outstanding = unpaid or partly paid; Settled = paid; Refunded; Failed;
 *   - an invoice belongs to a location through its order, and an empty list
 *     of locations is nothing, never everything;
 *   - rows per page is whatever the reader chose (aO.md §6), clamped to
 *     [1, 5000] like orders, with no unlimited option;
 *   - the screen opens on This month through `resolveRange`, mounts the
 *     period filters every report uses, and is rendered by the page suite.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/invoices-list-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { placeOrder } from '../src/features/orders/service'
import { capturePayment, ensureInvoice } from '../src/features/payments/service'
import { listInvoices } from '../src/features/payments/queries'

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

const stamp = Date.now().toString(36)
const DAY = 86_400_000
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.payment.deleteMany({ where: { restaurantId: id } })
  await prisma.invoice.deleteMany({ where: { restaurantId: id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.order.deleteMany({ where: { restaurantId: id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: id } })
  await prisma.food.deleteMany({ where: { restaurantId: id } })
  await prisma.category.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Inv ${stamp}`, slug: `inv-${stamp}`, status: 'ACTIVE', isActive: true,
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
  const category = await prisma.category.create({ data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` } })
  const rice = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Rice', slug: `rice-${stamp}`, price: 50_000, isAvailable: true },
  })
  for (const branchId of [main_.id, other.id]) {
    await prisma.foodBranch.create({ data: { restaurantId: restaurant.id, foodId: rice.id, branchId, isAvailable: true } })
  }
  const cashier = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `inv-${stamp}@test.local`, name: 'Till', passwordHash: 'x', role: 'CASHIER', branchId: main_.id },
  })
  const order = (branchId: string, quantity: number, name: string) =>
    placeOrder({
      restaurantId: restaurant.id, branchId, tableId: null, type: 'TAKEAWAY', channel: 'COUNTER',
      items: [{ foodId: rice.id, quantity, optionIds: [] }],
      customerName: name, customerPhone: '',
    })
  const invoice = (orderId: string) =>
    prisma.$transaction((tx) => ensureInvoice(tx, { restaurantId: restaurant.id, orderId }))

  const unpaid = await order(main_.id, 1, 'Unpaid')
  const partial = await order(main_.id, 2, 'Partial')
  const settled = await order(main_.id, 3, 'Settled')
  const elsewhere = await order(other.id, 1, 'Elsewhere')
  const invUnpaid = await invoice(unpaid.id)
  await invoice(partial.id)
  await invoice(settled.id)
  await invoice(elsewhere.id)
  await capturePayment({ restaurantId: restaurant.id, orderId: partial.id, method: 'CASH', amount: 30_000, tenderedAmount: 30_000, receivedById: cashier.id })
  await capturePayment({ restaurantId: restaurant.id, orderId: settled.id, method: 'CARD', amount: settled.grandTotal, receivedById: cashier.id })
  // The unpaid one was issued three days ago.
  await prisma.invoice.update({ where: { orderId: unpaid.id }, data: { issuedAt: new Date(Date.now() - 3 * DAY) } })
  check('invoices carry their own numbers', /^INV-\d{4}-\d{5}$/.test(invUnpaid))

  const week = { from: new Date(Date.now() - 7 * DAY), to: new Date(Date.now() + DAY) }
  const settledRow = await prisma.order.findUniqueOrThrow({ where: { id: settled.id } })
  const partialRow = await prisma.order.findUniqueOrThrow({ where: { id: partial.id } })

  console.log('\n── 1. Rows and totals from one predicate ──')
  {
    const all = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: week, perPage: 500 })
    check('every invoice issued in the period', all.invoices.length === 4 && all.total === 4)
    const amount = all.invoices.reduce((s, i) => s + i.order.grandTotal + i.order.tipAmount, 0)
    const collected = all.invoices.reduce((s, i) => s + i.order.paidTotal, 0)
    const owed = all.invoices.reduce((s, i) => s + Math.max(0, i.order.grandTotal + i.order.tipAmount - i.order.paidTotal), 0)
    check('count agrees with the rows', all.totals.count === 4)
    check('amount agrees with the rows', all.totals.amount === amount, `${all.totals.amount} vs ${amount}`)
    check('collected agrees with the rows', all.totals.collected === collected && collected === 30_000 + settledRow.grandTotal)
    check('outstanding agrees with the rows', all.totals.outstanding === owed, `${all.totals.outstanding} vs ${owed}`)
    check('newest first', all.invoices[0].order.id !== unpaid.id && all.invoices[all.invoices.length - 1].order.id === unpaid.id)
  }

  console.log('\n── 2. Status ──')
  {
    const outstanding = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: week, status: 'OUTSTANDING', perPage: 50 })
    check('Outstanding is unpaid and partly paid', outstanding.total === 3 && outstanding.invoices.every((i) => ['UNPAID', 'PARTIAL'].includes(i.order.paymentStatus)))
    check('and its totals are theirs', outstanding.totals.count === 3 && outstanding.totals.collected === 30_000 && outstanding.totals.outstanding === unpaid.grandTotal + (partialRow.grandTotal - 30_000) + elsewhere.grandTotal)
    const done = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: week, status: 'SETTLED', perPage: 50 })
    check('Settled is the paid one, nothing owed', done.total === 1 && done.invoices[0].order.id === settled.id && done.totals.outstanding === 0 && done.totals.collected === settledRow.grandTotal)
    const refunded = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: week, status: 'REFUNDED', perPage: 50 })
    check('Refunded is empty here, with zero totals', refunded.total === 0 && refunded.totals.count === 0 && refunded.totals.amount === 0)
  }

  console.log('\n── 3. The period ──')
  {
    const today = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: { from: new Date(Date.now() - DAY), to: week.to }, perPage: 50 })
    check('the older invoice is outside a one-day window', today.total === 3 && !today.invoices.some((i) => i.order.id === unpaid.id))
    check('and the totals follow', today.totals.count === 3 && today.totals.outstanding === (partialRow.grandTotal - 30_000) + elsewhere.grandTotal)
    const past = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: { from: new Date(Date.now() - 30 * DAY), to: new Date(Date.now() - 10 * DAY) }, perPage: 50 })
    check('a period with nothing is empty with zero totals', past.total === 0 && past.totals.amount === 0)
  }

  console.log('\n── 4. Locations ──')
  {
    const mainOnly = await listInvoices({ restaurantId: restaurant.id, branchIds: [main_.id], range: week, perPage: 50 })
    check('one site lists its own invoices', mainOnly.total === 3 && mainOnly.invoices.every((i) => i.order.branchId === main_.id) && mainOnly.totals.count === 3)
    const otherOnly = await listInvoices({ restaurantId: restaurant.id, branchIds: [other.id], range: week, perPage: 50 })
    check('and the other site its one', otherOnly.total === 1 && otherOnly.totals.amount === elsewhere.grandTotal)
    const none = await listInvoices({ restaurantId: restaurant.id, branchIds: [], range: week, perPage: 50 })
    check('no sites is nothing, never everything', none.total === 0 && none.totals.count === 0)
  }

  console.log('\n── 5. Rows per page ──')
  {
    const fifty = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: week })
    check('fifty a page by default', fifty.perPage === 50 && fifty.pageCount === 1)
    // DELIBERATE behaviour change 2026-09 (aO.md §6): the number is the
    // reader's, so a small one is honoured and there is no 'ALL'.
    const three = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: week, perPage: 3 })
    check('a small number is honoured, not lifted', three.perPage === 3 && three.invoices.length === 3 && three.pageCount === 2)
    const huge = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: week, perPage: 99_999 })
    check('and nothing above five thousand', huge.perPage === 5000)
    const fraction = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: week, perPage: 25.7 })
    check('a fraction is truncated, never zero', fraction.perPage === 25)
    const beyond = await listInvoices({ restaurantId: restaurant.id, branchIds: null, range: week, perPage: 10, page: 4 })
    check('a page past the end is empty, totals still the set’s', beyond.invoices.length === 0 && beyond.totals.count === 4)
  }

  console.log('\n── 6. The screen ──')
  {
    const page = readFileSync('src/app/dashboard/invoices/page.tsx', 'utf8')
    check('opens on This month through resolveRange', page.includes('resolveRange(') && page.includes("'THIS_MONTH'"))
    check('mounts the period filters every report uses', page.includes('<ReportFilters'))
    check('reads rows and totals from listInvoices, not an inline query', page.includes('listInvoices(') && !page.includes('prisma.invoice.findMany'))
    check('offers status and rows-per-page filters', page.includes('<InvoiceFilters'))
    // DELIBERATE behaviour change 2026-09 (aO.md §6): the same editable
    // control as the orders list, presets plus a custom number, no 'All'.
    const filters = readFileSync('src/features/payments/components/invoice-filters.tsx', 'utf8')
    check('rows per page is the shared, editable control', filters.includes('<RowsPerPage') && !filters.includes('All rows'))
    const suite = readFileSync('scripts/page-render-test.ts', 'utf8')
    check('and is rendered by the page suite', suite.includes("'/dashboard/invoices'"))
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
