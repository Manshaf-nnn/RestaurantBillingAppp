/**
 * The accountant's day, end to end (accountsds.md §16).
 *
 *   Purchase order → goods receipt → the payable appears → the accountant
 *   drafts and submits the payment → the owner approves → the accountant
 *   marks it paid → the SupplierPayment ledger row exists → the supplier
 *   balance drops → a cash expense reaches the drawer → the statement, the
 *   hub and the reconciliation all agree.
 *
 * Every step goes through the REAL services in the order a real day would,
 * and the finish line is the integrity checker saying OK — the same screen
 * the accountant reads before filing anything.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/e2e-accountant-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { openDrawer } from '../src/features/cashdrawer/service'
import { getAccountingHub } from '../src/features/accounting/hub'
import { getFinancialReconciliation } from '../src/features/accounting/financial-reconciliation'
import {
  createDraft,
  decide,
  markPaid,
  submit,
  type OutgoingActor,
} from '../src/features/outgoing-payments/service'
import { createPurchaseOrder, setPurchaseStatus } from '../src/features/purchasing/service'
import { receiveGoods } from '../src/features/purchasing/receiving'
import { getSupplierBalances, getSupplierLedger } from '../src/features/suppliers/ledger'
import { getPayablesStatement } from '../src/features/suppliers/payables'
import { resolveRange } from '../src/features/reports/range'

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
    data: {
      name: `Day ${stamp}`, slug: `day-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      timezone: 'Asia/Colombo',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: `Mills ${stamp}` },
  })
  const flour = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Flour ${stamp}`, unit: 'KG', quantity: 0 },
  })
  const category = await prisma.expenseCategory.create({
    data: { restaurantId: restaurant.id, name: `Utilities ${stamp}` },
  })
  const mkUser = (label: string, role: 'ACCOUNTANT' | 'OWNER' | 'CASHIER') =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `${label}-${stamp}@test.local`,
        name: label, passwordHash: 'x', role,
        ...(role === 'CASHIER' ? { branchId: branch.id } : {}),
      },
    })
  const accountantUser = await mkUser('accountant', 'ACCOUNTANT')
  const ownerUser = await mkUser('owner', 'OWNER')
  const cashierUser = await mkUser('cashier', 'CASHIER')
  const accountant: OutgoingActor = { id: accountantUser.id, name: 'The accountant', canApprove: false }
  const owner: OutgoingActor = { id: ownerUser.id, name: 'The owner', canApprove: true }

  console.log('\n── 1. Buy: PO for 100 kg of flour at 300.00/kg ──')
  const po = await createPurchaseOrder({
    restaurantId: restaurant.id,
    supplierId: supplier.id,
    branchId: branch.id,
    lines: [{ itemId: flour.id, quantity: 100, unitCost: 30_000 }],
    userId: ownerUser.id,
  })
  // The real ladder: DRAFT → APPROVED (owner's shortcut) → ORDERED.
  await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: po.id, status: 'APPROVED', userId: ownerUser.id })
  await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: po.id, status: 'ORDERED', userId: ownerUser.id })
  check('the PO exists and owes nothing yet', po.total === 3_000_000)
  {
    const balance = (await getSupplierBalances(restaurant.id)).get(supplier.id) ?? 0
    check('ordering creates no payable — only receiving does', balance === 0, `${balance}`)
  }

  console.log('\n── 2. Receive: the van arrives, the payable is born ──')
  const poItems = await prisma.purchaseItem.findMany({ where: { purchaseId: po.id } })
  await receiveGoods({
    restaurantId: restaurant.id,
    purchaseId: po.id,
    lines: [{ purchaseItemId: poItems[0].id, acceptedQty: 100 }],
    userId: cashierUser.id,
  })
  {
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour.id } })
    check('the stock landed: 100 kg on the shelf', item.quantity === 100, `${item.quantity}`)
    check('worth exactly what was paid for it', Number(item.stockValue) === 3_000_000, `${item.stockValue}`)
    const balance = (await getSupplierBalances(restaurant.id)).get(supplier.id) ?? 0
    check('the payable appeared at received value', balance === 3_000_000, `${balance}`)
  }

  console.log('\n── 3. The accountant raises the payment; the owner signs it ──')
  const payment = await createDraft({
    restaurantId: restaurant.id,
    branchId: branch.id,
    kind: 'SUPPLIER',
    supplierId: supplier.id,
    purchaseId: po.id,
    amount: 3_000_000,
    method: 'BANK_TRANSFER',
    reference: `TRF-${stamp}`,
    description: 'Settling the flour delivery',
    paymentDate: new Date(),
    actor: accountant,
  })
  await submit({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })
  await decide({ restaurantId: restaurant.id, paymentId: payment.id, approve: true, note: 'Checked against the GRN', actor: owner })
  const paid = await markPaid({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })
  check('paid, with the ledger row projected', paid.status === 'PAID' && paid.supplierPaymentId !== null)

  {
    const ledger = await getSupplierLedger({ restaurantId: restaurant.id, supplierId: supplier.id })
    check('the supplier ledger says settled: outstanding zero',
      ledger.totals.outstanding === 0, `${ledger.totals.outstanding}`)
    const projected = await prisma.supplierPayment.findUniqueOrThrow({
      where: { id: paid.supplierPaymentId! },
    })
    check('the projected row carries the amount, the PO and who paid',
      projected.amount === 3_000_000 && projected.purchaseId === po.id && projected.createdByName === 'The accountant')
  }

  console.log('\n── 4. A cash expense reaches the drawer ──')
  await openDrawer({
    restaurantId: restaurant.id, userId: accountantUser.id, branchId: branch.id, openingFloat: 200_000,
  })
  const expense = await createDraft({
    restaurantId: restaurant.id, branchId: branch.id, kind: 'EXPENSE',
    expenseCategoryId: category.id, amount: 45_000, method: 'CASH',
    description: 'Electricity top-up card', paymentDate: new Date(), actor: accountant,
  })
  await submit({ restaurantId: restaurant.id, paymentId: expense.id, actor: accountant })
  await decide({ restaurantId: restaurant.id, paymentId: expense.id, approve: true, actor: owner })
  await markPaid({ restaurantId: restaurant.id, paymentId: expense.id, actor: accountant })
  {
    const movement = await prisma.cashMovement.findFirst({ where: { outgoingPaymentId: expense.id } })
    check('the drawer shows the cash leaving, typed EXPENSE_PAID',
      movement !== null && movement.type === 'EXPENSE_PAID' && movement.amount === 45_000)
  }

  console.log('\n── 5. Every screen agrees ──')
  const range = resolveRange({ preset: 'TODAY', timeZone: restaurant.timezone })

  const statement = await getPayablesStatement({ restaurantId: restaurant.id, range })
  const row = statement.rows.find((entry) => entry.supplierId === supplier.id)
  check('the statement tells the whole story: received, paid, closing zero',
    row !== undefined && row.received === 3_000_000 && row.paid === 3_000_000 && row.closing === 0,
    row ? `${row.received}/${row.paid}/${row.closing}` : 'no row')

  const hub = await getAccountingHub({ restaurantId: restaurant.id, range })
  check('the hub shows the goods received — as purchases, never COGS',
    hub.purchasing.receivedValue === 3_000_000 && hub.profit.cogs === 0)
  check('the hub shows the supplier paid and the expense paid',
    hub.purchasing.supplierPaymentsPaid === 3_000_000 && hub.expenses.paid === 45_000)
  check('the hub shows the stock the money became',
    hub.inventory.stockValueNow === 3_000_000, `${hub.inventory.stockValueNow}`)

  const reconciliation = await getFinancialReconciliation({ restaurantId: restaurant.id, range })
  const bad = [
    ...reconciliation.integrity.checks.filter((entry) => entry.status === 'ERROR'),
    ...reconciliation.identities.filter((entry) => entry.status === 'ERROR'),
  ]
  check('the financial reconciliation ends the day on OK — no ERRORs anywhere',
    bad.length === 0,
    bad.map((entry) => ('key' in entry ? entry.key : '')).join(', '))

  // purchase_items → inventory_items is Restrict; purchases go first.
  await prisma.goodsReceipt.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.purchase.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
