/** Phase 11: concurrency, idempotency and transaction consistency under load. */
import { prisma } from '../src/server/db/prisma'
import { postMovement, recomputeBalance } from '../src/features/inventory/ledger'
import { setOpeningBalance } from '../src/features/inventory/operations'
import { reconcileOrderDepletion } from '../src/features/inventory/depletion'
import { requestTransfer, approveTransfer, dispatchTransfer } from '../src/features/transfers/service'
import { receiveGoods } from '../src/features/purchasing/receiving'
import { createPurchaseOrder, setPurchaseStatus } from '../src/features/purchasing/service'
import { capturePayment } from '../src/features/payments/service'

let pass = 0, fail = 0
const shops: string[] = []
function ok(n: string, c: boolean, d = '') { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)) }

async function main() {
  const S = Date.now().toString(36)
  const shop = await prisma.restaurant.create({
    data: { name: `HW ${S}`, slug: `hw-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  shops.push(shop.id)
  const branch = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Main', code: 'M', isDefault: true },
  })
  const user = await prisma.user.findFirstOrThrow({ where: { deletedAt: null } })
  const cat = await prisma.category.create({ data: { restaurantId: shop.id, name: 'M', slug: `m-${S}` } })

  const mkItem = async (name: string, qty: number) => {
    const i = await prisma.inventoryItem.create({
      data: { restaurantId: shop.id, name: `${name}-${S}`, unit: 'PIECE', costPerUnit: 100_00, branchId: branch.id },
    })
    if (qty > 0) await setOpeningBalance({ restaurantId: shop.id, itemId: i.id, quantity: qty, userId: user.id, branchId: branch.id })
    return i
  }

  console.log('\n── 1. Concurrent stock withdrawals ──────────────────────')
  const item = await mkItem('Patty', 100)
  // 20 simultaneous withdrawals of 5 from a balance of 100.
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      prisma.$transaction((tx) => postMovement(tx, {
        restaurantId: shop.id, itemId: item.id, type: 'SALE', quantity: 5,
        branchId: branch.id, userId: user.id,
      }), { timeout: 20_000 }),
    ),
  )
  const succeeded = results.filter((r) => r.status === 'fulfilled').length
  const balance = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantity
  ok(`all ${succeeded} concurrent withdrawals committed`, succeeded === 20, `${succeeded}/20`)
  ok('balance is exactly 100 − (20 × 5)', balance === 0, `got ${balance}`)

  const check = await recomputeBalance(shop.id, item.id)
  ok('no lost update: ledger equals cached balance', check.matches, `${check.cached} vs ${check.ledger}`)

  const rows = await prisma.stockMovement.findMany({
    where: { itemId: item.id, type: 'SALE' }, orderBy: { createdAt: 'asc' }, select: { balanceAfter: true },
  })
  const distinct = new Set(rows.map((r) => r.balanceAfter))
  ok('every row has a distinct running balance — no two read the same start',
    distinct.size === rows.length, `${distinct.size} distinct of ${rows.length}`)

  const locStock = await prisma.inventoryStock.findFirstOrThrow({
    where: { itemId: item.id, branchId: branch.id },
  })
  ok('per-location stock stayed in step', locStock.available === balance, `${locStock.available} vs ${balance}`)

  console.log('\n── 2. Concurrent transfer dispatch ──────────────────────')
  const other = await prisma.branch.create({ data: { restaurantId: shop.id, name: 'Two', code: 'T2' } })
  const tItem = await mkItem('Sauce', 30)
  const transfer = await requestTransfer({
    restaurantId: shop.id, fromBranchId: branch.id, toBranchId: other.id,
    lines: [{ itemId: tItem.id, quantity: 10 }], userId: user.id,
  })
  await approveTransfer({ restaurantId: shop.id, transferId: transfer.id, userId: user.id })

  const dispatches = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      dispatchTransfer({ restaurantId: shop.id, transferId: transfer.id, userId: user.id }),
    ),
  )
  const dispatched = dispatches.filter((d) => d.status === 'fulfilled').length
  ok('only one of five simultaneous dispatches succeeded', dispatched === 1, `${dispatched} succeeded`)
  const afterDispatch = await prisma.inventoryStock.findFirstOrThrow({ where: { itemId: tItem.id, branchId: branch.id } })
  ok('stock left exactly once (30 → 20)', afterDispatch.available === 20, `got ${afterDispatch.available}`)
  const inTransit = await prisma.inventoryStock.findFirstOrThrow({ where: { itemId: tItem.id, branchId: other.id } })
  ok('destination shows 10 in transit, not 50', inTransit.inTransit === 10, `got ${inTransit.inTransit}`)

  console.log('\n── 3. Concurrent recipe depletion ───────────────────────')
  const bun = await mkItem('Bun', 100)
  const food = await prisma.food.create({
    data: { restaurantId: shop.id, categoryId: cat.id, name: `F${S}`, slug: `f-${S}`, price: 1_000_00 },
  })
  const recipe = await prisma.recipe.create({
    data: { restaurantId: shop.id, foodId: food.id, version: 1, isActive: true, yieldQty: 1,
      ingredients: { create: [{ inventoryItemId: bun.id, quantity: 2, unit: 'PIECE' }] } },
  })
  const order = await prisma.order.create({
    data: { restaurantId: shop.id, branchId: branch.id, orderNumber: `C-${S}`, type: 'COUNTER',
      status: 'PENDING', paymentStatus: 'UNPAID', customerName: 'T', customerPhone: '07',
      subtotal: 3_000_00, grandTotal: 3_000_00,
      items: { create: [{ foodId: food.id, name: food.name, unitPrice: 1_000_00, quantity: 3, lineTotal: 3_000_00, recipeId: recipe.id }] } },
  })

  // Ten simultaneous reconciliations of the same order.
  await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      prisma.$transaction((tx) => reconcileOrderDepletion(tx, {
        restaurantId: shop.id, orderId: order.id, userId: user.id,
      }), { timeout: 20_000 }),
    ),
  )
  const bunLeft = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: bun.id } })).quantity
  ok('3 burgers × 2 buns deducted exactly once (100 → 94)', bunLeft === 94, `got ${bunLeft}`)
  const saleRows = await prisma.stockMovement.count({ where: { orderId: order.id, type: 'SALE' } })
  ok('only one SALE row despite ten attempts', saleRows === 1, `${saleRows} rows`)

  console.log('\n── 4. Duplicate payment protection ──────────────────────')
  const payOrder = await prisma.order.create({
    data: { restaurantId: shop.id, branchId: branch.id, orderNumber: `P-${S}`, type: 'COUNTER',
      status: 'SERVED', paymentStatus: 'UNPAID', customerName: 'T', customerPhone: '07',
      subtotal: 1_000_00, grandTotal: 1_000_00 },
  })
  const pays = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      capturePayment({ restaurantId: shop.id, orderId: payOrder.id, method: 'CASH',
        amount: 1_000_00, receivedById: user.id }),
    ),
  )
  const took = pays.filter((p) => p.status === 'fulfilled').length
  const paid = await prisma.order.findUniqueOrThrow({ where: { id: payOrder.id } })
  ok('overpayment is rejected, not absorbed', paid.paidTotal <= 1_000_00, `paidTotal ${paid.paidTotal}, ${took} accepted`)
  ok('the bill is settled exactly once', paid.paymentStatus === 'PAID')

  console.log('\n── 5. Concurrent goods receipt ──────────────────────────')
  const rItem = await mkItem('Rice', 0)
  const po = await createPurchaseOrder({
    restaurantId: shop.id, branchId: branch.id, userId: user.id,
    lines: [{ itemId: rItem.id, quantity: 50, unit: 'PIECE', unitCost: 100_00 }],
  })
  await setPurchaseStatus({ restaurantId: shop.id, purchaseId: po.id, status: 'APPROVED', userId: user.id })
  const poLine = await prisma.purchaseItem.findFirstOrThrow({ where: { purchaseId: po.id } })

  const receipts = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      receiveGoods({ restaurantId: shop.id, purchaseId: po.id, userId: user.id,
        lines: [{ purchaseItemId: poLine.id, acceptedQty: 50 }] }),
    ),
  )
  const accepted = receipts.filter((r) => r.status === 'fulfilled').length
  const riceQty = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: rItem.id } })).quantity
  ok('over-receipt is refused under concurrency', riceQty === 50, `got ${riceQty} from ${accepted} receipts`)

  console.log('\n── 6. Transaction atomicity ─────────────────────────────')
  const atomic = await mkItem('Atomic', 10)
  try {
    await prisma.$transaction(async (tx) => {
      await postMovement(tx, { restaurantId: shop.id, itemId: atomic.id, type: 'SALE',
        quantity: 5, branchId: branch.id, userId: user.id })
      throw new Error('simulated failure after the stock moved')
    })
  } catch { /* expected */ }
  const atomicQty = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: atomic.id } })).quantity
  ok('a failure after the deduction rolls the stock back', atomicQty === 10, `got ${atomicQty}`)
  const orphan = await prisma.stockMovement.count({ where: { itemId: atomic.id } })
  ok('and leaves no orphan ledger row', orphan === 1, `${orphan} rows (1 = opening balance only)`)

  // cleanup
  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.stockTransferLine.deleteMany({ where: { transfer: { restaurantId: shop.id } } })
  await prisma.stockTransfer.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { restaurantId: shop.id } } })
  await prisma.goodsReceipt.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.purchasePriceHistory.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.purchaseItem.deleteMany({ where: { purchase: { restaurantId: shop.id } } })
  await prisma.purchase.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.payment.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: shop.id } } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: shop.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId: shop.id } } })
  await prisma.recipe.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.food.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.category.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurant.deleteMany({ where: { id: { in: shops } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error('\nCRASHED:', e); await prisma.$disconnect(); process.exit(1) })
