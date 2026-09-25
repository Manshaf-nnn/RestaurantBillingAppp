/**
 * Menu codes, the waiter's table rules, delivery locations and the offers panel.
 *
 * Four changes that share one guest-facing consequence: what somebody is
 * allowed to do, and what they are shown before they do it.
 *
 *   • a dish can carry the owner's own code, unique per restaurant, and the
 *     pickers find it by that code as well as by name;
 *   • a waiter may not start an order on a table held for a booking or one
 *     whose bill is being settled — but an ordinary second round still works,
 *     because drinks then mains is two orders on one sitting;
 *   • a delivery guest picks from the owner's own list of places, narrowed to
 *     their customer category, and the order records where it went by id AND
 *     by name so a rename cannot rewrite history;
 *   • the offers panel lists the coupons the engine would actually honour —
 *     never one tied to a different QR code, never one outside its window.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/waiter-qr-flow-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { orderBlock, type PadTable } from '../src/features/waiter/components/waiter-order-pad'
import { locationsForGuest, resolveLocationForOrder, saveLocation } from '../src/features/qr/locations'
import { offersFor } from '../src/features/qr/offers'
import { splitLine } from '../src/features/orders/split-line'

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

function table(over: Partial<PadTable>): PadTable {
  return {
    id: 't1',
    number: '4',
    label: null,
    area: null,
    capacity: 4,
    status: 'AVAILABLE',
    openOrders: [],
    seatedGuests: null,
    billRequested: false,
    ...over,
  }
}

async function main() {
  const stamp = Date.now().toString(36)
  const money = (minor: number) => `Rs ${(minor / 100).toFixed(2)}`

  console.log('\n── 1. Which tables a waiter may order on ──')
  {
    check('an empty table is fine', orderBlock(table({})) === null)

    check(
      'a seated table is STILL fine — a second round is one bill',
      orderBlock(table({ status: 'OCCUPIED', openOrders: [{ id: 'o1', orderNumber: 'A-1' }] })) ===
        null,
    )

    const reserved = orderBlock(table({ status: 'RESERVED' }))
    check('a reserved table is refused', reserved !== null, String(reserved))
    check(
      '…and says why, in words a waiter can act on',
      (reserved ?? '').toLowerCase().includes('booking'),
      String(reserved),
    )

    const billing = orderBlock(table({ status: 'OCCUPIED', billRequested: true }))
    check('a table settling its bill is refused', billing !== null, String(billing))
    check(
      '…and names the bill rather than the booking',
      (billing ?? '').toLowerCase().includes('bill'),
      String(billing),
    )

    /*
     * Reserved wins over billing when both are true. Not arbitrary: the
     * reservation is the one a waiter can do something about (seat the party
     * from the floor plan), so it is the more useful sentence to show.
     */
    check(
      'reserved is reported first when a table is both',
      (orderBlock(table({ status: 'RESERVED', billRequested: true })) ?? '')
        .toLowerCase()
        .includes('booking'),
    )
  }

  /* ── Fixture ────────────────────────────────────────────────────────────── */

  const restaurant = await prisma.restaurant.create({
    data: { name: `Flow ${stamp}`, slug: `flow-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const main1 = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Campus', code: 'CMP', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Town', code: 'TWN' },
  })
  const students = await prisma.customerCategory.create({
    data: { restaurantId: restaurant.id, name: `Students ${stamp}` },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })

  console.log('\n── 2. A dish carries the owner’s own code ──')
  {
    const pizza = await prisma.food.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: category.id,
        name: 'Margherita',
        slug: `marg-${stamp}`,
        code: 'B12',
        price: 120_000,
      },
    })
    check('the code is stored as typed', pizza.code === 'B12')

    // A second dish may have NO code — many nulls must coexist under the
    // unique index, which is the whole reason it is nullable rather than ''.
    const plain1 = await prisma.food.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: category.id,
        name: 'Plain A',
        slug: `pa-${stamp}`,
        price: 1000,
      },
    })
    const plain2 = await prisma.food.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: category.id,
        name: 'Plain B',
        slug: `pb-${stamp}`,
        price: 1000,
      },
    })
    check('two dishes with no code coexist', Boolean(plain1.id && plain2.id))

    let refused = false
    try {
      await prisma.food.create({
        data: {
          restaurantId: restaurant.id,
          categoryId: category.id,
          name: 'Impostor',
          slug: `imp-${stamp}`,
          code: 'B12',
          price: 1000,
        },
      })
    } catch {
      refused = true
    }
    check('a repeated code is refused — a code names one dish', refused)
  }

  console.log('\n── 3. Delivery locations, narrowed by category ──')
  {
    await saveLocation({
      restaurantId: restaurant.id,
      input: { name: 'Boys Hostel', groupName: 'Hostels', categoryId: students.id, branchId: main1.id },
    })
    await saveLocation({
      restaurantId: restaurant.id,
      input: { name: 'Main Gate', branchId: main1.id, note: 'Ask at reception' },
    })
    await saveLocation({
      restaurantId: restaurant.id,
      input: { name: 'Town Square', branchId: other.id },
    })

    const forStudent = await locationsForGuest({
      restaurantId: restaurant.id,
      branchId: main1.id,
      categoryId: students.id,
    })
    check(
      'a student sees their own places AND the untagged ones',
      forStudent.length === 2 && forStudent.some((l) => l.name === 'Boys Hostel'),
      JSON.stringify(forStudent.map((l) => l.name)),
    )

    const forPublic = await locationsForGuest({
      restaurantId: restaurant.id,
      branchId: main1.id,
      categoryId: null,
    })
    check(
      'somebody with no category sees only the untagged ones',
      forPublic.length === 1 && forPublic[0].name === 'Main Gate',
      JSON.stringify(forPublic.map((l) => l.name)),
    )

    check(
      'another branch’s places are never offered here',
      forStudent.every((l) => l.name !== 'Town Square'),
    )

    const town = await prisma.deliveryLocation.findFirstOrThrow({
      where: { restaurantId: restaurant.id, name: 'Town Square' },
    })
    let crossBranch = false
    try {
      await resolveLocationForOrder({
        restaurantId: restaurant.id,
        branchId: main1.id,
        locationId: town.id,
      })
    } catch {
      crossBranch = true
    }
    check('an order cannot name a place from another branch’s round', crossBranch)

    const gate = await prisma.deliveryLocation.findFirstOrThrow({
      where: { restaurantId: restaurant.id, name: 'Main Gate' },
    })
    const resolved = await resolveLocationForOrder({
      restaurantId: restaurant.id,
      branchId: main1.id,
      locationId: gate.id,
    })
    check(
      'the rider’s note rides on the snapshotted name',
      resolved?.name === 'Main Gate — Ask at reception',
      String(resolved?.name),
    )

    check(
      'no location chosen is not an error',
      (await resolveLocationForOrder({
        restaurantId: restaurant.id,
        branchId: main1.id,
        locationId: null,
      })) === null,
    )

    // Two "Villa 1"s in one picker is a mis-delivery, so it is refused.
    let duplicate = false
    try {
      await saveLocation({
        restaurantId: restaurant.id,
        input: { name: 'Main Gate', branchId: main1.id },
      })
    } catch {
      duplicate = true
    }
    check('the same place cannot be added twice at one branch', duplicate)
  }

  console.log('\n── 4. The offers panel promises only what the engine honours ──')
  {
    const experience = await prisma.qrExperience.create({
      data: {
        restaurantId: restaurant.id,
        branchId: main1.id,
        publicId: `X${stamp.toUpperCase()}`.slice(0, 10),
        name: 'Leaflet',
        showOffers: true,
        offerNote: 'Students get 5% on Mondays.',
      },
    })

    await prisma.coupon.create({
      data: {
        restaurantId: restaurant.id,
        code: `OPEN${stamp}`.toUpperCase().slice(0, 20),
        type: 'PERCENT',
        value: 1000,
        minOrderAmount: 200_000,
      },
    })
    // Tied to a DIFFERENT code — must never be advertised on this one.
    const otherExperience = await prisma.qrExperience.create({
      data: {
        restaurantId: restaurant.id,
        branchId: main1.id,
        publicId: `Y${stamp.toUpperCase()}`.slice(0, 10),
        name: 'Staff only',
      },
    })
    await prisma.coupon.create({
      data: {
        restaurantId: restaurant.id,
        code: `SECRET${stamp}`.toUpperCase().slice(0, 20),
        type: 'FIXED',
        value: 50_000,
        qrExperienceId: otherExperience.id,
      },
    })
    // Expired yesterday.
    await prisma.coupon.create({
      data: {
        restaurantId: restaurant.id,
        code: `GONE${stamp}`.toUpperCase().slice(0, 20),
        type: 'PERCENT',
        value: 500,
        endsAt: new Date(Date.now() - 86_400_000),
      },
    })

    const panel = await offersFor({
      restaurantId: restaurant.id,
      branchId: main1.id,
      experienceId: experience.id,
      showOffers: true,
      offerNote: experience.offerNote,
      money,
    })

    check('the open offer is listed', panel.offers.length === 1, JSON.stringify(panel.offers))
    check(
      '…described in a line a guest can act on',
      panel.offers[0]?.headline === '10% off on orders over Rs 2000.00',
      panel.offers[0]?.headline,
    )
    check(
      'another code’s offer is never advertised here',
      panel.offers.every((offer) => !offer.code.startsWith('SECRET')),
    )
    check(
      'an expired offer is not advertised',
      panel.offers.every((offer) => !offer.code.startsWith('GONE')),
    )
    check('the owner’s own words are carried', panel.note === 'Students get 5% on Mondays.')

    const off = await offersFor({
      restaurantId: restaurant.id,
      branchId: main1.id,
      experienceId: experience.id,
      showOffers: false,
      offerNote: experience.offerNote,
      money,
    })
    check('the switch genuinely turns the panel off', off.hasAny === false && off.offers.length === 0)
  }

  console.log('\n── 5. One of these is different ──')
  {
    type L = { key: string; quantity: number; note: string }
    const cart: L[] = [{ key: 'pizza::', quantity: 2, note: '' }]

    // Two pizzas, one of them less spicy: one unit moves onto its own line.
    const split = splitLine(cart, {
      sourceKey: 'pizza::',
      quantity: 1,
      nextKey: 'pizza::less spice',
      create: (moved) => ({ key: 'pizza::less spice', quantity: moved, note: 'less spice' }),
      merge: (existing, moved) => ({ ...existing, quantity: existing.quantity + moved }),
    })
    check('the order now has two lines', split.length === 2, JSON.stringify(split))
    check('one pizza stays as it was', split[0].quantity === 1 && split[0].note === '')
    check('the other carries the requirement', split[1].quantity === 1 && split[1].note === 'less spice')
    check(
      'and it sits beside the line it came from, not at the bottom',
      split[1].key === 'pizza::less spice',
    )

    // Taking every unit leaves nothing behind rather than a zero line.
    const all = splitLine(cart, {
      sourceKey: 'pizza::',
      quantity: 2,
      nextKey: 'pizza::no cheese',
      create: (moved) => ({ key: 'pizza::no cheese', quantity: moved, note: 'no cheese' }),
      merge: (existing, moved) => ({ ...existing, quantity: existing.quantity + moved }),
    })
    check('taking every unit leaves one line, not a zero', all.length === 1 && all[0].quantity === 2)

    // Splitting onto a requirement already in the cart adds to it.
    const twoLines: L[] = [
      { key: 'pizza::', quantity: 3, note: '' },
      { key: 'pizza::less spice', quantity: 1, note: 'less spice' },
    ]
    const merged = splitLine(twoLines, {
      sourceKey: 'pizza::',
      quantity: 1,
      nextKey: 'pizza::less spice',
      create: (moved) => ({ key: 'pizza::less spice', quantity: moved, note: 'less spice' }),
      merge: (existing, moved) => ({ ...existing, quantity: existing.quantity + moved }),
    })
    check(
      'splitting onto a requirement already there adds to it',
      merged.length === 2 && merged[1].quantity === 2 && merged[0].quantity === 2,
      JSON.stringify(merged),
    )

    // Confirming the dialog without changing anything must not double the line.
    const unchanged = splitLine(cart, {
      sourceKey: 'pizza::',
      quantity: 1,
      nextKey: 'pizza::',
      create: (moved) => ({ key: 'pizza::', quantity: moved, note: '' }),
      merge: (existing, moved) => ({ ...existing, quantity: existing.quantity + moved }),
    })
    check(
      'confirming with no change is a no-op, not a doubling',
      unchanged.length === 1 && unchanged[0].quantity === 2,
      JSON.stringify(unchanged),
    )

    // Never more than the line holds.
    const clamped = splitLine(cart, {
      sourceKey: 'pizza::',
      quantity: 99,
      nextKey: 'pizza::x',
      create: (moved) => ({ key: 'pizza::x', quantity: moved, note: 'x' }),
      merge: (existing, moved) => ({ ...existing, quantity: existing.quantity + moved }),
    })
    check('it cannot move more units than the line has', clamped[0].quantity === 2)
  }

  /* ── Clean up ────────────────────────────────────────────────────────────── */
  await prisma.coupon.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.qrExperience.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.deliveryLocation.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.food.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.customerCategory.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exitCode = failed > 0 ? 1 : 0
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
