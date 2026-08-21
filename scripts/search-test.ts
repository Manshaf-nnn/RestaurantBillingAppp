/**
 * Global search.
 *
 * There was none — not a broken one, not even a decorative box. Finding a
 * purchase order meant knowing which screen listed purchase orders and reading
 * down it.
 *
 * The rule worth testing is the third one, and it is a security rule rather
 * than a convenience: **you cannot find what you may not open.** Every group is
 * gated on the same permission as the page it links to, and scoped to the
 * locations the caller may see. A search that returns a row and then answers
 * the click with /forbidden is worse than one that returns nothing — it
 * confirms the record exists and names it, which is the whole of what the
 * permission was hiding.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/search-test.ts
 */
import type { UserRole } from '@prisma/client'

import { prisma } from '../src/server/db/prisma'
import { globalSearch } from '../src/features/search/service'
import { ROLE_PERMISSIONS } from '../src/lib/rbac'
import type { TenantUser } from '../src/server/auth/guard'

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

/** A session-shaped user, as the action would build from a real session. */
function asUser(params: {
  id: string
  restaurantId: string
  role: UserRole
  branchId?: string | null
}): TenantUser {
  return {
    id: params.id,
    restaurantId: params.restaurantId,
    role: params.role,
    branchId: params.branchId ?? null,
    name: 'Tester',
    email: 'tester@example.com',
    permissions: ROLE_PERMISSIONS[params.role],
  } as TenantUser
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Find ${stamp}`, slug: `find-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const colombo = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Colombo', code: 'CMB', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' },
  })

  const owner = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Owner',
      email: `owner-${stamp}@example.com`,
      passwordHash: 'x',
      role: 'OWNER',
    },
  })

  await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Basmati Rice',
      sku: `RICE-${stamp.toUpperCase()}`,
      category: 'Grains',
      unit: 'KG',
      quantity: 40,
      costPerUnit: 25_000,
    },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: 'Sunrise Foods', phone: '0771234567' },
  })

  // One order per branch, so branch scoping can be tested.
  const cmbOrder = await prisma.purchase.create({
    data: {
      restaurantId: restaurant.id,
      supplierId: supplier.id,
      branchId: colombo.id,
      number: `PO-CMB-${stamp}`,
      status: 'APPROVED',
      total: 100_000,
    },
  })
  const kdyOrder = await prisma.purchase.create({
    data: {
      restaurantId: restaurant.id,
      supplierId: supplier.id,
      branchId: kandy.id,
      number: `PO-KDY-${stamp}`,
      status: 'APPROVED',
      total: 200_000,
    },
  })

  const ownerUser = asUser({ id: owner.id, restaurantId: restaurant.id, role: 'OWNER' })

  console.log('\n── it finds things ──')

  const rice = await globalSearch({ user: ownerUser, term: 'basmati' })
  check('by name', rice.hits.some((h) => h.title === 'Basmati Rice'))
  check(
    'and the hit leads somewhere',
    rice.hits.find((h) => h.title === 'Basmati Rice')?.href.startsWith('/dashboard/inventory/') === true,
  )

  const partial = await globalSearch({ user: ownerUser, term: 'asmat' })
  check('on a partial word, not just a prefix', partial.hits.some((h) => h.title === 'Basmati Rice'))

  const shouty = await globalSearch({ user: ownerUser, term: 'BASMATI RICE' })
  check('ignoring case', shouty.hits.some((h) => h.title === 'Basmati Rice'))

  const bySku = await globalSearch({ user: ownerUser, term: `RICE-${stamp.toUpperCase()}` })
  check('by item code', bySku.hits.some((h) => h.title === 'Basmati Rice'))

  const byPhone = await globalSearch({ user: ownerUser, term: '077123' })
  check('a supplier by phone number', byPhone.hits.some((h) => h.title === 'Sunrise Foods'))

  const byOrder = await globalSearch({ user: ownerUser, term: `PO-CMB-${stamp}` })
  check('an order by its number', byOrder.hits.some((h) => h.group === 'Purchase orders'))

  const bySupplierName = await globalSearch({ user: ownerUser, term: 'sunrise' })
  check(
    'and orders by their supplier',
    bySupplierName.hits.some((h) => h.group === 'Purchase orders'),
    'searching a supplier found the supplier but not their orders',
  )

  console.log('\n── and refuses to find nonsense ──')

  const nothing = await globalSearch({ user: ownerUser, term: 'zzzzqqqq' })
  check('a term that matches nothing returns nothing', nothing.hits.length === 0, `${nothing.hits.length}`)

  const empty = await globalSearch({ user: ownerUser, term: '' })
  check('an empty term returns nothing, not everything', empty.hits.length === 0, `${empty.hits.length}`)

  const single = await globalSearch({ user: ownerUser, term: 'a' })
  check(
    'and one character returns nothing rather than half the database',
    single.hits.length === 0,
    `${single.hits.length}`,
  )

  const spaces = await globalSearch({ user: ownerUser, term: '   ' })
  check('whitespace is not a search', spaces.hits.length === 0, `${spaces.hits.length}`)

  console.log('\n── another restaurant is invisible ──')

  const other = await prisma.restaurant.create({
    data: { name: `Other ${stamp}`, slug: `other-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const stranger = asUser({ id: 'x', restaurantId: other.id, role: 'OWNER' })

  const theirs = await globalSearch({ user: stranger, term: 'basmati' })
  check('their search finds none of our stock', theirs.hits.length === 0, `${theirs.hits.length}`)

  const theirOrders = await globalSearch({ user: stranger, term: `PO-CMB-${stamp}` })
  check('nor our orders', theirOrders.hits.length === 0, `${theirOrders.hits.length}`)

  console.log('\n── a branch manager sees only their branch ──')

  const kandyManager = asUser({
    id: 'k',
    restaurantId: restaurant.id,
    role: 'MANAGER',
    branchId: kandy.id,
  })

  const managerHits = await globalSearch({ user: kandyManager, term: `PO-` })
  const numbers = managerHits.hits.filter((h) => h.group === 'Purchase orders').map((h) => h.title)
  check('they find their own branch’s order', numbers.includes(kdyOrder.number))
  check(
    'and not another branch’s',
    !numbers.includes(cmbOrder.number),
    'a manager learned what another site had ordered',
  )

  /*
   * Items and suppliers are restaurant-wide by design — an item is defined once
   * and a supplier serves the whole business — so a branch manager sees those.
   * It is the branch-scoped documents that must not leak.
   */
  const managerItems = await globalSearch({ user: kandyManager, term: 'basmati' })
  check(
    'while restaurant-wide records are still findable',
    managerItems.hits.some((h) => h.title === 'Basmati Rice'),
  )

  console.log('\n── you cannot find what you may not open ──')

  /*
   * A kitchen hand has no purchasing or supplier rights. Returning the row and
   * refusing the click would confirm the record exists and name it, which is
   * exactly what the permission was hiding.
   */
  const cook = asUser({
    id: 'c',
    restaurantId: restaurant.id,
    role: 'KITCHEN',
    branchId: colombo.id,
  })

  const cookOrders = await globalSearch({ user: cook, term: 'PO-' })
  check(
    'a kitchen role finds no purchase orders',
    !cookOrders.hits.some((h) => h.group === 'Purchase orders'),
    'the search leaked what the permission hides',
  )

  const cookSuppliers = await globalSearch({ user: cook, term: 'sunrise' })
  check(
    'nor suppliers',
    !cookSuppliers.hits.some((h) => h.group === 'Suppliers'),
    'the search leaked a supplier',
  )

  const cookItems = await globalSearch({ user: cook, term: 'basmati' })
  check(
    'but does find stock, which they may see',
    cookItems.hits.some((h) => h.title === 'Basmati Rice'),
    'the permission check was too broad and blocked a legitimate search',
  )

  await prisma.purchase.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.supplier.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: other.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
