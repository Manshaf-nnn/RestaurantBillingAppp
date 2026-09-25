/**
 * Internal accounts: balances, deposits and transfers (bank.md).
 *
 * ── The one property everything else rests on ───────────────────────────────
 *
 * "Account balance and transaction history must always reconcile." Here that is
 * true by construction rather than by a nightly check, because the balance is
 * not stored: it IS the history, summed. So the assertions below are not
 * "did the cache keep up" — there is no cache — they are that every way money
 * can move lands in the history exactly once.
 *
 * Which is why one of the most important checks looks like an absence: a
 * customer payment must move the balance and write NO entry row, because a
 * payment is already attributed by `Payment.destination`, and a second row for
 * it is the mirror `CashMovementType` refuses for cash sales.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/payment-account-test.ts
 */
import { capturePayment, refundPayment } from '../src/features/payments/service'
import {
  createAccount,
  deposit,
  seedDefaultAccounts,
  setAccountActive,
  setAccountStaff,
  transfer,
  visibleAccountsFor,
  whyCannotUseAccount,
} from '../src/features/payments/accounts'
import { accountBalances, directionOf } from '../src/features/payments/accounts-ledger'
import { placeOrder } from '../src/features/orders/service'
import { prisma } from '../src/server/db/prisma'
import type { TenantUser } from '../src/server/auth/guard'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
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
  await seedDefaultAccounts(prisma, restaurant.id)
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const till = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `till-${stamp}@test.local`, name: 'Till',
      passwordHash: 'x', role: 'CASHIER',
    },
  })

  const balanceOfCode = async (code: string) =>
    (await accountBalances(prisma, restaurant.id)).find((row) => row.code === code)?.balance ?? null
  const entryCount = async (code: string) =>
    prisma.paymentAccountEntry.count({ where: { account: { code, restaurantId: restaurant.id } } })

  const boc = await createAccount({
    restaurantId: restaurant.id,
    input: { name: 'BOC Main Account', bankName: 'BOC', accountNumber: '1234567', holderName: 'Nimal' },
  })
  const hnb = await createAccount({ restaurantId: restaurant.id, input: { name: 'HNB Account', bankName: 'HNB' } })

  console.log('\n── 1. A new account opens at zero ──')
  {
    check('the four fields bank.md asks for are stored',
      boc.name === 'BOC Main Account' && boc.bankName === 'BOC' &&
      boc.accountNumber === '1234567' && boc.holderName === 'Nimal')
    check('its balance starts at nothing', (await balanceOfCode(boc.code)) === 0)
    check('and it has no history yet', (await entryCount(boc.code)) === 0)
    check('the code is minted from the name, never the id', boc.code === 'boc_main_account', boc.code)
  }

  console.log('\n── 2. Deposit ──')
  {
    await deposit({
      restaurantId: restaurant.id, accountId: boc.id, amount: 250_000,
      reason: 'Opening balance', clientRequestId: `dep-${stamp}-1`,
    })
    check('the balance is what was put in', (await balanceOfCode(boc.code)) === 250_000)
    check('and it left exactly one row behind', (await entryCount(boc.code)) === 1)

    // The same tap twice must deposit once — the shape `capturePayment` uses.
    const again = await deposit({
      restaurantId: restaurant.id, accountId: boc.id, amount: 250_000,
      reason: 'Opening balance', clientRequestId: `dep-${stamp}-1`,
    })
    check('a retry deposits once, not twice',
      again.replayed && (await balanceOfCode(boc.code)) === 250_000 && (await entryCount(boc.code)) === 1)

    await refuses('zero is not a deposit',
      () => deposit({ restaurantId: restaurant.id, accountId: boc.id, amount: 0 }),
      /greater than zero/i)
  }

  console.log('\n── 3. Money transfer: BOC → HNB, 50,000 ──')
  {
    const before = { boc: await balanceOfCode(boc.code), hnb: await balanceOfCode(hnb.code) }
    const moved = await transfer({
      restaurantId: restaurant.id, fromAccountId: boc.id, toAccountId: hnb.id,
      amount: 50_000, reason: 'Float for the week', clientRequestId: `xf-${stamp}-1`,
    })

    check('the source falls by exactly that', (await balanceOfCode(boc.code)) === before.boc! - 50_000)
    check('the destination rises by exactly that', (await balanceOfCode(hnb.code)) === before.hnb! + 50_000)

    const legs = await prisma.paymentAccountEntry.findMany({
      where: { transferGroupId: moved.transferGroupId }, orderBy: { type: 'asc' },
    })
    check('it is two rows, tied together', legs.length === 2 &&
      legs.every((leg) => leg.transferGroupId === moved.transferGroupId), JSON.stringify(legs.map((l) => l.type)))
    check('each names the account at the other end',
      legs.every((leg) => leg.counterpartyAccountId !== null))
    check('and each carries the reason, so it can be explained later',
      legs.every((leg) => leg.reason === 'Float for the week'))

    const replay = await transfer({
      restaurantId: restaurant.id, fromAccountId: boc.id, toAccountId: hnb.id,
      amount: 50_000, clientRequestId: `xf-${stamp}-1`,
    })
    check('a retry transfers once', replay.replayed &&
      (await balanceOfCode(boc.code)) === before.boc! - 50_000)

    check('nothing was created or destroyed',
      (await balanceOfCode(boc.code))! + (await balanceOfCode(hnb.code))! === before.boc! + before.hnb!)
  }

  console.log('\n── 4. A transfer never half-happens ──')
  {
    const before = { boc: await balanceOfCode(boc.code), hnb: await balanceOfCode(hnb.code) }
    const entriesBefore = await prisma.paymentAccountEntry.count({ where: { restaurantId: restaurant.id } })

    // A destination in another restaurant: the OUT leg would write, then the
    // lock fails. Both halves must roll back together.
    const foreign = await prisma.restaurant.create({
      data: { name: `Other ${stamp}`, slug: `other-${stamp}`, status: 'ACTIVE', isActive: true },
    })
    const theirs = await createAccount({ restaurantId: foreign.id, input: { name: 'Their account' } })

    await refuses('a transfer into another restaurant is refused',
      () => transfer({
        restaurantId: restaurant.id, fromAccountId: boc.id, toAccountId: theirs.id, amount: 1_000,
      }),
      /not found|account/i)

    check('the source is untouched', (await balanceOfCode(boc.code)) === before.boc)
    check('the destination is untouched', (await balanceOfCode(hnb.code)) === before.hnb)
    check('and not one row was left behind',
      (await prisma.paymentAccountEntry.count({ where: { restaurantId: restaurant.id } })) === entriesBefore)

    await prisma.paymentAccount.deleteMany({ where: { restaurantId: foreign.id } })
    await prisma.restaurant.delete({ where: { id: foreign.id } })

    await refuses('you cannot move money the account does not hold',
      () => transfer({
        restaurantId: restaurant.id, fromAccountId: boc.id, toAccountId: hnb.id, amount: 99_999_999,
      }),
      /does not hold enough/i)
    await refuses('an account cannot transfer to itself',
      () => transfer({
        restaurantId: restaurant.id, fromAccountId: boc.id, toAccountId: boc.id, amount: 100,
      }),
      /two different accounts/i)
  }

  console.log('\n── 5. A customer payment lands in its account, and writes no row ──')
  {
    await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { paymentConfig: { methodDestinations: { CASH: boc.code, CARD: hnb.code } } },
    })

    const category = await prisma.category.create({
      data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` },
    })
    const dish = await prisma.food.create({
      data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Rice', slug: `r-${stamp}`, price: 5_000 },
    })
    await prisma.foodBranch.create({
      data: { restaurantId: restaurant.id, foodId: dish.id, branchId: branch.id, isAvailable: true },
    })

    const before = await balanceOfCode(boc.code)
    const rowsBefore = await entryCount(boc.code)

    const order = await placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId: null,
      type: 'COUNTER', channel: 'COUNTER', customerName: 'Walk-in', customerPhone: '',
      items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
    })
    const paid = await capturePayment({
      restaurantId: restaurant.id, orderId: order.id, method: 'CASH', amount: order.grandTotal,
    })

    check('the money is in the account the method points at',
      (await balanceOfCode(boc.code)) === before! + order.grandTotal,
      `${await balanceOfCode(boc.code)} vs ${before! + order.grandTotal}`)
    /*
     * The heart of it. A payment is already attributed by `Payment.destination`;
     * a second row here would be the mirror the cash drawer refuses, and would
     * double-count the moment it is refunded.
     */
    check('…and NOT by writing a second row for it', (await entryCount(boc.code)) === rowsBefore)

    const afterPaid = await balanceOfCode(boc.code)
    await refundPayment({
      restaurantId: restaurant.id, paymentId: paid.payment.id, actorId: till.id,
      amount: 2_000, reason: 'Cold', clientRequestId: `rf-${stamp}-1`,
    })
    check('a refund takes it back out of the same account',
      (await balanceOfCode(boc.code)) === afterPaid! - 2_000)
    check('…still without writing an entry row', (await entryCount(boc.code)) === rowsBefore)
  }

  console.log('\n── 6. The balance IS the history ──')
  {
    const [account] = (await accountBalances(prisma, restaurant.id)).filter((row) => row.code === boc.code)
    const replayed =
      account.deposited + account.transferredIn - account.transferredOut +
      account.collected - account.refunded
    check('every part adds up to the number on the card', replayed === account.balance,
      `${replayed} vs ${account.balance}`)

    const entries = await prisma.paymentAccountEntry.findMany({
      where: { account: { code: boc.code, restaurantId: restaurant.id } },
    })
    const fromRows = entries.reduce((sum, row) => sum + directionOf(row.type) * row.amount, 0)
    check('the entry rows alone explain the deposit and transfer half',
      fromRows === account.deposited + account.transferredIn - account.transferredOut)
  }

  console.log('\n── 7. An entry is a fact ──')
  {
    const one = await prisma.paymentAccountEntry.findFirstOrThrow({
      where: { restaurantId: restaurant.id },
    })
    await refuses('the database refuses to rewrite an amount',
      () => prisma.$executeRawUnsafe(
        `UPDATE payment_account_entries SET "amount" = 1 WHERE id = '${one.id}'`),
      /fact|immutable/i)
  }

  console.log('\n── 8. Concurrency ──')
  {
    const before = await balanceOfCode(hnb.code)
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        deposit({
          restaurantId: restaurant.id, accountId: hnb.id, amount: 1_000,
          clientRequestId: `conc-${stamp}-${i}`,
        }),
      ),
    )
    check('twelve simultaneous deposits all land, none twice',
      (await balanceOfCode(hnb.code)) === before! + 12_000,
      `${await balanceOfCode(hnb.code)} vs ${before! + 12_000}`)

    /*
     * Opposite transfers at the same moment. Both accounts are locked in one
     * ORDER BY id statement, so the second waits rather than deadlocking; a
     * deadlock would surface here as a rejected promise.
     */
    const pairBefore = (await balanceOfCode(boc.code))! + (await balanceOfCode(hnb.code))!
    const results = await Promise.allSettled([
      transfer({ restaurantId: restaurant.id, fromAccountId: boc.id, toAccountId: hnb.id, amount: 500 }),
      transfer({ restaurantId: restaurant.id, fromAccountId: hnb.id, toAccountId: boc.id, amount: 700 }),
    ])
    const deadlocked = results.some(
      (r) => r.status === 'rejected' && /deadlock/i.test(String(r.reason?.message ?? r.reason)),
    )
    check('opposite transfers do not deadlock', !deadlocked)
    check('and the pair still holds what it held',
      (await balanceOfCode(boc.code))! + (await balanceOfCode(hnb.code))! === pairBefore)
  }

  console.log('\n── 9. Who may use an account (bank.md §2) ──')
  {
    const nila = await prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `nila-${stamp}@test.local`, name: 'Nila',
        passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
      },
    })
    const confined = { ...nila, restaurantId: restaurant.id } as unknown as TenantUser

    check('unassigned staff cannot even see it',
      whyCannotUseAccount({ user: confined, access: null, need: 'view' }) === 'NOT_ASSIGNED')
    check('…and cannot transfer from it',
      whyCannotUseAccount({ user: confined, access: null, need: 'transfer' }) === 'NOT_ASSIGNED')

    await setAccountStaff({
      restaurantId: restaurant.id, accountId: boc.id,
      staff: [{ userId: nila.id, canTransfer: false }],
    })
    const visible = await visibleAccountsFor(confined)
    check('assigned, she sees that account and only that one',
      visible.length === 1 && visible[0].code === boc.code, JSON.stringify(visible.map((v) => v.code)))
    check('but seeing it is not permission to move it',
      whyCannotUseAccount({ user: confined, access: { canTransfer: false }, need: 'transfer' })
        === 'NOT_A_TRANSFER_USER')
    check('…while she may still read it',
      whyCannotUseAccount({ user: confined, access: { canTransfer: false }, need: 'view' }) === null)

    await setAccountStaff({
      restaurantId: restaurant.id, accountId: boc.id,
      staff: [{ userId: nila.id, canTransfer: true }],
    })
    check('allowed explicitly, she may transfer',
      whyCannotUseAccount({ user: confined, access: { canTransfer: true }, need: 'transfer' }) === null)

    const owner = { id: 'owner', role: 'OWNER', restaurantId: restaurant.id } as unknown as TenantUser
    check('the owner is never on a list and never refused',
      whyCannotUseAccount({ user: owner, access: null, need: 'transfer' }) === null)

    const outsider = await prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `kam-${stamp}@test.local`, name: 'Kamal',
        passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
      },
    })
    check('somebody on no account sees none',
      (await visibleAccountsFor({ ...outsider, restaurantId: restaurant.id } as unknown as TenantUser)).length === 0)
  }

  console.log('\n── 10. Retiring, and renaming ──')
  {
    await refuses('an account still holding money cannot be retired',
      () => setAccountActive({ restaurantId: restaurant.id, accountId: boc.id, isActive: false }),
      /still holds money/i)

    const empty = await createAccount({ restaurantId: restaurant.id, input: { name: `Spare ${stamp}` } })
    await setAccountActive({ restaurantId: restaurant.id, accountId: empty.id, isActive: false })
    check('an empty one retires cleanly',
      (await prisma.paymentAccount.findUniqueOrThrow({ where: { id: empty.id } })).isActive === false)
    await refuses('and takes no new money once retired',
      () => deposit({ restaurantId: restaurant.id, accountId: empty.id, amount: 100 }),
      /retired/i)

    const before = await balanceOfCode(boc.code)
    await prisma.paymentAccount.update({
      where: { id: boc.id }, data: { name: 'Bank of Ceylon — current' },
    })
    check('renaming changes the label, not the balance', (await balanceOfCode(boc.code)) === before)
    check('…and never the code every payment is stamped with',
      (await prisma.paymentAccount.findUniqueOrThrow({ where: { id: boc.id } })).code === boc.code)
  }

  /* ── Clean up ────────────────────────────────────────────────────────────── */
  await prisma.paymentAccountStaff.deleteMany({ where: { account: { restaurantId: restaurant.id } } })
  await prisma.paymentAccountEntry.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.refund.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.payment.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.paymentAccount.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exitCode = failed > 0 ? 1 : 0
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
