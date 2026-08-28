/** Phase 6: locations, production house, inter-location transfers. */
import { prisma } from '../src/server/db/prisma'
import {
  requestTransfer, approveTransfer, dispatchTransfer, receiveTransfer, closeTransfer,
  recallTransfer, canTransition,
} from '../src/features/transfers/service'
import {
  createProductionOrder, setProductionStatus, completeProduction,
} from '../src/features/production/service'
import { saveRecipe } from '../src/features/recipes/service'
import { getLocationBalance, getItemAcrossLocations } from '../src/features/inventory/location-stock'
import { setOpeningBalance } from '../src/features/inventory/operations'
import { recomputeBalance, directionOf } from '../src/features/inventory/ledger'

let pass = 0, fail = 0
const items: string[] = [], branches: string[] = [], specs: string[] = [], shops: string[] = []
function ok(n: string, c: boolean, d = '') { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)) }
async function throws(n: string, fn: () => Promise<unknown>, code?: string) {
  try { await fn(); fail++; console.log(`  ✗ ${n} — expected rejection`) }
  catch (e) { const c = (e as { code?: string }).code
    if (code && c !== code) { fail++; console.log(`  ✗ ${n} — wanted ${code}, got ${c}`) }
    else { pass++; console.log(`  ✓ ${n} (${c ?? 'rejected'})`) } }
}

async function main() {
  const S = Date.now().toString(36)
  const shop = await prisma.restaurant.create({
    data: { name: `ABC ${S}`, slug: `abc-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  shops.push(shop.id)
  const user = await prisma.user.findFirstOrThrow({ where: { deletedAt: null } })

  const mkLoc = async (name: string, type: 'BRANCH' | 'PRODUCTION_HOUSE' | 'CENTRAL_WAREHOUSE', code: string) => {
    const b = await prisma.branch.create({
      data: { restaurantId: shop.id, name, code, type, isDefault: code === 'WH' },
    })
    branches.push(b.id); return b
  }
  const mkItem = async (name: string, unit: 'KG' | 'PIECE', extra: Record<string, unknown> = {}) => {
    const i = await prisma.inventoryItem.create({
      data: { restaurantId: shop.id, name: `${name}-${S}`, unit, costPerUnit: 100_00, ...extra },
    })
    items.push(i.id); return i
  }
  const avail = async (itemId: string, branchId: string) =>
    (await getLocationBalance({ restaurantId: shop.id, itemId, branchId })).available
  const transit = async (itemId: string, branchId: string) =>
    (await getLocationBalance({ restaurantId: shop.id, itemId, branchId })).inTransit

  console.log('\n── 1. Locations ─────────────────────────────────────────')
  const warehouse = await mkLoc('Central Warehouse', 'CENTRAL_WAREHOUSE', 'WH')
  const ph = await mkLoc('ABC Production House', 'PRODUCTION_HOUSE', 'PH')
  const colombo = await mkLoc('Colombo', 'BRANCH', 'COL')
  const kandy = await mkLoc('Kandy', 'BRANCH', 'KAN')
  const galle = await mkLoc('Galle', 'BRANCH', 'GAL')
  ok('five locations of three types created', branches.length === 5)
  ok('types are distinct', warehouse.type === 'CENTRAL_WAREHOUSE' && ph.type === 'PRODUCTION_HOUSE' && colombo.type === 'BRANCH')

  console.log('\n── 2. Stock at the production house ─────────────────────')
  const chicken = await mkItem('Chicken', 'KG', { branchId: ph.id })
  const spices = await mkItem('Spices', 'KG', { branchId: ph.id })
  const buns = await mkItem('Buns', 'PIECE', { branchId: colombo.id })
  const patty = await mkItem('Chicken Patty', 'PIECE', { branchId: ph.id, trackBatches: true })

  await setOpeningBalance({ restaurantId: shop.id, itemId: chicken.id, quantity: 100, userId: user.id, branchId: ph.id })
  await setOpeningBalance({ restaurantId: shop.id, itemId: spices.id, quantity: 10, userId: user.id, branchId: ph.id })
  await setOpeningBalance({ restaurantId: shop.id, itemId: buns.id, quantity: 500, userId: user.id, branchId: colombo.id })

  ok('chicken 100 kg at the production house', await avail(chicken.id, ph.id) === 100, `got ${await avail(chicken.id, ph.id)}`)
  ok('spices 10 kg at the production house', await avail(spices.id, ph.id) === 10)
  ok('buns 500 at Colombo', await avail(buns.id, colombo.id) === 500)
  ok('patties start at 0', await avail(patty.id, ph.id) === 0)
  ok('buns are not at the production house', await avail(buns.id, ph.id) === 0)

  console.log('\n── 3. Production: 100 patties ───────────────────────────')
  // One run of the recipe makes 100 patties from 20kg chicken and 2kg spices.
  const spec = await saveRecipe({
    restaurantId: shop.id, producesItemId: patty.id, name: 'Chicken Patty',
    yieldQty: 100, yieldUnit: 'PIECE', shelfLifeDays: 3,
    ingredients: [
      { inventoryItemId: chicken.id, quantity: 20, unit: 'KG' },
      { inventoryItemId: spices.id, quantity: 2, unit: 'KG' },
    ],
  })
  specs.push(spec.id)

  await throws('production at a branch is refused',
    () => createProductionOrder({ restaurantId: shop.id, branchId: colombo.id, recipeId: spec.id, plannedQty: 100, userId: user.id }),
    'NOT_PRODUCTION_HOUSE')

  const run = await createProductionOrder({
    restaurantId: shop.id, branchId: ph.id, recipeId: spec.id, plannedQty: 100, userId: user.id,
  })
  ok('run starts as DRAFT', run.status === 'DRAFT')
  ok('planning consumes nothing', await avail(chicken.id, ph.id) === 100)

  await throws('completing an unapproved run is refused',
    () => completeProduction({ restaurantId: shop.id, orderId: run.id, userId: user.id }),
    'PRODUCTION_NOT_APPROVED')

  await setProductionStatus({ restaurantId: shop.id, orderId: run.id, status: 'APPROVED', userId: user.id })
  const done = await completeProduction({ restaurantId: shop.id, orderId: run.id, userId: user.id })

  ok('chicken 100 → 80 kg', await avail(chicken.id, ph.id) === 80, `got ${await avail(chicken.id, ph.id)}`)
  ok('spices 10 → 8 kg', await avail(spices.id, ph.id) === 8, `got ${await avail(spices.id, ph.id)}`)
  ok('100 patties produced', await avail(patty.id, ph.id) === 100, `got ${await avail(patty.id, ph.id)}`)
  ok('total cost = 20×100 + 2×100', done.totalCost === (20 + 2) * 100_00, `got ${done.totalCost}`)
  ok('unit cost = cost / 100 patties', done.unitCost === Math.round(done.totalCost / 100), `got ${done.unitCost}`)
  ok('a batch number was assigned', Boolean(done.batchNumber))
  ok('shelf life set the expiry', done.order.expiryDate !== null)

  const consumption = await prisma.productionConsumption.count({ where: { orderId: run.id } })
  ok('both raw materials were recorded', consumption === 2)
  const outMv = await prisma.stockMovement.findFirst({ where: { referenceId: run.id, type: 'PRODUCTION_OUTPUT' } })
  const inMv = await prisma.stockMovement.count({ where: { referenceId: run.id, type: 'PRODUCTION_CONSUMPTION' } })
  ok('ledger has one PRODUCTION_OUTPUT', outMv !== null)
  ok('ledger has two PRODUCTION_CONSUMPTION rows', inMv === 2)
  await throws('completing twice is refused',
    () => completeProduction({ restaurantId: shop.id, orderId: run.id, userId: user.id }), 'PRODUCTION_DONE')

  console.log('\n── 4. Transfer: production house → Colombo, 40 ───────────')
  const t1 = await requestTransfer({
    restaurantId: shop.id, fromBranchId: ph.id, toBranchId: colombo.id,
    lines: [{ itemId: patty.id, quantity: 40 }], userId: user.id,
  })
  ok('transfer number issued', /^TRF-\d{6}$/.test(t1.number), t1.number)
  ok('requesting moves nothing', await avail(patty.id, ph.id) === 100)

  await approveTransfer({ restaurantId: shop.id, transferId: t1.id, userId: user.id })
  const afterApprove = await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: ph.id })
  ok('approval reserves but does not move', afterApprove.available === 100 && afterApprove.reserved === 40)
  ok('nothing is in transit yet', await transit(patty.id, colombo.id) === 0)

  await dispatchTransfer({ restaurantId: shop.id, transferId: t1.id, userId: user.id })
  ok('production house available 100 → 60', await avail(patty.id, ph.id) === 60, `got ${await avail(patty.id, ph.id)}`)
  ok('Colombo in-transit = 40', await transit(patty.id, colombo.id) === 40, `got ${await transit(patty.id, colombo.id)}`)
  ok('Colombo available still 0', await avail(patty.id, colombo.id) === 0)
  ok('the reservation was released', (await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: ph.id })).reserved === 0)

  await throws('dispatching twice is refused',
    () => dispatchTransfer({ restaurantId: shop.id, transferId: t1.id, userId: user.id }),
    'TRANSFER_BAD_TRANSITION')

  const lines1 = await prisma.stockTransferLine.findMany({ where: { transferId: t1.id } })
  await receiveTransfer({
    restaurantId: shop.id, transferId: t1.id, userId: user.id,
    lines: [{ lineId: lines1[0].id, receivedQty: 40 }],
  })
  ok('Colombo available = 40', await avail(patty.id, colombo.id) === 40, `got ${await avail(patty.id, colombo.id)}`)
  ok('Colombo in-transit cleared', await transit(patty.id, colombo.id) === 0)
  ok('production house keeps 60', await avail(patty.id, ph.id) === 60)

  console.log('\n── 5. Transfer with variance: Colombo → Kandy ───────────')
  const t2 = await requestTransfer({
    restaurantId: shop.id, fromBranchId: colombo.id, toBranchId: kandy.id,
    lines: [{ itemId: patty.id, quantity: 10 }], userId: user.id,
  })
  await approveTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id })
  await dispatchTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id })
  ok('Colombo 40 → 30', await avail(patty.id, colombo.id) === 30, `got ${await avail(patty.id, colombo.id)}`)
  ok('Kandy in-transit = 10', await transit(patty.id, kandy.id) === 10)

  const lines2 = await prisma.stockTransferLine.findMany({ where: { transferId: t2.id } })
  await throws('a shortfall with no reason is refused',
    () => receiveTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id,
      lines: [{ lineId: lines2[0].id, receivedQty: 8 }] }),
    'TRANSFER_VARIANCE_NO_REASON')

  const received = await receiveTransfer({
    restaurantId: shop.id, transferId: t2.id, userId: user.id,
    lines: [{ lineId: lines2[0].id, receivedQty: 8, varianceReason: 'DAMAGED_IN_TRANSIT', varianceNote: 'crushed in the van' }],
  })
  ok('Kandy available = 8', await avail(patty.id, kandy.id) === 8, `got ${await avail(patty.id, kandy.id)}`)
  ok('Kandy in-transit cleared', await transit(patty.id, kandy.id) === 0)
  ok('one variance recorded', received.variances === 1)

  const line2 = await prisma.stockTransferLine.findUniqueOrThrow({ where: { id: lines2[0].id } })
  ok('the dispatched 10 is preserved', line2.sentQty === 10, `got ${line2.sentQty}`)
  ok('received 8 recorded separately', line2.receivedQty === 8)
  ok('variance is -2', line2.variance === -2, `got ${line2.variance}`)
  ok('the reason is kept', line2.varianceReason === 'DAMAGED_IN_TRANSIT')
  await throws('receiving twice is refused',
    () => receiveTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id, lines: [] }),
    'TRANSFER_NOT_DISPATCHED')

  console.log('\n── 6. Guards ────────────────────────────────────────────')
  await throws('transferring more than a location holds is refused',
    async () => {
      const t = await requestTransfer({
        restaurantId: shop.id, fromBranchId: kandy.id, toBranchId: galle.id,
        lines: [{ itemId: patty.id, quantity: 500 }], userId: user.id,
      })
      await approveTransfer({ restaurantId: shop.id, transferId: t.id, userId: user.id })
    }, 'INSUFFICIENT_STOCK')
  await throws('transferring to the same location is refused',
    () => requestTransfer({ restaurantId: shop.id, fromBranchId: colombo.id, toBranchId: colombo.id,
      lines: [{ itemId: patty.id, quantity: 1 }], userId: user.id }),
    'TRANSFER_SAME_LOCATION')
  ok('REQUESTED → DISPATCHED is not a legal jump', !canTransition('REQUESTED', 'DISPATCHED'))
  ok('COMPLETED is terminal', !canTransition('COMPLETED', 'RECEIVED'))

  const t3 = await requestTransfer({
    restaurantId: shop.id, fromBranchId: ph.id, toBranchId: galle.id,
    lines: [{ itemId: patty.id, quantity: 5 }], userId: user.id,
  })
  await approveTransfer({ restaurantId: shop.id, transferId: t3.id, userId: user.id })
  await closeTransfer({ restaurantId: shop.id, transferId: t3.id, status: 'CANCELLED', userId: user.id })
  ok('cancelling releases the reservation',
    (await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: ph.id })).reserved === 0)

  /*
   * ── 6b. The two ways stock got stranded ──────────────────────────────────
   *
   * Neither of these was covered by any test, and both leave stock in a state
   * no report could show and no repair script could fix.
   */
  console.log('\n── 6b. Stranded stock ───────────────────────────────────')

  // A line dispatched as zero. The release used to sit AFTER the `continue`
  // that skips it, so its reservation was locked out of the source for ever.
  const t4 = await requestTransfer({
    restaurantId: shop.id,
    fromBranchId: ph.id,
    toBranchId: colombo.id,
    lines: [{ itemId: patty.id, quantity: 5 }],
    userId: user.id,
  })
  await approveTransfer({ restaurantId: shop.id, transferId: t4.id, userId: user.id })
  const reservedNow = (await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: ph.id })).reserved
  ok('approving reserves it', reservedNow === 5, `got ${reservedNow}`)

  const t4Lines = await prisma.stockTransferLine.findMany({ where: { transferId: t4.id } })
  await dispatchTransfer({
    restaurantId: shop.id,
    transferId: t4.id,
    sent: [{ lineId: t4Lines[0].id, quantity: 0 }],
    userId: user.id,
  })
  ok(
    'a line sent as zero still gives its reservation back',
    (await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: ph.id })).reserved === 0,
    'this stock was locked out permanently, and `reserved` cannot be rebuilt from the ledger',
  )

  // A van that never arrives. There was no edge out of DISPATCHED except
  // forward, so the stock sat in the destination's inTransit for ever.
  const beforeRecall = await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: ph.id })
  const t5 = await requestTransfer({
    restaurantId: shop.id,
    fromBranchId: ph.id,
    toBranchId: colombo.id,
    lines: [{ itemId: patty.id, quantity: 6 }],
    userId: user.id,
  })
  await approveTransfer({ restaurantId: shop.id, transferId: t5.id, userId: user.id })
  await dispatchTransfer({ restaurantId: shop.id, transferId: t5.id, userId: user.id })

  const sent = await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: ph.id })
  const inbound = await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: colombo.id })
  ok('dispatch takes it from the source', sent.available === beforeRecall.available - 6, `${sent.available}`)
  ok('and shows it inbound at the destination', inbound.inTransit === 6, `${inbound.inTransit}`)

  await throws(
    'a sent transfer cannot simply be marked cancelled',
    () => closeTransfer({ restaurantId: shop.id, transferId: t5.id, status: 'CANCELLED', userId: user.id }),
    'TRANSFER_ALREADY_SENT',
  )
  await throws(
    'and a recall needs a reason',
    () => recallTransfer({ restaurantId: shop.id, transferId: t5.id, reason: ' ', userId: user.id }),
    'TRANSFER_NO_RECALL_REASON',
  )

  await recallTransfer({
    restaurantId: shop.id,
    transferId: t5.id,
    reason: 'Van broke down, everything came back',
    userId: user.id,
  })
  const recalled = await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: ph.id })
  const cleared = await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: colombo.id })
  ok('recalling puts it back on the source shelf', recalled.available === beforeRecall.available, `${recalled.available}`)
  ok('and clears the destination’s inbound', cleared.inTransit === 0, `${cleared.inTransit}`)
  ok(
    'the ledger still reconciles after an out-and-back',
    (await recomputeBalance(shop.id, patty.id)).matches,
    'a recall is a real movement, not a status change',
  )

  console.log('\n── 7. Traceability ──────────────────────────────────────')
  const across = await getItemAcrossLocations({ restaurantId: shop.id, itemId: patty.id })
  const total = across.reduce((s, r) => s + r.available, 0)
  ok('patties are spread across three locations', across.filter((r) => r.available > 0).length === 3, `${across.filter((r) => r.available > 0).length}`)
  ok('60 + 30 + 8 = 98 (2 lost in transit)', total === 98, `got ${total}`)
  const itemTotal = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: patty.id } })).quantity
  ok('restaurant-wide total agrees with the locations', itemTotal === total, `item ${itemTotal} vs locations ${total}`)
  const ledger = await recomputeBalance(shop.id, patty.id)
  ok('the ledger reconciles', ledger.matches, `${ledger.cached} vs ${ledger.ledger}`)

  console.log('\n── 8. Every movement type has a direction ───────────────')
  // This guards the bug this phase actually hit: a new movement type added to
  // the enum but not to the direction table fell through to "signed" and added
  // stock where it should have removed it. Silent, and invisible until a count.
  const ALL_TYPES = [
    'PURCHASE', 'CONSUMPTION', 'WASTE', 'ADJUSTMENT', 'RETURN', 'EXPIRY',
    'SALE', 'WASTAGE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_IN',
    'TRANSFER_OUT', 'RETURN_TO_SUPPLIER', 'CUSTOMER_RETURN', 'PRODUCTION',
    'PRODUCTION_CONSUMPTION', 'PRODUCTION_OUTPUT', 'OPENING_BALANCE', 'SALE_REVERSAL',
  ] as const
  let undirected = 0
  for (const t of ALL_TYPES) {
    try { directionOf(t) } catch { undirected += 1; console.log(`      no direction: ${t}`) }
  }
  ok('every movement type resolves a direction', undirected === 0, `${undirected} missing`)
  ok('production consumption removes stock', directionOf('PRODUCTION_CONSUMPTION') === -1)
  ok('production output adds stock', directionOf('PRODUCTION_OUTPUT') === 1)
  ok('sale reversal adds stock back', directionOf('SALE_REVERSAL') === 1)
  ok('transfer out removes, transfer in adds',
    directionOf('TRANSFER_OUT') === -1 && directionOf('TRANSFER_IN') === 1)

  console.log('\n── 9. Tenant isolation ──────────────────────────────────')
  const shopB = await prisma.restaurant.create({
    data: { name: `XYZ ${S}`, slug: `xyz-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  shops.push(shopB.id)
  const bBranch = await prisma.branch.create({
    data: { restaurantId: shopB.id, name: 'B Kandy', code: 'BKAN', type: 'BRANCH', isDefault: true },
  })
  branches.push(bBranch.id)

  await throws('transferring into another restaurant’s location is refused',
    () => requestTransfer({ restaurantId: shop.id, fromBranchId: ph.id, toBranchId: bBranch.id,
      lines: [{ itemId: patty.id, quantity: 1 }], userId: user.id }))
  await throws('restaurant B cannot transfer restaurant A’s stock',
    () => requestTransfer({ restaurantId: shopB.id, fromBranchId: bBranch.id, toBranchId: bBranch.id,
      lines: [{ itemId: patty.id, quantity: 1 }], userId: user.id }))
  await throws('restaurant B cannot produce at restaurant A’s house',
    () => createProductionOrder({ restaurantId: shopB.id, branchId: ph.id, recipeId: spec.id, plannedQty: 100, userId: user.id }))
  const leak = await prisma.inventoryStock.findFirst({ where: { itemId: patty.id, restaurantId: shopB.id } })
  ok('restaurant B sees none of restaurant A’s stock', leak === null)
  const leakT = await prisma.stockTransfer.findFirst({ where: { id: t1.id, restaurantId: shopB.id } })
  ok('restaurant B cannot resolve restaurant A’s transfer', leakT === null)

  // cleanup
  await prisma.stockTransferLine.deleteMany({ where: { transfer: { restaurantId: { in: shops } } } })
  await prisma.stockTransfer.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.productionConsumption.deleteMany({ where: { order: { restaurantId: { in: shops } } } })
  await prisma.productionOutput.deleteMany({ where: { order: { restaurantId: { in: shops } } } })
  await prisma.productionOrder.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.recipeIngredient.deleteMany({ where: { recipeId: { in: specs } } })
  await prisma.recipe.deleteMany({ where: { id: { in: specs } } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.branch.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.restaurant.deleteMany({ where: { id: { in: shops } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\nCRASHED:', e)
  await prisma.$disconnect()
  process.exit(1)
})
