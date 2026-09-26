/**
 * The PO workflow over real HTTP: the actions as the requester, the approver
 * and the storekeeper actually call them, and the pages as they open them.
 *
 * `po-workflow-test.ts` proves the services. This proves the guards in front
 * of them — who may raise, who may decide, who may receive, and that a
 * decision or a delivery from the wrong person, the wrong site or the wrong
 * restaurant is refused with nothing written — and that every step leaves
 * its audit row.
 *
 * Run: BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json \
 *        scripts/po-flow-runtime-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

/** Server Action ids, read out of the built client bundle. */
function actionIds(): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.js')) {
        const src = readFileSync(full, 'utf8')
        const re = /createServerReference\)\("([0-9a-f]{40,42})"[^)]*?,"([A-Za-z0-9_$]+)"\)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(src))) if (!found.has(m[2])) found.set(m[2], m[1])
      }
    }
  }
  try { walk('.next/static/chunks') } catch { /* no build */ }
  return found
}

const stamp = Date.now().toString(36)
const restaurantIds: string[] = []

async function cleanup(id: string) {
  await prisma.approvalRequest.deleteMany({ where: { restaurantId: id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.session.deleteMany({ where: { user: { restaurantId: id } } })
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
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\`.`)
    process.exit(0)
  }
  const ids = actionIds()
  const createId = ids.get('createPurchaseOrderAction')
  const submitId = ids.get('submitPurchaseAction')
  const decideId = ids.get('decidePurchaseAction')
  const receiveId = ids.get('receiveGoodsAction')
  if (!createId || !submitId || !decideId || !receiveId) {
    console.error('The purchasing actions are not in the client bundle — run `npx next build` first.')
    process.exit(1)
  }

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `PO HTTP ${stamp}`, slug: `po-http-${stamp}`, email: `po-${stamp}@test.local`,
      status: 'ACTIVE', isActive: true, currency: 'LKR', timezone: 'Asia/Colombo',
    },
  })
  restaurantIds.push(restaurant.id)
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main Warehouse', code: 'MAIN', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' },
  })
  const supplier = await prisma.supplier.create({ data: { restaurantId: restaurant.id, name: 'ABC Foods' } })
  const chicken = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Chicken Breast', unit: 'KG', quantity: 0, costPerUnit: 0 },
  })
  const cheese = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Cheese Slice', unit: 'PIECE', quantity: 0, costPerUnit: 0 },
  })

  const person = (
    name: string,
    role: 'OWNER' | 'MANAGER' | 'PURCHASING_MANAGER' | 'STOCK_KEEPER' | 'ACCOUNTANT',
    branchId: string | null,
    rid = restaurant.id,
  ) =>
    prisma.user.create({
      data: {
        restaurantId: rid, email: `${name.toLowerCase()}-${stamp}@test.local`, name,
        passwordHash: 'x', role, branchId, emailVerifiedAt: new Date(),
      },
    })
  const rifnas = await person('Rifnas', 'PURCHASING_MANAGER', main.id)
  const kavi = await person('Kavi', 'MANAGER', main.id)
  const noor = await person('Noorullah', 'STOCK_KEEPER', main.id)
  const acc = await person('Acca', 'ACCOUNTANT', null)
  const kandyManager = await person('Kandyman', 'MANAGER', kandy.id)

  const other = await prisma.restaurant.create({
    data: { name: `Other ${stamp}`, slug: `other-po-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  restaurantIds.push(other.id)
  const stranger = await person('Stranger', 'OWNER', null, other.id)

  const sign = async (user: { id: string; role: string; name: string; email: string; restaurantId: string | null }) => {
    const refresh = generateToken()
    const session = await prisma.session.create({
      data: { userId: user.id, refreshTokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + 86_400_000) },
    })
    const access = await signAccessToken({
      sub: user.id, rid: user.restaurantId, role: user.role, name: user.name, email: user.email, sid: session.id,
    } as Parameters<typeof signAccessToken>[0])
    return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
  }
  const post = async (cookie: string, path: string, actionId: string, payload: unknown) => {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { cookie, 'Next-Action': actionId, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify([payload]),
      redirect: 'manual',
    })
    const body = await response.text()
    return { status: response.status, body, ok: response.status === 200 && body.includes('"ok":true') }
  }
  const visit = async (path: string, cookie: string) => {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' })
    const body = res.status === 200 ? await res.text() : ''
    const location = res.headers.get('location') ?? ''
    return {
      served: res.status === 200 && !body.includes('/forbidden'),
      refused: body.includes('/forbidden') || location.includes('/forbidden'),
      where: `${res.status} ${location}`,
    }
  }
  const auditRows = (action: string, entityId?: string) =>
    prisma.auditLog.findMany({
      where: { restaurantId: restaurant.id, action, ...(entityId ? { entityId } : {}) },
      orderBy: { createdAt: 'desc' },
    })

  const rifnasCookie = await sign(rifnas)
  const kaviCookie = await sign(kavi)
  const noorCookie = await sign(noor)
  const accCookie = await sign(acc)
  const kandyCookie = await sign(kandyManager)
  const strangerCookie = await sign(stranger)

  const request = {
    supplierId: supplier.id,
    branchId: main.id,
    expectedAt: '2026-09-28',
    priority: 'URGENT',
    notes: 'Weekend stock replenishment.',
    discount: 0,
    taxTotal: 0,
    lines: [
      { itemId: chicken.id, quantity: 30, unit: 'KG', unitCost: 1280 },
      { itemId: cheese.id, quantity: 100, unit: 'PIECE', unitCost: 115 },
    ],
  }

  console.log('\n── 1. Raising and submitting ──')
  const refusedCreate = await post(noorCookie, '/dashboard/purchases/new', createId, { ...request, submit: true })
  check('a storekeeper cannot raise a request', !refusedCreate.ok, refusedCreate.body.slice(0, 160))
  check('and nothing was written', (await prisma.purchase.count({ where: { restaurantId: restaurant.id } })) === 0)

  const created = await post(rifnasCookie, '/dashboard/purchases/new', createId, { ...request, submit: true })
  check('the buyer raises and submits in one go', created.ok, created.body.slice(0, 200))
  const po = await prisma.purchase.findFirstOrThrow({ where: { restaurantId: restaurant.id }, orderBy: { createdAt: 'desc' } })
  check('it is pending approval', po.status === 'PENDING_APPROVAL' && po.submittedAt !== null, po.status)
  check('urgent, with the required date and reason', po.priority === 'URGENT' && po.expectedAt?.toISOString().startsWith('2026-09-28') === true && po.notes === 'Weekend stock replenishment.')
  const desk = await prisma.approvalRequest.findFirst({ where: { restaurantId: restaurant.id, entity: 'Purchase', entityId: po.id } })
  check('and on the approvals desk, as a purchase order request', desk?.kind === 'PURCHASE_ORDER' && desk.status === 'PENDING' && desk.amount === po.total)
  check('raised and submitted are both on the record', (await auditRows('purchase.created', po.id)).length === 1 && (await auditRows('purchase.submitted', po.id)).length === 1)

  console.log('\n── 2. Deciding ──')
  const selfApprove = await post(rifnasCookie, `/dashboard/purchases/${po.id}`, decideId, { purchaseId: po.id, decision: 'APPROVE' })
  check('the buyer, who cannot approve purchases, is refused', !selfApprove.ok, selfApprove.body.slice(0, 160))
  const foreign = await post(strangerCookie, `/dashboard/purchases/${po.id}`, decideId, { purchaseId: po.id, decision: 'APPROVE' })
  check('another restaurant’s owner is refused', !foreign.ok)
  const otherSite = await post(kandyCookie, `/dashboard/purchases/${po.id}`, decideId, { purchaseId: po.id, decision: 'APPROVE' })
  check('a manager confined to another location is refused', !otherSite.ok, otherSite.body.slice(0, 160))
  check('and it is still pending', (await prisma.purchase.findUniqueOrThrow({ where: { id: po.id } })).status === 'PENDING_APPROVAL')

  const noReason = await post(kaviCookie, `/dashboard/purchases/${po.id}`, decideId, { purchaseId: po.id, decision: 'RETURN', reason: '' })
  check('returning without a reason is refused', !noReason.ok && /needs changing/.test(noReason.body), noReason.body.slice(0, 200))
  const returned = await post(kaviCookie, `/dashboard/purchases/${po.id}`, decideId, { purchaseId: po.id, decision: 'RETURN', reason: 'Check the cheese par first' })
  check('the manager returns it for edit', returned.ok, returned.body.slice(0, 200))
  let row = await prisma.purchase.findUniqueOrThrow({ where: { id: po.id } })
  check('returned, with the reason on it', row.status === 'RETURNED' && row.decisionNote === 'Check the cheese par first')
  check('and on the record', (await auditRows('purchase.returned_for_edit', po.id)).length === 1)

  const resubmitted = await post(rifnasCookie, `/dashboard/purchases/${po.id}`, submitId, { purchaseId: po.id })
  check('the buyer resubmits', resubmitted.ok, resubmitted.body.slice(0, 160))
  const approved = await post(kaviCookie, `/dashboard/purchases/${po.id}`, decideId, { purchaseId: po.id, decision: 'APPROVE' })
  check('the manager approves', approved.ok, approved.body.slice(0, 200))
  row = await prisma.purchase.findUniqueOrThrow({ where: { id: po.id } })
  check('approved, by the manager', row.status === 'APPROVED' && row.approvedById === kavi.id)
  const deskAfter = await prisma.approvalRequest.findMany({ where: { restaurantId: restaurant.id, entity: 'Purchase', entityId: po.id }, orderBy: { requestedAt: 'asc' } })
  check('the desk shows the return and then the approval', deskAfter.length === 2 && deskAfter[0].status === 'REJECTED' && deskAfter[1].status === 'APPROVED')
  const approvedAudit = await auditRows('purchase.approved', po.id)
  check('the approval is on the record, by the approver', approvedAudit.length === 1 && approvedAudit[0].userId === kavi.id)

  console.log('\n── 3. Who may receive ──')
  const accPage = await visit(`/dashboard/purchases/receive?po=${po.id}`, accCookie)
  check('an accountant, who may read orders, cannot open receiving', accPage.refused, accPage.where)
  const noorPage = await visit(`/dashboard/purchases/receive?po=${po.id}`, noorCookie)
  check('the storekeeper can', noorPage.served, noorPage.where)
  const noorOrder = await visit(`/dashboard/purchases/${po.id}`, noorCookie)
  check('and can read the order', noorOrder.served, noorOrder.where)

  const items = await prisma.purchaseItem.findMany({ where: { purchaseId: po.id }, include: { item: true } })
  const chickenLine = items.find((l) => l.itemId === chicken.id)!
  const cheeseLine = items.find((l) => l.itemId === cheese.id)!

  const byAccountant = await post(accCookie, '/dashboard/purchases/receive', receiveId, {
    purchaseId: po.id, supplierRef: 'INV-1', lines: [{ purchaseItemId: chickenLine.id, acceptedQty: 1 }], clientRequestId: `acc-${stamp}-00000001`,
  })
  check('the accountant cannot post a delivery either', !byAccountant.ok)

  console.log('\n── 4. Receiving: partial, at the invoice price ──')
  const grn = await post(noorCookie, '/dashboard/purchases/receive', receiveId, {
    purchaseId: po.id,
    supplierRef: 'INV-45821',
    invoiceDate: '2026-09-28',
    lines: [
      { purchaseItemId: chickenLine.id, acceptedQty: 30, unitCost: 1320 },
      { purchaseItemId: cheeseLine.id, acceptedQty: 80 },
    ],
    clientRequestId: `grn-${stamp}-00000001`,
  })
  check('the storekeeper books the delivery', grn.ok, grn.body.slice(0, 200))
  const receipt = await prisma.goodsReceipt.findFirstOrThrow({ where: { purchaseId: po.id }, include: { lines: true } })
  check('with the invoice number and date', receipt.supplierRef === 'INV-45821' && receipt.invoiceDate?.toISOString().startsWith('2026-09-28') === true)
  check('received by the storekeeper', receipt.receivedById === noor.id)
  row = await prisma.purchase.findUniqueOrThrow({ where: { id: po.id } })
  check('the order is partially received', row.status === 'PARTIALLY_RECEIVED')
  const layer = await prisma.stockBatch.findFirst({ where: { restaurantId: restaurant.id, itemId: chicken.id } })
  check('the FIFO layer is worth 30 × 1,320 — what was paid', layer?.receivedValue === 30 * 132_000, String(layer?.receivedValue))
  const receivedAudit = await auditRows('purchase.received')
  const variances = (receivedAudit[0]?.after as { priceVariances?: Array<{ item: string; percent: number }> } | null)?.priceVariances ?? []
  check('the delivery is on the record, naming the price variance', receivedAudit.length === 1 && variances.length === 1 && variances[0].item === 'Chicken Breast' && variances[0].percent === 3.1, JSON.stringify(variances))

  const over = await post(noorCookie, '/dashboard/purchases/receive', receiveId, {
    purchaseId: po.id, lines: [{ purchaseItemId: cheeseLine.id, acceptedQty: 25 }], clientRequestId: `grn-${stamp}-00000002`,
  })
  check('25 more slices against 20 outstanding is refused', !over.ok && /more than the/.test(over.body), over.body.slice(0, 200))
  check('and nothing was posted', (await prisma.goodsReceipt.count({ where: { purchaseId: po.id } })) === 1)

  const replay = await post(noorCookie, '/dashboard/purchases/receive', receiveId, {
    purchaseId: po.id,
    supplierRef: 'INV-45821',
    lines: [{ purchaseItemId: chickenLine.id, acceptedQty: 30, unitCost: 1320 }, { purchaseItemId: cheeseLine.id, acceptedQty: 80 }],
    clientRequestId: `grn-${stamp}-00000001`,
  })
  check('a retry of the same delivery is answered, not posted twice', replay.ok && (await prisma.goodsReceipt.count({ where: { purchaseId: po.id } })) === 1)
}

main()
  .catch((error) => {
    failed += 1
    console.error('\n  ✗ crashed:', error)
  })
  .finally(async () => {
    for (const id of restaurantIds) await cleanup(id).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
