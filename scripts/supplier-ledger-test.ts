/**
 * The supplier ledger.
 *
 * Before this there was no supplier payment record anywhere in the schema, so
 * "what do we owe ABC Distributors" had no answer and `Supplier.paymentTerms`
 * was stored, displayed, and drove nothing. The supplier page was a price list.
 *
 * Two design decisions are what these tests actually check.
 *
 * **The balance is derived, never stored.** There is no `balance` column and
 * there will not be one; it is recomputed from the documents on every read. A
 * stored balance is a second source of truth that drifts the first time a
 * receipt is posted by a path that forgets to update it — the bug class that has
 * cost this project more time than any other.
 *
 * **Received, not ordered.** A purchase order is a promise and nobody owes for
 * goods that have not arrived. An owner with 400,000 on order and 50,000
 * delivered owes 50,000, and a system reporting 400,000 would have them chasing
 * money they do not yet owe. So `onOrder` is reported separately and is
 * deliberately absent from the balance.
 *
 * The worked example is the one from the specification:
 *
 *     Opening balance      0
 *     GRN                 50,000
 *     Payment             30,000
 *     Outstanding         20,000
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/supplier-ledger-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { createPurchaseOrder, setPurchaseStatus } from '../src/features/purchasing/service'
import { receiveGoods } from '../src/features/purchasing/receiving'
import { getSupplierBalances, getSupplierLedger } from '../src/features/suppliers/ledger'

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

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Led ${stamp}`, slug: `led-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const abc = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: 'ABC Distributors', paymentTerms: 'NET_30' },
  })
  const other = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: 'Sunrise Foods' },
  })
  const rice = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Rice',
      unit: 'KG',
      quantity: 0,
      costPerUnit: 50_000,
    },
  })

  console.log('\n── a new account starts at nil ──')

  const empty = await getSupplierLedger({ restaurantId: restaurant.id, supplierId: abc.id })
  check('outstanding is zero', empty.totals.outstanding === 0, `${empty.totals.outstanding}`)
  check('with an explicit opening row', empty.entries.length === 1 && empty.entries[0].kind === 'OPENING')
  check('at a zero balance', empty.entries[0].balance === 0)
  check('and the contact details are carried', empty.supplier.paymentTerms === 'NET_30')

  console.log('\n── an order alone owes nothing ──')

  // 100kg at Rs. 500 = Rs. 50,000, in minor units.
  const po = await createPurchaseOrder({
    restaurantId: restaurant.id,
    supplierId: abc.id,
    branchId: branch.id,
    lines: [{ itemId: rice.id, quantity: 100, unit: 'KG', unitCost: 50_000 }],
  })
  await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: po.id, status: 'APPROVED' })

  const ordered = await getSupplierLedger({ restaurantId: restaurant.id, supplierId: abc.id })
  check(
    'an approved but undelivered order owes nothing',
    ordered.totals.outstanding === 0,
    `${ordered.totals.outstanding} — an owner would be chasing money they do not owe`,
  )
  check('but is reported as on order', ordered.totals.onOrder === 5_000_000, `${ordered.totals.onOrder}`)
  check('and appears in the purchase list', ordered.purchases.length === 1)

  console.log('\n── the worked example ──')

  const line = await prisma.purchaseItem.findFirstOrThrow({ where: { purchaseId: po.id } })
  const grn = await receiveGoods({
    restaurantId: restaurant.id,
    purchaseId: po.id,
    supplierRef: 'INV-77',
    lines: [{ purchaseItemId: line.id, acceptedQty: 100 }],
  })

  const received = await getSupplierLedger({ restaurantId: restaurant.id, supplierId: abc.id })
  check('the delivery credits 50,000', received.totals.received === 5_000_000, `${received.totals.received}`)
  check('so 50,000 is outstanding', received.totals.outstanding === 5_000_000, `${received.totals.outstanding}`)
  check('and nothing is left on order', received.totals.onOrder === 0, `${received.totals.onOrder}`)

  await prisma.supplierPayment.create({
    data: {
      restaurantId: restaurant.id,
      supplierId: abc.id,
      amount: 3_000_000,
      method: 'BANK_TRANSFER',
      reference: 'TRF-100',
      createdByName: 'Owner',
      paidAt: new Date(Date.now() + 1000),
    },
  })

  const paid = await getSupplierLedger({ restaurantId: restaurant.id, supplierId: abc.id })
  check('after paying 30,000, 20,000 remains', paid.totals.outstanding === 2_000_000, `${paid.totals.outstanding}`)

  console.log('\n── the statement reads in order and adds up ──')

  const rows = paid.entries
  check('opening, delivery, payment', rows.length === 3, `${rows.length} rows`)
  check('row 1 is the opening at 0', rows[0].kind === 'OPENING' && rows[0].balance === 0)
  check(
    'row 2 credits the delivery to 50,000',
    rows[1].kind === 'RECEIPT' && rows[1].credit === 5_000_000 && rows[1].balance === 5_000_000,
    `${rows[1].kind} ${rows[1].balance}`,
  )
  check(
    'row 3 debits the payment to 20,000',
    rows[2].kind === 'PAYMENT' && rows[2].debit === 3_000_000 && rows[2].balance === 2_000_000,
    `${rows[2].kind} ${rows[2].balance}`,
  )
  check(
    'the last balance is the outstanding figure',
    rows[rows.length - 1].balance === paid.totals.outstanding,
    'the statement and the headline disagree',
  )

  /*
   * Every row must lead somewhere. A statement you cannot read backwards is a
   * list of numbers — the whole point is that a figure resolves to the delivery
   * it came from, and that to the order behind it.
   */
  check(
    'the delivery links to its goods receipt',
    rows[1].href === `/dashboard/purchases/${po.id}/receipts/${grn.receipt.id}`,
    `${rows[1].href}`,
  )
  check('and the reference is the GRN number', rows[1].reference === grn.receipt.number)

  console.log('\n── a return reduces what is owed ──')

  const ret = await prisma.purchaseReturn.create({
    data: {
      restaurantId: restaurant.id,
      branchId: branch.id,
      supplierId: abc.id,
      purchaseId: po.id,
      number: `RET-${stamp}`,
      reason: 'Damaged in transit',
      createdAt: new Date(Date.now() + 2000),
      lines: { create: [{ itemId: rice.id, quantity: 4, unitCost: 50_000 }] },
    },
  })

  const afterReturn = await getSupplierLedger({ restaurantId: restaurant.id, supplierId: abc.id })
  check('the return debits 2,000', afterReturn.totals.returned === 200_000, `${afterReturn.totals.returned}`)
  check(
    'leaving 18,000 outstanding',
    afterReturn.totals.outstanding === 1_800_000,
    `${afterReturn.totals.outstanding}`,
  )
  check(
    'and it is the last row on the statement',
    afterReturn.entries[afterReturn.entries.length - 1].reference === ret.number,
  )

  console.log('\n── overpaying puts them in credit ──')

  await prisma.supplierPayment.create({
    data: {
      restaurantId: restaurant.id,
      supplierId: abc.id,
      amount: 2_000_000,
      method: 'CASH',
      createdByName: 'Owner',
      paidAt: new Date(Date.now() + 3000),
    },
  })

  const over = await getSupplierLedger({ restaurantId: restaurant.id, supplierId: abc.id })
  check(
    'the balance goes negative rather than clamping at zero',
    over.totals.outstanding === -200_000,
    `${over.totals.outstanding} — money paid must not vanish`,
  )

  console.log('\n── one supplier’s account is their own ──')

  const theirs = await getSupplierLedger({ restaurantId: restaurant.id, supplierId: other.id })
  check('another supplier owes nothing', theirs.totals.outstanding === 0, `${theirs.totals.outstanding}`)
  check('and has no entries but the opening', theirs.entries.length === 1)

  console.log('\n── the list-page balances agree with the ledger ──')

  const balances = await getSupplierBalances(restaurant.id)
  check(
    'the batched figure matches the detailed one',
    balances.get(abc.id) === over.totals.outstanding,
    `${balances.get(abc.id)} vs ${over.totals.outstanding} — two screens would show two answers`,
  )
  check('and a supplier with no activity is absent or zero', (balances.get(other.id) ?? 0) === 0)

  await prisma.supplierPayment.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.purchaseReturnLine.deleteMany({ where: { return: { restaurantId: restaurant.id } } })
  await prisma.purchaseReturn.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { restaurantId: restaurant.id } } })
  await prisma.goodsReceipt.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.purchasePriceHistory.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.purchaseItem.deleteMany({ where: { purchase: { restaurantId: restaurant.id } } })
  await prisma.purchase.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.supplier.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
