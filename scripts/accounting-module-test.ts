/**
 * The accountant's money-out workflow (accountsds.md).
 *
 *   • DRAFT → SUBMITTED → APPROVED → PAID, every transition a CAS — two
 *     owners approving at once, or a double-tapped "mark paid", produce one
 *     winner and one clear refusal.
 *   • The submitter can never approve their own payment.
 *   • Amounts lock at submission; send-back reopens the draft on the record.
 *   • A PAID row is immutable: corrections are reversal rows, and a supplier
 *     reversal is a NEGATING ledger row — the balance math never changes.
 *   • Cash payments post their drawer movement with the system-only type.
 *   • The payables statement agrees with the supplier balance to the cent.
 *   • Sealed accounting periods refuse backdated payment dates.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/accounting-module-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { openDrawer } from '../src/features/cashdrawer/service'
import {
  cancelOwn,
  createDraft,
  decide,
  markPaid,
  reverse,
  sendBack,
  submit,
  updateDraft,
  type OutgoingActor,
} from '../src/features/outgoing-payments/service'
import { getPayablesStatement } from '../src/features/suppliers/payables'
import { getSupplierBalances } from '../src/features/suppliers/ledger'
import { closePeriod, reopenPeriod } from '../src/features/accounting/service'
import { runIntegrityChecks } from '../src/features/accounting/integrity'
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
      name: `Acct ${stamp}`, slug: `acct-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      timezone: 'Asia/Colombo',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const other = await prisma.restaurant.create({
    data: {
      name: `Other ${stamp}`, slug: `other-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
    },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: `Farm ${stamp}` },
  })
  const category = await prisma.expenseCategory.create({
    data: { restaurantId: restaurant.id, name: `Rent ${stamp}` },
  })

  const mkUser = async (label: string, role: 'ACCOUNTANT' | 'OWNER') =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `${label}-${stamp}@test.local`,
        name: label, passwordHash: 'x', role,
      },
    })
  const accountantUser = await mkUser('nadia', 'ACCOUNTANT')
  const ownerUser = await mkUser('alex', 'OWNER')
  const secondOwnerUser = await mkUser('sam', 'OWNER')
  const accountant: OutgoingActor = { id: accountantUser.id, name: 'Nadia (accountant)', canApprove: false }
  const owner: OutgoingActor = { id: ownerUser.id, name: 'Alex (owner)', canApprove: true }

  const draft = (over: Partial<Parameters<typeof createDraft>[0]> = {}) =>
    createDraft({
      restaurantId: restaurant.id,
      branchId: branch.id,
      kind: 'EXPENSE',
      expenseCategoryId: category.id,
      amount: 150_000,
      method: 'BANK_TRANSFER',
      description: 'September rent',
      paymentDate: new Date(),
      actor: accountant,
      ...over,
    })

  console.log('\n── 1. The happy path, stamped at every step ──')
  {
    const payment = await draft()
    check('a draft gets a number', /^OP-\d{4}-\d{5}$/.test(payment.number), payment.number)

    const submitted = await submit({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })
    check('submitted, with the submitter stamped',
      submitted.status === 'SUBMITTED' && submitted.submittedById === accountant.id && submitted.submittedAt !== null)

    const approved = await decide({ restaurantId: restaurant.id, paymentId: payment.id, approve: true, note: 'Fine', actor: owner })
    check('approved by the owner, on the record',
      approved.status === 'APPROVED' && approved.decidedById === owner.id && approved.decisionNote === 'Fine')

    const paid = await markPaid({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })
    check('paid by the accountant — approval was the control',
      paid.status === 'PAID' && paid.paidById === accountant.id && paid.paidAt !== null)
  }

  console.log('\n── 2. The two-person control ──')
  {
    const payment = await draft()
    await submit({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })
    await refuses(
      'the submitter cannot approve their own payment',
      () => decide({ restaurantId: restaurant.id, paymentId: payment.id, approve: true, actor: accountant }),
      /cannot approve a payment you raised/,
    )
    await refuses(
      'rejecting demands a reason',
      () => decide({ restaurantId: restaurant.id, paymentId: payment.id, approve: false, actor: owner }),
      /reason/i,
    )
    const rejected = await decide({
      restaurantId: restaurant.id, paymentId: payment.id, approve: false,
      note: 'Wrong month', actor: owner,
    })
    check('rejected with the reason kept', rejected.status === 'REJECTED' && rejected.decisionNote === 'Wrong month')
  }

  console.log('\n── 3. Races: exactly one winner ──')
  {
    const payment = await draft()
    await submit({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })
    const second: OutgoingActor = { id: secondOwnerUser.id, name: 'Second owner', canApprove: true }
    const decisions = await Promise.allSettled([
      decide({ restaurantId: restaurant.id, paymentId: payment.id, approve: true, actor: owner }),
      decide({ restaurantId: restaurant.id, paymentId: payment.id, approve: false, note: 'No', actor: second }),
    ])
    const wins = decisions.filter((result) => result.status === 'fulfilled').length
    check('two simultaneous decisions: exactly one lands', wins === 1, `${wins} won`)

    const row = await prisma.outgoingPayment.findUniqueOrThrow({ where: { id: payment.id } })
    if (row.status === 'APPROVED') {
      const pays = await Promise.allSettled([
        markPaid({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant }),
        markPaid({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant }),
      ])
      check('a double-tapped mark-paid pays once',
        pays.filter((result) => result.status === 'fulfilled').length === 1)
    } else {
      check('a double-tapped mark-paid pays once', true, 'skipped — the rejection won the race')
    }
  }

  console.log('\n── 4. Amounts lock at submission; send-back reopens ──')
  {
    const payment = await draft({ amount: 90_000 })
    await submit({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })
    await refuses(
      'editing a submitted amount is refused',
      () => updateDraft({
        restaurantId: restaurant.id, paymentId: payment.id,
        patch: { amount: 999_999 }, actor: accountant,
      }),
      /locked/i,
    )
    await sendBack({ restaurantId: restaurant.id, paymentId: payment.id, note: 'Make it the agreed 80k', actor: owner })
    const reopened = await updateDraft({
      restaurantId: restaurant.id, paymentId: payment.id,
      patch: { amount: 80_000 }, actor: accountant,
    })
    check('after send-back the draft reopens and takes the edit',
      reopened.status === 'DRAFT' && reopened.amount === 80_000)
    await submit({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })
    const redecided = await decide({ restaurantId: restaurant.id, paymentId: payment.id, approve: true, actor: owner })
    check('the resubmit goes through the full control again', redecided.status === 'APPROVED')
    await cancelOwn({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant }).catch(() => null)
  }

  console.log('\n── 5. Supplier payments reach the ledger; reversal negates, never deletes ──')
  {
    // Give the supplier a real debt first: a received delivery.
    const item = await prisma.inventoryItem.create({
      data: { restaurantId: restaurant.id, name: `Beans ${stamp}`, unit: 'KG', quantity: 0 },
    })
    const purchase = await prisma.purchase.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, supplierId: supplier.id,
        number: `PO-T-${stamp}`, status: 'RECEIVED', total: 500_000,
        items: { create: [{ itemId: item.id, quantity: 10, unitCost: 50_000, lineTotal: 500_000 }] },
      },
      include: { items: true },
    })
    await prisma.goodsReceipt.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, purchaseId: purchase.id,
        number: `GRN-T-${stamp}`,
        lines: {
          create: [{
            purchaseItemId: purchase.items[0].id, itemId: item.id,
            acceptedQty: 10, unitCost: 50_000,
          }],
        },
      },
    })

    const before = (await getSupplierBalances(restaurant.id)).get(supplier.id) ?? 0
    check('the delivery made a payable', before === 500_000, `${before}`)

    const payment = await draft({
      kind: 'SUPPLIER', supplierId: supplier.id, purchaseId: purchase.id,
      expenseCategoryId: null, amount: 300_000, description: 'Part payment for beans',
    })
    await submit({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })
    await decide({ restaurantId: restaurant.id, paymentId: payment.id, approve: true, actor: owner })
    const paid = await markPaid({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })

    check('paying projected a SupplierPayment ledger row', paid.supplierPaymentId !== null)
    const after = (await getSupplierBalances(restaurant.id)).get(supplier.id) ?? 0
    check('the supplier balance dropped by exactly the payment', after === 200_000, `${after}`)

    // The statement agrees with the ledger.
    const range = resolveRange({ preset: 'TODAY', timeZone: 'Asia/Colombo' })
    const statement = await getPayablesStatement({ restaurantId: restaurant.id, range })
    const row = statement.rows.find((entry) => entry.supplierId === supplier.id)
    check('the statement closing equals the live balance',
      row !== undefined && row.closing === after,
      `${row?.closing} vs ${after}`)
    check('partial payment shows in the statement',
      row !== undefined && row.received === 500_000 && row.paid === 300_000)
    check('the unpaid remainder ages in the current bucket',
      row !== undefined && row.aging.current === 200_000, `${JSON.stringify(row?.aging)}`)

    // Reversal: a negating row, never a deletion.
    const reversal = await reverse({
      restaurantId: restaurant.id, paymentId: payment.id,
      reason: 'Paid the wrong supplier', actor: owner,
    })
    check('the reversal is its own PAID row pointing at the original',
      reversal.status === 'PAID' && reversal.reversalOfId === payment.id)
    const original = await prisma.outgoingPayment.findUniqueOrThrow({ where: { id: payment.id } })
    check('the original is REVERSED, not edited',
      original.status === 'REVERSED' && original.amount === 300_000)
    const restored = (await getSupplierBalances(restaurant.id)).get(supplier.id) ?? 0
    check('the supplier balance is restored through the ledger', restored === 500_000, `${restored}`)
    const ledgerRows = await prisma.supplierPayment.count({ where: { supplierId: supplier.id } })
    check('both ledger rows survive — payment and its negation', ledgerRows === 2, `${ledgerRows}`)

    await refuses(
      'a second reversal is refused',
      () => reverse({ restaurantId: restaurant.id, paymentId: payment.id, reason: 'again', actor: owner }),
      /only once|Only a paid/i,
    )
  }

  console.log('\n── 6. Cash pays from a drawer, with the system-only type ──')
  {
    const cashier = await prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `acct-${stamp}@test.local`, name: 'Till',
        passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
      },
    })
    // Through the real service, like the cash-drawer suite does.
    const session = await openDrawer({
      restaurantId: restaurant.id,
      userId: cashier.id,
      branchId: branch.id,
      openingFloat: 500_000,
    })

    const payment = await draft({ amount: 40_000, method: 'CASH', description: 'Gas cylinder' })
    await submit({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })
    await decide({ restaurantId: restaurant.id, paymentId: payment.id, approve: true, actor: owner })
    await markPaid({ restaurantId: restaurant.id, paymentId: payment.id, actor: accountant })

    const movement = await prisma.cashMovement.findFirst({
      where: { outgoingPaymentId: payment.id },
    })
    check('the drawer movement exists, linked and typed EXPENSE_PAID',
      movement !== null && movement.type === 'EXPENSE_PAID' && movement.sessionId === session.id,
      movement?.type)

    const bank = await draft({ amount: 60_000, method: 'BANK_TRANSFER' })
    await submit({ restaurantId: restaurant.id, paymentId: bank.id, actor: accountant })
    await decide({ restaurantId: restaurant.id, paymentId: bank.id, approve: true, actor: owner })
    await markPaid({ restaurantId: restaurant.id, paymentId: bank.id, actor: accountant })
    const bankMovement = await prisma.cashMovement.findFirst({ where: { outgoingPaymentId: bank.id } })
    check('a bank transfer touches no drawer', bankMovement === null)
  }

  console.log('\n── 7. Sealed periods refuse backdated money ──')
  {
    const dayMs = 86_400_000
    const start = new Date(Date.now() - 10 * dayMs)
    const end = new Date(Date.now() - 5 * dayMs)
    const period = await closePeriod({
      restaurantId: restaurant.id, from: start, to: end, userId: owner.id,
    })
    const backdated = await draft({ paymentDate: new Date(Date.now() - 7 * dayMs) })
    await refuses(
      'submitting a payment dated into a sealed period is refused',
      () => submit({ restaurantId: restaurant.id, paymentId: backdated.id, actor: accountant }),
      /closed accounting period/,
    )
    await reopenPeriod({ restaurantId: restaurant.id, periodId: period.id, userId: owner.id })
    const reopened = await submit({ restaurantId: restaurant.id, paymentId: backdated.id, actor: accountant })
    check('reopening the period lifts the refusal', reopened.status === 'SUBMITTED')
    await decide({ restaurantId: restaurant.id, paymentId: backdated.id, approve: false, note: 'test tidy', actor: owner })
  }

  console.log('\n── 8. Tenancy and integrity ──')
  {
    const anyPayment = await prisma.outgoingPayment.findFirstOrThrow({
      where: { restaurantId: restaurant.id },
    })
    await refuses(
      'another restaurant cannot touch this workflow',
      () => submit({ restaurantId: other.id, paymentId: anyPayment.id, actor: owner }),
      /not found/i,
    )
    await refuses(
      'an expense draft without a category is refused',
      () => draft({ expenseCategoryId: null }),
      /category/i,
    )
    await refuses(
      'a supplier draft without a supplier is refused',
      () => draft({ kind: 'SUPPLIER', expenseCategoryId: null }),
      /supplier/i,
    )

    const report = await runIntegrityChecks(restaurant.id)
    const workflowChecks = report.checks.filter((entry) => entry.key.startsWith('outgoing-'))
    check('all four workflow integrity checks are green',
      workflowChecks.length === 4 && workflowChecks.every((entry) => entry.status === 'OK'),
      workflowChecks.map((entry) => `${entry.key}:${entry.status}`).join(' '))
  }

  // purchase_items → inventory_items is Restrict, so the purchases go first.
  await prisma.goodsReceipt.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.purchase.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: other.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
