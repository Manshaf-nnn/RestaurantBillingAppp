/**
 * The approvals desk: four tabs, and a request is in exactly one list.
 *
 * What this holds:
 *
 *   · every queue lands in exactly one of the four tabs, and the tab badge
 *     agrees with the list underneath it;
 *   · a request is in Pending until it is decided and in Record from the
 *     moment it is, never in both and never in neither — the failure that
 *     would let somebody approve the same thing twice, or lose it;
 *   · a submitted purchase order appears ONCE. Submitting now raises an
 *     approval request as well as setting the order's status, and the desk
 *     read both tables — so the order was on the desk twice, with two sets
 *     of buttons for one decision;
 *   · the tab narrows which queues are read at all, so a tab shows nothing
 *     belonging to another.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/approvals-desk-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  REQUEST_TYPES,
  getApprovalsInbox,
  getApprovalsRecord,
  getPendingCountsByType,
  typeForApprovalKind,
  type RequestType,
} from '../src/features/accounting/inbox'
import { createPurchaseOrder, setPurchaseStatus } from '../src/features/purchasing/service'
import { decideApproval, requestApproval } from '../src/features/approvals/service'

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

const stamp = Date.now().toString(36)
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.approvalRequest.deleteMany({ where: { restaurantId: id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.pettyCashRequest.deleteMany({ where: { restaurantId: id } })
  await prisma.purchaseItem.deleteMany({ where: { purchase: { restaurantId: id } } })
  await prisma.purchase.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: id } })
  await prisma.supplier.deleteMany({ where: { restaurantId: id } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: `Desk ${stamp}`, slug: `desk-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
  })
  restaurantId = restaurant.id
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const supplier = await prisma.supplier.create({ data: { restaurantId: restaurant.id, name: 'ABC' } })
  const item = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Chicken', unit: 'KG', quantity: 0, costPerUnit: 0 },
  })
  const asker = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `asker-${stamp}@test.local`, name: 'Asker',
      passwordHash: 'x', role: 'MANAGER', branchId: main.id, emailVerifiedAt: new Date(),
    },
  })
  const boss = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `boss-${stamp}@test.local`, name: 'Boss',
      passwordHash: 'x', role: 'OWNER', emailVerifiedAt: new Date(),
    },
  })

  const pendingIn = (type: RequestType) => getApprovalsInbox(restaurant.id, null, { type })
  const recordIn = (type: RequestType) => getApprovalsRecord(restaurant.id, null, { type })

  console.log('\n── 1. Every kind lands in exactly one tab ──')
  {
    const pairs: Array<[string, RequestType]> = [
      ['STOCK_TRANSFER', 'TRANSFER'],
      ['PURCHASE_ORDER', 'PURCHASE'],
      ['REFUND', 'MONEY'],
      ['DISCOUNT', 'MONEY'],
      ['PRICE_OVERRIDE', 'MONEY'],
      ['STOCK_ADJUSTMENT', 'OTHER'],
    ]
    for (const [kind, type] of pairs) {
      check(`${kind} → ${type}`, typeForApprovalKind(kind) === type, typeForApprovalKind(kind))
    }
    check('and there are exactly four tabs', REQUEST_TYPES.length === 4, REQUEST_TYPES.join(', '))
  }

  console.log('\n── 2. A PO request appears once, not twice ──')
  let poId = ''
  {
    const po = await createPurchaseOrder({
      restaurantId: restaurant.id, supplierId: supplier.id, branchId: main.id, userId: asker.id,
      lines: [{ itemId: item.id, quantity: 10, unit: 'KG', unitCost: 100_00 }],
    })
    poId = po.id
    await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: po.id, status: 'PENDING_APPROVAL', userId: asker.id })
    await requestApproval({
      restaurantId: restaurant.id, branchId: main.id, kind: 'PURCHASE_ORDER', entity: 'Purchase',
      entityId: po.id, amount: po.total, reason: `Purchase request ${po.number}`, userId: asker.id,
    })

    const rows = await pendingIn('PURCHASE')
    check('the order is on the desk exactly once', rows.length === 1, `${rows.length} rows`)
    check('as an approval request, so it can be decided from the desk', rows[0]?.kind === 'APPROVAL_REQUEST', rows[0]?.kind)
    check('and it is on the PO tab', rows[0]?.type === 'PURCHASE')

    const counts = await getPendingCountsByType(restaurant.id, null)
    check('the tab badge agrees with the list', counts.PURCHASE === 1, `badge ${counts.PURCHASE}`)
  }

  console.log('\n── 3. A tab shows nothing belonging to another ──')
  {
    await prisma.pettyCashRequest.create({
      data: {
        restaurantId: restaurant.id, branchId: main.id, amount: 5_000_00,
        category: 'Supplies',
        description: 'Cleaning supplies', requestedById: asker.id, status: 'PENDING',
      },
    })
    await requestApproval({
      restaurantId: restaurant.id, branchId: main.id, kind: 'REFUND', entity: 'Order',
      entityId: null, amount: 2_000_00, reason: 'Wrong dish served', userId: asker.id,
    })

    const money = await pendingIn('MONEY')
    check('the money tab has the petty cash and the refund', money.length === 2, `${money.length}`)
    check('and nothing that is not money', money.every((row) => row.type === 'MONEY'))
    const purchase = await pendingIn('PURCHASE')
    check('the PO tab still has only the order', purchase.length === 1 && purchase[0].type === 'PURCHASE')
    const transfer = await pendingIn('TRANSFER')
    check('the transfers tab is empty', transfer.length === 0, `${transfer.length}`)

    const counts = await getPendingCountsByType(restaurant.id, null)
    check('every badge matches its list', counts.MONEY === 2 && counts.PURCHASE === 1 && counts.TRANSFER === 0, JSON.stringify(counts))
  }

  console.log('\n── 4. Deciding moves it from Pending to Record ──')
  {
    const before = await pendingIn('PURCHASE')
    check('it starts in Pending', before.length === 1)
    check('and Record is empty', (await recordIn('PURCHASE')).length === 0)

    const request = await prisma.approvalRequest.findFirstOrThrow({
      where: { restaurantId: restaurant.id, kind: 'PURCHASE_ORDER', status: 'PENDING' },
    })
    await decideApproval({
      restaurantId: restaurant.id, approvalId: request.id, approve: true, userId: boss.id, unconfined: true,
      apply: async (tx) => {
        await tx.purchase.update({ where: { id: poId }, data: { status: 'APPROVED', approvedById: boss.id, approvedAt: new Date() } })
      },
    })

    const after = await pendingIn('PURCHASE')
    check('it leaves Pending', after.length === 0, `${after.length} still waiting`)
    const settled = await recordIn('PURCHASE')
    check('and appears in Record', settled.length === 1, `${settled.length}`)
    check('as approved', settled[0]?.outcome === 'APPROVED', settled[0]?.outcome)
    check('naming who decided it', settled[0]?.decidedByName === 'Boss', String(settled[0]?.decidedByName))
    check('with when', settled[0]?.decidedAt !== null)
    check('and a way back to the order', settled[0]?.href === `/dashboard/purchases/${poId}`)

    const counts = await getPendingCountsByType(restaurant.id, null)
    check('the badge drops to zero', counts.PURCHASE === 0, `${counts.PURCHASE}`)

    // The approved order must not reappear through the orphan-purchase query.
    check('and the approved order is not counted a second time', settled.filter((r) => r.id === poId || r.reference?.includes('Purchase')).length === 1)
  }

  console.log('\n── 5. A refusal is kept, with its reason ──')
  {
    const refund = await prisma.approvalRequest.findFirstOrThrow({
      where: { restaurantId: restaurant.id, kind: 'REFUND', status: 'PENDING' },
    })
    await decideApproval({
      restaurantId: restaurant.id, approvalId: refund.id, approve: false, userId: boss.id,
      note: 'The guest ate it', unconfined: true,
    })

    const money = await pendingIn('MONEY')
    check('the refund leaves Pending', money.every((row) => row.queue !== 'Refund'), money.map((r) => r.queue).join(', '))
    check('the petty cash is still waiting', money.length === 1 && money[0].queue === 'Petty cash')

    const settled = await recordIn('MONEY')
    const rejected = settled.find((row) => row.queue === 'Refund')
    check('and the refund is in Record', rejected !== undefined)
    check('marked rejected', rejected?.outcome === 'REJECTED', rejected?.outcome)
    check('with the reason kept', rejected?.decisionNote === 'The guest ate it', String(rejected?.decisionNote))
  }

  console.log('\n── 6. Nothing is in both lists, on any tab ──')
  {
    for (const type of REQUEST_TYPES) {
      const waiting = await pendingIn(type)
      const settled = await recordIn(type)
      const overlap = waiting.filter((row) => settled.some((done) => done.id === row.id))
      check(`${type}: no request is both waiting and settled`, overlap.length === 0, overlap.map((r) => r.title).join(', '))
    }
  }
}

main()
  .catch((error) => {
    failed += 1
    console.error('\n  ✗ crashed:', error)
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
