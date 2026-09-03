/**
 * The derived ledger, proven (acCal.md §9).
 *
 * A double-entry view that does not balance is worse than none — it lends
 * false authority to a wrong number. So this suite does not test that the
 * code runs; it tests the accounting:
 *
 *   • every entry balances, and the trial balance balances for any range
 *   • revenue in the ledger IS the sales report's net sales
 *   • COGS in the ledger IS the profit report's COGS
 *   • payables in the ledger IS the supplier ledger's outstanding
 *   • the inventory account moves by receipts − consumption − waste
 *   • the cash book's closing balance is what the drawer maths says
 *   • cancelled bills contribute nothing at all
 *   • every line carries a source you can click to
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/ledger-test.ts
 */
import { openDrawer } from '../src/features/cashdrawer/service'
import { createPurchaseOrder, setPurchaseStatus } from '../src/features/purchasing/service'
import { receiveGoods } from '../src/features/purchasing/receiving'
import { buildJournal } from '../src/features/ledger/journal'
import { foldCashBook, foldPosition, foldProfitAndLoss, foldTrialBalance } from '../src/features/ledger/queries'
import { getProfitReport } from '../src/features/reports/profit'
import { getSalesReport } from '../src/features/reports/sales'
import { resolveRange } from '../src/features/reports/range'
import { getSupplierBalances } from '../src/features/suppliers/ledger'
import { prisma } from '../src/server/db/prisma'

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
  const now = new Date()

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Ledger ${stamp}`, slug: `ledger-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 1_000, serviceChargeBps: 0, taxInclusive: false,
      timezone: 'Asia/Colombo',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `led-${stamp}@test.local`,
      name: 'Ledger keeper', passwordHash: 'x', role: 'OWNER',
    },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: `Farm ${stamp}` },
  })
  const item = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Rice ${stamp}`, unit: 'KG', quantity: 0 },
  })
  const category = await prisma.expenseCategory.create({
    data: { restaurantId: restaurant.id, name: `Rent ${stamp}` },
  })

  // ── A day's trading, written through real record shapes ──────────────────
  //
  // Bill: 100,000 food, 10,000 discount, 9,000 tax (10% of 90,000), 2,000 tip.
  // Grand total 99,000; the guest pays 101,000 including the tip, in cash.
  const order = await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `L-${stamp}-1`,
      customerName: 'Walk-in', customerPhone: '0770000000',
      status: 'COMPLETED', paymentStatus: 'PAID',
      subtotal: 100_000, discountTotal: 10_000, manualDiscount: 10_000,
      taxTotal: 9_000, tipAmount: 2_000, grandTotal: 99_000, paidTotal: 101_000,
      placedAt: now,
      items: {
        create: [{ name: 'Rice & curry', unitPrice: 100_000, quantity: 1, lineTotal: 100_000, costPrice: 30_000 }],
      },
      payments: {
        create: [{ restaurantId: restaurant.id, amount: 101_000, method: 'CASH', status: 'PAID', paidAt: now }],
      },
    },
  })
  // A cancelled bill of the same size — it must contribute nothing anywhere.
  await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `L-${stamp}-X`,
      customerName: 'Ghost', customerPhone: '0770000000',
      status: 'CANCELLED', paymentStatus: 'UNPAID',
      subtotal: 500_000, grandTotal: 500_000, placedAt: now,
      items: { create: [{ name: 'Never served', unitPrice: 500_000, quantity: 1, lineTotal: 500_000, costPrice: 200_000 }] },
    },
  })

  // Goods received through the real purchasing services: 50 kg at 400.00,
  // so 20,000.00 of stock arrives and the same is owed to the supplier.
  const purchase = await createPurchaseOrder({
    restaurantId: restaurant.id, supplierId: supplier.id, branchId: branch.id,
    lines: [{ itemId: item.id, quantity: 50, unitCost: 40_000 }], userId: user.id,
  })
  await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: purchase.id, status: 'APPROVED', userId: user.id })
  await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: purchase.id, status: 'ORDERED', userId: user.id })
  const purchaseItems = await prisma.purchaseItem.findMany({ where: { purchaseId: purchase.id } })
  await receiveGoods({
    restaurantId: restaurant.id, purchaseId: purchase.id,
    lines: [{ purchaseItemId: purchaseItems[0].id, acceptedQty: 50 }], userId: user.id,
  })
  // Paid half of it by bank transfer.
  await prisma.supplierPayment.create({
    data: {
      restaurantId: restaurant.id, supplierId: supplier.id, purchaseId: purchase.id,
      amount: 1_000_000, method: 'BANK_TRANSFER', paidAt: now, createdByName: 'Ledger keeper',
    },
  })
  // An expense paid from the bank.
  await prisma.outgoingPayment.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, number: `OP-${stamp}`,
      kind: 'EXPENSE', status: 'PAID', expenseCategoryId: category.id,
      amount: 150_000, method: 'BANK_TRANSFER', description: 'Monthly rent',
      paymentDate: now, createdByName: 'Ledger keeper',
    },
  })
  // Wastage of 5,000.
  await prisma.wastageRecord.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, itemId: item.id,
      quantity: 1, costValue: 5_000, reason: 'SPOILED', createdById: user.id,
    },
  })
  // A drawer opened with a 50,000 float and closed 500 short.
  const session = await openDrawer({
    restaurantId: restaurant.id, userId: user.id, branchId: branch.id, openingFloat: 50_000,
  })
  await prisma.cashDrawerSession.update({
    where: { id: session.id },
    data: {
      status: 'CLOSED', closedAt: now, closedBy: { connect: { id: user.id } },
      countedCash: 50_000, expectedCash: 50_500, variance: -500,
      varianceReason: 'Short by 500 — under investigation',
    },
  })

  const range = resolveRange({ preset: 'TODAY', timeZone: restaurant.timezone })
  const [entries, sales, profit, balances] = await Promise.all([
    buildJournal({ restaurantId: restaurant.id, range }),
    getSalesReport({ restaurantId: restaurant.id, range }),
    getProfitReport({ restaurantId: restaurant.id, range }),
    getSupplierBalances(restaurant.id),
  ])
  const trial = foldTrialBalance(entries)
  const pnl = foldProfitAndLoss(entries)
  const cashBook = foldCashBook(entries)
  const position = foldPosition(entries)

  const accountBalance = (code: string) => trial.rows.find((row) => row.code === code)?.balance ?? 0

  console.log('\n── 1. Double entry means double entry ──')
  {
    const unbalanced = entries.filter(
      (entry) =>
        entry.lines.reduce((sum, line) => sum + line.debit, 0) !==
        entry.lines.reduce((sum, line) => sum + line.credit, 0),
    )
    check('every single entry balances', unbalanced.length === 0,
      unbalanced.map((entry) => entry.id).join(', '))
    check('the trial balance balances', trial.balanced,
      `${trial.totalDebits} vs ${trial.totalCredits}`)
    check('debits and credits are not both zero — the ledger has content',
      trial.totalDebits > 0)
    check('every line names an account we know',
      entries.every((entry) => entry.lines.every((line) => line.accountName !== line.account)))
    check('every entry links to the record behind it',
      entries.every((entry) => entry.href.startsWith('/dashboard/') && entry.sourceId.length > 0))
  }

  console.log('\n── 2. The ledger agrees with the engines that own each number ──')
  {
    // Revenue = 4000 − 4100 − 4110, the contra accounts doing their job.
    const ledgerNetSales = accountBalance('4000') - accountBalance('4100') - accountBalance('4110')
    check('ledger revenue IS the sales report’s net sales',
      ledgerNetSales === sales.totals.netSales && ledgerNetSales === 90_000,
      `${ledgerNetSales} vs ${sales.totals.netSales}`)
    check('ledger COGS IS the profit report’s COGS',
      accountBalance('5000') === profit.totals.cogs && accountBalance('5000') === 30_000,
      `${accountBalance('5000')} vs ${profit.totals.cogs}`)
    const owed = [...balances.values()].reduce((sum, value) => sum + value, 0)
    check('ledger payables IS the supplier ledger’s outstanding',
      accountBalance('2000') === owed && owed === 1_000_000,
      `${accountBalance('2000')} vs ${owed}`)
    check('tax collected sits in a liability, not in revenue',
      accountBalance('2100') === 9_000 && accountBalance('4000') === 100_000)
    check('tips are held for staff, never counted as ours',
      accountBalance('2120') === 2_000)
  }

  console.log('\n── 3. Inventory moves the way stock moves ──')
  {
    // Received 2,000,000 − sold 30,000 of ingredients − wasted 5,000.
    const expected = 2_000_000 - 30_000 - 5_000
    check('the inventory account = received − consumed − wasted',
      accountBalance('1200') === expected, `${accountBalance('1200')} vs ${expected}`)
    check('wastage is an expense, not a silent disappearance',
      accountBalance('6200') === 5_000)
  }

  console.log('\n── 4. Cash is followed to the note ──')
  {
    // In: 101,000 sale + 50,000 float. Out: 500 counted short.
    // The float is the business's own money moved into the till, not income:
    // the cash book follows TRADING cash — takings in, differences out.
    check('the cash book closes at takings − shortfall',
      cashBook.closing === 100_500, `${cashBook.closing}`)
    check('the counted difference is on the books as an expense',
      accountBalance('6910') === 500)
    check('the cash book lists every cash event, newest first',
      cashBook.rows.length === 2 &&
        cashBook.rows[0].date.getTime() >= cashBook.rows[cashBook.rows.length - 1].date.getTime())
    check('bank-side money never lands in the cash account',
      accountBalance('1050') === -1_150_000, `${accountBalance('1050')}`)
  }

  console.log('\n── 5. A cancelled bill is not a transaction ──')
  {
    check('nothing from the cancelled order reached the journal',
      !entries.some((entry) => entry.sourceId.includes(`${stamp}-X`)))
    check('…and its 500,000 is nowhere in revenue',
      accountBalance('4000') === 100_000)
  }

  console.log('\n── 6. The P&L and the position tell the same story ──')
  {
    check('P&L net sales matches the ledger and the sales report',
      pnl.revenue.netSales === sales.totals.netSales)
    check('gross profit = net sales − COGS', pnl.grossProfit === 90_000 - 30_000)
    check('operating profit subtracts the recorded costs',
      pnl.operatingProfit === 60_000 - (150_000 + 5_000 + 500),
      `${pnl.operatingProfit}`)
    check('the position balances once retained earnings closes it',
      position.balanced,
      `${position.assets.total} vs ${position.liabilities.total + position.equity.total}`)
    check('it is labelled derived, never claimed as a statutory balance sheet',
      position.equity.rows.some((row) => row.label.includes('derived')))
  }

  console.log('\n── 7. An empty range is empty, not broken ──')
  {
    const empty = await buildJournal({
      restaurantId: restaurant.id,
      range: resolveRange({ preset: 'CUSTOM', from: '2020-01-01', to: '2020-01-02', timeZone: restaurant.timezone }),
    })
    const emptyTrial = foldTrialBalance(empty)
    check('a quiet period produces no entries and still balances',
      empty.length === 0 && emptyTrial.balanced && emptyTrial.totalDebits === 0)
  }

  // Cleanup: purchase_items → inventory_items is Restrict, purchases first.
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
