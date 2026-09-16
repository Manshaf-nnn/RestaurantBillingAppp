/**
 * The approvals desk, second pass (recorrection.md §1).
 *
 * ── What went wrong the first time, and is pinned here so it stays fixed ───
 *
 *   1. Deciding was gated on `settings.manage`. A MANAGER could open the desk,
 *      configure its approvers and hold the override, and decide nothing. The
 *      gate is now the permission for the KIND of request.
 *   2. An owner who was not on a branch's approver list was hard-blocked, and
 *      the pending queue never offered the override — a live deadlock. An
 *      unconfined user is bound by no list; their own request is allowed and
 *      marked as forced.
 *   3. The decision and its consequence were two steps, the second in a
 *      try/catch that swallowed. An APPROVED request could point at a
 *      REQUESTED transfer. They are one transaction now.
 *   4. The destination of a transfer could not see the request it raised;
 *      the row showed a line count instead of the lines; the consequence
 *      text said "dispatches" when it reserves.
 *   5. Filters narrowed only the history table. They narrow the pending desk.
 *   6. Wastage awaiting review was invisible to a desk that claimed to hold
 *      every decision.
 *   7. Two managers saving two branches' approver lists at once lost one.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/approval-desk-test.ts
 */
import { readFileSync } from 'node:fs'

import { ApprovalKind } from '@prisma/client'

import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { getApprovalsInbox, getApprovalsInboxCount } from '../src/features/accounting/inbox'
import { DECIDE_PERMISSION } from '../src/features/approvals/permissions'
import {
  decideApproval,
  getApprovalDetail,
  getApprovalPolicyStamp,
  requestApproval,
  saveApprovers,
  whyCannotApprove,
  type ApprovalPolicy,
} from '../src/features/approvals/service'
import { approveTransfer, closeTransfer, requestTransfer } from '../src/features/transfers/service'
import { PERMISSIONS, permissionsFor } from '../src/lib/rbac'

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

/** Refused, and for the right reason — matched against the code and the message together. */
async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(`${code} ${message}`), `wrong reason: ${code} ${message}`)
  }
}

const stamp = Date.now().toString(36)
let restaurantId: string | null = null

/**
 * Teardown in foreign-key order. Deleting the restaurant cascades through
 * users, branches and requests, but transfer lines, movements and stock rows
 * reference the item without a cascade, so those go first.
 */
async function cleanup(restaurantId: string) {
  await prisma.stockTransferLine.deleteMany({ where: { transfer: { restaurantId } } })
  await prisma.stockTransfer.deleteMany({ where: { restaurantId } })
  await prisma.approvalRequest.deleteMany({ where: { restaurantId } })
  await prisma.wastageRecord.deleteMany({ where: { restaurantId } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId } })
  await prisma.restaurant.deleteMany({ where: { id: restaurantId } })
}
const basePolicy = { enabled: true } as ApprovalPolicy

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Desk Co', slug: `desk-${stamp}`, email: `desk-${stamp}@test.local` },
  })
  restaurantId = restaurant.id
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true },
  })
  const jaffna = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Jaffna', code: 'JAF' },
  })
  const galle = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Galle', code: 'GAL' },
  })

  const mk = (name: string, role: 'OWNER' | 'MANAGER', branchId: string | null) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        email: `${name.toLowerCase()}-${stamp}@test.local`,
        name,
        passwordHash: 'x',
        role,
        branchId,
      },
    })
  const owner = await mk('Owner', 'OWNER', null)
  const alice = await mk('Alice', 'MANAGER', kandy.id)
  const bob = await mk('Bob', 'MANAGER', kandy.id)
  const jay = await mk('Jay', 'MANAGER', jaffna.id)

  const chicken = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Chicken ${stamp}`, unit: 'KG', branchId: kandy.id, costPerUnit: 1_200_00 },
  })
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: chicken.id, type: 'PURCHASE', quantity: 5,
      branchId: kandy.id, locationId: null, userId: owner.id,
    }),
  )

  /** Jaffna asks Kandy for stock, and the request that goes to Kandy's desk. */
  let seq = 0
  const pull = async (quantity: number, by = jay) => {
    const transfer = await requestTransfer({
      restaurantId: restaurant.id,
      fromBranchId: kandy.id,
      toBranchId: jaffna.id,
      lines: [{ itemId: chicken.id, quantity }],
      userId: by.id,
    })
    const request = await requestApproval({
      restaurantId: restaurant.id,
      branchId: kandy.id,
      kind: 'STOCK_TRANSFER',
      entity: 'StockTransfer',
      entityId: transfer.id,
      reason: `Pull ${++seq}`,
      payload: { toBranchId: jaffna.id, lines: 1 },
      userId: by.id,
    })
    return { transfer, request }
  }

  console.log('\n── 1. The gate is the permission for the kind ──')
  {
    check(
      'a transfer is decided with transfer.approve',
      DECIDE_PERMISSION.STOCK_TRANSFER === PERMISSIONS.TRANSFER_APPROVE,
    )
    check('a refund with payment.refund', DECIDE_PERMISSION.REFUND === PERMISSIONS.PAYMENT_REFUND)
    check('a discount with discount.apply', DECIDE_PERMISSION.DISCOUNT === PERMISSIONS.DISCOUNT_APPLY)
    check(
      'every kind the database knows has a gate',
      Object.values(ApprovalKind).every((kind) => Boolean(DECIDE_PERMISSION[kind])),
    )
    check(
      'and a manager holds the one for transfers — the spec\'s "branch manager approves for their own branch"',
      permissionsFor({ role: 'MANAGER', permissions: [], rolePermissions: null }).has(PERMISSIONS.TRANSFER_APPROVE),
    )

    const action = readFileSync('src/features/approvals/actions.ts', 'utf8')
    const decide = action.slice(action.indexOf('export async function decideApprovalAction'), action.indexOf('export async function withdrawApprovalAction'))
    check('decideApprovalAction no longer asks for settings.manage', !decide.includes('SETTINGS_MANAGE'))
    check('it asks the per-kind map', decide.includes('DECIDE_PERMISSION[target.kind]'))
    check('and tells the service whether the decider is confined', decide.includes('unconfined: visibleBranchIds(user) === null'))
  }

  console.log('\n── 2. An owner is bound by no list; their own request is allowed and marked ──')
  {
    const listed: ApprovalPolicy = { ...basePolicy, approvers: { [kandy.id]: [bob.id] } }
    const { request: byAlice } = await pull(1, alice)

    check(
      'a confined manager off the list is refused',
      whyCannotApprove({ policy: listed, request: byAlice, userId: owner.id, unconfined: false })?.code ===
        'APPROVAL_NOT_APPROVER',
    )
    check(
      'the same person unconfined is not — the list does not bind an owner',
      whyCannotApprove({ policy: listed, request: byAlice, userId: owner.id, unconfined: true }) === null,
    )

    const { request: byOwner } = await pull(1, owner)
    check(
      'the self-rule is still NAMED for an owner',
      whyCannotApprove({ policy: listed, request: byOwner, userId: owner.id, unconfined: true })?.code ===
        'APPROVAL_SELF',
    )
    const decided = await decideApproval({
      restaurantId: restaurant.id,
      approvalId: byOwner.id,
      approve: true,
      userId: owner.id,
      unconfined: true,
    })
    check('but plain Approve goes through for them', decided.status === 'APPROVED')
    check('recorded as forced — the two-person rule was bypassed', decided.forced === true && decided.forcedAt !== null)

    const { request: byBob } = await pull(1, bob)
    await refuses(
      'a confined approver still cannot sign their own',
      () => decideApproval({ restaurantId: restaurant.id, approvalId: byBob.id, approve: true, userId: bob.id, unconfined: false }),
      /APPROVAL_SELF/,
    )
    // `decideApproval` reads the policy from the database, so the list has
    // to be there for the rule to exist.
    await saveApprovers({
      restaurantId: restaurant.id, key: kandy.id, approverIds: [bob.id],
      expectedUpdatedAt: await getApprovalPolicyStamp(restaurant.id),
    })
    await refuses(
      'nor decide off the list without asking to override — holding the permission is not using it',
      () =>
        decideApproval({
          restaurantId: restaurant.id, approvalId: byAlice.id, approve: true, userId: owner.id,
          unconfined: false, mayForce: true,
        }),
      /APPROVAL_NOT_APPROVER/,
    )
    const forced = await decideApproval({
      restaurantId: restaurant.id, approvalId: byAlice.id, approve: true, userId: owner.id,
      unconfined: false, mayForce: true, force: true,
    })
    check('with the override it goes through, marked', forced.status === 'APPROVED' && forced.forced === true)
    await saveApprovers({
      restaurantId: restaurant.id, key: kandy.id, approverIds: [],
      expectedUpdatedAt: await getApprovalPolicyStamp(restaurant.id),
    })
  }

  console.log('\n── 3. The decision and its consequence are one transaction ──')
  {
    // Five on the shelf. Two requests for five each; the second's reserve is
    // taken first, so the first cannot be honoured when it is approved.
    const a = await pull(5)
    const b = await pull(5)
    await approveTransfer({ restaurantId: restaurant.id, transferId: b.transfer.id, userId: bob.id })

    await refuses(
      'approving a transfer whose stock has gone is refused',
      () =>
        decideApproval({
          restaurantId: restaurant.id, approvalId: a.request.id, approve: true, userId: owner.id, unconfined: true,
          apply: (tx) => approveTransfer({ restaurantId: restaurant.id, transferId: a.transfer.id, userId: owner.id, tx }).then(() => undefined),
        }),
      /insufficient|not enough|only .* available|STOCK/i,
    )
    const requestAfter = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: a.request.id } })
    const transferAfter = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: a.transfer.id } })
    check('and the request is still PENDING — the ruling rolled back with it', requestAfter.status === 'PENDING')
    check('the transfer still REQUESTED', transferAfter.status === 'REQUESTED')

    // Release the other reservation and try again.
    await closeTransfer({ restaurantId: restaurant.id, transferId: b.transfer.id, status: 'CANCELLED', userId: bob.id })
    await prisma.approvalRequest.update({ where: { id: b.request.id }, data: { status: 'WITHDRAWN' } })
    const decided = await decideApproval({
      restaurantId: restaurant.id, approvalId: a.request.id, approve: true, userId: owner.id, unconfined: true,
      apply: (tx) => approveTransfer({ restaurantId: restaurant.id, transferId: a.transfer.id, userId: owner.id, tx }).then(() => undefined),
    })
    const moved = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: a.transfer.id } })
    check('once the stock is free the same decision goes through', decided.status === 'APPROVED')
    check('and the transfer moved with it', moved.status === 'APPROVED' && moved.approvedById === owner.id)

    const c = await pull(1)
    await decideApproval({
      restaurantId: restaurant.id, approvalId: c.request.id, approve: false, note: 'Not this week', userId: owner.id, unconfined: true,
      apply: (tx) => closeTransfer({ restaurantId: restaurant.id, transferId: c.transfer.id, status: 'REJECTED', reason: 'Not this week', userId: owner.id, tx }).then(() => undefined),
    })
    const rejected = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: c.transfer.id } })
    check("rejecting closes the transfer with the decider's reason", rejected.status === 'REJECTED' && rejected.rejectReason === 'Not this week')
    // Release for the sections below.
    await closeTransfer({ restaurantId: restaurant.id, transferId: a.transfer.id, status: 'CANCELLED', userId: owner.id })
  }

  console.log('\n── 4. The desk shows the transfer, to both ends ──')
  {
    const d = await pull(2)

    const detail = await getApprovalDetail({ restaurantId: restaurant.id, approvalId: d.request.id })
    check('the detail carries the transfer', detail.transfer !== null)
    check('with its own number', /^TRF-/.test(detail.transfer?.number ?? ''))
    check('both ends by name', detail.transfer?.fromBranch.name === 'Kandy' && detail.transfer?.toBranch.name === 'Jaffna')
    check('and the lines — item, quantity, unit', detail.transfer?.lines[0]?.item.name === chicken.name && detail.transfer?.lines[0]?.requestedQty === 2)

    const atSource = await getApprovalsInbox(restaurant.id, [kandy.id])
    const atDestination = await getApprovalsInbox(restaurant.id, [jaffna.id])
    const elsewhere = await getApprovalsInbox(restaurant.id, [galle.id])
    const row = atSource.find((r) => r.id === d.request.id)
    check('the source sees it', row !== undefined)
    check('the destination sees it too — the manager who raised it can watch it', atDestination.some((r) => r.id === d.request.id))
    check('a third branch does not', !elsewhere.some((r) => r.id === d.request.id))
    check('the row carries the lines', row?.transfer?.lines[0]?.quantity === 2 && row?.transfer?.lines[0]?.name === chicken.name)
    check('and the destination by name', row?.transfer?.toBranchName === 'Jaffna')
    check('its reference is the transfer number', /^TRF-/.test(row?.reference ?? ''))
    check('it is filed under Stock transfers', row?.category === 'Stock transfers')
    check(
      'and the consequence says reserves, not dispatches',
      /reserves the stock at Kandy/.test(row?.consequence ?? '') && !/dispatches the transfer/.test(row?.consequence ?? ''),
    )
    check('the row names the kind for the per-kind gate', row?.approvalKind === 'STOCK_TRANSFER')

    console.log('\n── 5. Filters narrow the pending desk ──')
    const has = async (filters: Parameters<typeof getApprovalsInbox>[2]) =>
      (await getApprovalsInbox(restaurant.id, null, filters)).some((r) => r.id === d.request.id)
    check('kind = transfer keeps it', await has({ kind: 'STOCK_TRANSFER' }))
    check('kind = refund drops it', !(await has({ kind: 'REFUND' })))
    check('requested by Jay keeps it', await has({ requestedById: jay.id }))
    check('requested by Bob drops it', !(await has({ requestedById: bob.id })))
    check('from Kandy keeps it', await has({ fromBranchId: kandy.id }))
    check('from Jaffna drops it', !(await has({ fromBranchId: jaffna.id })))
    check('to Jaffna keeps it — the destination lives in the payload', await has({ toBranchId: jaffna.id }))
    check('to Kandy drops it', !(await has({ toBranchId: kandy.id })))
    check('status = waiting keeps it', await has({ status: 'PENDING' }))
    check('status = approved empties the pending desk by definition', (await getApprovalsInbox(restaurant.id, null, { status: 'APPROVED' })).length === 0)
    const dayMs = 86_400_000
    check('a date range that covers today keeps it', await has({ from: new Date(Date.now() - dayMs), to: new Date(Date.now() + dayMs) }))
    check('a range ending yesterday drops it', !(await has({ to: new Date(Date.now() - dayMs) })))
    check('a range starting tomorrow drops it', !(await has({ from: new Date(Date.now() + dayMs) })))
  }

  console.log('\n── 6. Write-offs join the desk ──')
  {
    const wastage = await prisma.wastageRecord.create({
      data: {
        restaurantId: restaurant.id, itemId: chicken.id, quantity: 0.5, enteredUnit: 'KG',
        costValue: 600_00, reason: 'SPOILED', reasonNote: 'Left out overnight',
        branchId: kandy.id, createdById: alice.id,
      },
    })
    const rows = await getApprovalsInbox(restaurant.id, [kandy.id])
    const row = rows.find((r) => r.kind === 'WASTAGE' && r.id === wastage.id)
    check('a recorded write-off is on the desk', row !== undefined)
    check('under Stock write-offs', row?.category === 'Stock write-offs')
    check('naming the item and quantity', (row?.title ?? '').includes(chicken.name) && (row?.title ?? '').includes('0.5'))
    check("with the recorder's reason", row?.reason === 'Left out overnight')
    check('and the cost', row?.amount === 600_00)
    check('honest that the stock is already gone', /already written off/.test(row?.consequence ?? ''))
    check('narrowed by the write-off kind', (await getApprovalsInbox(restaurant.id, null, { kind: 'STOCK_WRITEOFF' })).every((r) => r.kind === 'WASTAGE'))
    check('and absent from a transfer-only view', !(await getApprovalsInbox(restaurant.id, null, { kind: 'STOCK_TRANSFER' })).some((r) => r.kind === 'WASTAGE'))

    const count = await getApprovalsInboxCount(restaurant.id, [kandy.id])
    check('the badge counts it', count.byQueue.some((q) => q.queue === 'Write-offs' && q.count >= 1))
  }

  console.log('\n── 7. Saving an approver list is compare-and-swap ──')
  {
    const stale = await getApprovalPolicyStamp(restaurant.id)
    const first = await saveApprovers({ restaurantId: restaurant.id, key: kandy.id, approverIds: [bob.id], expectedUpdatedAt: stale })
    check('the first write lands', first.after.length === 1)
    await refuses(
      'a second write with the same stamp is refused — somebody moved the row',
      () => saveApprovers({ restaurantId: restaurant.id, key: jaffna.id, approverIds: [jay.id], expectedUpdatedAt: stale }),
      /APPROVAL_POLICY_CHANGED/,
    )
    const kept = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurant.id }, select: { approvalPolicy: true } })
    const approvers = (kept.approvalPolicy as { approvers?: Record<string, string[]> }).approvers ?? {}
    check("and Kandy's list survived", approvers[kandy.id]?.[0] === bob.id)
    check("Jaffna's was not written", approvers[jaffna.id] === undefined)
    const fresh = await getApprovalPolicyStamp(restaurant.id)
    const second = await saveApprovers({ restaurantId: restaurant.id, key: jaffna.id, approverIds: [jay.id], expectedUpdatedAt: fresh })
    check('with a fresh stamp it lands, and the previous list is reported', second.before.length === 0 && second.after[0] === jay.id)
  }

}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
