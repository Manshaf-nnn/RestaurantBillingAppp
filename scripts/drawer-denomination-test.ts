/**
 * The cashier counts notes; the server does the arithmetic; nobody is shown
 * the answer until it is too late to change the count.
 *
 * ── The control this protects ──────────────────────────────────────────────
 *
 * correctionA.md §4: "Before drawer closure, the cashier MUST NOT see the
 * variance amount. Do not expose expected-vs-actual difference to the
 * cashier."
 *
 * The reason is not distrust of cashiers, it is what a count is FOR. A drawer
 * count is evidence, and evidence that can be checked against the answer
 * before it is submitted stops being evidence — not necessarily through
 * theft, but through the entirely human act of counting again until the
 * numbers agree. Whatever was actually in the till is then unrecoverable.
 *
 * Which makes the test surface wider than "is the variance hidden". Expected
 * cash is
 *
 *     openingFloat + cashSales + cashIn − cashOut
 *
 * so anybody holding those four terms has the answer, and hiding only the
 * last line would be a curtain with a gap in it. Section 3 checks the payload
 * itself rather than what the component renders, because a field that reaches
 * the browser is in the page source whether or not anything draws it.
 *
 * ── And the total must not come from the client ────────────────────────────
 *
 * If the browser can post the total, it can post the one that matches
 * expected, and every line above is theatre. The action takes counts; the
 * server multiplies them by the face values the currency actually has.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/drawer-denomination-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  denominationsFor,
  sanitiseCounts,
  totalFromCounts,
} from '../src/features/cashdrawer/denominations'
import { closeDrawer, computeDrawerTotals, openDrawer } from '../src/features/cashdrawer/service'
import { getDrawerPageData } from '../src/features/cashdrawer/queries'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const stamp = Date.now().toString(36)

async function main() {
  console.log('\n── 1. The notes are the currency’s, not a hardcoded list ──')
  {
    const lkr = denominationsFor('LKR').map((d) => d.label)
    check('LKR has a 5000 note', lkr.includes('5000'), lkr.join(', '))
    check('and no 2000 — Sri Lanka does not print one', !lkr.includes('2000'), lkr.join(', '))

    const inr = denominationsFor('INR').map((d) => d.label)
    check('INR has a 200', inr.includes('200'), inr.join(', '))
    check('and no 5000', !inr.includes('5000'), inr.join(', '))

    /*
     * A currency nobody listed must still produce a usable count. An empty
     * grid on the first day in a new market reads as the feature being broken.
     */
    const unknown = denominationsFor('XYZ')
    check('an unlisted currency still gets a ladder', unknown.length > 0, `${unknown.length}`)

    // Minor units throughout, like every other money value in this codebase.
    const inrValues = denominationsFor('INR')
    check(
      'face values are in minor units',
      inrValues.some((d) => d.label === '500' && d.value === 500_00),
      JSON.stringify(inrValues.find((d) => d.label === '500')),
    )
    check('and are ordered largest first', inrValues[0]!.value >= inrValues[1]!.value)
  }

  console.log('\n── 2. Nothing invented reaches the total ──')
  {
    const counts = sanitiseCounts('LKR', {
      '500000': 2, // a real 5000 note, in minor units
      '99999999': 1, // not a denomination
      '10000': -4, // negative
      '5000': 1.7, // fractional notes do not exist
      nonsense: 3,
    })
    check('an unknown face value is dropped', counts['99999999'] === undefined)
    check('a negative count is dropped', counts['10000'] === undefined)
    check('a fractional count is truncated', counts['5000'] === 1, String(counts['5000']))
    check('and the real one survives', counts['500000'] === 2)

    /*
     * The arithmetic itself. Two 5000s and one 50 is 10,050 — and the point of
     * checking it here is that this function, not the browser, is what the
     * recorded figure comes from.
     */
    check(
      'the total is the sum of face value × count',
      totalFromCounts('LKR', { '500000': 2, '5000': 1 }) === 1_005_000,
      String(totalFromCounts('LKR', { '500000': 2, '5000': 1 })),
    )
    check('an empty count is zero, not an error', totalFromCounts('LKR', {}) === 0)
  }

  const restaurant = await prisma.restaurant.create({
    data: {
      name: 'Drawer Co',
      slug: `drawer-${stamp}`,
      email: `dr-${stamp}@test.local`,
      currency: 'LKR',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `cash-${stamp}@test.local`,
      name: 'Cashier',
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: branch.id,
    },
  })
  const manager = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `mgr-${stamp}@test.local`,
      name: 'Manager',
      passwordHash: 'x',
      role: 'MANAGER',
      branchId: branch.id,
    },
  })

  const actorFor = (u: typeof cashier) => ({
    id: u.id,
    role: u.role,
    branchId: u.branchId,
    canManageOthers: u.role !== 'CASHIER',
  })

  console.log('\n── 3. What the cashier is sent while the drawer is open (§4) ──')
  {
    await openDrawer({
      restaurantId: restaurant.id,
      branchId: branch.id,
      openingFloat: 10_000_00,
      userId: cashier.id,
      userBranchId: branch.id,
    })

    const theirs = await getDrawerPageData({
      restaurantId: restaurant.id,
      userId: cashier.id,
      currency: 'LKR',
      canSeeAll: false,
      canReview: false,
    })

    check('the cashier has an open drawer on screen', theirs.open !== null)
    /*
     * The payload, not the render. A component that simply does not draw a
     * field still ships it in the page source, where "view source" is a
     * complete workaround for the control.
     */
    check('expected cash is not in the payload', theirs.open?.expectedCash == null, String(theirs.open?.expectedCash))
    check(
      'and neither is the sales figure it is derived from',
      theirs.open?.cashSales == null,
      String(theirs.open?.cashSales),
    )
    check('and the page says so, so the form can adapt', theirs.maySeeReconciliation === false)
    check(
      'but the float they typed themselves is still there',
      theirs.open?.openingFloat === 10_000_00,
      String(theirs.open?.openingFloat),
    )
    check('and the notes to count came with it', theirs.denominations.length > 0)

    const theirManagers = await getDrawerPageData({
      restaurantId: restaurant.id,
      userId: manager.id,
      currency: 'LKR',
      canSeeAll: true,
      canReview: true,
    })
    check('a manager reconciling the floor still gets all of it', theirManagers.maySeeReconciliation === true)
  }

  console.log('\n── 4. Closing against a count ──')
  {
    const session = await prisma.cashDrawerSession.findFirstOrThrow({
      where: { restaurantId: restaurant.id, status: 'OPEN' },
    })
    const expected = (await computeDrawerTotals(session.id)).expectedCash

    // Two 5000s exactly — 10,000, which is the float and nothing else.
    const result = await closeDrawer({
      restaurantId: restaurant.id,
      sessionId: session.id,
      counts: { '500000': 2 },
      userId: cashier.id,
      actor: actorFor(cashier),
    })

    check(
      'the total is derived from the notes, not sent',
      result.countedCash === 10_000_00,
      String(result.countedCash),
    )
    check('and the variance is against the real expected', result.variance === 10_000_00 - expected)
    check(
      'the breakdown is kept for a disputed count',
      JSON.stringify(result.session.closingCounts) === JSON.stringify({ '500000': 2 }),
      JSON.stringify(result.session.closingCounts),
    )
    /*
     * The change §4 asked for, pinned from the other side: this close carried
     * no reason and was not refused. `cash-drawer-test` records the same
     * decision where the old assertion used to live.
     */
    check('no explanation was demanded of the cashier', result.session.varianceReason === null)
  }

  console.log('\n── 5. A posted count cannot invent money ──')
  {
    await openDrawer({
      restaurantId: restaurant.id,
      branchId: branch.id,
      openingFloat: 1_000_00,
      userId: manager.id,
      userBranchId: branch.id,
    })
    const session = await prisma.cashDrawerSession.findFirstOrThrow({
      where: { restaurantId: restaurant.id, status: 'OPEN', openedById: manager.id },
    })

    /*
     * The attack the server-side multiplication exists to stop: a face value
     * this currency does not have, chosen to make the drawer balance.
     */
    const result = await closeDrawer({
      restaurantId: restaurant.id,
      sessionId: session.id,
      counts: { '500000': 1, '123456789': 1 },
      userId: manager.id,
      actor: actorFor(manager),
    })
    check(
      'a face value the currency does not have counts for nothing',
      result.countedCash === 5_000_00,
      String(result.countedCash),
    )
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
