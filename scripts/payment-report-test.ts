/**
 * The Payment details report adds up, and shows only what the owner allowed.
 *
 * Pinned:
 *   - collected, refunded and net are exactly the payments and refunds of the
 *     period, split by method and by account;
 *   - the report's balances are the account balances Payment details shows
 *     (`accountBalances`), so the two screens cannot disagree;
 *   - a deposit and a transfer appear once each, the transfer from the side
 *     the money left;
 *   - a staff member given one account sees that account's money and none of
 *     the other's; one given no account sees nothing at all;
 *   - the branch filter narrows payments, and nothing outside the period
 *     counts.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/payment-report-test.ts
 */
import { capturePayment, refundPayment } from '../src/features/payments/service'
import { createAccount, deposit, seedDefaultAccounts, setAccountStaff, transfer } from '../src/features/payments/accounts'
import { accountBalances } from '../src/features/payments/accounts-ledger'
import { getPaymentReport } from '../src/features/payments/report'
import { placeOrder } from '../src/features/orders/service'
import { prisma } from '../src/server/db/prisma'
import type { TenantUser } from '../src/server/auth/guard'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  const stamp = Date.now().toString(36)
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Report ${stamp}`, slug: `report-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false, timezone: 'Asia/Colombo',
    },
  })
  const restaurantId = restaurant.id
  try {
    await seedDefaultAccounts(prisma, restaurantId)
    const main = await prisma.branch.create({ data: { restaurantId, name: 'Main', code: 'MAIN', isDefault: true } })
    const kandy = await prisma.branch.create({ data: { restaurantId, name: 'Kandy', code: 'KDY' } })
    const boc = await createAccount({ restaurantId, input: { name: 'BOC', bankName: 'BOC' } })
    const hnb = await createAccount({ restaurantId, input: { name: 'HNB', bankName: 'HNB' } })
    await prisma.restaurant.update({
      where: { id: restaurantId },
      data: { paymentConfig: { methodDestinations: { CASH: boc.code, CARD: hnb.code } } },
    })

    const category = await prisma.category.create({ data: { restaurantId, name: 'Mains', slug: `m-${stamp}` } })
    const dish = await prisma.food.create({
      data: { restaurantId, categoryId: category.id, name: 'Rice', slug: `r-${stamp}`, price: 10_000 },
    })
    for (const branch of [main, kandy]) {
      await prisma.foodBranch.create({ data: { restaurantId, foodId: dish.id, branchId: branch.id, isAvailable: true } })
    }
    const owner = await prisma.user.create({
      data: { restaurantId, email: `own-${stamp}@test.local`, name: 'Owner', passwordHash: 'x', role: 'OWNER' },
    })
    const cashier = await prisma.user.create({
      data: { restaurantId, email: `cash-${stamp}@test.local`, name: 'Sunil', passwordHash: 'x', role: 'CASHIER', branchId: main.id },
    })
    const stranger = await prisma.user.create({
      data: { restaurantId, email: `str-${stamp}@test.local`, name: 'Kamal', passwordHash: 'x', role: 'ACCOUNTANT' },
    })
    const tenant = (u: typeof owner) => ({ ...u, restaurantId }) as unknown as TenantUser

    const sell = async (branchId: string, method: 'CASH' | 'CARD', quantity: number) => {
      const order = await placeOrder({
        restaurantId, branchId, tableId: null, type: 'COUNTER', channel: 'COUNTER',
        customerName: 'Walk-in', customerPhone: '', items: [{ foodId: dish.id, quantity, optionIds: [] }],
      })
      return capturePayment({ restaurantId, orderId: order.id, method, amount: order.grandTotal })
    }

    // Cash 20,000 and card 30,000 at Main; cash 10,000 at Kandy; 5,000 of the Main cash refunded.
    const mainCash = await sell(main.id, 'CASH', 2)
    await sell(main.id, 'CARD', 3)
    await sell(kandy.id, 'CASH', 1)
    await refundPayment({
      restaurantId, paymentId: mainCash.payment.id, actorId: owner.id,
      amount: 5_000, reason: 'Cold', clientRequestId: `rf-${stamp}`,
    })
    await deposit({ restaurantId, accountId: boc.id, amount: 100_000, reason: 'Opening', userId: owner.id, actorName: 'Owner' })
    await transfer({
      restaurantId, fromAccountId: boc.id, toAccountId: hnb.id, amount: 40_000,
      reason: 'Sweep', userId: owner.id, actorName: 'Owner',
    })

    const now = new Date()
    const window = {
      from: new Date(now.getTime() - 3_600_000),
      to: new Date(now.getTime() + 60_000),
      previous: { from: new Date(now.getTime() - 7_200_000), to: new Date(now.getTime() - 3_600_001) },
      timeZone: 'Asia/Colombo',
    }

    console.log('\n── 1. The owner sees everything, and it adds up ──')
    const all = await getPaymentReport({ user: tenant(owner), branchIds: null, ...window })
    check('collected is every payment', all.collected === 60_000, String(all.collected))
    check('refunded is every refund', all.refunded === 5_000, String(all.refunded))
    check('net is the difference', all.net === 55_000, String(all.net))
    check('three payments, one refund', all.payments === 3 && all.refunds === 1, `${all.payments}/${all.refunds}`)
    const cash = all.byMethod.find((row) => row.method === 'CASH')
    check('cash: 30,000 in, 5,000 back', cash?.collected === 30_000 && cash.refunded === 5_000 && cash.net === 25_000, JSON.stringify(cash))
    check('by account: BOC nets 25,000, HNB 30,000',
      all.byAccount.find((row) => row.code === boc.code)?.net === 25_000 &&
        all.byAccount.find((row) => row.code === hnb.code)?.net === 30_000)

    const ledger = await accountBalances(prisma, restaurantId)
    const same = all.balances.every((row) => ledger.find((l) => l.code === row.code)?.balance === row.balance)
    check('its balances are exactly the balances Payment details shows', same)
    check('BOC: 25,000 + 100,000 deposited − 40,000 moved = 85,000',
      all.balances.find((row) => row.code === boc.code)?.balance === 85_000,
      String(all.balances.find((row) => row.code === boc.code)?.balance))
    check('one deposit and one transfer, each listed once',
      all.deposited.count === 1 && all.moved.count === 1 && all.movements.length === 2,
      `${all.deposited.count}/${all.moved.count}/${all.movements.length}`)
    check('the transfer is listed from the side the money left',
      all.movements.some((row) => row.kind === 'Transfer' && row.account === 'BOC' && row.counterparty === 'HNB'))
    check('the trend sums to the same net', all.trend.reduce((sum, p) => sum + p.net, 0) === all.net)

    console.log('\n── 2. The branch filter narrows payments ──')
    const kandyOnly = await getPaymentReport({ user: tenant(owner), branchIds: [kandy.id], ...window })
    check('Kandy collected only its own 10,000', kandyOnly.collected === 10_000 && kandyOnly.refunded === 0, `${kandyOnly.collected}`)

    console.log('\n── 3. Nothing outside the period counts ──')
    const later = await getPaymentReport({
      user: tenant(owner), branchIds: null, ...window,
      from: new Date(now.getTime() + 120_000), to: new Date(now.getTime() + 3_600_000),
    })
    check('a later window is empty', later.collected === 0 && later.movements.length === 0)
    check('…while the balances still stand', later.totalBalance === all.totalBalance)

    console.log('\n── 4. Staff see only what the owner gave them ──')
    await setAccountStaff({ restaurantId, accountId: boc.id, staff: [{ userId: cashier.id, canTransfer: false }] })
    const mine = await getPaymentReport({ user: tenant(cashier), branchIds: null, ...window })
    check('the cashier given BOC sees BOC’s money only',
      mine.collected === 30_000 && mine.byAccount.every((row) => row.code === boc.code),
      `${mine.collected} ${mine.byAccount.map((r) => r.code).join(',')}`)
    check('…and only BOC’s balance', mine.balances.length === 1 && mine.balances[0]?.code === boc.code)
    check('…and not the HNB side of anything', !mine.byMethod.some((row) => row.method === 'CARD'))
    const none = await getPaymentReport({ user: tenant(stranger), branchIds: null, ...window })
    check('an accountant given nothing sees nothing',
      none.collected === 0 && none.balances.length === 0 && none.movements.length === 0 && none.totalBalance === 0)
  } finally {
    await prisma.paymentAccountStaff.deleteMany({ where: { account: { restaurantId } } })
    await prisma.paymentAccountEntry.deleteMany({ where: { restaurantId } })
    await prisma.refund.deleteMany({ where: { restaurantId } })
    await prisma.payment.deleteMany({ where: { restaurantId } })
    await prisma.orderEvent.deleteMany({ where: { order: { restaurantId } } })
    await prisma.orderItem.deleteMany({ where: { order: { restaurantId } } })
    await prisma.invoice.deleteMany({ where: { restaurantId } })
    await prisma.order.deleteMany({ where: { restaurantId } })
    await prisma.paymentAccount.deleteMany({ where: { restaurantId } })
    await prisma.restaurant.delete({ where: { id: restaurantId } }).catch((error) => console.error('cleanup', error.message))
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exitCode = failed > 0 ? 1 : 0
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
