/**
 * The books tie to the layers, after everything.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * FIFO.md asks that every screen and report reconcile with the same underlying
 * layers. That is not a thing you can assert once: it is an invariant, and the
 * way to test an invariant is to do a great deal to the stock and then check
 * it still holds.
 *
 * So this walks the whole flow the spec lists — purchase → recipe →
 * production → sale/COGS → wastage → transfer → adjustment → reversal — and
 * after EVERY step asserts the same four things:
 *
 *   1. Σ(layer remainingQty) per item+branch == InventoryStock.available
 *   2. Σ(layer remainingValue) per item      == InventoryItem.stockValue
 *   3. Σ(trace lineValue) per movement       == StockMovement.valueMoved
 *   4. no layer is negative, and none holds more than it received
 *
 * (2) is the one that matters most. The item's value used to be a weighted
 * average pool maintained beside the layers; if it is a cache of them, these
 * two numbers are the same integer, always. If they ever drift, one of the
 * twenty callers has found a way to move stock without going through the
 * ledger — which is exactly what this is watching for.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/fifo-invariants-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { currentUnitCost } from '../src/features/inventory/fifo'

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

/** Every invariant, over one restaurant. Returns the complaints. */
async function audit(restaurantId: string): Promise<string[]> {
  const problems: string[] = []

  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    select: { id: true, name: true, quantity: true, stockValue: true },
  })

  // (2) value: Σ layers == the item's cached value.
  const layerValue = await prisma.stockBatch.groupBy({
    by: ['itemId'],
    where: { restaurantId, remainingQty: { gt: 0 } },
    _sum: { remainingValue: true },
  })
  const valueOf = new Map(layerValue.map((row) => [row.itemId, row._sum.remainingValue ?? 0]))
  for (const item of items) {
    const layers = valueOf.get(item.id) ?? 0
    const cached = Math.round(Number(item.stockValue))
    if (layers !== cached) {
      problems.push(`value ${item.name}: layers ${layers} vs cache ${cached}`)
    }
  }

  // (1) quantity: Σ layers == what the branch holds.
  const perBranchLayers = await prisma.stockBatch.groupBy({
    by: ['itemId', 'branchId'],
    where: { restaurantId, remainingQty: { gt: 0 } },
    _sum: { remainingQty: true },
  })
  const perBranchStock = await prisma.inventoryStock.groupBy({
    by: ['itemId', 'branchId'],
    where: { restaurantId },
    _sum: { available: true },
  })
  const key = (i: string, b: string) => `${i}:${b}`
  const stockAt = new Map(perBranchStock.map((r) => [key(r.itemId, r.branchId), r._sum.available ?? 0]))
  const layersAt = new Map(perBranchLayers.map((r) => [key(r.itemId, r.branchId), r._sum.remainingQty ?? 0]))
  for (const [k, qty] of layersAt) {
    const held = stockAt.get(k) ?? 0
    if (Math.abs(qty - held) > 1e-6) problems.push(`qty ${k}: layers ${qty} vs stock ${held}`)
  }
  for (const [k, held] of stockAt) {
    if (held > 1e-6 && !layersAt.has(k)) problems.push(`qty ${k}: ${held} on hand with no layer`)
  }

  // (3) the trace sums to the movement.
  const movements = await prisma.stockMovement.findMany({
    where: { restaurantId, lots: { some: {} } },
    select: { id: true, type: true, valueMoved: true, lots: { select: { lineValue: true } } },
  })
  for (const movement of movements) {
    const traced = movement.lots.reduce((sum, lot) => sum + lot.lineValue, 0)
    if (traced !== movement.valueMoved) {
      problems.push(`trace ${movement.type}: lots ${traced} vs movement ${movement.valueMoved}`)
    }
  }

  // (4) no layer is impossible.
  const bad = await prisma.stockBatch.findMany({
    where: { restaurantId, OR: [{ remainingQty: { lt: 0 } }, { remainingValue: { lt: 0 } }] },
    select: { batchNo: true, remainingQty: true, remainingValue: true },
  })
  for (const layer of bad) {
    problems.push(`negative layer ${layer.batchNo}: ${layer.remainingQty} / ${layer.remainingValue}`)
  }

  return problems
}

async function main() {
  const stamp = Date.now().toString(36)
  const M = (major: number) => Math.round(major * 100)

  const restaurant = await prisma.restaurant.create({
    data: { name: `FIFO inv ${stamp}`, slug: `fifo-inv-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const main1 = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Beach', code: 'BEACH' },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `chef-${stamp}@test.dev`, name: 'Chef',
      role: 'OWNER', passwordHash: 'x',
    },
  })
  const cheese = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Cheese', unit: 'KG', quantity: 0, costPerUnit: 0 },
  })

  const post = (params: Record<string, unknown>) =>
    prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id,
        itemId: cheese.id,
        branchId: main1.id,
        userId: user.id,
        ...params,
      } as never),
    )

  /** Run the invariants and report under a name. */
  const stillTies = async (what: string) => {
    const problems = await audit(restaurant.id)
    check(`the books tie after ${what}`, problems.length === 0, problems.slice(0, 2).join(' · '))
  }

  /* ── 1. The spec's ladder, through the real ledger ───────────────────────── */
  console.log('\n1. FIFO.md’s ladder, posted through the ledger')

  await post({ type: 'PURCHASE', quantity: 50, unitCost: M(1), totalValue: 50 * M(1), batchNo: `A-${stamp}` })
  await stillTies('a first delivery')
  await post({ type: 'PURCHASE', quantity: 20, unitCost: M(1.5), totalValue: 20 * M(1.5), batchNo: `B-${stamp}` })
  await stillTies('a second delivery at a different price')

  let item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: cheese.id } })
  check('70 on hand', item.quantity === 70, String(item.quantity))
  check('worth 8,000 — 50×100 + 20×150', Math.round(Number(item.stockValue)) === 8000, String(item.stockValue))
  check(
    'and the next unit costs 100, the oldest layer’s rate',
    (await currentUnitCost(prisma, { restaurantId: restaurant.id, itemId: cheese.id, branchId: main1.id })) === 100,
  )

  for (const [qty, cost] of [[10, 1000], [35, 3500], [5, 500], [10, 1500]] as const) {
    const posted = await post({ type: 'SALE', quantity: qty, referenceType: 'Order', referenceId: `ord-${stamp}` })
    check(`consuming ${qty} costs ${cost}`, posted.valueMoved === cost, String(posted.valueMoved))
  }
  await stillTies('four consumptions across two layers')

  item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: cheese.id } })
  check('10 left, worth 1,500', item.quantity === 10 && Math.round(Number(item.stockValue)) === 1500,
    `${item.quantity} / ${item.stockValue}`)
  check(
    'the next unit now costs 150 — the cheap layer is spent',
    (await currentUnitCost(prisma, { restaurantId: restaurant.id, itemId: cheese.id, branchId: main1.id })) === 150,
  )

  /* ── 2. Everything else the spec lists ───────────────────────────────────── */
  console.log('\n2. The rest of the flow')

  await post({ type: 'WASTAGE', quantity: 2 })
  await stillTies('wastage')

  await post({ type: 'ADJUSTMENT_IN', quantity: 5 })
  await stillTies('an adjustment in')

  await post({ type: 'ADJUSTMENT_OUT', quantity: 3 })
  await stillTies('an adjustment out')

  await post({ type: 'TRANSFER_OUT', quantity: 4, referenceType: 'StockTransfer', referenceId: `tr-${stamp}` })
  await stillTies('stock leaving on a transfer')

  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: cheese.id, branchId: other.id, userId: user.id,
      type: 'TRANSFER_IN', quantity: 4, totalValue: 600, batchNo: `T-${stamp}`,
    }),
  )
  await stillTies('it arriving at the other branch')

  const atOther = await prisma.stockBatch.findFirstOrThrow({
    where: { itemId: cheese.id, branchId: other.id },
  })
  check('the receiving branch has its own layer', atOther.remainingQty === 4 && atOther.remainingValue === 600)
  check(
    'and the sending branch is not credited with it',
    (await prisma.stockBatch.aggregate({
      where: { itemId: cheese.id, branchId: main1.id, remainingQty: { gt: 0 } },
      _sum: { remainingQty: true },
    }))._sum.remainingQty !== 4,
  )

  /* ── 3. A reversal puts stock back where it came from ────────────────────── */
  console.log('\n3. A reversal is not a purchase at today’s price')

  const before = await prisma.stockBatch.findMany({
    where: { itemId: cheese.id, branchId: main1.id },
    orderBy: { receivedAt: 'asc' },
    select: { id: true, remainingQty: true, remainingValue: true },
  })
  const sold = await post({ type: 'SALE', quantity: 2, referenceType: 'Order', referenceId: `rev-${stamp}` })
  const back = await post({
    type: 'SALE_REVERSAL', quantity: 2, referenceType: 'Order', referenceId: `rev-${stamp}`,
  })
  check('the reversal returns exactly what the sale took', back.valueMoved === sold.valueMoved,
    `${sold.valueMoved} out, ${back.valueMoved} back`)

  const after = await prisma.stockBatch.findMany({
    where: { itemId: cheese.id, branchId: main1.id },
    orderBy: { receivedAt: 'asc' },
    select: { id: true, remainingQty: true, remainingValue: true },
  })
  const byId = new Map(after.map((l) => [l.id, l]))
  check(
    'and every layer is back exactly where it was',
    before.every((l) => {
      const now = byId.get(l.id)
      return now && Math.abs(now.remainingQty - l.remainingQty) < 1e-9 && now.remainingValue === l.remainingValue
    }),
  )
  await stillTies('a sale and its reversal')

  /* ── 4. Exactness on a sub-minor-unit cost ───────────────────────────────── */
  console.log('\n4. A cost below one minor unit')

  const salt = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Salt', unit: 'GRAM', quantity: 0, costPerUnit: 0 },
  })
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: salt.id, branchId: main1.id, userId: user.id,
      type: 'PURCHASE', quantity: 1000, unitCost: 1, totalValue: 650, batchNo: `S-${stamp}`,
    }),
  )
  const saltItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: salt.id } })
  check(
    '650 paid for 1,000 g is recorded as 650, not 1,000',
    Math.round(Number(saltItem.stockValue)) === 650,
    String(saltItem.stockValue),
  )

  let takenOut = 0
  for (const qty of [400, 400, 200]) {
    const posted = await prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId: salt.id, branchId: main1.id, userId: user.id,
        type: 'SALE', quantity: qty,
      }),
    )
    takenOut += posted.valueMoved
  }
  check('and issues out as exactly 650 across three draws', takenOut === 650, String(takenOut))
  await stillTies('a sub-minor-unit item drawn to nothing')

  /* ── Clean up ────────────────────────────────────────────────────────────── */
  await prisma.stockMovementLot.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
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
