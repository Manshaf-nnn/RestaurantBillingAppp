/**
 * PO request → approval → approved PO → receive/GRN → FIFO inventory.
 *
 * The whole chain, at the service layer, against a real database. What it
 * holds:
 *
 *   · a request is DRAFT until submitted, PENDING while decided, and comes
 *     back RETURNED (editable) or REJECTED (terminal) with a reason — never
 *     without one;
 *   · the decision goes through the approvals desk, so the desk's own rules
 *     hold: the requester cannot sign their own, an unconfined owner may and
 *     is marked as having done so;
 *   · nothing can be received against anything but an approved order;
 *   · a partial delivery leaves the remainder outstanding, a second delivery
 *     completes it, one more than was ordered is refused;
 *   · a price that differs from the order is recorded as a variance, and the
 *     FIFO layer is valued at what was PAID — not the PO price, not an
 *     average — with each delivery its own layer;
 *   · the invoice date is kept; a closed order takes no more stock.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/po-workflow-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  applyPurchaseDecision,
  createPurchaseOrder,
  setPurchaseStatus,
  updatePurchaseOrder,
} from '../src/features/purchasing/service'
import { receiveGoods } from '../src/features/purchasing/receiving'
import {
  getItemPriceInsight,
  getPurchaseDetail,
  listAwaitingDelivery,
  listPurchaseOrders,
  pendingPurchaseApproval,
} from '../src/features/purchasing/queries'
import { REQUEST_VIEWS } from '../src/features/purchasing/status'
import {
  decideApproval,
  getApprovalDetail,
  requestApproval,
} from '../src/features/approvals/service'

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

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ''}` : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

const stamp = Date.now().toString(36)
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.approvalRequest.deleteMany({ where: { restaurantId: id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { restaurantId: id } } })
  await prisma.goodsReceipt.deleteMany({ where: { restaurantId: id } })
  await prisma.purchasePriceHistory.deleteMany({ where: { restaurantId: id } })
  await prisma.purchaseItem.deleteMany({ where: { purchase: { restaurantId: id } } })
  await prisma.purchase.deleteMany({ where: { restaurantId: id } })
  await prisma.stockMovementLot.deleteMany({ where: { restaurantId: id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: id } })
  await prisma.supplier.deleteMany({ where: { restaurantId: id } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: `PO flow ${stamp}`, slug: `po-flow-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
  })
  restaurantId = restaurant.id
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: `ABC Foods ${stamp}` },
  })
  const chicken = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Chicken Breast', unit: 'KG', quantity: 0, costPerUnit: 0 },
  })
  const cheese = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Cheese Slice', unit: 'PIECE', quantity: 0, costPerUnit: 0 },
  })
  const person = (name: string, role: 'OWNER' | 'PURCHASING_MANAGER' | 'MANAGER', branchId: string | null) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `${name.toLowerCase()}-${stamp}@test.local`, name,
        passwordHash: 'x', role, branchId, emailVerifiedAt: new Date(),
      },
    })
  const owner = await person('Ova', 'OWNER', null)
  const rifnas = await person('Rifnas', 'MANAGER', main.id)
  const kavi = await person('Kavi', 'MANAGER', main.id)

  /** What `submitPurchaseAction` does, at the service layer. */
  const submit = async (purchaseId: string, byUserId: string) => {
    const po = await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId, status: 'PENDING_APPROVAL', userId: byUserId })
    await requestApproval({
      restaurantId: restaurant.id, branchId: po.branchId, kind: 'PURCHASE_ORDER',
      entity: 'Purchase', entityId: po.id, amount: po.total, reason: po.notes ?? `Purchase request ${po.number}`,
      userId: byUserId,
    })
    return po
  }
  /** What `decidePurchaseAction` does when a desk request is pending. */
  const decideViaDesk = async (
    purchaseId: string,
    decision: 'APPROVE' | 'REJECT' | 'RETURN',
    byUserId: string,
    reason: string | null,
    unconfined: boolean,
  ) => {
    const pending = await pendingPurchaseApproval(restaurant.id, purchaseId)
    if (!pending) throw new Error('no pending desk request')
    return decideApproval({
      restaurantId: restaurant.id, approvalId: pending.id, approve: decision === 'APPROVE',
      userId: byUserId, note: reason, unconfined,
      apply: async (tx) => {
        await applyPurchaseDecision({ restaurantId: restaurant.id, purchaseId, decision, userId: byUserId, reason, tx })
      },
    })
  }

  console.log('\n── 1. A request: draft → pending → returned → pending → approved ──')
  const first = await createPurchaseOrder({
    restaurantId: restaurant.id, supplierId: supplier.id, branchId: main.id, userId: rifnas.id,
    priority: 'URGENT', notes: 'Weekend stock replenishment',
    lines: [
      { itemId: chicken.id, quantity: 30, unit: 'KG', unitCost: 128_000 },
      { itemId: cheese.id, quantity: 100, unit: 'PIECE', unitCost: 11_500 },
    ],
  })
  check('a new request is a draft', first.status === 'DRAFT')
  check('it carries its priority', first.priority === 'URGENT')
  check('and its estimated total', first.total === 30 * 128_000 + 100 * 11_500, String(first.total))

  await refuses('nothing can be received against a draft', () =>
    receiveGoods({ restaurantId: restaurant.id, purchaseId: first.id, lines: [{ purchaseItemId: 'x', acceptedQty: 1 }] }),
    /Approve the order|PO_NOT_APPROVED/)

  const submitted = await submit(first.id, rifnas.id)
  check('submitting makes it pending', submitted.status === 'PENDING_APPROVAL')
  check('and stamps when', submitted.submittedAt !== null)
  const desk = await pendingPurchaseApproval(restaurant.id, first.id)
  check('and raises a request on the approvals desk', desk !== null && desk.requestedById === rifnas.id)
  const deskDetail = await getApprovalDetail({ restaurantId: restaurant.id, approvalId: desk!.id })
  check('which carries the lines for the approver to read', deskDetail.purchase?.items.length === 2 && deskDetail.purchase.number === first.number)

  await refuses('the person who raised it cannot approve it', () =>
    decideViaDesk(first.id, 'APPROVE', rifnas.id, null, false),
    /own request|APPROVAL_SELF/)
  await refuses('nothing can be received while it is pending', () =>
    receiveGoods({ restaurantId: restaurant.id, purchaseId: first.id, lines: [{ purchaseItemId: 'x', acceptedQty: 1 }] }),
    /Approve the order|PO_NOT_APPROVED/)

  await refuses('returning it needs a reason', () =>
    applyPurchaseDecision({ restaurantId: restaurant.id, purchaseId: first.id, decision: 'RETURN', userId: kavi.id, reason: '' }),
    /needs changing|PO_NO_REASON/)
  await decideViaDesk(first.id, 'RETURN', kavi.id, 'Cheese quantity looks high — check the par', false)
  let row = await prisma.purchase.findUniqueOrThrow({ where: { id: first.id } })
  check('returned for edit, with the reason on the order', row.status === 'RETURNED' && row.decisionNote?.includes('par') === true)
  const deskRow = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: desk!.id } })
  check('and the desk row says it was sent back', deskRow.status === 'REJECTED' && deskRow.decidedById === kavi.id)
  await refuses('nothing can be received while it is returned', () =>
    receiveGoods({ restaurantId: restaurant.id, purchaseId: first.id, lines: [{ purchaseItemId: 'x', acceptedQty: 1 }] }),
    /Approve the order|PO_NOT_APPROVED/)

  await updatePurchaseOrder({
    restaurantId: restaurant.id, purchaseId: first.id,
    lines: [
      { itemId: chicken.id, quantity: 30, unit: 'KG', unitCost: 128_000 },
      { itemId: cheese.id, quantity: 100, unit: 'PIECE', unitCost: 11_500 },
    ],
    notes: 'Weekend stock replenishment (par confirmed)',
  })
  check('a returned request can be edited', true)
  const resubmitted = await submit(first.id, rifnas.id)
  check('and resubmitted', resubmitted.status === 'PENDING_APPROVAL' && resubmitted.decisionNote === null)
  const second = await pendingPurchaseApproval(restaurant.id, first.id)
  check('with a fresh desk request', second !== null && second.id !== desk!.id)

  await refuses('rejecting needs a reason too', () =>
    decideViaDesk(first.id, 'REJECT', kavi.id, '', false),
    /reason|APPROVAL_NO_REASON|PO_NO_REASON/)

  const ruling = await decideViaDesk(first.id, 'APPROVE', kavi.id, null, false)
  row = await prisma.purchase.findUniqueOrThrow({ where: { id: first.id } })
  check('a second person approves it', row.status === 'APPROVED' && row.approvedById === kavi.id && row.approvedAt !== null)
  check('and the desk row agrees', ruling.status === 'APPROVED' && !ruling.forced)
  await refuses('an approved order cannot be edited', () =>
    updatePurchaseOrder({ restaurantId: restaurant.id, purchaseId: first.id, lines: [{ itemId: chicken.id, quantity: 1, unit: 'KG', unitCost: 1 }] }),
    /cannot be edited|PO_NOT_EDITABLE/)

  console.log('\n── 2. An owner signing their own is allowed, and marked ──')
  const own = await createPurchaseOrder({
    restaurantId: restaurant.id, branchId: main.id, userId: owner.id,
    lines: [{ itemId: chicken.id, quantity: 5, unit: 'KG', unitCost: 128_000 }],
  })
  await submit(own.id, owner.id)
  const forced = await decideViaDesk(own.id, 'APPROVE', owner.id, null, true)
  check('an unconfined owner may approve their own request', forced.status === 'APPROVED')
  check('and it is recorded as an override', forced.forced && forced.forcedAt !== null)

  console.log('\n── 3. Rejection is terminal ──')
  const bad = await createPurchaseOrder({
    restaurantId: restaurant.id, branchId: main.id, userId: rifnas.id,
    lines: [{ itemId: cheese.id, quantity: 500, unit: 'PIECE', unitCost: 11_500 }],
  })
  await submit(bad.id, rifnas.id)
  await decideViaDesk(bad.id, 'REJECT', kavi.id, 'Far more than we sell in a month', false)
  row = await prisma.purchase.findUniqueOrThrow({ where: { id: bad.id } })
  check('rejected, with the reason kept', row.status === 'REJECTED' && row.decisionNote?.includes('month') === true)
  await refuses('it cannot be resubmitted', () =>
    setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: bad.id, status: 'PENDING_APPROVAL' }),
    /cannot become|PO_BAD_TRANSITION/)
  await refuses('and nothing can be received against it', () =>
    receiveGoods({ restaurantId: restaurant.id, purchaseId: bad.id, lines: [{ purchaseItemId: 'x', acceptedQty: 1 }] }),
    /Approve the order|PO_NOT_APPROVED/)

  console.log('\n── 4. Partial receiving, price variance, and the FIFO layer ──')
  const detail = await getPurchaseDetail({ restaurantId: restaurant.id, purchaseId: first.id, currency: 'LKR' })
  const chickenLine = detail.lines.find((l) => l.itemId === chicken.id)!
  const cheeseLine = detail.lines.find((l) => l.itemId === cheese.id)!

  const grn1 = await receiveGoods({
    restaurantId: restaurant.id, purchaseId: first.id, userId: kavi.id,
    supplierRef: 'INV-45821', invoiceDate: new Date('2026-09-28T00:00:00Z'),
    lines: [
      // The invoice says 1,320 a kilo, not the 1,280 the order agreed.
      { purchaseItemId: chickenLine.id, acceptedQty: 30, unitCost: 132_000 },
      // Only 80 of the 100 slices came.
      { purchaseItemId: cheeseLine.id, acceptedQty: 80 },
    ],
  })
  check('the first delivery leaves the order partially received', grn1.status === 'PARTIALLY_RECEIVED')
  check('the invoice number and date are on the GRN', grn1.receipt.supplierRef === 'INV-45821' && grn1.receipt.invoiceDate?.toISOString().startsWith('2026-09-28') === true)
  check('the price variance is named', grn1.variances.length === 1 && grn1.variances[0].itemId === chicken.id, JSON.stringify(grn1.variances))
  check('as +3.1% against the order', Math.abs(grn1.variances[0].priceVariance - 0.03125) < 1e-9, String(grn1.variances[0].priceVariance))

  const after1 = await getPurchaseDetail({ restaurantId: restaurant.id, purchaseId: first.id, currency: 'LKR' })
  check('20 slices stay outstanding', after1.lines.find((l) => l.itemId === cheese.id)?.outstanding === 20)
  check('the order itself still says 1,280 — the PO was not rewritten', after1.lines.find((l) => l.itemId === chicken.id)?.unitCost === 128_000)
  check('the receipt records both prices', after1.receipts[0].lines.find((l) => l.name === 'Chicken Breast')?.unitCost === 132_000 && after1.receipts[0].lines.find((l) => l.name === 'Chicken Breast')?.orderedUnitCost === 128_000)

  const chickenLayers = await prisma.stockBatch.findMany({ where: { restaurantId: restaurant.id, itemId: chicken.id, branchId: main.id } })
  check('the delivery is one FIFO layer', chickenLayers.length === 1, `${chickenLayers.length}`)
  check('valued at what was PAID, exactly', chickenLayers[0]?.receivedValue === 30 * 132_000 && chickenLayers[0]?.remainingValue === 30 * 132_000, String(chickenLayers[0]?.receivedValue))
  check('not at the PO price', chickenLayers[0]?.receivedValue !== 30 * 128_000)
  check('with the per-unit cost derived from it', chickenLayers[0]?.unitCost === 132_000, String(chickenLayers[0]?.unitCost))

  const history = await getItemPriceInsight({ restaurantId: restaurant.id, itemId: chicken.id })
  check('and the price history now says 1,320 was last paid', history.last?.unitCost === 132_000 && history.last.supplierName === supplier.name)
  check('with the receipt it came on', history.last?.receiptNumber === grn1.receipt.number)

  const stillAwaiting = await listAwaitingDelivery({ restaurantId: restaurant.id })
  check('the order is still awaiting the rest', stillAwaiting.some((po) => po.id === first.id && po.outstandingQty === 20))

  await refuses('one more slice than was ordered is refused', () =>
    receiveGoods({ restaurantId: restaurant.id, purchaseId: first.id, lines: [{ purchaseItemId: cheeseLine.id, acceptedQty: 21 }] }),
    /more than the|RECEIPT_OVER/)

  const grn2 = await receiveGoods({
    restaurantId: restaurant.id, purchaseId: first.id, userId: kavi.id,
    lines: [{ purchaseItemId: cheeseLine.id, acceptedQty: 20, unitCost: 11_000 }],
  })
  check('the second delivery completes the order', grn2.status === 'RECEIVED')
  const cheeseLayers = await prisma.stockBatch.findMany({
    where: { restaurantId: restaurant.id, itemId: cheese.id, branchId: main.id }, orderBy: { createdAt: 'asc' },
  })
  check('each delivery is its own layer', cheeseLayers.length === 2, `${cheeseLayers.length}`)
  check('each at its own cost', cheeseLayers[0]?.receivedValue === 80 * 11_500 && cheeseLayers[1]?.receivedValue === 20 * 11_000)
  const stockValue = cheeseLayers.reduce((sum, layer) => sum + layer.remainingValue, 0)
  check('stock value is the sum of the layers, not quantity × an average', stockValue === 80 * 11_500 + 20 * 11_000, String(stockValue))

  console.log('\n── 5. Closing ──')
  await refuses('nothing more can be received against a fully received order', () =>
    receiveGoods({ restaurantId: restaurant.id, purchaseId: first.id, lines: [{ purchaseItemId: cheeseLine.id, acceptedQty: 1 }] }),
    /more than the|RECEIPT_OVER/)
  const closed = await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: first.id, status: 'CLOSED', userId: kavi.id })
  check('a received order closes', closed.status === 'CLOSED' && closed.closedAt !== null)
  check('and leaves the awaiting list', !(await listAwaitingDelivery({ restaurantId: restaurant.id })).some((po) => po.id === first.id))

  // Closing short: the owner's own order, half delivered, remainder not coming.
  const ownDetail = await getPurchaseDetail({ restaurantId: restaurant.id, purchaseId: own.id, currency: 'LKR' })
  await receiveGoods({ restaurantId: restaurant.id, purchaseId: own.id, lines: [{ purchaseItemId: ownDetail.lines[0].id, acceptedQty: 2 }] })
  const short = await setPurchaseStatus({ restaurantId: restaurant.id, purchaseId: own.id, status: 'CLOSED', userId: owner.id })
  check('a partially received order can be closed short', short.status === 'CLOSED')
  await refuses('and then takes no more stock', () =>
    receiveGoods({ restaurantId: restaurant.id, purchaseId: own.id, lines: [{ purchaseItemId: ownDetail.lines[0].id, acceptedQty: 1 }] }),
    /closed|PO_CLOSED/i)

  console.log('\n── 6. The list reads by status ──')
  const pendingView = REQUEST_VIEWS.find((v) => v.key === 'pending')!
  const extra = await createPurchaseOrder({
    restaurantId: restaurant.id, branchId: main.id, userId: rifnas.id,
    lines: [{ itemId: chicken.id, quantity: 1, unit: 'KG', unitCost: 100 }],
  })
  await submit(extra.id, rifnas.id)
  const pendingRows = await listPurchaseOrders({ restaurantId: restaurant.id, statuses: pendingView.statuses })
  check('the pending view shows only pending requests', pendingRows.length === 1 && pendingRows[0].id === extra.id, `${pendingRows.length}`)
  const rejectedRows = await listPurchaseOrders({ restaurantId: restaurant.id, statuses: ['REJECTED'] })
  check('and the rejected view the rejected one', rejectedRows.length === 1 && rejectedRows[0].id === bad.id)
  check('rows carry priority and who asked', pendingRows[0].priority === 'NORMAL' && pendingRows[0].createdByName === 'Rifnas')
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
