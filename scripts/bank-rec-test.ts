/**
 * Bank reconciliation, proven (acCal.md §6).
 *
 * A wrong match is a lie that survives in the books, so the rules under test
 * are the conservative ones: exact amounts only, direction must agree, the
 * same file cannot be imported twice, the same payment cannot be claimed by
 * two lines, and two people accepting at once resolve to exactly one winner.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/bank-rec-test.ts
 */
import { parseCsv, readStatementRows } from '../src/features/ledger/bank-import'
import { acceptMatch, getBankReconciliation, importStatement, setLineStatus, suggestMatch } from '../src/features/ledger/bank-matching'
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

async function refuses(name: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, pattern.test(message), message)
  }
}

function isoDay(offsetDays: number): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000)
  return date.toISOString().slice(0, 10)
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Bank ${stamp}`, slug: `bank-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      timezone: 'Asia/Colombo',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `bank-${stamp}@test.local`,
      name: 'Book keeper', passwordHash: 'x', role: 'ACCOUNTANT',
    },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: `Dairy ${stamp}` },
  })

  console.log('\n── 1. Reading what banks actually export ──')
  {
    const rows = parseCsv(
      'Date,Description,Reference,Amount\n' +
        `${isoDay(0)},"CARD SETTLEMENT, BATCH 7",REF1234,1500.00\n` +
        `${isoDay(-1)},SUPPLIER TRANSFER,PAY-77,-2500.50\n`,
    )
    check('a quoted field containing a comma stays one field', rows[1].length === 4)
    const read = readStatementRows({ restaurantId: restaurant.id, rows, currencyFactor: 100 })
    check('amounts arrive in minor units, signed by direction',
      read.lines[0].amount === 150_000 && read.lines[1].amount === -250_050,
      `${read.lines[0].amount}, ${read.lines[1].amount}`)
    check('every line gets a hash for duplicate detection',
      read.lines.every((line) => line.lineHash.length === 64))

    // A debit/credit-column export, the other common shape.
    const twoColumn = parseCsv(
      'Value Date,Narration,Debit,Credit\n' + `${isoDay(0)},POS DEPOSIT,,"3,000.00"\n` + `${isoDay(0)},BANK CHARGE,250.00,\n`,
    )
    const readTwo = readStatementRows({ restaurantId: restaurant.id, rows: twoColumn, currencyFactor: 100 })
    check('debit and credit columns are read as one signed amount',
      readTwo.lines[0].amount === 300_000 && readTwo.lines[1].amount === -25_000,
      `${readTwo.lines[0].amount}, ${readTwo.lines[1].amount}`)

    // Unreadable rows are counted, never guessed.
    const messy = parseCsv('Date,Description,Amount\n' + `${isoDay(0)},GOOD ROW,100.00\n` + 'not-a-date,BAD ROW,abc\n')
    const readMessy = readStatementRows({ restaurantId: restaurant.id, rows: messy, currencyFactor: 100 })
    check('a row it cannot read is skipped and counted, never guessed',
      readMessy.lines.length === 1 && readMessy.skipped === 1)

    await refuses(
      'a file with no amount column is refused with a plain reason',
      async () =>
        readStatementRows({
          restaurantId: restaurant.id,
          rows: parseCsv('Date,Description\n2026-01-01,SOMETHING\n'),
          currencyFactor: 100,
        }),
      /amount column/i,
    )
  }

  console.log('\n── 2. Importing: the same file twice is refused ──')
  const csv =
    'Date,Description,Reference,Amount\n' +
    `${isoDay(0)},CARD SETTLEMENT,ORD-${stamp},1500.00\n` +
    `${isoDay(0)},TRANSFER TO DAIRY,TRF-${stamp},-2500.00\n` +
    `${isoDay(0)},BANK CHARGE,,-100.00\n`
  {
    const result = await importStatement({
      restaurantId: restaurant.id, branchId: branch.id, fileName: 'statement.csv',
      content: csv, rows: parseCsv(csv), currencyFactor: 100,
      uploadedById: user.id, uploadedByName: user.name,
    })
    check('three lines imported, nothing skipped', result.imported === 3 && result.skipped === 0)

    await refuses(
      'the identical file cannot be imported again',
      () =>
        importStatement({
          restaurantId: restaurant.id, branchId: branch.id, fileName: 'statement-copy.csv',
          content: csv, rows: parseCsv(csv), currencyFactor: 100,
          uploadedById: user.id, uploadedByName: user.name,
        }),
      /already imported/i,
    )

    // A different file carrying one line we have seen before.
    const second =
      'Date,Description,Reference,Amount\n' +
      `${isoDay(0)},CARD SETTLEMENT,ORD-${stamp},1500.00\n` +
      `${isoDay(0)},NEW LINE,,700.00\n`
    const again = await importStatement({
      restaurantId: restaurant.id, branchId: branch.id, fileName: 'statement-2.csv',
      content: second, rows: parseCsv(second), currencyFactor: 100,
      uploadedById: user.id, uploadedByName: user.name,
    })
    check('a line seen in an earlier statement is flagged DUPLICATE, not dropped',
      again.imported === 2 && again.duplicates === 1)
  }

  console.log('\n── 3. Matching: exact amount, right direction, near date ──')
  {
    const now = new Date()
    // Money in: a card payment on a bill.
    const order = await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `ORD-${stamp}`,
        customerName: 'Walk-in', customerPhone: '0770000000',
        status: 'COMPLETED', paymentStatus: 'PAID',
        subtotal: 150_000, grandTotal: 150_000, paidTotal: 150_000, placedAt: now,
        payments: {
          create: [{ restaurantId: restaurant.id, amount: 150_000, method: 'CARD', status: 'PAID', paidAt: now }],
        },
      },
    })
    // Money out: a supplier transfer of the same magnitude as the debit line.
    const supplierPayment = await prisma.supplierPayment.create({
      data: {
        restaurantId: restaurant.id, supplierId: supplier.id, amount: 250_000,
        method: 'BANK_TRANSFER', paidAt: now, reference: `TRF-${stamp}`, createdByName: 'Book keeper',
      },
    })
    // A cash payment of the SAME amount as the credit line — cash never
    // reaches the bank, so it must never be offered as a match.
    await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `CASH-${stamp}`,
        customerName: 'Walk-in', customerPhone: '0770000000',
        status: 'COMPLETED', paymentStatus: 'PAID',
        subtotal: 150_000, grandTotal: 150_000, paidTotal: 150_000, placedAt: now,
        payments: {
          create: [{ restaurantId: restaurant.id, amount: 150_000, method: 'CASH', status: 'PAID', paidAt: now }],
        },
      },
    })

    const lines = await prisma.bankStatementLine.findMany({
      where: { restaurantId: restaurant.id, status: 'UNMATCHED' },
      orderBy: { amount: 'desc' },
    })
    const creditLine = lines.find((line) => line.amount === 150_000)!
    const debitLine = lines.find((line) => line.amount === -250_000)!
    const chargeLine = lines.find((line) => line.amount === -10_000)!

    const forCredit = await suggestMatch({ restaurantId: restaurant.id, line: creditLine })
    check('money in matches the CARD payment, never the cash one',
      forCredit?.type === 'PAYMENT' && forCredit.amount === 150_000,
      `${forCredit?.type}`)
    check('…and the suggestion links to the bill behind it',
      forCredit?.href === `/dashboard/orders/${order.id}`)

    const forDebit = await suggestMatch({ restaurantId: restaurant.id, line: debitLine })
    check('money out matches the supplier transfer',
      forDebit?.type === 'SUPPLIER_PAYMENT' && forDebit.id === supplierPayment.id)
    check('the reference in the narration lifts the score above a bare date match',
      (forDebit?.score ?? 0) >= 100)

    const forCharge = await suggestMatch({ restaurantId: restaurant.id, line: chargeLine })
    check('a bank charge nothing explains gets no suggestion at all', forCharge === null)

    console.log('\n── 4. Accepting: once, by one person, for one record ──')
    await acceptMatch({
      restaurantId: restaurant.id, lineId: debitLine.id,
      type: 'SUPPLIER_PAYMENT', targetId: supplierPayment.id, userId: user.id,
    })
    const matched = await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: debitLine.id } })
    check('the line is MATCHED and says what it matched',
      matched.status === 'MATCHED' && matched.matchedId === supplierPayment.id && matched.matchedAt !== null)

    // The duplicate line of the same transfer must not claim the same payment.
    const duplicateOfDebit = await prisma.bankStatementLine.create({
      data: {
        restaurantId: restaurant.id, statementId: matched.statementId,
        lineDate: matched.lineDate, description: matched.description,
        reference: matched.reference, amount: matched.amount, lineHash: `${matched.lineHash}-x`,
      },
    })
    await refuses(
      'a second line cannot claim a payment that is already matched',
      () =>
        acceptMatch({
          restaurantId: restaurant.id, lineId: duplicateOfDebit.id,
          type: 'SUPPLIER_PAYMENT', targetId: supplierPayment.id, userId: user.id,
        }),
      /already matched/i,
    )
    const suggestionAfter = await suggestMatch({ restaurantId: restaurant.id, line: duplicateOfDebit })
    check('…and a matched payment is never suggested again', suggestionAfter === null)

    // Two people accepting the same line at the same instant.
    const raceLine = creditLine
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })
    const results = await Promise.allSettled([
      acceptMatch({ restaurantId: restaurant.id, lineId: raceLine.id, type: 'PAYMENT', targetId: payment.id, userId: user.id }),
      acceptMatch({ restaurantId: restaurant.id, lineId: raceLine.id, type: 'PAYMENT', targetId: payment.id, userId: user.id }),
    ])
    check('two people accepting at once: exactly one wins',
      results.filter((row) => row.status === 'fulfilled').length === 1,
      results.map((row) => row.status).join(', '))

    console.log('\n── 5. Undoing and setting aside ──')
    await setLineStatus({ restaurantId: restaurant.id, lineId: raceLine.id, status: 'UNMATCHED', userId: user.id })
    const undone = await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: raceLine.id } })
    check('un-matching clears the link so the payment can be matched again',
      undone.status === 'UNMATCHED' && undone.matchedId === null)

    await setLineStatus({ restaurantId: restaurant.id, lineId: chargeLine.id, status: 'IGNORED', userId: user.id })
    const summary = await getBankReconciliation({ restaurantId: restaurant.id })
    check('the summary counts every state',
      summary.counts.matched === 1 && summary.counts.ignored === 1 && summary.counts.unmatched >= 1,
      JSON.stringify(summary.counts))
    check('set-aside and matched lines drop off the to-do list',
      !summary.open.some(({ line }) => line.id === chargeLine.id || line.id === debitLine.id))
  }

  console.log('\n── 6. Tenancy ──')
  {
    const other = await prisma.restaurant.create({
      data: {
        name: `Other ${stamp}`, slug: `other-bank-${stamp}`, status: 'ACTIVE', isActive: true,
        currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      },
    })
    const line = await prisma.bankStatementLine.findFirstOrThrow({ where: { restaurantId: restaurant.id } })
    await refuses(
      'another restaurant cannot touch these statement lines',
      () => setLineStatus({ restaurantId: other.id, lineId: line.id, status: 'IGNORED', userId: user.id }),
      /not found/i,
    )
    await prisma.restaurant.delete({ where: { id: other.id } })
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
