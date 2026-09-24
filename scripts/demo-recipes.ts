/**
 * Demo prep recipes for Kitchen Production — LOCAL ONLY.
 *
 * The Make an Item tab is now the recipe editor plus a list of saved recipes
 * to produce from. The demo restaurant has one recipe, so the list shows a
 * single card and demonstrates nothing. This adds a few more, built from raw
 * items that are actually on the shelf, so the cards carry real FIFO costs and
 * one of them is deliberately short of stock.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 *
 * It moves no stock and creates no production orders. A recipe is a statement
 * about how something is made; saving one is exactly the act that moves
 * nothing, which is the whole point of the first screen. Producing from these
 * is left to whoever is looking at the screen — and doing so runs the real
 * FIFO draw against real lots, which is what makes it worth testing.
 *
 * Run:    npx tsx --tsconfig tsconfig.test.json scripts/demo-recipes.ts
 * Remove: npx tsx --tsconfig tsconfig.test.json scripts/demo-recipes.ts --clean
 */
import { readFileSync } from 'node:fs'

import type { StockUnit } from '@prisma/client'

import { prisma } from '../src/server/db/prisma'

const OWNER_EMAIL = 'owner@restaurantos.dev'

/**
 * Local database only — the same rule `scripts/guard-local-db.mjs` applies to
 * `prisma db push`, and for the same reason. This invents recipes and prepared
 * items; against a real restaurant that is somebody else's menu appearing in
 * their kitchen, and `--clean` only partly undoes it.
 */
function assertLocalDatabase() {
  const raw =
    process.env.DATABASE_URL ??
    ['.env.local', '.env']
      .map((file) => {
        try {
          return readFileSync(file, 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.+)$/m)?.[1]
        } catch {
          return undefined
        }
      })
      .find(Boolean)
      ?.trim()
      .replace(/^["']|["']$/g, '')

  if (!raw) throw new Error('DATABASE_URL is not set — refusing to write demo rows into the unknown.')

  let host = ''
  try {
    host = new URL(raw).hostname
  } catch {
    throw new Error('DATABASE_URL is not a valid URL, so its host cannot be checked.')
  }

  const LOCAL = ['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'postgres', 'db']
  if (!LOCAL.includes(host) && !host.endsWith('.local')) {
    throw new Error(`Refusing to write demo recipes into ${host}. This script is for a local demo database only.`)
  }
}

/** Every recipe this script makes carries it, so `--clean` finds them again. */
const MARK = '[demo recipe]'

/** What to make, and out of what. Ingredient names are matched on the shelf. */
const PLAN: Array<{
  name: string
  category: string
  yieldQty: number
  yieldUnit: StockUnit
  instructions: string
  lines: Array<{ item: string; quantity: number; unit: StockUnit }>
}> = [
  {
    name: 'Pizza Sauce Base',
    category: 'Sauce',
    yieldQty: 5,
    yieldUnit: 'LITRE',
    instructions: 'Reduce the tomato sauce with oil and basil over a low flame for 40 minutes.',
    lines: [
      { item: 'Tomato Sauce', quantity: 4, unit: 'LITRE' },
      { item: 'Olive Oil', quantity: 0.5, unit: 'LITRE' },
      { item: 'Fresh Basil', quantity: 2, unit: 'PACK' },
    ],
  },
  {
    name: 'Marinated Chicken',
    category: 'Semi-finished',
    yieldQty: 2,
    yieldUnit: 'KG',
    instructions: 'Marinate overnight, then grill to colour. Cool before storing.',
    lines: [
      { item: 'Chicken Breast', quantity: 2.5, unit: 'KG' },
      { item: 'Olive Oil', quantity: 0.2, unit: 'LITRE' },
    ],
  },
  {
    /*
     * Deliberately asks for more paneer than the shelf holds, so the card
     * carries a "short" badge and the order panel's stock check has something
     * to refuse. A screen that only ever shows the happy path is untested.
     */
    name: 'Paneer Filling',
    category: 'Semi-finished',
    yieldQty: 3,
    yieldUnit: 'KG',
    instructions: 'Crumble, season and fold through warmed sauce.',
    lines: [
      { item: 'Paneer', quantity: 3, unit: 'KG' },
      { item: 'Tomato Sauce', quantity: 0.5, unit: 'LITRE' },
    ],
  },
]

async function main() {
  assertLocalDatabase()
  const clean = process.argv.includes('--clean')

  const owner = await prisma.user.findFirst({
    where: { email: OWNER_EMAIL },
    select: { id: true, restaurantId: true },
  })
  if (!owner?.restaurantId) {
    console.log(`No ${OWNER_EMAIL} with a restaurant on this database — nothing to do.`)
    return
  }
  const restaurantId = owner.restaurantId

  if (clean) {
    const recipes = await prisma.recipe.findMany({
      where: { restaurantId, prepNotes: { contains: MARK } },
      select: { id: true, producesItemId: true },
    })
    const itemIds = recipes.map((r) => r.producesItemId).filter((id): id is string => Boolean(id))
    await prisma.recipeIngredient.deleteMany({ where: { recipeId: { in: recipes.map((r) => r.id) } } })
    const gone = await prisma.recipe.deleteMany({ where: { id: { in: recipes.map((r) => r.id) } } })
    /*
     * The prepared items go too, but only the ones nothing has happened to.
     * An item with a production run behind it is a record, not scaffolding.
     */
    const removable = await prisma.inventoryItem.findMany({
      where: { id: { in: itemIds }, producedRuns: { none: {} }, movements: { none: {} } },
      select: { id: true, name: true },
    })
    await prisma.inventoryStock.deleteMany({ where: { itemId: { in: removable.map((i) => i.id) } } })
    await prisma.inventoryItem.deleteMany({ where: { id: { in: removable.map((i) => i.id) } } })
    console.log(`Removed ${gone.count} demo recipe(s) and ${removable.length} unused prepared item(s).`)
    return
  }

  const branch = await prisma.branch.findFirst({
    where: { restaurantId, deletedAt: null, isActive: true, type: 'BRANCH' },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true },
  })
  if (!branch) {
    console.log('No location on this restaurant — nothing to make anything at.')
    return
  }

  const shelf = await prisma.inventoryItem.findMany({
    where: { restaurantId, isPrepared: false },
    select: { id: true, name: true, unit: true },
  })
  const byName = new Map(shelf.map((item) => [item.name.toLowerCase(), item]))

  let made = 0
  for (const entry of PLAN) {
    const lines = entry.lines
      .map((line) => ({ ...line, item: byName.get(line.item.toLowerCase()) }))
      .filter((line): line is typeof line & { item: { id: string } } => Boolean(line.item))

    if (lines.length !== entry.lines.length) {
      console.log(`Skipped ${entry.name} — its ingredients are not on this shelf.`)
      continue
    }

    const existing = await prisma.inventoryItem.findFirst({
      where: { restaurantId, name: entry.name },
      select: { id: true },
    })
    const item =
      existing ??
      (await prisma.inventoryItem.create({
        data: {
          restaurantId,
          name: entry.name,
          unit: entry.yieldUnit,
          category: entry.category,
          quantity: 0,
          costPerUnit: 0,
          branchId: branch.id,
        },
        select: { id: true },
      }))

    if (await prisma.recipe.findFirst({ where: { producesItemId: item.id, isActive: true } })) {
      console.log(`${entry.name} already has a recipe — leaving it alone.`)
      continue
    }

    await prisma.recipe.create({
      data: {
        restaurantId,
        producesItemId: item.id,
        name: entry.name,
        yieldQty: entry.yieldQty,
        yieldUnit: entry.yieldUnit,
        isActive: true,
        version: 1,
        prepNotes: `${entry.instructions} ${MARK}`,
        createdById: owner.id,
        ingredients: {
          create: lines.map((line, index) => ({
            inventoryItemId: line.item.id,
            quantity: line.quantity,
            unit: line.unit,
            sortOrder: index,
          })),
        },
      },
    })
    made += 1
  }

  console.log(`Saved ${made} demo recipe(s) at ${branch.name}. Nothing left the shelf.`)
  console.log('Remove them again with:  npx tsx --tsconfig tsconfig.test.json scripts/demo-recipes.ts --clean')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
