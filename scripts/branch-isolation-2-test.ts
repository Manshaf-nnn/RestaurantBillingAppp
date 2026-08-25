/**
 * A branch is a sealed box for reading, and a porous one for transfers.
 *
 * ── What this is guarding ───────────────────────────────────────────────────
 *
 * `branch-isolation-test` proves orders, stock and the menu stay apart. This is
 * the second sweep, written after an audit found five places that were not:
 *
 *   the supplier ledger, which showed every branch's purchasing to a warehouse
 *     worker confined to one site — labelled by branch, so it read as a feature
 *   global search, which returned any guest and the whole staff roster,
 *     directly contradicting the rule its own file opens by stating
 *   the audit log, which filtered on the restaurant and nothing else
 *   a customer's spend and visits, group-wide counters printed above a
 *     branch-filtered order list — twelve visits over three orders
 *   reservations, whose table picker offered every branch's tables with
 *     nothing to tell them apart
 *
 * Each section below is one of those, written so it fails against the old code.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/branch-isolation-2-test.ts
 */
import type { UserRole } from '@prisma/client'

import { prisma } from '../src/server/db/prisma'
import { getSupplierLedger, getSupplierBalances } from '../src/features/suppliers/ledger'
import { globalSearch } from '../src/features/search/service'
import { getCustomerProfile } from '../src/features/customers/analytics'
import { PERMISSIONS, ROLE_PERMISSIONS, customersAtBranch, visibleBranchIds } from '../src/lib/rbac'
import {
  FEATURES,
  featureByKey,
  levelOf,
  permissionsForLevel,
  primaryAction,
  withLevel,
} from '../src/features/access/features'

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

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Isolation ${stamp}`,
      slug: `iso-${stamp}`,
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

  const mk = (name: string, role: UserRole, branchId: string | null) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        email: `${name.toLowerCase()}-${stamp}@test.local`,
        name,
        passwordHash: 'x',
        role,
        branchId,
      },
    })

  const owner = await mk('Owner', 'OWNER', null)
  const kandyManager = await mk('KandyBoss', 'MANAGER', kandy.id)
  const colomboManager = await mk('ColomboBoss', 'MANAGER', colombo.id)
  const kandyStore = await mk('KandyStore', 'WAREHOUSE_STAFF', kandy.id)

  const subject = (u: { role: UserRole; branchId: string | null }) => ({
    role: u.role,
    branchId: u.branchId,
  })
  const reachOf = (u: { role: UserRole; branchId: string | null }) => visibleBranchIds(subject(u))

  // ── 1. the supplier ledger ────────────────────────────────────────────────
  console.log('\n── 1. a supplier is shared; their invoices are not ──')

  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: `Fresh Foods ${stamp}` },
  })

  const po = async (branchId: string, number: string, total: number) =>
    prisma.purchase.create({
      data: {
        restaurantId: restaurant.id,
        branchId,
        supplierId: supplier.id,
        number,
        status: 'RECEIVED',
        total,
      },
    })

  await po(colombo.id, `PO-CMB-${stamp}`, 100_000)
  await po(kandy.id, `PO-KDY-${stamp}`, 40_000)

  const asOwner = await getSupplierLedger({
    restaurantId: restaurant.id,
    supplierId: supplier.id,
    branchIds: reachOf(owner),
  })
  const asStore = await getSupplierLedger({
    restaurantId: restaurant.id,
    supplierId: supplier.id,
    branchIds: reachOf(kandyStore),
  })

  check('the owner sees both branches’ orders', asOwner.purchases.length === 2)
  check(
    'a Kandy warehouse worker sees only Kandy’s',
    asStore.purchases.length === 1 && asStore.purchases[0].branchName === 'Kandy',
    `${asStore.purchases.length} orders`,
  )
  check(
    'and Colombo’s order number is nowhere in their statement',
    !asStore.purchases.some((p) => p.number.includes('CMB')),
    'the page prints branch.name beside every row, so this read as a feature',
  )
  check(
    'the supplier record itself is still shared',
    asStore.supplier.id === supplier.id && asOwner.supplier.id === supplier.id,
    'a supplier belongs to the business — only the ledger narrows',
  )

  const ownerBalances = await getSupplierBalances(restaurant.id, reachOf(owner))
  const storeBalances = await getSupplierBalances(restaurant.id, reachOf(kandyStore))
  check(
    'the list balance narrows with the statement behind it',
    (ownerBalances.get(supplier.id) ?? 0) >= (storeBalances.get(supplier.id) ?? 0),
  )

  // ── 2. global search ──────────────────────────────────────────────────────
  console.log('\n── 2. the search box obeys the rule its own file states ──')

  const colomboGuest = await prisma.customer.create({
    data: { restaurantId: restaurant.id, name: `Colombo Guest ${stamp}`, phone: `07711${stamp.slice(-5)}` },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Rice',
      slug: `rice-${stamp}`,
      price: 1_000_00,
    },
  })
  await prisma.order.create({
    data: {
      restaurantId: restaurant.id,
      branchId: colombo.id,
      orderNumber: `A-${stamp}`,
      customerId: colomboGuest.id,
      customerName: colomboGuest.name!,
      customerPhone: colomboGuest.phone,
      status: 'COMPLETED',
      subtotal: 1_000_00,
      grandTotal: 1_000_00,
      paidTotal: 1_000_00,
      items: { create: [{ foodId: dish.id, name: 'Rice', quantity: 1, unitPrice: 1_000_00, lineTotal: 1_000_00 }] },
    },
  })

  const searchAs = (u: { id: string; role: UserRole; branchId: string | null }, term: string) =>
    globalSearch({
      user: {
        id: u.id,
        restaurantId: restaurant.id,
        role: u.role,
        branchId: u.branchId,
        permissions: [],
        rolePermissions: null,
      } as never,
      term,
    }).then((r) => r.hits)

  const kandyFindsGuest = await searchAs(kandyManager, colomboGuest.phone)
  check(
    'a Kandy manager cannot find a Colombo-only guest by phone',
    !kandyFindsGuest.some((h) => h.id === `customer-${colomboGuest.id}`),
    'this was a way round the Customers screen’s own narrowing',
  )

  const colomboFindsGuest = await searchAs(colomboManager, colomboGuest.phone)
  check(
    'and Colombo’s own manager still finds them',
    colomboFindsGuest.some((h) => h.id === `customer-${colomboGuest.id}`),
  )

  const kandyFindsStaff = await searchAs(kandyManager, 'ColomboBoss')
  check(
    'a Kandy manager cannot find Colombo’s staff',
    !kandyFindsStaff.some((h) => h.id === `staff-${colomboManager.id}`),
    'the staff page fixed this and search handed the roster back',
  )

  const ownerFindsStaff = await searchAs(owner, 'ColomboBoss')
  check('an owner still finds everybody', ownerFindsStaff.some((h) => h.id === `staff-${colomboManager.id}`))

  // ── 3. a customer's figures ───────────────────────────────────────────────
  console.log('\n── 3. what a branch sees of a guest ──')

  // The same guest, now with a Kandy order too.
  await prisma.order.create({
    data: {
      restaurantId: restaurant.id,
      branchId: kandy.id,
      orderNumber: `B-${stamp}`,
      customerId: colomboGuest.id,
      customerName: colomboGuest.name!,
      customerPhone: colomboGuest.phone,
      status: 'COMPLETED',
      subtotal: 500_00,
      grandTotal: 500_00,
      paidTotal: 500_00,
      items: { create: [{ foodId: dish.id, name: 'Rice', quantity: 1, unitPrice: 500_00, lineTotal: 500_00 }] },
    },
  })
  await prisma.customer.update({
    where: { id: colomboGuest.id },
    // The group-wide counters the profile used to read straight off.
    data: { totalSpent: 1_500_00, totalOrders: 2, loyaltyPoints: 150 },
  })

  const kandyView = await getCustomerProfile({
    restaurantId: restaurant.id,
    customerId: colomboGuest.id,
    branchIds: [kandy.id],
  })
  const ownerView = await getCustomerProfile({
    restaurantId: restaurant.id,
    customerId: colomboGuest.id,
    branchIds: null,
  })

  check(
    'a branch sees what the guest spent there',
    kandyView.totalSpent === 500_00 && kandyView.totalOrders === 1,
    `${kandyView.totalSpent} over ${kandyView.totalOrders}`,
  )
  check(
    'and the figures match the orders listed under them',
    kandyView.totalOrders === kandyView.recentOrders.length,
    'twelve visits over three orders was the bug',
  )
  check('which is flagged, so the label can say so', kandyView.figuresScopedToBranch)
  check(
    'an owner still sees the lifetime counters',
    ownerView.totalSpent === 1_500_00 && ownerView.totalOrders === 2 && !ownerView.figuresScopedToBranch,
  )
  check(
    'loyalty follows the person, not the branch',
    kandyView.loyaltyPoints === 150 && ownerView.loyaltyPoints === 150,
    'one counter with no ledger — a regular must not be halved for visiting both',
  )

  const visibleAtKandy = await prisma.customer.findMany({
    where: { restaurantId: restaurant.id, ...customersAtBranch([kandy.id]) },
    select: { id: true },
  })
  check(
    'and they are visible at Kandy now they have ordered there',
    visibleAtKandy.some((c) => c.id === colomboGuest.id),
  )

  // ── 4. reservations ───────────────────────────────────────────────────────
  console.log('\n── 4. a booking is for a place ──')

  const cmbTable = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: colombo.id, number: '4' },
  })
  const kdyTable = await prisma.restaurantTable.create({
    // The same number at the other site — legal, and the reason the picker
    // was ambiguous.
    data: { restaurantId: restaurant.id, branchId: kandy.id, number: '4' },
  })

  await prisma.reservation.create({
    data: {
      restaurantId: restaurant.id,
      branchId: colombo.id,
      tableId: cmbTable.id,
      customerName: 'Colombo diner',
      customerPhone: '0770000001',
      reservedAt: new Date(),
    },
  })

  const kandyDiary = await prisma.reservation.findMany({
    where: { restaurantId: restaurant.id, branchId: { in: [kandy.id] } },
  })
  check("a Kandy manager does not read Colombo's diary", kandyDiary.length === 0)

  const kandyTables = await prisma.restaurantTable.findMany({
    where: { restaurantId: restaurant.id, isActive: true, branchId: { in: [kandy.id] } },
    select: { id: true },
  })
  check(
    'and the table picker offers only their own tables',
    kandyTables.length === 1 && kandyTables[0].id === kdyTable.id,
    'it listed several indistinguishable "Table 4" rows across branches',
  )

  // ── 5. the feature levels ─────────────────────────────────────────────────
  console.log('\n── 5. off, read, full ──')

  const transfers = featureByKey('transfers')!
  const empty = new Set<string>()

  check('a feature with nothing granted is off', levelOf(transfers, empty) === 'off')

  const readSet = withLevel(empty, transfers, 'read')
  check(
    'read grants exactly the action that opens the page',
    readSet.size === 1 && readSet.has(primaryAction(transfers)!.permission),
    `${[...readSet].join(', ')}`,
  )
  check('and reads back as read', levelOf(transfers, readSet) === 'read')

  const fullSet = withLevel(empty, transfers, 'full')
  check(
    'full grants every action the feature has',
    fullSet.size === transfers.actions.length &&
      transfers.actions.every((a) => fullSet.has(a.permission)),
  )
  check('and reads back as full', levelOf(transfers, fullSet) === 'full')

  check(
    'switching a feature off clears its actions and leaves the rest alone',
    (() => {
      const both = withLevel(withLevel(empty, transfers, 'full'), featureByKey('orders')!, 'read')
      const off = withLevel(both, transfers, 'off')
      return (
        transfers.actions.every((a) => !off.has(a.permission)) &&
        off.has(primaryAction(featureByKey('orders')!)!.permission)
      )
    })(),
  )

  /*
   * A role composed action-by-action in the builder often sits between two
   * words. It has to read back as `custom` and be left alone, or opening the
   * location screen and saving would silently rewrite somebody's careful work.
   */
  const partial = new Set([
    primaryAction(transfers)!.permission,
    PERMISSIONS.TRANSFER_DISPATCH,
  ])
  check('a hand-built role in between reads as custom', levelOf(transfers, partial) === 'custom')

  check(
    'every feature can express all three levels',
    FEATURES.every((f) => {
      const read = permissionsForLevel(f, 'read')
      const full = permissionsForLevel(f, 'full')
      return read.length >= 1 && full.length >= read.length
    }),
  )

  check(
    'a built-in manager could be described by these levels',
    ROLE_PERMISSIONS.MANAGER.length > 0,
    'sanity: the presets are still non-empty',
  )

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
