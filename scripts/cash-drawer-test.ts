/**
 * The till has to be countable.
 *
 * ── What this is guarding ───────────────────────────────────────────────────
 *
 * A drawer session's only job is to make one question answerable: at the end of
 * the shift, is the money in the drawer the money that should be there, and if
 * not, whose shift was it. Everything below is a way that question stops having
 * an answer.
 *
 *   two people accountable for one till, or one person for two
 *   cash from Kandy landing in Colombo's drawer
 *   a refund that leaves the till and is recorded nowhere
 *   a shortfall nobody had to explain on the night
 *   petty cash and float counted as one pile
 *   a cashier reading another branch's takings
 *
 * ── Written against the code that was here ──────────────────────────────────
 *
 * Several sections fail on the previous implementation, deliberately:
 *
 *   §2  uniqueness was `(restaurant, cashier)` in application code, so two
 *       cashiers could hold the same till and a read-then-write race let two
 *       concurrent opens both through
 *   §3  the drawer lookup at payment time had no branch predicate
 *   §5  `closeDrawerSchema.note` was `.optional()` and nothing checked variance
 *   §6  there was no petty cash at all
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/cash-drawer-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder } from '../src/features/orders/service'
import { capturePayment, refundPayment } from '../src/features/payments/service'
import {
  closeDrawer,
  computeDrawerTotals,
  getUnattributedCash,
  getUnrecordedRefunds,
  forceCloseDrawer,
  listOpenDrawers,
  openDrawer,
  recordCashMovement,
  reviewDrawer,
  listDrawerSessions,
  type DrawerActor,
} from '../src/features/cashdrawer/service'
import { ensureRegister, createRegister } from '../src/features/cashdrawer/registers'
import { MOVEMENT_TYPES, directionOf } from '../src/features/cashdrawer/movement-types'
import {
  createRequest,
  decideRequest,
  payRequest,
  getFundBalance,
  listRequests,
  type PettyActor,
} from '../src/features/pettycash/service'
import {
  acceptHandover,
  listHandoverCandidates,
  requestHandover,
} from '../src/features/handover/cash-service'
import { getCashDrawerReport, getPettyCashReport } from '../src/features/reports/cash'
import { resolveRange } from '../src/features/reports/range'
import { isTillOperator } from '../src/features/cashdrawer/gate'
import { PERMISSIONS, ROLE_PERMISSIONS, canAny } from '../src/lib/rbac'

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
      name: `Till ${stamp}`,
      slug: `till-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      currency: 'LKR',
      timezone: 'Asia/Colombo',
      taxRateBps: 0,
      serviceChargeBps: 0,
    },
  })

  const colombo = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Colombo', code: 'CMB', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' },
  })

  const ann = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `ann-${stamp}@test.local`,
      name: 'Ann',
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: colombo.id,
    },
  })
  const bob = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `bob-${stamp}@test.local`,
      name: 'Bob',
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: colombo.id,
    },
  })
  const kumar = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `kumar-${stamp}@test.local`,
      name: 'Kumar',
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: kandy.id,
    },
  })
  const boss = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `boss-${stamp}@test.local`,
      name: 'Boss',
      passwordHash: 'x',
      role: 'OWNER',
    },
  })

  const actorFor = (
    u: { id: string; role: string; branchId?: string | null },
    manage = false,
  ): DrawerActor => ({
    id: u.id,
    role: u.role as DrawerActor['role'],
    branchId: u.branchId ?? null,
    canManageOthers: manage,
  })
  const pettyActorFor = (
    u: { id: string; role: string; branchId?: string | null },
    approve = false,
  ): PettyActor => ({
    id: u.id,
    role: u.role as PettyActor['role'],
    branchId: u.branchId ?? null,
    canApprove: approve,
  })

  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Rice & curry',
      slug: `rc-${stamp}`,
      price: 1_000_00,
      isAvailable: true,
    },
  })
  await prisma.foodBranch.createMany({
    data: [colombo, kandy].map((b) => ({
      restaurantId: restaurant.id,
      branchId: b.id,
      foodId: dish.id,
      isAvailable: true,
    })),
  })

  const sell = async (branchId: string, quantity = 1) =>
    placeOrder({
      restaurantId: restaurant.id,
      branchId,
      type: 'COUNTER',
      channel: 'COUNTER',
      customerName: 'Walk-in',
      customerPhone: '0770000000',
      items: [{ foodId: dish.id, quantity, optionIds: [] }],
    })

  // ── 1. tills exist and belong to a branch ─────────────────────────────────
  console.log('\n── 1. one branch, one counter, unless somebody says otherwise ──')

  const colomboTill = await ensureRegister({ restaurantId: restaurant.id, branchId: colombo.id })
  const kandyTill = await ensureRegister({ restaurantId: restaurant.id, branchId: kandy.id })

  check('a branch gets a till without anybody setting one up', Boolean(colomboTill.id))
  check('and asking twice returns the same one, not a second',
    (await ensureRegister({ restaurantId: restaurant.id, branchId: colombo.id })).id === colomboTill.id)
  check('tills belong to their branch', colomboTill.branchId === colombo.id && kandyTill.branchId === kandy.id)

  const colomboTill2 = await createRegister({
    restaurantId: restaurant.id,
    branchId: colombo.id,
    name: 'Counter 2',
  })
  check('a second till can be added', colomboTill2.branchId === colombo.id)

  await refuses(
    'a till id from another branch is refused',
    () =>
      openDrawer({
        restaurantId: restaurant.id,
        userId: kumar.id,
        branchId: kandy.id,
        registerId: colomboTill.id,
        openingFloat: 1_000_00,
      }),
    /till/i,
  )

  // ── 2. one open session per till, and per cashier ─────────────────────────
  console.log('\n── 2. who is accountable, and for which drawer ──')

  const annSession = await openDrawer({
    restaurantId: restaurant.id,
    userId: ann.id,
    branchId: colombo.id,
    registerId: colomboTill.id,
    openingFloat: 10_000_00,
    openingPettyCash: 5_000_00,
  })

  check('a session gets a readable number', /^CD-\d{4}-\d{6}$/.test(annSession.sessionNumber),
    annSession.sessionNumber)
  check(
    'opening cash and opening petty cash are stored separately',
    annSession.openingFloat === 10_000_00 && annSession.openingPettyCash === 5_000_00,
  )

  await refuses(
    'the same cashier cannot open a second drawer',
    () =>
      openDrawer({
        restaurantId: restaurant.id,
        userId: ann.id,
        branchId: colombo.id,
        registerId: colomboTill2.id,
        openingFloat: 1_000_00,
      }),
    /already have an open drawer/i,
  )

  await refuses(
    'and nobody else can open the till she is on',
    () =>
      openDrawer({
        restaurantId: restaurant.id,
        userId: bob.id,
        branchId: colombo.id,
        registerId: colomboTill.id,
        openingFloat: 1_000_00,
      }),
    /already has this till open|already open/i,
  )

  /*
   * The race. Two opens on the same till, launched together, with no await
   * between the check and the write. Application-level "is one already open?"
   * loses this every time; a unique index does not.
   */
  const raced = await Promise.allSettled([
    openDrawer({
      restaurantId: restaurant.id,
      userId: bob.id,
      branchId: colombo.id,
      registerId: colomboTill2.id,
      openingFloat: 5_000_00,
    }),
    openDrawer({
      restaurantId: restaurant.id,
      userId: kumar.id,
      branchId: colombo.id,
      registerId: colomboTill2.id,
      openingFloat: 5_000_00,
    }),
  ])
  const won = raced.filter((r) => r.status === 'fulfilled').length
  check('two simultaneous opens on one till: exactly one wins', won === 1, `${won} won`)

  // Whichever lost, make Bob the holder of till 2 for the rest of the run.
  const openOnTill2 = await prisma.cashDrawerSession.findFirst({
    where: { registerId: colomboTill2.id, status: 'OPEN' },
  })
  if (openOnTill2 && openOnTill2.openedById !== bob.id) {
    // Closed against its own expected figure, so the tidy-up does not itself
    // become a variance the close rules would refuse.
    await closeDrawer({
      restaurantId: restaurant.id,
      sessionId: openOnTill2.id,
      countedCash: (await computeDrawerTotals(openOnTill2.id)).expectedCash,
      userId: openOnTill2.openedById,
      actor: actorFor(boss, true),
    })
  }
  const bobSession =
    openOnTill2?.openedById === bob.id
      ? openOnTill2
      : await openDrawer({
          restaurantId: restaurant.id,
          userId: bob.id,
          branchId: colombo.id,
          registerId: colomboTill2.id,
          openingFloat: 5_000_00,
        })

  const kumarSession = await openDrawer({
    restaurantId: restaurant.id,
    userId: kumar.id,
    branchId: kandy.id,
    registerId: kandyTill.id,
    openingFloat: 2_000_00,
  })

  // ── 3. money lands in the right drawer ────────────────────────────────────
  console.log('\n── 3. cash sales, card sales, and the branch they belong to ──')

  const cash1 = await sell(colombo.id, 2) // 2,000.00
  await capturePayment({
    restaurantId: restaurant.id,
    orderId: cash1.id,
    method: 'CASH',
    amount: cash1.grandTotal,
    receivedById: ann.id,
  })

  const card1 = await sell(colombo.id, 3) // 3,000.00
  await capturePayment({
    restaurantId: restaurant.id,
    orderId: card1.id,
    method: 'CARD',
    amount: card1.grandTotal,
    receivedById: ann.id,
  })

  let totals = await computeDrawerTotals(annSession.id)
  check('a cash sale raises expected cash', totals.cashSales === cash1.grandTotal,
    `${totals.cashSales}`)
  check(
    'expected cash is float + cash sales',
    totals.expectedCash === 10_000_00 + cash1.grandTotal,
    `${totals.expectedCash}`,
  )
  check('a card sale does not', totals.cardSales === card1.grandTotal && totals.expectedCash === 10_000_00 + cash1.grandTotal)
  check('but it still shows in the summary', totals.cardSales > 0)

  /*
   * The branch bug. Ann holds a Colombo till. She settles a Kandy bill. That
   * cash must NOT land in her drawer — it is not at her counter, and booking it
   * there makes both branches' reconciliations wrong at once.
   */
  const kandyBill = await sell(kandy.id, 1)
  await capturePayment({
    restaurantId: restaurant.id,
    orderId: kandyBill.id,
    method: 'CASH',
    amount: kandyBill.grandTotal,
    receivedById: ann.id,
  })
  const afterCrossBranch = await computeDrawerTotals(annSession.id)
  check(
    "a Kandy bill settled by a Colombo cashier never enters Colombo's drawer",
    afterCrossBranch.cashSales === cash1.grandTotal,
    `${afterCrossBranch.cashSales} vs ${cash1.grandTotal}`,
  )
  const kandyTotals = await computeDrawerTotals(kumarSession.id)
  check(
    'and it is not silently added to the Kandy drawer either',
    kandyTotals.cashSales === 0,
    'the payment belongs to nobody, which is visible rather than wrong',
  )

  const stray = await getUnattributedCash({
    restaurantId: restaurant.id,
    branchIds: [kandy.id],
    from: new Date(Date.now() - 60 * 60 * 1000),
    to: new Date(Date.now() + 60 * 1000),
  })
  check(
    'unattributed cash is reported rather than lost',
    stray.amount === kandyBill.grandTotal,
    `${stray.amount}`,
  )

  // ── 4. movements, their direction, and their reason ───────────────────────
  console.log('\n── 4. every note in or out leaves a row ──')

  check(
    'every movement type has a direction and a label',
    Object.values(MOVEMENT_TYPES).every((m) => (m.direction === 1 || m.direction === -1) && m.label.length > 0),
  )
  check('a bank deposit takes money out', directionOf('BANK_DEPOSIT') === -1)
  check('additional float puts money in', directionOf('ADDITIONAL_CASH') === 1)

  await recordCashMovement({
    restaurantId: restaurant.id,
    sessionId: annSession.id,
    type: 'ADDITIONAL_CASH',
    amount: 2_000_00,
    reason: 'More change brought up',
    userId: ann.id,
    actor: actorFor(ann),
  })
  await recordCashMovement({
    restaurantId: restaurant.id,
    sessionId: annSession.id,
    type: 'CASH_DROP',
    amount: 1_000_00,
    reason: 'To the safe',
    reference: 'DROP-1',
    userId: ann.id,
    actor: actorFor(ann),
  })

  totals = await computeDrawerTotals(annSession.id)
  check(
    'a drop reduces expected cash and a top-up raises it',
    totals.expectedCash === 10_000_00 + cash1.grandTotal + 2_000_00 - 1_000_00,
    `${totals.expectedCash}`,
  )
  check('and each type is reported on its own', totals.byType.CASH_DROP === 1_000_00)

  await refuses(
    'a movement with no reason is refused',
    () =>
      recordCashMovement({
        restaurantId: restaurant.id,
        sessionId: annSession.id,
        type: 'CASH_OUT',
        amount: 100_00,
        reason: '   ',
        userId: ann.id,
        actor: actorFor(ann),
      }),
    /reason/i,
  )
  await refuses(
    'a system-only type cannot be posted by hand',
    () =>
      recordCashMovement({
        restaurantId: restaurant.id,
        sessionId: annSession.id,
        type: 'CASH_REFUND',
        amount: 100_00,
        reason: 'trying it on',
        userId: ann.id,
        actor: actorFor(ann),
      }),
    /recorded by the system/i,
  )
  await refuses(
    "a cashier cannot touch another branch's drawer",
    () =>
      recordCashMovement({
        restaurantId: restaurant.id,
        sessionId: kumarSession.id,
        type: 'CASH_OUT',
        amount: 100_00,
        reason: 'not mine',
        userId: ann.id,
        actor: actorFor(ann),
      }),
    /another location/i,
  )
  await refuses(
    "nor another cashier's at her own branch",
    () =>
      recordCashMovement({
        restaurantId: restaurant.id,
        sessionId: bobSession.id,
        type: 'CASH_OUT',
        amount: 100_00,
        reason: 'not mine',
        userId: ann.id,
        actor: actorFor(ann),
      }),
    /opened by someone else/i,
  )

  // ── 5. refunds ────────────────────────────────────────────────────────────
  console.log('\n── 5. money handed back ──')

  const refundable = await sell(colombo.id, 1)
  const paid = await capturePayment({
    restaurantId: restaurant.id,
    orderId: refundable.id,
    method: 'CASH',
    amount: refundable.grandTotal,
    receivedById: ann.id,
  })
  const beforeRefund = await computeDrawerTotals(annSession.id)

  await refundPayment({
    restaurantId: restaurant.id,
    paymentId: paid.payment.id,
    reason: 'Wrong dish',
    actorId: ann.id,
  })

  const afterRefund = await computeDrawerTotals(annSession.id)
  check(
    'a refund reduces expected cash',
    afterRefund.expectedCash === beforeRefund.expectedCash - refundable.grandTotal,
    `${afterRefund.expectedCash} vs ${beforeRefund.expectedCash}`,
  )
  check(
    'the original sale is not netted off — both movements are visible',
    afterRefund.cashSales === beforeRefund.cashSales,
  )
  check('and it is recorded as a refund, not a generic cash-out',
    (afterRefund.byType.CASH_REFUND ?? 0) === refundable.grandTotal)

  /*
   * A refund given when NO drawer is open anywhere at the branch still goes
   * ahead — a refund must never be blocked by bookkeeping — but it must not
   * vanish either. Kandy has no open till at this point, so this is the case.
   */
  const kandySale = await sell(kandy.id, 1)
  const kandyPaid = await capturePayment({
    restaurantId: restaurant.id,
    orderId: kandySale.id,
    method: 'CASH',
    amount: kandySale.grandTotal,
    receivedById: kumar.id,
  })
  const kandyDrawerBefore = await computeDrawerTotals(kumarSession.id)
  await prisma.cashDrawerSession.update({
    where: { id: kumarSession.id },
    data: { status: 'CLOSED', activeRegisterKey: null, activeCashierKey: null },
  })
  await refundPayment({
    restaurantId: restaurant.id,
    paymentId: kandyPaid.payment.id,
    reason: 'Refunded after close',
    actorId: boss.id,
  })
  await prisma.cashDrawerSession.update({
    where: { id: kumarSession.id },
    data: { status: 'OPEN', activeRegisterKey: kandyTill.id, activeCashierKey: kumar.id },
  })

  const orphanRefunds = await getUnrecordedRefunds({
    restaurantId: restaurant.id,
    branchIds: [kandy.id],
    from: new Date(Date.now() - 60 * 60 * 1000),
    to: new Date(Date.now() + 60 * 1000),
  })
  check(
    'a refund given with no drawer open is surfaced, not silently dropped',
    orphanRefunds.amount === kandySale.grandTotal && orphanRefunds.count === 1,
    `${orphanRefunds.amount} across ${orphanRefunds.count}`,
  )
  check(
    'and it did not quietly land on some other session',
    (await computeDrawerTotals(kumarSession.id)).expectedCash ===
      kandyDrawerBefore.expectedCash,
  )

  // ── 6. petty cash ─────────────────────────────────────────────────────────
  console.log('\n── 6. two tins, and only one of them is the drawer ──')

  const fund0 = await getFundBalance(restaurant.id, annSession.id)
  check('the tin starts at what was counted into it', fund0.balance === 5_000_00)

  const fromTin = await createRequest({
    restaurantId: restaurant.id,
    branchId: colombo.id,
    category: 'Cleaning',
    description: 'Mop and bucket',
    amount: 800_00,
    paidFrom: 'PETTY_FUND',
    userId: ann.id,
  })
  check('a request starts as pending, not approved', fromTin.status === 'PENDING')

  const drawerBeforePetty = await computeDrawerTotals(annSession.id)

  await refuses(
    'an unapproved request cannot be paid',
    () =>
      payRequest({
        restaurantId: restaurant.id,
        requestId: fromTin.id,
        sessionId: annSession.id,
        userId: boss.id,
        actor: pettyActorFor(boss, true),
      }),
    /approved/i,
  )
  const stillFull = await getFundBalance(restaurant.id, annSession.id)
  check('and nothing has left the tin', stillFull.balance === 5_000_00)

  await decideRequest({
    restaurantId: restaurant.id,
    requestId: fromTin.id,
    approve: true,
    userId: boss.id,
    actor: pettyActorFor(boss, true),
  })
  const approvedNotPaid = await getFundBalance(restaurant.id, annSession.id)
  check(
    'approving alone still does not move money',
    approvedNotPaid.balance === 5_000_00 && approvedNotPaid.committed >= 800_00,
  )

  await payRequest({
    restaurantId: restaurant.id,
    requestId: fromTin.id,
    sessionId: annSession.id,
    userId: boss.id,
    actor: pettyActorFor(boss, true),
  })
  const afterTinSpend = await getFundBalance(restaurant.id, annSession.id)
  const drawerAfterTinSpend = await computeDrawerTotals(annSession.id)

  check('paying reduces the tin', afterTinSpend.balance === 5_000_00 - 800_00, `${afterTinSpend.balance}`)
  check(
    'and leaves the drawer completely alone',
    drawerAfterTinSpend.expectedCash === drawerBeforePetty.expectedCash,
    `${drawerAfterTinSpend.expectedCash} vs ${drawerBeforePetty.expectedCash}`,
  )

  const fromDrawer = await createRequest({
    restaurantId: restaurant.id,
    branchId: colombo.id,
    category: 'Transport',
    description: 'Three-wheeler to the market',
    amount: 400_00,
    paidFrom: 'DRAWER',
    userId: ann.id,
  })
  await decideRequest({
    restaurantId: restaurant.id,
    requestId: fromDrawer.id,
    approve: true,
    userId: boss.id,
    actor: pettyActorFor(boss, true),
  })
  await payRequest({
    restaurantId: restaurant.id,
    requestId: fromDrawer.id,
    sessionId: annSession.id,
    userId: boss.id,
    actor: pettyActorFor(boss, true),
  })

  const afterDrawerSpend = await computeDrawerTotals(annSession.id)
  const tinUnchanged = await getFundBalance(restaurant.id, annSession.id)
  check(
    'a drawer-paid expense comes off the drawer',
    afterDrawerSpend.expectedCash === drawerAfterTinSpend.expectedCash - 400_00,
    `${afterDrawerSpend.expectedCash}`,
  )
  check(
    'and does not come off the tin as well',
    tinUnchanged.balance === afterTinSpend.balance,
    'charging both tins would double-count the same rupees',
  )

  await refuses(
    'the tin cannot be overspent',
    async () => {
      const big = await createRequest({
        restaurantId: restaurant.id,
        branchId: colombo.id,
        category: 'Other',
        description: 'Something far too expensive',
        amount: 99_000_00,
        paidFrom: 'PETTY_FUND',
        userId: ann.id,
      })
      await decideRequest({
        restaurantId: restaurant.id,
        requestId: big.id,
        approve: true,
        userId: boss.id,
        actor: pettyActorFor(boss, true),
      })
      return payRequest({
        restaurantId: restaurant.id,
        requestId: big.id,
        sessionId: annSession.id,
        userId: boss.id,
        actor: pettyActorFor(boss, true),
      })
    },
    /only has|top it up/i,
  )

  /*
   * Two clicks on "Pay out". Without the status in the UPDATE's WHERE, both
   * read APPROVED, both write a movement, and the same expense leaves the till
   * twice — the most expensive kind of double-submit there is.
   */
  const doubleClick = await createRequest({
    restaurantId: restaurant.id,
    branchId: colombo.id,
    category: 'Other',
    description: 'Paid for twice, if we are not careful',
    amount: 100_00,
    paidFrom: 'DRAWER',
    userId: ann.id,
  })
  await decideRequest({
    restaurantId: restaurant.id,
    requestId: doubleClick.id,
    approve: true,
    userId: boss.id,
    actor: pettyActorFor(boss, true),
  })
  const payTwice = await Promise.allSettled([
    payRequest({
      restaurantId: restaurant.id,
      requestId: doubleClick.id,
      sessionId: annSession.id,
      userId: boss.id,
      actor: pettyActorFor(boss, true),
    }),
    payRequest({
      restaurantId: restaurant.id,
      requestId: doubleClick.id,
      sessionId: annSession.id,
      userId: boss.id,
      actor: pettyActorFor(boss, true),
    }),
  ])
  check(
    'paying the same request twice at once succeeds exactly once',
    payTwice.filter((r) => r.status === 'fulfilled').length === 1,
    `${payTwice.filter((r) => r.status === 'fulfilled').length} succeeded`,
  )
  const movementsFor = await prisma.cashMovement.count({
    where: { pettyCashRequestId: doubleClick.id },
  })
  check('and leaves exactly one movement behind', movementsFor === 1, `${movementsFor}`)

  /*
   * And two different expenses that each fit the tin but together do not. The
   * balance check has to be inside the transaction or both see enough money.
   */
  const tinNow = (await getFundBalance(restaurant.id, annSession.id)).balance
  const half = Math.floor(tinNow * 0.6)
  const [a, b] = await Promise.all([
    createRequest({
      restaurantId: restaurant.id,
      branchId: colombo.id,
      category: 'Other',
      description: 'Overdraw A',
      amount: half,
      paidFrom: 'PETTY_FUND',
      userId: ann.id,
    }),
    createRequest({
      restaurantId: restaurant.id,
      branchId: colombo.id,
      category: 'Other',
      description: 'Overdraw B',
      amount: half,
      paidFrom: 'PETTY_FUND',
      userId: ann.id,
    }),
  ])
  for (const r of [a, b]) {
    await decideRequest({
      restaurantId: restaurant.id,
      requestId: r.id,
      approve: true,
      userId: boss.id,
      actor: pettyActorFor(boss, true),
    })
  }
  const overdraw = await Promise.allSettled(
    [a, b].map((r) =>
      payRequest({
        restaurantId: restaurant.id,
        requestId: r.id,
        sessionId: annSession.id,
        userId: boss.id,
        actor: pettyActorFor(boss, true),
      }),
    ),
  )
  const bothPaid = overdraw.filter((r) => r.status === 'fulfilled').length
  const tinAfter = (await getFundBalance(restaurant.id, annSession.id)).balance
  check(
    'two concurrent payments cannot together overdraw the tin',
    tinAfter >= 0,
    `${bothPaid} paid, tin left at ${tinAfter}`,
  )

  // Approver ≠ requester, above the threshold (default 2,000.00).
  const selfRaised = await createRequest({
    restaurantId: restaurant.id,
    branchId: colombo.id,
    category: 'Repairs',
    description: 'Fridge door seal',
    amount: 3_000_00,
    paidFrom: 'DRAWER',
    userId: boss.id,
  })
  await refuses(
    'a large request cannot be approved by the person who raised it',
    () =>
      decideRequest({
        restaurantId: restaurant.id,
        requestId: selfRaised.id,
        approve: true,
        userId: boss.id,
        actor: pettyActorFor(boss, true),
      }),
    /somebody else/i,
  )

  const smallSelfRaised = await createRequest({
    restaurantId: restaurant.id,
    branchId: colombo.id,
    category: 'Printing',
    description: 'Bill roll',
    amount: 200_00,
    paidFrom: 'DRAWER',
    userId: boss.id,
  })
  const decidedSmall = await decideRequest({
    restaurantId: restaurant.id,
    requestId: smallSelfRaised.id,
    approve: true,
    userId: boss.id,
    actor: pettyActorFor(boss, true),
  })
  check(
    'but a small one may be, so the control stays proportionate',
    decidedSmall.status === 'APPROVED',
  )

  await refuses(
    "a Kandy cashier cannot approve Colombo's petty cash",
    () =>
      decideRequest({
        restaurantId: restaurant.id,
        requestId: smallSelfRaised.id,
        approve: false,
        userId: kumar.id,
        actor: pettyActorFor(kumar, true),
      }),
    /another location/i,
  )

  // ── 7. closing ────────────────────────────────────────────────────────────
  console.log('\n── 7. counting up, and explaining the gap ──')

  const kandyExpected = (await computeDrawerTotals(kumarSession.id)).expectedCash

  await refuses(
    'closing short with no reason is refused',
    () =>
      closeDrawer({
        restaurantId: restaurant.id,
        sessionId: kumarSession.id,
        countedCash: kandyExpected - 300_00,
        userId: kumar.id,
        actor: actorFor(kumar),
      }),
    /why the drawer does not balance/i,
  )

  const smallShort = await closeDrawer({
    restaurantId: restaurant.id,
    sessionId: kumarSession.id,
    countedCash: kandyExpected - 300_00,
    varianceReason: 'Gave the wrong change on a 5000 note',
    userId: kumar.id,
    actor: actorFor(kumar),
  })
  check('variance is counted minus expected', smallShort.variance === -300_00, `${smallShort.variance}`)
  check(
    'a small gap closes outright',
    smallShort.session.status === 'CLOSED' && smallShort.needsReview === false,
  )
  check('the reason is kept on the row', smallShort.session.varianceReason !== null)

  // Bob's till, short by more than the 500.00 default threshold.
  const bobExpected = (await computeDrawerTotals(bobSession.id)).expectedCash
  const bigShort = await closeDrawer({
    restaurantId: restaurant.id,
    sessionId: bobSession.id,
    countedCash: bobExpected - 900_00,
    varianceReason: 'No idea, counted it three times',
    userId: bob.id,
    actor: actorFor(bob),
  })
  check(
    'a large gap stops for review instead of closing',
    bigShort.needsReview && bigShort.session.status === 'PENDING_REVIEW',
    bigShort.session.status,
  )

  await refuses(
    'a drawer waiting for review takes no more money',
    () =>
      recordCashMovement({
        restaurantId: restaurant.id,
        sessionId: bobSession.id,
        type: 'CASH_IN',
        amount: 100_00,
        reason: 'topping it back up quietly',
        userId: bob.id,
        actor: actorFor(bob),
      }),
    /waiting for a manager/i,
  )

  await refuses(
    'and the person who counted it cannot sign it off',
    () =>
      reviewDrawer({
        restaurantId: restaurant.id,
        sessionId: bobSession.id,
        userId: bob.id,
        actor: actorFor(bob, true),
      }),
    /somebody else/i,
  )

  await refuses(
    'nor can somebody without the permission',
    () =>
      reviewDrawer({
        restaurantId: restaurant.id,
        sessionId: bobSession.id,
        userId: ann.id,
        actor: actorFor(ann, false),
      }),
    /manager/i,
  )

  const reviewed = await reviewDrawer({
    restaurantId: restaurant.id,
    sessionId: bobSession.id,
    userId: boss.id,
    note: 'Watched the CCTV, it was a miscount',
    actor: actorFor(boss, true),
  })
  check('a manager signs it off', reviewed.status === 'CLOSED' && reviewed.reviewedById === boss.id)
  check(
    'and the count itself is never edited by the review',
    reviewed.countedCash === bobExpected - 900_00 && reviewed.variance === -900_00,
  )

  check(
    'a closed session releases its till and its cashier',
    reviewed.activeRegisterKey === null && reviewed.activeCashierKey === null,
  )
  const reopened = await openDrawer({
    restaurantId: restaurant.id,
    userId: bob.id,
    branchId: colombo.id,
    registerId: colomboTill2.id,
    openingFloat: 5_000_00,
  })
  check('so the next person can open it', reopened.status === 'OPEN')

  // ── 7b. the drawer somebody left open ─────────────────────────────────────
  console.log('\n── 7b. closing a till the cashier walked away from ──')

  /*
   * The situation: Kumar opens Kandy's till and goes home. Nobody can work that
   * counter until it is closed, and the person who could close it is not here.
   */
  const forgotten = await openDrawer({
    restaurantId: restaurant.id,
    userId: kumar.id,
    branchId: kandy.id,
    registerId: kandyTill.id,
    openingFloat: 3_000_00,
  })

  const nextCashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `night-${stamp}@test.local`,
      name: 'Night shift',
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: kandy.id,
    },
  })

  await refuses(
    'the next cashier cannot open that till',
    () =>
      openDrawer({
        restaurantId: restaurant.id,
        userId: nextCashier.id,
        branchId: kandy.id,
        registerId: kandyTill.id,
        openingFloat: 1_000_00,
      }),
    /already has this till open/i,
  )

  const visible = await listOpenDrawers({ restaurantId: restaurant.id, branchIds: [kandy.id] })
  check(
    'a manager can see it is open and whose it is',
    visible.some((row) => row.id === forgotten.id && row.openedById === kumar.id),
    'there was no screen anywhere showing somebody else’s open drawer',
  )

  await refuses(
    'a cashier cannot close somebody else’s drawer',
    () =>
      forceCloseDrawer({
        restaurantId: restaurant.id,
        sessionId: forgotten.id,
        countedCash: null,
        reason: 'trying it on',
        userId: ann.id,
        actor: actorFor(ann, false),
      }),
    /manager/i,
  )
  await refuses(
    'and a reason is required even from a manager',
    () =>
      forceCloseDrawer({
        restaurantId: restaurant.id,
        sessionId: forgotten.id,
        countedCash: null,
        reason: ' ',
        userId: boss.id,
        actor: actorFor(boss, true),
      }),
    /why you are closing/i,
  )

  const uncounted = await forceCloseDrawer({
    restaurantId: restaurant.id,
    sessionId: forgotten.id,
    countedCash: null,
    reason: 'Kumar went home without closing',
    userId: boss.id,
    actor: actorFor(boss, true),
  })

  check(
    'closing without a count records the variance as unknown, not zero',
    uncounted.variance === null && uncounted.session.variance === null,
    `${uncounted.session.variance}`,
  )
  check(
    'and does not park the till in review, which would block it again',
    uncounted.session.status === 'CLOSED',
    uncounted.session.status,
  )
  check('it is marked as closed by somebody else', uncounted.session.closedOnBehalf)
  check(
    'the shift still belongs to the cashier who opened it',
    uncounted.session.openedById === kumar.id && uncounted.session.closedById === boss.id,
  )
  check('and the owner’s explanation is on the record', uncounted.session.varianceReason !== null)

  const nightSession = await openDrawer({
    restaurantId: restaurant.id,
    userId: nextCashier.id,
    branchId: kandy.id,
    registerId: kandyTill.id,
    openingFloat: 1_000_00,
  })
  check('so the next cashier can start their shift', nightSession.status === 'OPEN')

  /*
   * And the other half of the decision: when the owner IS standing at the till,
   * the count is real and the variance lands on the person whose shift it was.
   */
  const nightExpected = (await computeDrawerTotals(nightSession.id)).expectedCash
  const countedClose = await forceCloseDrawer({
    restaurantId: restaurant.id,
    sessionId: nightSession.id,
    countedCash: nightExpected - 200_00,
    reason: 'Counted it myself at close',
    userId: boss.id,
    actor: actorFor(boss, true),
  })
  check(
    'a counted force-close records a real variance',
    countedClose.variance === -200_00,
    `${countedClose.variance}`,
  )
  check(
    'against the cashier who opened it',
    countedClose.session.openedById === nextCashier.id,
  )

  await refuses(
    'a closed drawer cannot be force-closed again',
    () =>
      forceCloseDrawer({
        restaurantId: restaurant.id,
        sessionId: nightSession.id,
        countedCash: null,
        reason: 'again',
        userId: boss.id,
        actor: actorFor(boss, true),
      }),
    /not open/i,
  )

  // Reopen Kumar's till so the sections below still have their fixture.
  await openDrawer({
    restaurantId: restaurant.id,
    userId: kumar.id,
    branchId: kandy.id,
    registerId: kandyTill.id,
    openingFloat: 2_000_00,
  })

  // ── 8. handover ───────────────────────────────────────────────────────────
  console.log('\n── 8. passing the till on ──')

  const candidates = await listHandoverCandidates({
    restaurantId: restaurant.id,
    branchId: colombo.id,
    excludeUserId: ann.id,
  })
  check('handover candidates exclude yourself', candidates.every((c) => c.id !== ann.id))
  check(
    'and exclude staff from another branch',
    !candidates.some((c) => c.id === kumar.id),
    'Kumar works at Kandy',
  )
  check('while including the owner, who can work anywhere', candidates.some((c) => c.id === boss.id))

  /*
   * The dropdown filters by role; so must the action. Otherwise a posted id
   * could open a session in the name of somebody who cannot reach the screen to
   * close it, and the till would be held by a person with no way to release it.
   */
  const porter = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `porter-${stamp}@test.local`,
      name: 'Porter',
      passwordHash: 'x',
      role: 'KITCHEN',
      branchId: colombo.id,
    },
  })
  check('a kitchen porter is not offered as a candidate', !candidates.some((c) => c.id === porter.id))
  await refuses(
    'and cannot be handed the till by posting their id',
    async () =>
      requestHandover({
        restaurantId: restaurant.id,
        sessionId: annSession.id,
        toUserId: porter.id,
        countedAmount: (await computeDrawerTotals(annSession.id)).expectedCash,
        userId: ann.id,
        actor: actorFor(ann),
      }),
    /does not work a till/i,
  )

  const annExpected = (await computeDrawerTotals(annSession.id)).expectedCash

  await refuses(
    'a till cannot be handed to somebody at another branch',
    () =>
      requestHandover({
        restaurantId: restaurant.id,
        sessionId: annSession.id,
        toUserId: kumar.id,
        countedAmount: annExpected,
        userId: ann.id,
        actor: actorFor(ann),
      }),
    /does not work at this location/i,
  )

  await refuses(
    'handing over a drawer that does not balance still needs a reason',
    () =>
      requestHandover({
        restaurantId: restaurant.id,
        sessionId: annSession.id,
        toUserId: boss.id,
        countedAmount: annExpected - 100_00,
        userId: ann.id,
        actor: actorFor(ann),
      }),
    /does not balance/i,
  )

  const handover = await requestHandover({
    restaurantId: restaurant.id,
    sessionId: annSession.id,
    toUserId: boss.id,
    countedAmount: annExpected,
    note: 'Table 6 still owes for two drinks',
    userId: ann.id,
    actor: actorFor(ann),
  })
  check('the handover records both figures', handover.expectedAmount === annExpected && handover.countedAmount === annExpected)

  const annAfter = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: annSession.id } })
  check(
    'the outgoing session is closed, not shared',
    annAfter.status === 'CLOSED' && annAfter.closedById === ann.id,
    annAfter.status,
  )
  check('so nobody is accountable for a session they did not run', annAfter.activeCashierKey === null)

  /*
   * Accepted twice at once. Without the status in the UPDATE's WHERE, both
   * transactions open a session and one of them ends up orphaned — a cashier
   * accountable for a till somebody else is standing at.
   */
  const acceptedTwice = await Promise.allSettled([
    acceptHandover({
      restaurantId: restaurant.id,
      handoverId: handover.id,
      userId: boss.id,
      actor: actorFor(boss, true),
    }),
    acceptHandover({
      restaurantId: restaurant.id,
      handoverId: handover.id,
      userId: boss.id,
      actor: actorFor(boss, true),
    }),
  ])
  const wins = acceptedTwice.filter((r) => r.status === 'fulfilled')
  check('two simultaneous accepts settle it exactly once', wins.length === 1, `${wins.length} won`)

  const sessionsOnTill = await prisma.cashDrawerSession.count({
    where: { registerId: annSession.registerId, status: 'OPEN' },
  })
  check('and leave one open session on the till, not two', sessionsOnTill === 1, `${sessionsOnTill}`)

  const taken = (wins[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acceptHandover>>>).value
  const newSession = await prisma.cashDrawerSession.findUniqueOrThrow({
    where: { id: taken.sessionId },
  })
  check(
    'the incoming cashier gets a new session opened with what was counted',
    newSession.openingFloat === annExpected && newSession.openedById === boss.id,
  )
  check('on the same till, at the same branch',
    newSession.registerId === annSession.registerId && newSession.branchId === colombo.id)
  check('and the chain links both sessions', taken.handover.toSessionId === newSession.id)

  /*
   * The tin goes with the till. Without this the new session took the schema
   * default of 0 and the notes physically in the tin vanished from the books at
   * every shift change.
   */
  const tinAtHandover = (await getFundBalance(restaurant.id, annSession.id)).balance
  check(
    'the petty cash tin is carried across, not reset to zero',
    newSession.openingPettyCash === tinAtHandover && tinAtHandover > 0,
    `carried ${newSession.openingPettyCash}, tin held ${tinAtHandover}`,
  )

  /*
   * And a handover is a close, so it obeys the same variance threshold. If it
   * did not, "Hand over" would be the documented way round the manager review.
   */
  const bigGap = await computeDrawerTotals(newSession.id)
  const dodged = await requestHandover({
    restaurantId: restaurant.id,
    sessionId: newSession.id,
    toUserId: ann.id,
    countedAmount: bigGap.expectedCash - 900_00,
    varianceReason: 'trying to slip a big shortfall past the review',
    userId: boss.id,
    actor: actorFor(boss, true),
  })
  const dodgedSession = await prisma.cashDrawerSession.findUniqueOrThrow({
    where: { id: newSession.id },
  })
  check(
    'handing over a badly short till still stops for a manager',
    dodgedSession.status === 'PENDING_REVIEW',
    `status ${dodgedSession.status}`,
  )
  check(
    'and the till is still released so the next person is not held up',
    dodgedSession.activeRegisterKey === null,
  )
  check('the handover itself still stands', dodged.status === 'PENDING')

  await refuses(
    'a handover cannot be accepted twice',
    () =>
      acceptHandover({
        restaurantId: restaurant.id,
        handoverId: handover.id,
        userId: boss.id,
        actor: actorFor(boss, true),
      }),
    /already been settled/i,
  )

  // ── 9. the reports ────────────────────────────────────────────────────────
  console.log('\n── 9. what the report says, and the rows it says it from ──')

  const today = resolveRange({ preset: 'TODAY', timeZone: 'Asia/Colombo' })
  const report = await getCashDrawerReport({ restaurantId: restaurant.id, range: today })

  check('every session opened today is in it', report.rows.length >= 5, `${report.rows.length}`)
  check(
    'the header totals equal the sum of the rows shown',
    report.totals.openingCash === report.rows.reduce((s, r) => s + r.openingFloat, 0) &&
      report.totals.cashSales === report.rows.reduce((s, r) => s + r.cashSales, 0),
  )
  /*
   * Derived from the rows, not a hard-coded figure: the property under test is
   * that a short till and an over one are two separate facts. Netting them
   * would let a drawer Rs 500 over hide one Rs 500 short, which is the exact
   * pair of shifts an owner most needs to see.
   */
  const rowShort = report.rows.reduce(
    (s, r) => s + (r.variance !== null && r.variance < 0 ? -r.variance : 0),
    0,
  )
  const rowOver = report.rows.reduce(
    (s, r) => s + (r.variance !== null && r.variance > 0 ? r.variance : 0),
    0,
  )
  check(
    'short and over are reported separately, never netted',
    report.totals.cashShort === rowShort &&
      report.totals.cashOver === rowOver &&
      rowShort > 0,
    `short ${report.totals.cashShort} vs ${rowShort}, over ${report.totals.cashOver} vs ${rowOver}`,
  )
  check(
    'an open session still reports a live expected figure',
    report.rows.filter((r) => r.status === 'OPEN').every((r) => r.expectedCash > 0),
  )
  /*
   * Derived from the ledger rather than hard-coded. A headcount here would go
   * stale every time a case is added above and would be "fixed" by editing the
   * number, which is how a test stops testing anything.
   */
  const paidRequests = await prisma.pettyCashRequest.findMany({
    where: { restaurantId: restaurant.id, status: 'PAID' },
    select: { amount: true, paidFrom: true },
  })
  const paidFromTin = paidRequests
    .filter((r) => r.paidFrom === 'PETTY_FUND')
    .reduce((s, r) => s + r.amount, 0)
  const paidFromDrawer = paidRequests
    .filter((r) => r.paidFrom === 'DRAWER')
    .reduce((s, r) => s + r.amount, 0)

  check(
    'petty cash from both tins is counted as petty cash',
    report.rows.reduce((s, r) => s + r.pettyCashPaid, 0) === paidFromTin + paidFromDrawer,
    `report ${report.rows.reduce((s, r) => s + r.pettyCashPaid, 0)} vs ledger ${paidFromTin + paidFromDrawer}`,
  )
  check(
    'unattributed cash is named on the report',
    report.unattributed.amount === kandyBill.grandTotal,
  )

  const kandyOnly = await getCashDrawerReport({
    restaurantId: restaurant.id,
    range: today,
    branchIds: [kandy.id],
  })
  check(
    'a branch filter narrows it to that branch',
    kandyOnly.rows.length > 0 && kandyOnly.rows.every((r) => r.branchName === 'Kandy'),
  )
  check(
    "and Colombo's sessions are nowhere in it",
    !kandyOnly.rows.some((r) => r.branchName === 'Colombo'),
  )

  const annOnly = await getCashDrawerReport({
    restaurantId: restaurant.id,
    range: today,
    cashierId: ann.id,
  })
  check('a cashier filter narrows it', annOnly.rows.every((r) => r.cashierName === 'Ann'))

  const tillOnly = await getCashDrawerReport({
    restaurantId: restaurant.id,
    range: today,
    registerId: colomboTill2.id,
  })
  check('a till filter narrows it', tillOnly.rows.every((r) => r.registerName === 'Counter 2'))

  const closedOnly = await getCashDrawerReport({
    restaurantId: restaurant.id,
    range: today,
    status: 'CLOSED',
  })
  check('a status filter narrows it', closedOnly.rows.every((r) => r.status === 'CLOSED'))

  const nowhere = await getCashDrawerReport({
    restaurantId: restaurant.id,
    range: today,
    branchIds: [],
  })
  check(
    'an empty allow-list means nothing, not everything',
    nowhere.rows.length === 0,
    'a confined user with no branch must see no drawers',
  )

  const lastMonth = resolveRange({ preset: 'LAST_MONTH', timeZone: 'Asia/Colombo' })
  const nothingThen = await getCashDrawerReport({ restaurantId: restaurant.id, range: lastMonth })
  check('a range that excludes today returns nothing', nothingThen.rows.length === 0)
  check(
    'and the ranges are built in the restaurant’s own timezone',
    today.timeZone === 'Asia/Colombo',
  )

  const petty = await getPettyCashReport({ restaurantId: restaurant.id, range: today })
  check(
    'the petty cash report separates the tin from the drawer',
    petty.totals.spentFromFund === paidFromTin &&
      petty.totals.spentFromDrawer === paidFromDrawer,
    `report ${petty.totals.spentFromFund}/${petty.totals.spentFromDrawer} vs ledger ${paidFromTin}/${paidFromDrawer}`,
  )
  check(
    'and its remaining balance only counts what left the tin',
    petty.totals.remaining ===
      petty.totals.openingBalance + petty.totals.allocated - paidFromTin,
    'a drawer-paid expense must not come off the fund as well',
  )
  check(
    'pending, approved and rejected are all counted',
    petty.totals.approved + petty.totals.paid + petty.totals.pending > 0,
  )

  const pettyKandy = await getPettyCashReport({
    restaurantId: restaurant.id,
    range: today,
    branchIds: [kandy.id],
  })
  check(
    'petty cash stays strictly branch-specific',
    pettyKandy.rows.length === 0,
    'every request above was raised at Colombo',
  )

  // ── 10. who is sent to the session screen ─────────────────────────────────
  console.log('\n── 10. the gate ──')

  const cashierPerms = ROLE_PERMISSIONS.CASHIER
  const ownerPerms = ROLE_PERMISSIONS.OWNER

  check(
    'a cashier is a till operator',
    isTillOperator({ role: 'CASHIER', permissions: [...cashierPerms] }),
  )
  check(
    'an owner is not, so the gate can never lock them out of their own dashboard',
    !isTillOperator({ role: 'OWNER', permissions: [...ownerPerms] }),
  )
  check(
    'somebody with no drawer permission at all is not gated',
    !isTillOperator({ role: 'KITCHEN', permissions: [...ROLE_PERMISSIONS.KITCHEN] }),
  )
  /*
   * A role that reconciles the floor but never works a till still has to reach
   * /dashboard/cash-drawer, because the review queue lives on it. A saved
   * custom role's permission list REPLACES the defaults, so an owner unticking
   * OPERATE while leaving MANAGE ticked is a state that really occurs — the
   * page therefore accepts either permission rather than only the first.
   */
  const manageOnly = { role: 'MANAGER' as const, rolePermissions: [PERMISSIONS.CASH_DRAWER_MANAGE] }
  check(
    'a MANAGE-only role can still open the cash drawer page',
    canAny(manageOnly, [PERMISSIONS.CASH_DRAWER_OPERATE, PERMISSIONS.CASH_DRAWER_MANAGE]),
  )
  check(
    'and is still not sent to the session screen',
    !isTillOperator(manageOnly),
    'they reconcile the floor; they do not run a till',
  )

  check(
    'a custom role granted only OPERATE is gated, whatever it is called',
    isTillOperator({
      role: 'MANAGER',
      permissions: [],
      rolePermissions: [PERMISSIONS.CASH_DRAWER_OPERATE],
    }),
  )
  check(
    'and one granted MANAGE as well is not',
    !isTillOperator({
      role: 'MANAGER',
      permissions: [],
      rolePermissions: [PERMISSIONS.CASH_DRAWER_OPERATE, PERMISSIONS.CASH_DRAWER_MANAGE],
    }),
  )

  // ── 11. history is permanent ──────────────────────────────────────────────
  console.log('\n── 11. a closed drawer does not disappear ──')

  await prisma.branch.update({ where: { id: kandy.id }, data: { isActive: false } })
  const afterDeactivate = await listDrawerSessions({
    restaurantId: restaurant.id,
    branchId: kandy.id,
  })
  check(
    'closed sessions survive their branch being switched off',
    afterDeactivate.length > 0,
    'the money still happened',
  )
  await prisma.branch.update({ where: { id: kandy.id }, data: { isActive: true } })

  const requestsStillThere = await listRequests({ restaurantId: restaurant.id })
  check('and so does the petty cash ledger', requestsStillThere.length >= 4)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
