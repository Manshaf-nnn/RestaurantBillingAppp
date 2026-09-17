/**
 * The orders list: a period, filters, rows per page, and totals that are
 * true for the whole filtered set (abc.md §1).
 *
 *   - totals come from the SAME predicate as the rows: count, total,
 *     collected and outstanding agree with the rows when every row is shown,
 *     and stay the whole set's figures on any one page;
 *   - every filter narrows rows and totals together — status, payment,
 *     type, source (channel), search, and the period;
 *   - rows per page is whatever the reader chose (aO.md §6) — presets and a
 *     custom number — clamped to [1, 5000] so the export's 500 a page is
 *     honoured (it used to be silently cut to 100) and no request can ask
 *     for an unbounded set;
 *   - `to` works as a bare date ("2026-09-15", meaning the whole day) and
 *     as a full instant, as before;
 *   - the screen opens on Today through `resolveRange`, mounts the same
 *     period filters every report uses, and offers Take payment on unpaid
 *     rows to whoever may collect — through the till's own contract.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/orders-list-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { listOrders } from '../src/features/orders/queries'
import { placeOrder } from '../src/features/orders/service'
import { capturePayment } from '../src/features/payments/service'

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
      name: `List ${stamp}`, slug: `list-${stamp}`, status: 'ACTIVE', isActive: true,
      timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const category = await prisma.category.create({ data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` } })
  const rice = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Rice', slug: `rice-${stamp}`, price: 50_000, isAvailable: true },
  })
  await prisma.foodBranch.create({ data: { restaurantId: restaurant.id, foodId: rice.id, branchId: branch.id, isAvailable: true } })
  const cashier = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `list-${stamp}@test.local`, name: 'Till', passwordHash: 'x', role: 'CASHIER', branchId: branch.id },
  })
  const order = (channel: 'COUNTER' | 'QR' | 'STAFF', quantity: number, name: string) =>
    placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId: null, type: 'TAKEAWAY', channel,
      items: [{ foodId: rice.id, quantity, optionIds: [] }],
      customerName: name, customerPhone: '',
    })

  const a = await order('COUNTER', 1, 'Alpha')
  const b = await order('COUNTER', 2, 'Bravo')
  const c = await order('QR', 3, 'Charlie')
  const d = await order('STAFF', 1, 'Delta')
  await capturePayment({ restaurantId: restaurant.id, orderId: b.id, method: 'CASH', amount: 20_000, tenderedAmount: 20_000, receivedById: cashier.id })
  await capturePayment({ restaurantId: restaurant.id, orderId: d.id, method: 'CARD', amount: d.grandTotal, receivedById: cashier.id })
  // An older order, outside "today".
  await prisma.order.update({ where: { id: a.id }, data: { placedAt: new Date(Date.now() - 3 * DAY) } })

  const from = new Date(Date.now() - 7 * DAY).toISOString()
  const to = new Date(Date.now() + DAY).toISOString()
  const sum = (rows: Array<{ grandTotal: number; tipAmount: number; paidTotal: number }>) => ({
    grandTotal: rows.reduce((s, r) => s + r.grandTotal, 0),
    paidTotal: rows.reduce((s, r) => s + r.paidTotal, 0),
    outstanding: rows.reduce((s, r) => s + Math.max(0, r.grandTotal + r.tipAmount - r.paidTotal), 0),
  })

  console.log('\n── 1. Totals are the whole set’s, from the rows’ own predicate ──')
  {
    const all = await listOrders(restaurant.id, { from, to, perPage: 500 })
    check('a big page shows every order in the period', all.orders.length === 4 && all.total === 4 && all.pageCount === 1)
    const expected = sum(all.orders)
    check('count agrees with the rows', all.totals.count === 4)
    check('total agrees with the rows', all.totals.grandTotal === expected.grandTotal, `${all.totals.grandTotal} vs ${expected.grandTotal}`)
    check('collected agrees with the rows', all.totals.paidTotal === expected.paidTotal && all.totals.paidTotal === 20_000 + d.grandTotal)
    check('outstanding agrees with the rows', all.totals.outstanding === expected.outstanding, `${all.totals.outstanding} vs ${expected.outstanding}`)
    check('outstanding = total + tips − collected', all.totals.outstanding === all.totals.grandTotal + all.totals.tipAmount - all.totals.paidTotal)
  }

  console.log('\n── 2. Every filter narrows rows and totals together ──')
  {
    const partial = await listOrders(restaurant.id, { from, to, paymentStatus: 'PARTIAL', perPage: 50 })
    check('payment filter: the one partly-paid bill', partial.orders.length === 1 && partial.orders[0].id === b.id)
    check('and its totals are that bill’s alone', partial.totals.count === 1 && partial.totals.grandTotal === b.grandTotal && partial.totals.paidTotal === 20_000)
    const qr = await listOrders(restaurant.id, { from, to, channel: 'QR', perPage: 50 })
    check('source filter: the one QR order', qr.orders.length === 1 && qr.orders[0].id === c.id && qr.totals.count === 1)
    const counter = await listOrders(restaurant.id, { from, to, channel: 'COUNTER', perPage: 50 })
    check('source filter: the two counter orders', counter.total === 2 && counter.totals.count === 2)
    const search = await listOrders(restaurant.id, { from, to, search: 'charl', perPage: 50 })
    check('search narrows the totals too', search.total === 1 && search.totals.grandTotal === c.grandTotal)
    const paid = await listOrders(restaurant.id, { from, to, paymentStatus: 'PAID', perPage: 50 })
    check('a settled bill has nothing outstanding', paid.totals.count === 1 && paid.totals.outstanding === 0)
    const none = await listOrders(restaurant.id, { from, to, status: 'CANCELLED', perPage: 50 })
    check('nothing matching is zero everywhere, not undefined', none.total === 0 && none.totals.count === 0 && none.totals.grandTotal === 0 && none.totals.outstanding === 0)
  }

  console.log('\n── 3. Rows per page ──')
  {
    const fifty = await listOrders(restaurant.id, { from, to, perPage: 50 })
    check('50 a page is 50 a page', fifty.perPage === 50 && fifty.pageCount === 1)
    const hundred = await listOrders(restaurant.id, { from, to, perPage: 100 })
    check('and 100', hundred.perPage === 100)
    // DELIBERATE behaviour change 2026-09 (aO.md §6): the reader picks the
    // number, so a small one is honoured rather than lifted to ten, and
    // 'ALL' — never a size anybody chose — is gone.
    const five = await listOrders(restaurant.id, { from, to, perPage: 5 })
    check('a small number is honoured, not lifted', five.perPage === 5)
    const one = await listOrders(restaurant.id, { from, to, perPage: 1 })
    check('one a page is one a page', one.perPage === 1 && one.orders.length === 1 && one.pageCount === 4)
    const fraction = await listOrders(restaurant.id, { from, to, perPage: 12.9 })
    check('a fraction is truncated, never zero', fraction.perPage === 12)
    const huge = await listOrders(restaurant.id, { from, to, perPage: 99_999 })
    check('and nothing above five thousand', huge.perPage === 5000)
    const export_ = await listOrders(restaurant.id, { from, to, perPage: 500 })
    check('the export’s 500 a page is honoured, not cut to 100', export_.perPage === 500)
    const beyond = await listOrders(restaurant.id, { from, to, perPage: 10, page: 3 })
    check('a page past the end is empty, but the totals are still the set’s', beyond.orders.length === 0 && beyond.totals.count === 4)
    const noPeriod = await listOrders(restaurant.id, { perPage: 500 })
    check('a big page needs no period guard any more', noPeriod.perPage === 500)
  }

  console.log('\n── 4. The period ──')
  {
    const today = await listOrders(restaurant.id, { from: new Date(Date.now() - DAY).toISOString(), to, perPage: 50 })
    check('the older order is outside a one-day window', today.total === 3 && !today.orders.some((o) => o.id === a.id) && today.totals.count === 3)
    // A bare `to` is read as the end of that day in the server's clock (the
    // page's own convention), so the window ends on tomorrow's date to be
    // sure of covering "now" whatever zone this runs in.
    const dateOnly = new Date(Date.now() + DAY).toISOString().slice(0, 10)
    const bare = await listOrders(restaurant.id, { from: new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10), to: dateOnly, perPage: 50 })
    check('a bare date as `to` still means the whole day', bare.total === 4, `${bare.total}`)
    const cutOff = await listOrders(restaurant.id, { from: new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10), to: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10), perPage: 50 })
    check('and a bare date before today leaves today out', cutOff.total === 1 && cutOff.orders[0].id === a.id, `${cutOff.total}`)
    const future = await listOrders(restaurant.id, { from: new Date(Date.now() + DAY).toISOString(), to: new Date(Date.now() + 2 * DAY).toISOString(), perPage: 50 })
    check('a period with nothing in it is empty with zero totals', future.total === 0 && future.totals.grandTotal === 0)
    const branchless = await listOrders(restaurant.id, { from, to, branchId: 'nope', perPage: 50 })
    check('a branch with nothing is nothing', branchless.total === 0 && branchless.totals.count === 0)
  }

  console.log('\n── 5. The screen ──')
  {
    const page = readFileSync('src/app/dashboard/orders/page.tsx', 'utf8')
    check('opens on Today through resolveRange', page.includes("resolveRange(") && page.includes("'TODAY'"))
    check('mounts the period filters every report uses', page.includes('<ReportFilters'))
    check('Take payment is offered to whoever may collect', page.includes('canCollect={can(user, PERMISSIONS.PAYMENT_COLLECT)}'))
    const table = readFileSync('src/features/orders/components/orders-table.tsx', 'utf8')
    // DELIBERATE behaviour change 2026-09 (aO.md §6): presets plus Custom,
    // in one shared control, and no unlimited option anywhere.
    const control = readFileSync('src/components/ui/rows-per-page.tsx', 'utf8')
    check('rows per page is the shared, editable control', table.includes('<RowsPerPage') && !table.includes('PER_PAGE_OPTIONS') && !table.includes('All rows'))
    check('with the presets', [10, 25, 50, 100, 250, 500].every((n) => control.includes(String(n))))
    check('and a custom number', control.includes('Custom') && control.includes('Rows per page, exactly'))
    check('and no unlimited option', !control.includes('All rows'))
    check('the totals footer is there', table.includes('data-testid="orders-totals"'))
    check('a source filter is there', table.includes("setParam('channel'"))
    check('and Take payment opens the dialog on unpaid rows', table.includes('<TakePaymentDialog') && table.includes('Take payment'))
    const dialog = readFileSync('src/features/payments/components/take-payment-dialog.tsx', 'utf8')
    check("the dialog uses the till's contract: one key per attempt, renewed after success",
      dialog.includes("newRequestKey('pay')") && dialog.includes('clientRequestId: tenderKey.current') && /tenderKey\.current = newRequestKey\('pay'\)/.test(dialog))
    check('and the same collectPayment action', dialog.includes('collectPayment({'))
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
