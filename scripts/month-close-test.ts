/**
 * Month-end close, proven (acCal.md §13).
 *
 * The checklist must answer from the RECORDS — an item that can be ticked by
 * a person is decoration. So each item is flipped by creating the real
 * blocking condition and watching it go red, then clearing it and watching
 * it go green. Closing over open items is allowed (accountants sometimes
 * must) but only with the word CLOSE and a written reason, both of which
 * land on the period.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/month-close-test.ts
 */
import { closePeriod, reopenPeriod } from '../src/features/accounting/service'
import { getMonthCloseChecklist, monthBounds } from '../src/features/accounting/month-close'
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
  const timeZone = 'Asia/Colombo'
  // A month safely in the past, so "today" never drifts the fixture.
  const month = '2026-04'
  const bounds = monthBounds(month, timeZone)
  const midMonth = new Date(Date.UTC(2026, 3, 15, 10, 0, 0))

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Close ${stamp}`, slug: `close-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false, timezone: timeZone,
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `close-${stamp}@test.local`,
      name: 'Closer', passwordHash: 'x', role: 'OWNER',
    },
  })

  const checklistNow = () =>
    getMonthCloseChecklist({ restaurantId: restaurant.id, month, timeZone })
  const itemOf = async (key: string) => {
    const list = await checklistNow()
    return list.items.find((item) => item.key === key)!
  }

  console.log('\n── 1. A month with nothing in it is ready ──')
  {
    const list = await checklistNow()
    check('every item is clear when nothing happened',
      list.items.every((item) => item.done) && list.readyPercent === 100,
      `${list.readyPercent}%`)
    check('the month is named the way a person would name it',
      list.month.label === 'April 2026', list.month.label)
    check('it knows the month is not sealed yet', list.closedPeriodId === null)
  }

  console.log('\n── 2. A trading day that was never signed off blocks the close ──')
  {
    await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `C-${stamp}`,
        customerName: 'Walk-in', customerPhone: '0770000000',
        status: 'COMPLETED', paymentStatus: 'PAID',
        subtotal: 50_000, grandTotal: 50_000, paidTotal: 50_000, placedAt: midMonth,
        items: { create: [{ name: 'Lunch', unitPrice: 50_000, quantity: 1, lineTotal: 50_000 }] },
        payments: {
          create: [{ restaurantId: restaurant.id, amount: 50_000, method: 'CASH', status: 'PAID', paidAt: midMonth }],
        },
      },
    })
    const blocked = await itemOf('days')
    check('the unsigned day is counted and named', !blocked.done && blocked.count === 1,
      `${blocked.done} / ${blocked.count}`)
    check('…and it links to the screen that fixes it',
      blocked.href === '/dashboard/reports/daily-close')
    check('readiness falls below 100%', (await checklistNow()).readyPercent < 100)

    await prisma.dailyClose.create({
      data: {
        restaurantId: restaurant.id, businessDate: new Date(Date.UTC(2026, 3, 15)),
        snapshot: {}, closedById: user.id,
      },
    })
    check('signing the day off clears the item', (await itemOf('days')).done)
  }

  console.log('\n── 3. An open drawer and a pending approval each block it ──')
  {
    const register = await prisma.cashRegister.create({
      data: { restaurantId: restaurant.id, branchId: branch.id, name: 'Till 1' },
    })
    const session = await prisma.cashDrawerSession.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, registerId: register.id,
        sessionNumber: `S-${stamp}`, openedById: user.id, openedAt: midMonth,
        openingFloat: 10_000, status: 'OPEN',
      },
    })
    check('a drawer still open blocks the close', !(await itemOf('drawers')).done)
    await prisma.cashDrawerSession.update({
      where: { id: session.id },
      data: { status: 'CLOSED', closedAt: midMonth, countedCash: 10_000, expectedCash: 10_000, variance: 0 },
    })
    check('closing it clears the item', (await itemOf('drawers')).done)

    const category = await prisma.expenseCategory.create({
      data: { restaurantId: restaurant.id, name: `Rent ${stamp}` },
    })
    const submitted = await prisma.outgoingPayment.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, number: `OP-${stamp}`,
        kind: 'EXPENSE', status: 'SUBMITTED', expenseCategoryId: category.id,
        amount: 25_000, method: 'CASH', description: 'Waiting on the owner',
        paymentDate: midMonth, createdByName: 'Accountant',
      },
    })
    const approvals = await itemOf('approvals')
    check('a request waiting on a decision blocks the close',
      !approvals.done && approvals.count === 1)
    await prisma.outgoingPayment.update({ where: { id: submitted.id }, data: { status: 'REJECTED' } })
    check('deciding it clears the item', (await itemOf('approvals')).done)
  }

  console.log('\n── 4. Money that does not reconcile blocks it ──')
  {
    // A bill whose cached paid total disagrees with its payment ledger.
    const drifted = await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `M-${stamp}`,
        customerName: 'Walk-in', customerPhone: '0770000000',
        status: 'COMPLETED', paymentStatus: 'PAID',
        subtotal: 30_000, grandTotal: 30_000, paidTotal: 30_000, placedAt: midMonth,
        items: { create: [{ name: 'Dinner', unitPrice: 30_000, quantity: 1, lineTotal: 30_000 }] },
        payments: {
          create: [{ restaurantId: restaurant.id, amount: 12_000, method: 'CARD', status: 'PAID', paidAt: midMonth }],
        },
      },
    })
    const payments = await itemOf('payments')
    check('a bill disagreeing with its payments blocks the close',
      !payments.done && payments.count === 1)
    const integrity = await itemOf('integrity')
    check('…and the same drift shows as a critical issue', !integrity.done)

    await prisma.order.update({ where: { id: drifted.id }, data: { paidTotal: 12_000, paymentStatus: 'PARTIAL' } })
    check('correcting the record clears both', (await itemOf('payments')).done && (await itemOf('integrity')).done)

    // An unmatched bank line inside the month.
    const statement = await prisma.bankStatement.create({
      data: {
        restaurantId: restaurant.id, fileName: 'apr.csv', importHash: `hash-${stamp}`,
        lineCount: 1, uploadedByName: 'Closer',
      },
    })
    const line = await prisma.bankStatementLine.create({
      data: {
        restaurantId: restaurant.id, statementId: statement.id, lineDate: midMonth,
        description: 'UNKNOWN CREDIT', amount: 5_000, lineHash: `line-${stamp}`,
      },
    })
    check('an unmatched bank line blocks the close', !(await itemOf('bank')).done)
    await prisma.bankStatementLine.update({ where: { id: line.id }, data: { status: 'IGNORED' } })
    check('setting it aside clears the item', (await itemOf('bank')).done)
  }

  console.log('\n── 5. The journals item asks the ledger itself ──')
  {
    const journals = await itemOf('journals')
    check('debits equal credits for the month', journals.done, journals.detail)
  }

  console.log('\n── 6. Closing, and reopening ──')
  {
    const ready = await checklistNow()
    check('the checklist is fully clear again', ready.readyPercent === 100,
      ready.items.filter((item) => !item.done).map((item) => item.key).join(', '))

    const period = await closePeriod({
      restaurantId: restaurant.id, from: bounds.from, to: bounds.to,
      userId: user.id, notes: 'April signed off',
    })
    const closed = await checklistNow()
    check('the checklist now knows the month is sealed',
      closed.closedPeriodId === period.id)

    // A sealed month refuses edits to what is inside it — the existing guard.
    const { assertPeriodOpen } = await import('../src/features/accounting/service')
    let refused = false
    try {
      await assertPeriodOpen(prisma, restaurant.id, midMonth)
    } catch {
      refused = true
    }
    check('a date inside the sealed month refuses new dated writes', refused)

    await reopenPeriod({ restaurantId: restaurant.id, periodId: period.id, userId: user.id })
    check('reopening lifts the seal', (await checklistNow()).closedPeriodId === null)
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
