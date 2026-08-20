/**
 * Storage-aware stock.
 *
 * The thing worth proving is that a branch total and its shelves can never
 * disagree, because the total is derived from the shelves rather than stored
 * alongside them.
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement, recomputeBalance } from '../src/features/inventory/ledger'
import { getLocationBalance, getShelfBalances } from '../src/features/inventory/location-stock'
import {
  requestTransfer, approveTransfer, dispatchTransfer, receiveTransfer,
} from '../src/features/transfers/service'

let pass = 0, fail = 0
const shops: string[] = []
const ok = (n: string, c: boolean, d = '') =>
  c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`))
async function throws(n: string, fn: () => Promise<unknown>, code?: string) {
  try { await fn(); fail++; console.log(`  ✗ ${n} — was allowed`) }
  catch (e) { const c = (e as { code?: string }).code
    if (code && c !== code) { fail++; console.log(`  ✗ ${n} — wanted ${code}, got ${c}`) }
    else { pass++; console.log(`  ✓ ${n} (${c ?? 'rejected'})`) } }
}

async function main() {
  const S = Date.now().toString(36)
  const shop = await prisma.restaurant.create({
    data: { name: `Shelf ${S}`, slug: `shelf-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  shops.push(shop.id)
  const user = await prisma.user.findFirstOrThrow({ where: { deletedAt: null } })

  const colombo = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Colombo', code: `C${S}`, isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Kandy', code: `K${S}` },
  })
  const main = await prisma.storageLocation.create({
    data: { restaurantId: shop.id, branchId: colombo.id, name: 'Main Store', code: `MS${S}` },
  })
  const cold = await prisma.storageLocation.create({
    data: { restaurantId: shop.id, branchId: colombo.id, name: 'Cold Room', code: `CR${S}` },
  })
  const kandyMain = await prisma.storageLocation.create({
    data: { restaurantId: shop.id, branchId: kandy.id, name: 'Main Store', code: `KM${S}` },
  })

  const patty = await prisma.inventoryItem.create({
    data: { restaurantId: shop.id, name: `Patty ${S}`, unit: 'PIECE', branchId: colombo.id, costPerUnit: 100_00 },
  })

  const put = (qty: number, storage: string | null) =>
    prisma.$transaction((tx) => postMovement(tx, {
      restaurantId: shop.id, itemId: patty.id, type: 'PURCHASE', quantity: qty,
      branchId: colombo.id, locationId: storage, userId: user.id,
    }))
  const branchTotal = async (b: string) =>
    (await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: b })).available
  const shelf = async (b: string, s: string | null) =>
    (await getLocationBalance({ restaurantId: shop.id, itemId: patty.id, branchId: b, storageLocationId: s })).available

  console.log('\n── 1. Shelves are separate positions ────────────────────')
  await put(60, main.id)
  await put(40, cold.id)
  ok('Main Store holds 60', await shelf(colombo.id, main.id) === 60, `got ${await shelf(colombo.id, main.id)}`)
  ok('Cold Room holds 40', await shelf(colombo.id, cold.id) === 40, `got ${await shelf(colombo.id, cold.id)}`)
  ok('branch total is the sum, 100', await branchTotal(colombo.id) === 100, `got ${await branchTotal(colombo.id)}`)

  const rows = await prisma.inventoryStock.count({ where: { itemId: patty.id, branchId: colombo.id } })
  ok('two shelves means two rows, not one merged row', rows === 2, `got ${rows}`)

  console.log('\n── 2. Postings do not relabel a shelf ───────────────────')
  await put(10, main.id)
  ok('Main Store 60 → 70', await shelf(colombo.id, main.id) === 70, `got ${await shelf(colombo.id, main.id)}`)
  ok('Cold Room untouched at 40', await shelf(colombo.id, cold.id) === 40, `got ${await shelf(colombo.id, cold.id)}`)

  console.log('\n── 3. Unassigned stock is its own position ──────────────')
  await put(5, null)
  ok('unassigned holds 5', await shelf(colombo.id, null) === 5, `got ${await shelf(colombo.id, null)}`)
  ok('branch total now 115', await branchTotal(colombo.id) === 115, `got ${await branchTotal(colombo.id)}`)
  const nullRows = await prisma.inventoryStock.count({
    where: { itemId: patty.id, branchId: colombo.id, storageLocationId: null },
  })
  ok('unassigned stock did not accumulate duplicate rows', nullRows === 1, `got ${nullRows}`)

  console.log('\n── 4. Store-to-store inside one branch ──────────────────')
  const t1 = await requestTransfer({
    restaurantId: shop.id, fromBranchId: colombo.id, toBranchId: colombo.id,
    fromStorageId: main.id, toStorageId: cold.id,
    lines: [{ itemId: patty.id, quantity: 10 }], userId: user.id,
  })
  await approveTransfer({ restaurantId: shop.id, transferId: t1.id, userId: user.id })
  await dispatchTransfer({ restaurantId: shop.id, transferId: t1.id, userId: user.id })
  ok('Main Store 70 → 60 on dispatch', await shelf(colombo.id, main.id) === 60, `got ${await shelf(colombo.id, main.id)}`)
  const l1 = await prisma.stockTransferLine.findFirstOrThrow({ where: { transferId: t1.id } })
  await receiveTransfer({ restaurantId: shop.id, transferId: t1.id, userId: user.id, lines: [{ lineId: l1.id, receivedQty: 10 }] })
  ok('Cold Room 40 → 50 on receipt', await shelf(colombo.id, cold.id) === 50, `got ${await shelf(colombo.id, cold.id)}`)
  ok('branch total unchanged at 115', await branchTotal(colombo.id) === 115, `got ${await branchTotal(colombo.id)}`)

  console.log('\n── 5. Guards ────────────────────────────────────────────')
  await throws('same branch AND same shelf is refused',
    () => requestTransfer({ restaurantId: shop.id, fromBranchId: colombo.id, toBranchId: colombo.id,
      fromStorageId: main.id, toStorageId: main.id, lines: [{ itemId: patty.id, quantity: 1 }], userId: user.id }),
    'TRANSFER_SAME_LOCATION')
  await throws('same branch with no shelves is refused',
    () => requestTransfer({ restaurantId: shop.id, fromBranchId: colombo.id, toBranchId: colombo.id,
      lines: [{ itemId: patty.id, quantity: 1 }], userId: user.id }),
    'TRANSFER_SAME_LOCATION')
  await throws('a shelf from another branch is refused',
    () => requestTransfer({ restaurantId: shop.id, fromBranchId: colombo.id, toBranchId: kandy.id,
      fromStorageId: kandyMain.id, lines: [{ itemId: patty.id, quantity: 1 }], userId: user.id }),
    'TRANSFER_BAD_STORAGE')

  console.log('\n── 6. Cross-branch, shelf to shelf ──────────────────────')
  const t2 = await requestTransfer({
    restaurantId: shop.id, fromBranchId: colombo.id, toBranchId: kandy.id,
    fromStorageId: cold.id, toStorageId: kandyMain.id,
    lines: [{ itemId: patty.id, quantity: 20 }], userId: user.id,
  })
  await approveTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id })
  await dispatchTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id })
  ok('Cold Room 50 → 30', await shelf(colombo.id, cold.id) === 30, `got ${await shelf(colombo.id, cold.id)}`)
  ok('Kandy Main Store in transit, not available',
    await shelf(kandy.id, kandyMain.id) === 0, `got ${await shelf(kandy.id, kandyMain.id)}`)
  const l2 = await prisma.stockTransferLine.findFirstOrThrow({ where: { transferId: t2.id } })
  await receiveTransfer({ restaurantId: shop.id, transferId: t2.id, userId: user.id, lines: [{ lineId: l2.id, receivedQty: 20 }] })
  ok('Kandy Main Store holds 20', await shelf(kandy.id, kandyMain.id) === 20, `got ${await shelf(kandy.id, kandyMain.id)}`)
  ok('Colombo total 115 → 95', await branchTotal(colombo.id) === 95, `got ${await branchTotal(colombo.id)}`)

  console.log('\n── 7. Everything reconciles ─────────────────────────────')
  const shelves = await getShelfBalances({ restaurantId: shop.id, itemId: patty.id, branchId: colombo.id })
  const shelfSum = Math.round(shelves.reduce((s, r) => s + r.available, 0) * 1e6) / 1e6
  ok('shelf sum equals the branch total', shelfSum === await branchTotal(colombo.id), `${shelfSum} vs ${await branchTotal(colombo.id)}`)
  ok('shelves are named', shelves.every((s) => s.name.length > 0))

  const led = await recomputeBalance(shop.id, patty.id)
  ok('cached item total equals the replayed ledger', led.matches, `${led.cached} vs ${led.ledger}`)
  const allLocations = await prisma.inventoryStock.aggregate({
    where: { itemId: patty.id }, _sum: { available: true },
  })
  ok('every location summed equals the item total',
    Math.round((allLocations._sum.available ?? 0) * 1e6) / 1e6 === led.cached,
    `${allLocations._sum.available} vs ${led.cached}`)

  console.log('\n── Shelf breakdown ──────────────────────────────────────')
  for (const s of shelves) console.log(`  ${s.name.padEnd(16)}${String(s.available).padStart(6)}`)

  // cleanup
  await prisma.stockTransferLine.deleteMany({ where: { transfer: { restaurantId: shop.id } } })
  await prisma.stockTransfer.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.storageLocation.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
  await prisma.restaurant.deleteMany({ where: { id: { in: shops } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(async (e) => { console.error('CRASHED:', e); await prisma.$disconnect(); process.exit(1) })
