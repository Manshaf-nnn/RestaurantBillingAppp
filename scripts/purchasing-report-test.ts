/**
 * The purchasing report.
 *
 * Two things here are judgement calls rather than arithmetic, and both are what
 * these pin:
 *
 *   · a purchase REQUEST is not a purchase. A rejected request is not cancelled
 *     spending and a draft is not committed money, so neither may reach the
 *     figures — the split `service.ts` draws deliberately;
 *   · there is no budget in this system, so the "variance" is committed against
 *     ACTUAL: what the PO said, against what the delivery was invoiced at.
 */
import { prisma } from '../src/server/db/prisma'
import { getPurchasingReport } from '../src/features/purchasing/report'
import { getPurchasingDrill } from '../src/features/purchasing/report-drill'
import { resolveRange } from '../src/features/reports/range'

let passed = 0
let failed = 0
function check(what: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${what}`) }
  else { failed += 1; console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ''}`) }
}

const S = Date.now().toString(36)

async function main() {
  const shop = await prisma.restaurant.create({
    data: { name: `Purch ${S}`, slug: `purch-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const cat = await prisma.inventoryCategory.create({
    data: { restaurantId: shop.id, name: `Meat ${S}` },
  })
  const chicken = await prisma.inventoryItem.create({
    data: {
      restaurantId: shop.id, name: `Chicken ${S}`, unit: 'KG', costPerUnit: 1_000_00,
      branchId: branch.id, categoryId: cat.id,
    },
  })
  const tomato = await prisma.inventoryItem.create({
    data: {
      restaurantId: shop.id, name: `Tomato ${S}`, unit: 'KG', costPerUnit: 200_00,
      branchId: branch.id,
    },
  })
  const acme = await prisma.supplier.create({
    data: { restaurantId: shop.id, name: `Acme ${S}` },
  })
  const other = await prisma.supplier.create({
    data: { restaurantId: shop.id, name: `Bestco ${S}` },
  })

  const now = new Date()
  const mkPo = async (opts: {
    number: string
    supplierId: string
    status: 'RECEIVED' | 'CANCELLED' | 'PARTIALLY_RECEIVED' | 'DRAFT' | 'REJECTED' | 'ORDERED'
    total: number
    receivedAt?: Date | null
    lines: Array<{ itemId: string; quantity: number; unitCost: number }>
  }) =>
    prisma.purchase.create({
      data: {
        restaurantId: shop.id, branchId: branch.id, supplierId: opts.supplierId,
        number: opts.number, status: opts.status, total: opts.total,
        subtotal: opts.total, orderedAt: now, receivedAt: opts.receivedAt ?? null,
        items: {
          create: opts.lines.map((l) => ({
            itemId: l.itemId, quantity: l.quantity, unitCost: l.unitCost,
            lineTotal: Math.round(l.quantity * l.unitCost),
          })),
        },
      },
      include: { items: true },
    })

  // Received in full: 10 kg chicken at 1,000 committed.
  const po1 = await mkPo({
    number: `PO-${S}-1`, supplierId: acme.id, status: 'RECEIVED', total: 10_000_00,
    receivedAt: now, lines: [{ itemId: chicken.id, quantity: 10, unitCost: 1_000_00 }],
  })
  // Cancelled: an order, but not money committed.
  await mkPo({
    number: `PO-${S}-2`, supplierId: acme.id, status: 'CANCELLED', total: 5_000_00,
    lines: [{ itemId: tomato.id, quantity: 25, unitCost: 200_00 }],
  })
  // A request nobody approved, and one an approver refused. Neither is buying.
  await mkPo({
    number: `PO-${S}-3`, supplierId: other.id, status: 'DRAFT', total: 9_999_00,
    lines: [{ itemId: tomato.id, quantity: 50, unitCost: 200_00 }],
  })
  await mkPo({
    number: `PO-${S}-4`, supplierId: other.id, status: 'REJECTED', total: 7_777_00,
    lines: [{ itemId: tomato.id, quantity: 40, unitCost: 200_00 }],
  })
  // Partially received from a second supplier.
  await mkPo({
    number: `PO-${S}-5`, supplierId: other.id, status: 'PARTIALLY_RECEIVED', total: 2_000_00,
    lines: [{ itemId: tomato.id, quantity: 10, unitCost: 200_00 }],
  })

  /*
   * The delivery against PO-1 was invoiced at 1,050 a kilo, not the 1,000 the
   * order committed — the gap is the whole point of the variance tile.
   */
  const receipt = await prisma.goodsReceipt.create({
    data: {
      restaurantId: shop.id, purchaseId: po1.id, branchId: branch.id,
      number: `GRN-${S}-1`, receivedAt: now,
    },
  })
  await prisma.goodsReceiptLine.create({
    data: {
      receiptId: receipt.id, purchaseItemId: po1.items[0].id, itemId: chicken.id,
      acceptedQty: 10, unitCost: 1_050_00,
    },
  })

  const range = resolveRange({ preset: 'TODAY', timeZone: shop.timezone })
  const report = await getPurchasingReport({
    restaurantId: shop.id, range, timeZone: shop.timezone,
  })
  const drill = await getPurchasingDrill({ restaurantId: shop.id, range })

  console.log('\n── A request is not a purchase ──────────────────────────')
  check('committed spend counts the received and partial orders only',
    report.totals.purchaseValue === 12_000_00, `got ${report.totals.purchaseValue}`)
  check('the draft and the rejected request are not spending',
    report.totals.purchaseValue !== 12_000_00 + 9_999_00 + 7_777_00)
  check('orders counts the cancelled one but not the two requests',
    report.totals.orders === 3, `got ${report.totals.orders}`)
  check('and the requests still waiting are named, not hidden',
    report.awaitingApproval === 2, `got ${report.awaitingApproval}`)

  console.log('\n── Committed against actual, not against a budget ───────')
  check('committed is what the received order said', report.totals.variance.committed === 10_000_00,
    `got ${report.totals.variance.committed}`)
  check('actual is what the delivery was invoiced at', report.totals.variance.actual === 10_500_00,
    `got ${report.totals.variance.actual}`)
  check('the variance is the 500 overcharge', report.totals.variance.amount === 500_00,
    `got ${report.totals.variance.amount}`)
  check('as a percent of what was committed', report.totals.variance.percent === 5,
    `got ${report.totals.variance.percent}`)

  console.log('\n── The panels ──────────────────────────────────────────')
  const meat = report.byCategory.find((r) => r.label === cat.name)
  check('a managed category is used where the item has one', meat?.value === 10_000_00,
    `got ${meat?.value}`)
  const uncat = report.byCategory.find((r) => r.label === 'Uncategorised')
  check('and an item without one is not dropped', uncat?.value === 2_000_00, `got ${uncat?.value}`)
  const acmeRow = report.bySupplier.find((r) => r.label === acme.name)
  check('the supplier panel excludes the cancelled order', acmeRow?.value === 10_000_00,
    `got ${acmeRow?.value}`)
  const received = report.byStatus.find((r) => r.key === 'RECEIVED')
  const partial = report.byStatus.find((r) => r.key === 'PARTIAL')
  const cancelled = report.byStatus.find((r) => r.key === 'CANCELLED')
  check('one received, one partial, one cancelled',
    received?.count === 1 && partial?.count === 1 && cancelled?.count === 1,
    `got ${received?.count}/${partial?.count}/${cancelled?.count}`)
  check('the status slices add to the order count',
    report.byStatus.reduce((s, r) => s + r.count, 0) === report.totals.orders)

  console.log('\n── Suppliers ───────────────────────────────────────────')
  check('both suppliers were bought from', report.totals.suppliers === 2,
    `got ${report.totals.suppliers}`)
  check('and both are new, nothing having been bought before today',
    report.totals.newSuppliers === 2, `got ${report.totals.newSuppliers}`)

  console.log('\n── The drill-downs ─────────────────────────────────────')
  check('the order table lists the three orders', drill.orders.length === 3,
    `got ${drill.orders.length}`)
  check('a fully received order reads as Received',
    drill.orders.find((r) => r.number === `PO-${S}-1`)?.statusLabel === 'Received')
  const chickenRow = drill.byItem.find((r) => r.label === chicken.name)
  check('the item table shows what was bought', chickenRow?.quantity === 10,
    `got ${chickenRow?.quantity}`)
  check('its average unit cost is what was PAID per unit over the period',
    chickenRow?.averageUnitCost === 1_000_00, `got ${chickenRow?.averageUnitCost}`)
  check('and it carries the unit, so the quantity means something',
    chickenRow?.unit === 'KG', `got ${chickenRow?.unit}`)
  const acmeDrill = drill.bySupplier.find((r) => r.label === acme.name)
  check('a supplier total is not multiplied by its line count',
    acmeDrill?.value === 10_000_00, `got ${acmeDrill?.value}`)
  check('the supplier shares add to 100',
    Math.round(drill.bySupplier.reduce((s, r) => s + r.share, 0)) === 100,
    `got ${drill.bySupplier.reduce((s, r) => s + r.share, 0)}`)

  console.log('\n── Another tenant sees none of it ──────────────────────')
  const stranger = await prisma.restaurant.create({
    data: { name: `Nope ${S}`, slug: `nope-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  const theirs = await getPurchasingReport({
    restaurantId: stranger.id, range, timeZone: 'Asia/Colombo',
  })
  check('a neighbour reads no spend', theirs.totals.purchaseValue === 0)
  check('and no suppliers', theirs.totals.suppliers === 0)

  await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { restaurantId: shop.id } } })
  await prisma.goodsReceipt.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.purchaseItem.deleteMany({ where: { purchase: { restaurantId: shop.id } } })
  await prisma.purchase.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.supplier.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryCategory.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurant.deleteMany({ where: { id: { in: [shop.id, stranger.id] } } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
