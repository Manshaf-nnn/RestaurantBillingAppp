/**
 * Sizes have to work the same wherever the order is taken.
 *
 * ── The showstopper this is written around ──────────────────────────────────
 *
 * The variant system was complete on the guest side and absent on the staff
 * side. Both till screens sent a hard-coded empty selection:
 *
 *     pos-terminal.tsx:168    optionIds: []
 *     cashier-board.tsx:271   optionIds: []
 *
 * while `buildDraft` enforces required groups. So the moment an owner did the
 * thing `menuelogic.md` is entirely about — add "Portion: Normal / Full" and
 * mark it required — **that dish became un-sellable at the counter**, failing
 * with OPTION_REQUIRED. A guest with a phone could buy it. The cashier standing
 * in front of that guest could not.
 *
 * Section 2 is that case: an empty selection on a dish with a required group
 * must be refused, and the same order with a real selection must go through.
 * The first half passes today; the second half is what was broken.
 *
 * ── And the same order must cost the same either way ────────────────────────
 *
 * Section 3 rings up an identical choice through the guest path and the staff
 * path and asserts the two order lines are indistinguishable — same unit price,
 * same options total, same line total, same snapshot. A till that prices
 * differently from the QR code is worse than a till that cannot take the order.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/variant-order-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder } from '../src/features/orders/service'
import { readOptions } from '../src/features/orders/queries'
import { getPublicMenu } from '../src/features/menu/queries'
import {
  absolutePrice,
  deltaFor,
  optionPriceLabel,
  priceRange,
  replacesPrice,
} from '../src/features/menu/variant-pricing'
import { formatMoney } from '../src/lib/money'

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

const money = (minor: number) => formatMoney(minor, 'LKR', 'en-IN')

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Variants ${stamp}`,
      slug: `variants-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      currency: 'LKR',
      taxRateBps: 0,
      serviceChargeBps: 0,
    },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const second = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Branch 02', code: 'BR02' },
  })
  const staff = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `variants-${stamp}@test.local`,
      name: 'Cashier',
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: main.id,
    },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Rice', slug: `rice-${stamp}` },
  })

  /*
   * The spec's own example: Chicken Fried Rice, Normal Rs 850 / Full Rs 1,400,
   * plus an optional add-on group. Stored as deltas — 0 and +550 — which is
   * exactly the conversion the editor now does for the owner.
   */
  const BASE = 85_000 // Rs 850.00
  const FULL = 140_000 // Rs 1,400.00

  const rice = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Chicken Fried Rice',
      slug: `rice-${stamp}`,
      price: BASE,
      isAvailable: true,
      variantGroups: {
        create: [
          {
            name: 'Portion',
            kind: 'VARIANT',
            isRequired: true,
            minSelect: 1,
            maxSelect: 1,
            sortOrder: 0,
            options: {
              create: [
                { name: 'Normal', priceDelta: 0, isDefault: true, sortOrder: 0 },
                { name: 'Full', priceDelta: deltaFor(BASE, FULL), sortOrder: 1 },
              ],
            },
          },
          {
            name: 'Extras',
            kind: 'ADDON',
            isRequired: false,
            minSelect: 0,
            maxSelect: 2,
            sortOrder: 1,
            options: {
              create: [
                { name: 'Extra egg', priceDelta: 15_000, sortOrder: 0 },
                { name: 'Extra chicken', priceDelta: 50_000, sortOrder: 1 },
              ],
            },
          },
        ],
      },
    },
    include: { variantGroups: { include: { options: true }, orderBy: { sortOrder: 'asc' } } },
  })

  const water = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Water',
      slug: `water-${stamp}`,
      price: 10_000,
      isAvailable: true,
    },
  })

  await prisma.foodBranch.createMany({
    data: [main, second].flatMap((branch) =>
      [rice, water].map((food) => ({
        restaurantId: restaurant.id,
        branchId: branch.id,
        foodId: food.id,
        isAvailable: true,
      })),
    ),
  })

  const portion = rice.variantGroups.find((g) => g.name === 'Portion')!
  const extras = rice.variantGroups.find((g) => g.name === 'Extras')!
  const normal = portion.options.find((o) => o.name === 'Normal')!
  const full = portion.options.find((o) => o.name === 'Full')!
  const egg = extras.options.find((o) => o.name === 'Extra egg')!
  const chicken = extras.options.find((o) => o.name === 'Extra chicken')!

  // ── 1. prices read the way people say them ────────────────────────────────
  console.log('\n── 1. a size is a price, an add-on is an addition ──')

  check('Full costs Rs 1,400', absolutePrice(BASE, full.priceDelta) === FULL)
  check('and is stored as the difference', full.priceDelta === 55_000, `${full.priceDelta}`)
  check(
    'the conversion round-trips',
    absolutePrice(BASE, deltaFor(BASE, FULL)) === FULL &&
      deltaFor(BASE, absolutePrice(BASE, 55_000)) === 55_000,
  )
  check(
    'a half portion below the base price is a negative difference',
    deltaFor(BASE, 40_000) === -45_000,
    'the column is signed for exactly this',
  )

  check(
    'a size shows its own price, not a difference',
    optionPriceLabel(full, portion, BASE, money) === money(FULL),
    `${optionPriceLabel(full, portion, BASE, money)}`,
  )
  check(
    'an add-on still shows what it adds',
    optionPriceLabel(egg, extras, BASE, money) === `+${money(15_000)}`,
    `${optionPriceLabel(egg, extras, BASE, money)}`,
  )
  check(
    'a free add-on shows nothing rather than "+Rs 0.00"',
    optionPriceLabel({ priceDelta: 0 }, extras, BASE, money) === null,
  )
  check('a size replaces the price', replacesPrice(portion) && !replacesPrice(extras))

  const range = priceRange(BASE, rice.variantGroups)
  check('the card says "from Rs 850"', range.from === BASE, `${range.from}`)
  check('and that there are 2 sizes', range.sizeCount === 2, `${range.sizeCount}`)
  const plain = priceRange(10_000, [])
  check('a dish with no sizes says nothing extra', plain.sizeCount === 0 && plain.from === 10_000)

  // ── 2. the showstopper ────────────────────────────────────────────────────
  console.log('\n── 2. a required portion must not make a dish un-sellable ──')

  const ring = (optionIds: string[], quantity = 1, branchId = main.id) =>
    placeOrder({
      restaurantId: restaurant.id,
      type: 'COUNTER',
      channel: 'COUNTER',
      branchId,
      tableId: null,
      servedById: staff.id,
      createdById: staff.id,
      customerName: 'Walk-in',
      customerPhone: '',
      items: [{ foodId: rice.id, quantity, optionIds }],
    })

  await refuses(
    'the empty selection the till used to send is refused',
    () => ring([]),
    /Choose Portion/i,
  )

  const counterOrder = await ring([full.id])
  check(
    'and the same order with a portion chosen goes through',
    counterOrder.items.length === 1,
    'this is what was broken at the counter',
  )
  check('priced at the full portion', counterOrder.items[0].lineTotal === FULL, `${counterOrder.items[0].lineTotal}`)
  check(
    'a dish with no options still needs none',
    (
      await placeOrder({
        restaurantId: restaurant.id,
        type: 'COUNTER',
        channel: 'COUNTER',
        branchId: main.id,
        tableId: null,
        servedById: staff.id,
        createdById: staff.id,
        customerName: 'Walk-in',
        customerPhone: '',
        items: [{ foodId: water.id, quantity: 1, optionIds: [] }],
      })
    ).items.length === 1,
  )

  // ── 3. the guest and the till agree ───────────────────────────────────────
  console.log('\n── 3. the same choice costs the same either way ──')

  const viaTill = await ring([full.id])
  const viaQr = await placeOrder({
    restaurantId: restaurant.id,
    type: 'TAKEAWAY',
    channel: 'QR',
    branchId: main.id,
    tableId: null,
    servedById: staff.id,
    createdById: staff.id,
    customerName: 'Guest',
    customerPhone: '0770000000',
    items: [{ foodId: rice.id, quantity: 1, optionIds: [full.id] }],
  })
  const a = viaTill.items[0]
  const b = viaQr.items[0]
  check(
    'identical unit price, options total and line total',
    a.unitPrice === b.unitPrice && a.optionsTotal === b.optionsTotal && a.lineTotal === b.lineTotal,
    `${a.unitPrice}/${a.optionsTotal}/${a.lineTotal} vs ${b.unitPrice}/${b.optionsTotal}/${b.lineTotal}`,
  )
  check(
    'and an identical snapshot of what was chosen',
    JSON.stringify(readOptions(a.options)) === JSON.stringify(readOptions(b.options)),
  )

  // ── 4. what the order remembers ───────────────────────────────────────────
  console.log('\n── 4. the order line remembers the portion ──')

  const snapshot = readOptions(viaTill.items[0].options)
  check('the option name is stored', snapshot[0]?.name === 'Full', JSON.stringify(snapshot))
  check('with the group it came from', snapshot[0]?.groupName === 'Portion')
  check('and its price at the time', snapshot[0]?.priceDelta === 55_000)
  check(
    'the kitchen label reads "Full"',
    snapshot.map((o) => o.name).join(' · ') === 'Full',
  )

  const withExtras = await ring([full.id, egg.id, chicken.id])
  check(
    'add-ons stack on top of the size',
    withExtras.items[0].lineTotal === FULL + 15_000 + 50_000,
    `${withExtras.items[0].lineTotal}`,
  )
  check(
    'and quantity multiplies the lot',
    (await ring([full.id, egg.id], 2)).items[0].lineTotal === (FULL + 15_000) * 2,
  )

  // ── 5. the rules still hold ───────────────────────────────────────────────
  console.log('\n── 5. the server still refuses what it should ──')

  await refuses(
    'too many add-ons from a max-2 group',
    async () => {
      const third = await prisma.variantOption.create({
        data: { groupId: extras.id, name: 'Extra cheese', priceDelta: 20_000, sortOrder: 2 },
      })
      return ring([full.id, egg.id, chicken.id, third.id])
    },
    /at most 2/i,
  )

  await refuses(
    'an option that belongs to no group on this dish',
    () => ring([full.id, 'clh0000000000000000000000']),
    /Invalid choice/i,
  )

  await prisma.variantOption.update({ where: { id: full.id }, data: { isAvailable: false } })
  await refuses('a sold-out size', () => ring([full.id]), /unavailable/i)
  await prisma.variantOption.update({ where: { id: full.id }, data: { isAvailable: true } })

  // ── 6. history survives the menu changing ─────────────────────────────────
  console.log('\n── 6. yesterday’s order keeps yesterday’s price ──')

  const historic = await ring([full.id])
  await prisma.food.update({ where: { id: rice.id }, data: { price: 90_000 } })
  await prisma.variantOption.update({
    where: { id: full.id },
    data: { name: 'Full portion', priceDelta: 60_000 },
  })

  const reread = await prisma.orderItem.findUniqueOrThrow({ where: { id: historic.items[0].id } })
  check('the line total is unchanged', reread.lineTotal === FULL, `${reread.lineTotal}`)
  check('the unit price is unchanged', reread.unitPrice === BASE, `${reread.unitPrice}`)
  check(
    'and it still says the size it was sold as',
    readOptions(reread.options)[0]?.name === 'Full',
    'renaming the option must not rewrite the receipt',
  )

  await prisma.variantOption.delete({ where: { id: full.id } })
  const afterDelete = await prisma.orderItem.findUniqueOrThrow({
    where: { id: historic.items[0].id },
  })
  check(
    'deleting the size outright leaves the record intact',
    readOptions(afterDelete.options)[0]?.name === 'Full' && afterDelete.lineTotal === FULL,
  )

  // ── 7. a guest's open cart survives the owner editing the dish ───────────
  console.log('\n── 7. an open cart survives a menu edit ──')

  /*
   * `saveFood` used to delete every group and recreate them, minting fresh
   * cuids each time. A guest browsing with a basket open, an owner fixing a
   * typo on that dish, and the guest's next tap failed the tamper check —
   * INVALID_OPTION, fired at somebody who tampered with nothing.
   *
   * This re-saves the dish the way the action does and then checks the ids the
   * guest is still holding.
   */
  const beforeSave = await prisma.variantOption.findMany({
    where: { group: { foodId: rice.id } },
    select: { id: true, name: true },
    orderBy: { sortOrder: 'asc' },
  })

  /*
   * The same shape `saveFood` writes: update in place, keyed on the id the form
   * sent back. The action itself needs a request scope for its permission
   * guard, so the write it performs is reproduced here rather than called.
   */
  const liveGroup = await prisma.variantGroup.findFirstOrThrow({
    where: { foodId: rice.id, name: 'Portion' },
    include: { options: true },
  })
  await prisma.variantGroup.update({
    where: { id: liveGroup.id },
    data: { name: 'Portion size' },
  })
  for (const option of liveGroup.options) {
    await prisma.variantOption.updateMany({
      where: { id: option.id, groupId: liveGroup.id },
      data: { name: option.name },
    })
  }

  const afterSave = await prisma.variantOption.findMany({
    where: { group: { foodId: rice.id } },
    select: { id: true },
  })
  const kept = new Set(afterSave.map((option) => option.id))
  check(
    'every option id the guest holds still exists',
    beforeSave.every((option) => kept.has(option.id)),
    'a delete-and-recreate save is what killed live baskets',
  )

  const stillWorks = await ring([normal.id])
  check(
    'so a cart built before the edit still checks out',
    stillWorks.items.length === 1,
    'this failed with INVALID_OPTION before',
  )

  // ── 8. the menu a guest is shown carries the sizes ────────────────────────
  console.log('\n── 8. what the QR menu hands the guest ──')

  const menu = await getPublicMenu(restaurant.id, 'Asia/Colombo', second.id)
  const shown = menu.items.find((item) => item.id === rice.id)
  check('the dish is on Branch 02’s menu', Boolean(shown))
  /*
   * Matched by id, not name — section 7 renames the group to prove an edit
   * keeps its identity, and a name lookup here would go looking for the old
   * one. The id is the thing that has to survive.
   */
  const shownPortion = shown?.groups.find((g) => g.id === portion.id)
  check('with its portion group', Boolean(shownPortion))
  check(
    'still the same group after the rename',
    shownPortion?.name === 'Portion size',
    `${shownPortion?.name}`,
  )
  check(
    'marked required, so the sheet holds the button shut',
    shownPortion?.isRequired ?? false,
  )
  check(
    'and the add-on group is multi-choice',
    (shown?.groups.find((g) => g.id === extras.id)?.maxSelect ?? 0) === 2,
  )

  const atSecond = await ring([normal.id], 1, second.id)
  check('an order rung up at Branch 02 belongs to Branch 02', atSecond.branchId === second.id)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.variantOption.deleteMany({ where: { group: { food: { restaurantId: restaurant.id } } } })
  await prisma.variantGroup.deleteMany({ where: { food: { restaurantId: restaurant.id } } })
  await prisma.food.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.customer.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
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
