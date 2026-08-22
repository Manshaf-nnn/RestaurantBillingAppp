/** Phase 3: recipes, nesting, yield, and idempotent depletion. */
import { prisma } from '../src/server/db/prisma'
import { reconcileOrderDepletion } from '../src/features/inventory/depletion'
import { resolveRecipe } from '../src/features/inventory/recipe-resolver'
import { getFoodCost } from '../src/features/inventory/food-cost'
import { setOpeningBalance } from '../src/features/inventory/operations'
import { ensureDefaultBranch } from '../src/features/branches/service'

let pass = 0, fail = 0
const items: string[] = [], foods: string[] = [], recipes: string[] = [], orders: string[] = []

function ok(n: string, c: boolean, d = '') { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)) }
async function throws(n: string, fn: () => Promise<unknown>, code?: string) {
  try { await fn(); fail++; console.log(`  ✗ ${n} — expected rejection`) }
  catch (e) { const c = (e as { code?: string }).code
    if (code && c !== code) { fail++; console.log(`  ✗ ${n} — wanted ${code}, got ${c}`) }
    else { pass++; console.log(`  ✓ ${n} (${c ?? 'rejected'})`) } }
}
const qty = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).quantity

async function main() {
  const shop = await prisma.restaurant.findFirstOrThrow({ where: { slug: 'the-copper-spoon' } })

  /*
   * Where the stock in this fixture lives.
   *
   * The ledger will not post a movement without a location — a movement that
   * names no place updates the restaurant's total and nobody's balance, which
   * is exactly the drift these tests exist to catch.
   */
  const shopBranch = (await ensureDefaultBranch(shop.id)).id
  const user = await prisma.user.findFirstOrThrow({ where: { restaurantId: shop.id, deletedAt: null } })
  const category = await prisma.category.findFirstOrThrow({ where: { restaurantId: shop.id, deletedAt: null } })
  // Orders carry a required branch now.
  const branch = await prisma.branch.findFirstOrThrow({
    where: { restaurantId: shop.id, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
  const S = Date.now().toString(36)

  const mkItem = async (name: string, unit: 'PIECE' | 'GRAM' | 'KG', cost = 0) => {
    const i = await prisma.inventoryItem.create({
      data: { restaurantId: shop.id, name: `${name}-${S}`, unit, costPerUnit: cost },
    })
    items.push(i.id); return i
  }
  const mkFood = async (name: string, price: number) => {
    const f = await prisma.food.create({
      data: { restaurantId: shop.id, categoryId: category.id, name: `${name}-${S}`, slug: `${name}-${S}`.toLowerCase(), price },
    })
    foods.push(f.id); return f
  }

  console.log('\n── Setup: the burger from the spec ──────────────────────')
  const bun = await mkItem('Bun', 'PIECE', 5000)
  const patty = await mkItem('Chicken Patty', 'PIECE', 20000)
  const cheese = await mkItem('Cheese', 'PIECE', 3000)
  const lettuce = await mkItem('Lettuce', 'GRAM', 20)
  const sauce = await mkItem('Sauce', 'GRAM', 30)

  for (const [item, q] of [[bun, 10], [patty, 10], [cheese, 10], [lettuce, 1000], [sauce, 1000]] as const) {
    await setOpeningBalance({ restaurantId: shop.id, branchId: shopBranch, itemId: item.id, quantity: q, userId: user.id })
  }
  ok('opening balances set', await qty(bun.id) === 10 && await qty(lettuce.id) === 1000)

  const burger = await mkFood('Chicken Burger', 120000)
  const recipe = await prisma.recipe.create({
    data: {
      restaurantId: shop.id, foodId: burger.id, version: 1, isActive: true, yieldQty: 1,
      ingredients: {
        create: [
          { inventoryItemId: bun.id, quantity: 1, unit: 'PIECE' },
          { inventoryItemId: patty.id, quantity: 1, unit: 'PIECE' },
          { inventoryItemId: cheese.id, quantity: 1, unit: 'PIECE' },
          { inventoryItemId: lettuce.id, quantity: 20, unit: 'GRAM' },
          { inventoryItemId: sauce.id, quantity: 15, unit: 'GRAM' },
        ],
      },
    },
  })
  recipes.push(recipe.id)

  const mkOrder = async (burgerQty: number) => {
    const o = await prisma.order.create({
      data: {
        restaurantId: shop.id, branchId: branch.id,
        orderNumber: `T3-${S}-${orders.length}`, type: 'COUNTER',
        status: 'PENDING', paymentStatus: 'UNPAID', customerName: 'Test', customerPhone: '0700000000',
        subtotal: 0, grandTotal: 0,
        items: { create: [{ foodId: burger.id, name: burger.name, unitPrice: 120000, quantity: burgerQty, lineTotal: 120000 * burgerQty }] },
      },
    })
    orders.push(o.id); return o
  }

  console.log('\n── 1. Sell 2 burgers ────────────────────────────────────')
  const order = await mkOrder(2)
  await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: order.id, userId: user.id }))

  ok('buns 10 → 8', await qty(bun.id) === 8, `got ${await qty(bun.id)}`)
  ok('patties 10 → 8', await qty(patty.id) === 8, `got ${await qty(patty.id)}`)
  ok('cheese 10 → 8', await qty(cheese.id) === 8, `got ${await qty(cheese.id)}`)
  ok('lettuce 1000 → 960 g', await qty(lettuce.id) === 960, `got ${await qty(lettuce.id)}`)
  ok('sauce 1000 → 970 g', await qty(sauce.id) === 970, `got ${await qty(sauce.id)}`)

  const saleRows = await prisma.stockMovement.findMany({ where: { orderId: order.id, type: 'SALE' } })
  ok('five SALE ledger rows were written', saleRows.length === 5, `got ${saleRows.length}`)
  ok('each references the order', saleRows.every((r) => r.referenceType === 'Order' && r.referenceId === order.id))

  console.log('\n── 2. Duplicate processing ──────────────────────────────')
  for (let i = 0; i < 3; i++) {
    await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: order.id, userId: user.id }))
  }
  ok('running 3 more times changes nothing', await qty(bun.id) === 8 && await qty(lettuce.id) === 960)
  const after = await prisma.stockMovement.count({ where: { orderId: order.id } })
  ok('no extra ledger rows were created', after === 5, `got ${after}`)

  console.log('\n── 3. Quantity change 2 → 3 ─────────────────────────────')
  await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { quantity: 3 } })
  await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: order.id, userId: user.id }))
  ok('buns 8 → 7 (only one more)', await qty(bun.id) === 7, `got ${await qty(bun.id)}`)
  ok('lettuce 960 → 940 (only 20 g more)', await qty(lettuce.id) === 940, `got ${await qty(lettuce.id)}`)
  ok('sauce 970 → 955 (only 15 g more)', await qty(sauce.id) === 955, `got ${await qty(sauce.id)}`)

  console.log('\n── 4. Quantity change 3 → 1 ─────────────────────────────')
  await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { quantity: 1 } })
  await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: order.id, userId: user.id }))
  ok('buns 7 → 9 (two returned)', await qty(bun.id) === 9, `got ${await qty(bun.id)}`)
  ok('lettuce 940 → 980 (40 g returned)', await qty(lettuce.id) === 980, `got ${await qty(lettuce.id)}`)
  const reversals = await prisma.stockMovement.findMany({ where: { orderId: order.id, type: 'SALE_REVERSAL' } })
  ok('returns are logged as SALE_REVERSAL', reversals.length === 5, `got ${reversals.length}`)

  console.log('\n── 5. Cancellation ──────────────────────────────────────')
  await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: order.id, userId: user.id, releaseAll: true }))
  ok('everything is back: buns 10', await qty(bun.id) === 10, `got ${await qty(bun.id)}`)
  ok('everything is back: lettuce 1000 g', await qty(lettuce.id) === 1000, `got ${await qty(lettuce.id)}`)
  ok('everything is back: sauce 1000 g', await qty(sauce.id) === 1000, `got ${await qty(sauce.id)}`)
  const depletions = await prisma.orderStockDepletion.findMany({ where: { orderId: order.id } })
  ok('the depletion record nets to zero', depletions.every((d) => Math.abs(d.appliedQty) < 1e-6))
  await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: order.id, userId: user.id, releaseAll: true }))
  ok('cancelling twice does not double-return', await qty(bun.id) === 10)

  console.log('\n── 6. Prep recipe with yield ────────────────────────────')
  const mayo = await mkItem('Mayonnaise', 'GRAM', 40)
  const ketchup = await mkItem('Ketchup', 'GRAM', 20)
  await setOpeningBalance({ restaurantId: shop.id, branchId: shopBranch, itemId: mayo.id, quantity: 5000, userId: user.id })
  await setOpeningBalance({ restaurantId: shop.id, branchId: shopBranch, itemId: ketchup.id, quantity: 5000, userId: user.id })

  // One batch yields 2 kg: 1500 g mayo + 500 g ketchup.
  const sauceRecipe = await prisma.recipe.create({
    data: {
      restaurantId: shop.id, name: 'Burger Sauce', version: 1, isActive: true,
      yieldQty: 2000, yieldUnit: 'GRAM',
      ingredients: { create: [
        { inventoryItemId: mayo.id, quantity: 1500, unit: 'GRAM' },
        { inventoryItemId: ketchup.id, quantity: 500, unit: 'GRAM' },
      ] },
    },
  })
  recipes.push(sauceRecipe.id)

  const burger2 = await mkFood('Sauce Burger', 100000)
  const r2 = await prisma.recipe.create({
    data: {
      restaurantId: shop.id, foodId: burger2.id, version: 1, isActive: true, yieldQty: 1,
      ingredients: { create: [
        { inventoryItemId: bun.id, quantity: 1, unit: 'PIECE' },
        { subRecipeId: sauceRecipe.id, quantity: 20, unit: 'GRAM' },
      ] },
    },
  })
  recipes.push(r2.id)

  const resolved = await resolveRecipe(prisma, { restaurantId: shop.id, recipeId: r2.id, portions: 1 })
  const mayoLine = resolved.ingredients.find((i) => i.itemId === mayo.id)
  const ketLine = resolved.ingredients.find((i) => i.itemId === ketchup.id)
  // 20 g of a 2000 g batch = 1%. 1% of 1500 g mayo = 15 g; of 500 g ketchup = 5 g.
  ok('20 g of sauce uses 15 g mayonnaise', mayoLine?.quantity === 15, `got ${mayoLine?.quantity}`)
  ok('20 g of sauce uses 5 g ketchup', ketLine?.quantity === 5, `got ${ketLine?.quantity}`)
  ok('no problems reported', resolved.problems.length === 0, resolved.problems.join('; '))

  console.log('\n── 7. Wastage percentage ────────────────────────────────')
  const trimmed = await mkFood('Trimmed Dish', 50000)
  const rw = await prisma.recipe.create({
    data: { restaurantId: shop.id, foodId: trimmed.id, version: 1, isActive: true, yieldQty: 1,
      ingredients: { create: [{ inventoryItemId: lettuce.id, quantity: 100, unit: 'GRAM', wastagePercent: 5 }] } },
  })
  recipes.push(rw.id)
  const rwResolved = await resolveRecipe(prisma, { restaurantId: shop.id, recipeId: rw.id, portions: 1 })
  ok('100 g with 5% trim removes 105 g', rwResolved.ingredients[0]?.quantity === 105, `got ${rwResolved.ingredients[0]?.quantity}`)

  console.log('\n── 8. Cycle safety ──────────────────────────────────────')
  const loopA = await prisma.recipe.create({ data: { restaurantId: shop.id, name: 'A', version: 1, yieldQty: 1, yieldUnit: 'GRAM' } })
  const loopB = await prisma.recipe.create({ data: { restaurantId: shop.id, name: 'B', version: 1, yieldQty: 1, yieldUnit: 'GRAM' } })
  recipes.push(loopA.id, loopB.id)
  await prisma.recipeIngredient.create({ data: { recipeId: loopA.id, subRecipeId: loopB.id, quantity: 1, unit: 'GRAM' } })
  await prisma.recipeIngredient.create({ data: { recipeId: loopB.id, subRecipeId: loopA.id, quantity: 1, unit: 'GRAM' } })
  await throws('a recipe loop is caught, not hung',
    () => resolveRecipe(prisma, { restaurantId: shop.id, recipeId: loopA.id, portions: 1 }), 'RECIPE_CYCLE')

  console.log('\n── 9. Food cost ─────────────────────────────────────────')
  const cost = await getFoodCost({ restaurantId: shop.id, foodId: burger.id })
  // 1×50 + 1×200 + 1×30 + 20×0.20 + 15×0.30 = 288.50 → 28850 minor
  ok('ingredient cost is computed from the recipe', cost.ingredientCost === 28850, `got ${cost.ingredientCost}`)
  ok('selling price carried through', cost.sellingPrice === 120000)
  ok('gross profit = price − cost', cost.grossProfit === 120000 - 28850)
  ok('food cost % is right', Math.abs((cost.foodCostPercent ?? 0) - 24.04) < 0.05, `got ${cost.foodCostPercent}`)
  ok('every ingredient is listed', cost.ingredients.length === 5)
  const noRecipe = await mkFood('No Recipe Dish', 10000)
  const nc = await getFoodCost({ restaurantId: shop.id, foodId: noRecipe.id })
  ok('a dish with no recipe says so rather than claiming zero cost', nc.problems.length > 0 && nc.foodCostPercent === null)

  console.log('\n── 10. Versioning ───────────────────────────────────────')
  const v2 = await prisma.recipe.create({
    data: { restaurantId: shop.id, foodId: burger.id, version: 2, isActive: true, yieldQty: 1,
      ingredients: { create: [{ inventoryItemId: patty.id, quantity: 2, unit: 'PIECE' }] } },
  })
  recipes.push(v2.id)
  await prisma.recipe.update({ where: { id: recipe.id }, data: { isActive: false } })

  const pinnedOrder = await mkOrder(1)
  await prisma.orderItem.updateMany({ where: { orderId: pinnedOrder.id }, data: { recipeId: recipe.id } })
  const pattyBefore = await qty(patty.id)
  await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: pinnedOrder.id, userId: user.id }))
  ok('a pinned old version still deducts 1 patty, not 2',
    await qty(patty.id) === pattyBefore - 1, `${pattyBefore} -> ${await qty(patty.id)}`)
  ok('the old recipe row still exists', (await prisma.recipe.findUnique({ where: { id: recipe.id } })) !== null)

  const unpinned = await mkOrder(1)
  const pattyBefore2 = await qty(patty.id)
  await prisma.$transaction((tx) => reconcileOrderDepletion(tx, { restaurantId: shop.id, orderId: unpinned.id, userId: user.id }))
  ok('a new order uses v2 and deducts 2 patties',
    await qty(patty.id) === pattyBefore2 - 2, `${pattyBefore2} -> ${await qty(patty.id)}`)

  // cleanup
  await prisma.orderStockDepletion.deleteMany({ where: { orderId: { in: orders } } })
  await prisma.stockMovement.deleteMany({ where: { OR: [{ orderId: { in: orders } }, { itemId: { in: items } }] } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orders } } })
  await prisma.orderEvent.deleteMany({ where: { orderId: { in: orders } } })
  await prisma.order.deleteMany({ where: { id: { in: orders } } })
  await prisma.recipeIngredient.deleteMany({ where: { recipeId: { in: recipes } } })
  await prisma.recipe.deleteMany({ where: { id: { in: recipes } } })
  await prisma.food.deleteMany({ where: { id: { in: foods } } })
  await prisma.inventoryItem.deleteMany({ where: { id: { in: items } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\nCRASHED:', e)
  await prisma.orderStockDepletion.deleteMany({ where: { orderId: { in: orders } } }).catch(() => {})
  await prisma.stockMovement.deleteMany({ where: { OR: [{ orderId: { in: orders } }, { itemId: { in: items } }] } }).catch(() => {})
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orders } } }).catch(() => {})
  await prisma.orderEvent.deleteMany({ where: { orderId: { in: orders } } }).catch(() => {})
  await prisma.order.deleteMany({ where: { id: { in: orders } } }).catch(() => {})
  await prisma.recipeIngredient.deleteMany({ where: { recipeId: { in: recipes } } }).catch(() => {})
  await prisma.recipe.deleteMany({ where: { id: { in: recipes } } }).catch(() => {})
  await prisma.food.deleteMany({ where: { id: { in: foods } } }).catch(() => {})
  await prisma.inventoryItem.deleteMany({ where: { id: { in: items } } }).catch(() => {})
  await prisma.$disconnect()
  process.exit(1)
})
