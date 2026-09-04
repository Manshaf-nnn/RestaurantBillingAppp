/**
 * What a restaurant has bought, and what that hides.
 *
 * The chain `superadmin.md` describes is:
 *
 *   platform availability → role permission → user access
 *
 * Both halves have to hold. A feature the restaurant never bought is refused to
 * everybody in it — **including the owner**, who is otherwise short-circuited to
 * every permission there is. And a feature they did buy is still subject to the
 * role, so this cannot become a way to widen access.
 *
 * The property that makes downgrading safe to sell is the last section: turning
 * a feature off deletes nothing, and turning it back on returns every row.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/feature-access-test.ts
 */
import { PERMISSIONS, can, permissionsFor } from '../src/lib/rbac'
import { FEATURES, permissionsForFeatures, permissionsSoldByFeatures } from '../src/features/access/features'
import { visibleSections } from '../src/features/dashboard/nav'
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

/** Every feature except the ones named — what a narrower plan looks like. */
const allExcept = (...keys: string[]) =>
  FEATURES.map((feature) => feature.key).filter((key) => !keys.includes(key))

/**
 * Every feature that grants a permission.
 *
 * More than one can. `inventory.view` belongs to both Inventory and Inventory
 * setup, because somebody sold the setup screens plainly needs to read stock.
 * So a permission goes away only when EVERY feature offering it is off — which
 * is the correct reading of "what have they bought", and the reason this test
 * computes the exclusion rather than naming one feature and hoping.
 */
const grantedBy = (permission: string) =>
  FEATURES.filter((feature) =>
    feature.actions.some((action) => action.permission === permission),
  ).map((feature) => feature.key)

async function main() {
  const stamp = Date.now().toString(36)

  console.log('\n1. An empty list means everything, not nothing')

  const unrestricted = permissionsFor({ role: 'MANAGER', availablePermissions: [] })
  const noField = permissionsFor({ role: 'MANAGER' })
  check('a restaurant with no plan set holds what its role holds',
    unrestricted.size === noField.size && unrestricted.size > 0, `${unrestricted.size}`)
  check(
    'which is what every restaurant that already exists is in',
    unrestricted.has(PERMISSIONS.INVENTORY_VIEW),
    'an empty list read as "nothing" would lock out every current customer',
  )

  console.log('\n2. A feature they did not buy is refused to everybody')

  const inventoryFeatures = grantedBy(PERMISSIONS.INVENTORY_VIEW)
  const sold = permissionsForFeatures(allExcept(...inventoryFeatures))

  const manager = { role: 'MANAGER' as const, availablePermissions: sold }
  check('a manager cannot reach inventory', !can(manager, PERMISSIONS.INVENTORY_VIEW))
  check('but keeps everything else', can(manager, PERMISSIONS.ORDER_VIEW))

  /*
   * The one that matters. `permissionsFor` short-circuits OWNER to every
   * permission there is, so if the intersection were applied inside that branch
   * instead of around it, every tenant's owner would hold every feature and the
   * whole plan would be decorative.
   */
  const owner = { role: 'OWNER' as const, availablePermissions: sold }
  check('and neither can the OWNER, who is otherwise granted everything',
    !can(owner, PERMISSIONS.INVENTORY_VIEW),
    'the availability check is inside the OWNER short-circuit rather than around it')
  check('the owner still holds what they did buy', can(owner, PERMISSIONS.ORDER_VIEW))

  /*
   * And the converse. Selling only ONE of the features that grants a permission
   * must still grant it — a restaurant given Inventory setup and nothing else
   * would be unable to read the stock it is setting up.
   */
  const setupOnly = {
    role: 'MANAGER' as const,
    availablePermissions: permissionsForFeatures(['inventorySetup']),
  }
  check(
    'a permission survives while any feature granting it is sold',
    can(setupOnly, PERMISSIONS.INVENTORY_VIEW),
    'inventory.view belongs to both Inventory and Inventory setup',
  )

  console.log('\n3. It narrows, it never widens')

  const waiterSold = permissionsForFeatures(FEATURES.map((f) => f.key))
  const waiterWith = permissionsFor({ role: 'WAITER', availablePermissions: waiterSold })
  const waiterWithout = permissionsFor({ role: 'WAITER' })
  check('buying every feature grants a waiter nothing extra',
    [...waiterWith].every((permission) => waiterWithout.has(permission)),
    'the intersection is adding permissions instead of removing them')

  console.log('\n4. The sidebar hides what is not sold')

  const withInventory = visibleSections({ role: 'MANAGER' })
  const without = visibleSections({ role: 'MANAGER', availablePermissions: sold })
  const names = (sections: ReturnType<typeof visibleSections>) =>
    sections.flatMap((section) => section.items.map((item) => item.href))

  check('the inventory link is there by default', names(withInventory).includes('/dashboard/inventory'))
  check('and gone once the feature is not part of the plan',
    !names(without).includes('/dashboard/inventory'))
  check('while the rest of the sidebar is untouched',
    names(without).includes('/dashboard/orders'))

  console.log('\n5. An owner cannot grant what the restaurant has not bought')

  /*
   * `grantable` on the roles screen is `permissionsFor(user)`, so the same
   * intersection stops an owner handing a role the keys to a feature they do
   * not have — which would otherwise be a way around the whole thing.
   */
  const grantable = permissionsFor(owner)
  check('inventory is not among the permissions an owner may hand out',
    !grantable.has(PERMISSIONS.INVENTORY_VIEW))

  console.log('\n6. Switching a feature off deletes nothing')

  const restaurant = await prisma.restaurant.create({
    data: { name: `FA ${stamp}`, slug: `fa-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const item = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Rice', unit: 'KG', quantity: 42, costPerUnit: 1000 },
  })

  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: { enabledFeatures: allExcept(...inventoryFeatures) },
  })
  const locked = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurant.id } })
  check('the plan is narrowed', !locked.enabledFeatures.includes('inventory'))
  check('and the stock row is still exactly where it was',
    (await prisma.inventoryItem.findUnique({ where: { id: item.id } }))?.quantity === 42,
    'disabling a feature touched its data — it must be a read-side gate only')

  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: { enabledFeatures: [] },
  })
  const restored = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurant.id } })
  check('switching it back on restores access', restored.enabledFeatures.length === 0)
  check('with the data untouched throughout',
    (await prisma.inventoryItem.findUnique({ where: { id: item.id } }))?.quantity === 42)

  console.log('\n7. A package is a list of real features')

  const pkg = await prisma.featurePackage.create({
    data: { name: `Basic ${stamp}`, featureKeys: ['dashboard', 'orders', 'menu'] },
  })
  const fromPackage = permissionsForFeatures(pkg.featureKeys)
  check('a package resolves to the permissions of its features', fromPackage.length > 0)
  check('and contains nothing outside them',
    !fromPackage.includes(PERMISSIONS.INVENTORY_VIEW), 'a package leaked a permission it does not own')

  console.log('\n8. A feature that was bought can actually be USED')

  /*
   * production.md / superadmin.md — the bug this section exists for.
   *
   * `availablePermissions` was built from `permissionsForFeatures`, which adds
   * only each feature's PRIMARY action. `permissionsFor` then intersects every
   * role's grants against that set. So a restaurant that had bought Purchasing
   * got `purchase.view` and nothing else: the owner could open the purchasing
   * screens and could never grant anybody — themselves included — the ability
   * to raise, approve or receive a purchase order, whatever the role said. The
   * feature was sold, paid for, visible and inert, and the same held for every
   * feature with more than one action.
   *
   * The two functions answer different questions and both are still needed:
   * `permissionsForFeatures` is what a ROLE starts with when an owner switches
   * a feature on (primary action only, so enabling Payments for a waiter does
   * not hand them refunds), and `permissionsSoldByFeatures` is what the
   * RESTAURANT may reach at all.
   */
  const soldForPurchasing = permissionsSoldByFeatures(['purchasing'])
  const roleDefault = permissionsForFeatures(['purchasing'])

  check('buying Purchasing makes its view permission available',
    soldForPurchasing.includes(PERMISSIONS.PURCHASE_VIEW))
  check('…and its create permission, which the plan used to withhold for ever',
    soldForPurchasing.includes(PERMISSIONS.PURCHASE_CREATE),
    `sold: ${soldForPurchasing.join(', ')}`)
  check('…and its approve permission',
    soldForPurchasing.includes(PERMISSIONS.PURCHASE_APPROVE), `sold: ${soldForPurchasing.join(', ')}`)
  check('the sold set is strictly wider than a role\'s starting set',
    soldForPurchasing.length > roleDefault.length, `${soldForPurchasing.length} vs ${roleDefault.length}`)

  /*
   * The half that must NOT change: enabling a feature for a role still grants
   * only the primary action, so this fix widens what an owner may GRANT and
   * never what anybody automatically HOLDS.
   */
  check('but a role switching Purchasing on still starts at view only',
    roleDefault.includes(PERMISSIONS.PURCHASE_VIEW) &&
      !roleDefault.includes(PERMISSIONS.PURCHASE_APPROVE),
    `role default: ${roleDefault.join(', ')}`)

  check('and a feature nobody bought sells no permissions at all',
    permissionsSoldByFeatures([]).length === 0)

  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.featurePackage.delete({ where: { id: pkg.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
