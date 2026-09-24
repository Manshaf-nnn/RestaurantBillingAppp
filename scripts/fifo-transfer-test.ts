/**
 * A transfer moves stock AND what it cost (FIFO.md).
 *
 * ── The requirement, and what it used to do ────────────────────────────────
 *
 * FIFO.md is explicit: "Transfers must preserve the original FIFO costs:
 * Source consumes FIFO layers → destination receives the same cost layers."
 *
 * None of that happened. Dispatch passed no cost, so stock left at the running
 * weighted average. Receipt passed no cost and created no layer at all, so the
 * arriving stock was valued at the DESTINATION's blend and belonged to no
 * layer — which then had to be drawn at an average for ever afterwards. Two
 * branches that had genuinely paid different prices reported the same one, and
 * every transfer made the FIFO position a little less true.
 *
 * What this pins:
 *
 *   • the source's layers are drawn oldest first, and the value that leaves is
 *     theirs, not a blend;
 *   • the destination gets ONE LAYER PER SOURCE LAYER, at the same values —
 *     never a single blended layer, because that would destroy the ordering
 *     the next draw depends on;
 *   • those layers keep the ORIGINAL receipt dates, so old stock does not
 *     arrive looking fresh and stop being consumed first;
 *   • nothing is created or destroyed: what left one branch equals what
 *     arrived at the other;
 *   • a short delivery is written off at the destination, at the layers' own
 *     cost, and says so.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/fifo-transfer-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { approveTransfer, dispatchTransfer, receiveTransfer, requestTransfer } from '../src/features/transfers/service'

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
  const M = (major: number) => Math.round(major * 100)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Xfer ${stamp}`, slug: `xfer-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true },
  })
  const jaffna = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Jaffna', code: 'JAF' },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `mgr-${stamp}@test.dev`, name: 'Asha',
      role: 'OWNER', passwordHash: 'x',
    },
  })
  const rice = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Rice', unit: 'KG', quantity: 0, costPerUnit: 0 },
  })

  /*
   * Kandy buys twice at two prices, a month apart. Jaffna buys once, dearer —
   * so if the transfer blends, or re-dates, or values at the destination's
   * own rate, the numbers below all move.
   */
  const march = new Date(Date.UTC(2026, 2, 1))
  const april = new Date(Date.UTC(2026, 3, 1))
  await prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: restaurant.id, itemId: rice.id, branchId: kandy.id, userId: user.id,
    type: 'PURCHASE', quantity: 30, unitCost: M(10), totalValue: 30 * M(10),
    batchNo: `K-MAR-${stamp}`, receivedAt: march,
  }))
  await prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: restaurant.id, itemId: rice.id, branchId: kandy.id, userId: user.id,
    type: 'PURCHASE', quantity: 30, unitCost: M(20), totalValue: 30 * M(20),
    batchNo: `K-APR-${stamp}`, receivedAt: april,
  }))
  await prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: restaurant.id, itemId: rice.id, branchId: jaffna.id, userId: user.id,
    type: 'PURCHASE', quantity: 10, unitCost: M(50), totalValue: 10 * M(50),
    batchNo: `J-${stamp}`,
  }))

  const valueAt = async (branchId: string) =>
    (await prisma.stockBatch.aggregate({
      where: { itemId: rice.id, branchId, remainingQty: { gt: 0 } },
      _sum: { remainingValue: true },
    }))._sum.remainingValue ?? 0
  const layersAt = async (branchId: string) =>
    prisma.stockBatch.findMany({
      where: { itemId: rice.id, branchId, remainingQty: { gt: 0 } },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
      select: { batchNo: true, remainingQty: true, remainingValue: true, receivedAt: true },
    })

  const kandyBefore = await valueAt(kandy.id)
  const jaffnaBefore = await valueAt(jaffna.id)
  check('Kandy holds 60 kg worth 900', kandyBefore === 30 * M(10) + 30 * M(20), String(kandyBefore))
  check('Jaffna holds 10 kg worth 500 — a very different rate', jaffnaBefore === 10 * M(50))

  /* ── 1. 40 kg Kandy → Jaffna, crossing a layer boundary ──────────────────── */
  console.log('\n1. Forty kilos, which crosses a layer boundary')

  const transfer = await requestTransfer({
    restaurantId: restaurant.id,
    fromBranchId: kandy.id,
    toBranchId: jaffna.id,
    lines: [{ itemId: rice.id, quantity: 40 }],
    userId: user.id,
  })
  const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { transferId: transfer.id } })
  check(
    'the line is not priced at request time — nobody has chosen the stock yet',
    line.unitCost === 0,
    String(line.unitCost),
  )

  await approveTransfer({ restaurantId: restaurant.id, transferId: transfer.id, userId: user.id })
  await dispatchTransfer({ restaurantId: restaurant.id, transferId: transfer.id, userId: user.id })

  const dispatched = await prisma.stockTransferLine.findFirstOrThrow({ where: { id: line.id } })
  /* 30 @ 10.00 + 10 @ 20.00 = 500.00 over 40 kg = 12.50 */
  check(
    'dispatch prices the line from what actually left: 12.50/kg',
    dispatched.unitCost === M(12.5),
    String(dispatched.unitCost),
  )

  const kandyAfter = await layersAt(kandy.id)
  check('Kandy’s March layer is spent', !kandyAfter.some((l) => l.batchNo.startsWith('K-MAR')))
  check('and 20 kg of April remains', kandyAfter.length === 1 && kandyAfter[0].remainingQty === 20)
  check(
    'worth 400 — the April rate, not a blend',
    kandyAfter[0].remainingValue === 20 * M(20),
    String(kandyAfter[0].remainingValue),
  )

  /* ── 2. The destination receives the source's layers ─────────────────────── */
  console.log('\n2. What arrives is what left')

  await receiveTransfer({
    restaurantId: restaurant.id,
    transferId: transfer.id,
    lines: [{ lineId: line.id, receivedQty: 40 }],
    userId: user.id,
  })

  const arrived = await layersAt(jaffna.id)
  const moved = arrived.filter((l) => !l.batchNo.startsWith(`J-`))
  check('two layers arrived, not one blended one', moved.length === 2, `${moved.length}`)
  check(
    'the March stock arrived at the March price',
    moved.some((l) => l.remainingQty === 30 && l.remainingValue === 30 * M(10)),
    JSON.stringify(moved),
  )
  check(
    'and the April stock at the April price',
    moved.some((l) => l.remainingQty === 10 && l.remainingValue === 10 * M(20)),
  )
  check(
    'each keeping its ORIGINAL receipt date, so it stays at the front of the queue',
    moved.some((l) => l.receivedAt.getTime() === march.getTime()) &&
      moved.some((l) => l.receivedAt.getTime() === april.getTime()),
    moved.map((l) => l.receivedAt.toISOString().slice(0, 10)).join(', '),
  )
  check(
    'the oldest layer at Jaffna is now Kandy’s March stock, ahead of Jaffna’s own',
    arrived[0].batchNo.startsWith('K-MAR'),
    arrived[0].batchNo,
  )

  /* ── 3. Nothing is created or destroyed ──────────────────────────────────── */
  console.log('\n3. The business is no richer or poorer for moving it')

  const kandyNow = await valueAt(kandy.id)
  const jaffnaNow = await valueAt(jaffna.id)
  check(
    'what left Kandy is what arrived at Jaffna',
    kandyBefore - kandyNow === jaffnaNow - jaffnaBefore,
    `Kandy −${kandyBefore - kandyNow}, Jaffna +${jaffnaNow - jaffnaBefore}`,
  )
  check(
    'and the total across both branches is unchanged',
    kandyNow + jaffnaNow === kandyBefore + jaffnaBefore,
    `${kandyBefore + jaffnaBefore} → ${kandyNow + jaffnaNow}`,
  )

  /* ── 4. A short delivery ─────────────────────────────────────────────────── */
  console.log('\n4. Two kilos never arrive')

  const second = await requestTransfer({
    restaurantId: restaurant.id,
    fromBranchId: kandy.id,
    toBranchId: jaffna.id,
    lines: [{ itemId: rice.id, quantity: 10 }],
    userId: user.id,
  })
  const line2 = await prisma.stockTransferLine.findFirstOrThrow({ where: { transferId: second.id } })
  await approveTransfer({ restaurantId: restaurant.id, transferId: second.id, userId: user.id })
  await dispatchTransfer({ restaurantId: restaurant.id, transferId: second.id, userId: user.id })
  await receiveTransfer({
    restaurantId: restaurant.id,
    transferId: second.id,
    lines: [{ lineId: line2.id, receivedQty: 8, varianceReason: 'MISSING' }],
    userId: user.id,
  })

  const waste = await prisma.stockMovement.findFirst({
    where: { itemId: rice.id, type: 'WASTAGE', referenceId: second.id },
  })
  check('the shortfall is written off, not quietly lost', waste !== null)
  check('at the destination, which was expecting it', waste?.branchId === jaffna.id)
  /*
   * At 10.00 a kilo, and that is the whole point.
   *
   * The 2 kg that went missing were dispatched from Kandy's April stock at
   * 20.00, but the write-off happens at JAFFNA, and Jaffna's oldest layer is
   * the March stock that arrived on the first transfer still carrying its
   * March date and its 10.00 price. So FIFO draws that, correctly.
   *
   * This is what "the destination receives the same cost layers" buys: the
   * transferred stock kept its place in the queue, so the next draw at the far
   * end takes the genuinely oldest stock the branch holds — not whatever
   * happened to arrive most recently.
   */
  check(
    'for 2 kg, drawn from Jaffna’s oldest layer at 10.00 — the March stock that moved',
    waste?.quantity === -2 && waste?.valueMoved === 2 * M(10),
    `${waste?.quantity} for ${waste?.valueMoved}`,
  )
  check('and says why', (waste?.reason ?? '').includes('missing'))

  const finalKandy = await valueAt(kandy.id)
  const finalJaffna = await valueAt(jaffna.id)
  check(
    'the books lost exactly the 2 kg that went missing, and nothing else',
    kandyBefore + jaffnaBefore - (finalKandy + finalJaffna) === 2 * M(10),
    `${kandyBefore + jaffnaBefore} → ${finalKandy + finalJaffna}`,
  )

  /* ── Clean up ────────────────────────────────────────────────────────────── */
  await prisma.stockMovementLot.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockTransferLine.deleteMany({ where: { transfer: { restaurantId: restaurant.id } } })
  await prisma.stockTransfer.deleteMany({ where: { restaurantId: restaurant.id } })
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
