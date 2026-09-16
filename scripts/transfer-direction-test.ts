/**
 * Transfers are pulled, not pushed (recorrection.md §1).
 *
 * The branch that needs stock asks for it; the source approves and sends; the
 * destination receives. That fixes which end may do what, and this file pins
 * each of those facts:
 *
 *   - a request is raised by somebody at the DESTINATION (the form locks it,
 *     the action refuses anything else; an owner may act for any branch);
 *   - the list files every transfer by its status AND by which end the viewer
 *     stands at, so "waiting on you" is a fact and not a guess;
 *   - the transfer page no longer offers Approve — the desk owns that;
 *   - every transfer audit names its branch, and completion has its own key.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/transfer-direction-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { getLocationBalance } from '../src/features/inventory/location-stock'
import { getTransferBuilderData } from '../src/features/transfers/queries'
import { sectionFor } from '../src/features/transfers/sections'
import {
  approveTransfer, assertTransferSide, dispatchTransfer, receiveTransfer, requestTransfer,
} from '../src/features/transfers/service'
import { AUDIT_ACTIONS } from '../src/server/audit'

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

function refusesSync(name: string, run: () => unknown) {
  try {
    run()
    check(name, false, 'it was allowed')
  } catch {
    check(name, true)
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

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Pull Co', slug: `pull-${stamp}`, email: `pull-${stamp}@test.local` },
  })
  restaurantId = restaurant.id
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true },
  })
  const jaffna = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Jaffna', code: 'JAF' },
  })
  const owner = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `owner-${stamp}@test.local`, name: 'Owner', passwordHash: 'x', role: 'OWNER' },
  })
  const ends = { fromBranchId: kandy.id, toBranchId: jaffna.id }
  const atKandy = { role: 'MANAGER' as const, branchId: kandy.id }
  const atJaffna = { role: 'MANAGER' as const, branchId: jaffna.id }
  const unconfined = { role: 'OWNER' as const, branchId: null }

  console.log('\n── 1. The destination requests ──')
  {
    assertTransferSide(atJaffna, ends, 'DESTINATION')
    check('somebody at the destination may request', true)
    refusesSync('somebody at the source may not — that would be a push', () => assertTransferSide(atKandy, ends, 'DESTINATION'))
    assertTransferSide(unconfined, ends, 'DESTINATION')
    check('an owner may act for any destination', true)
    assertTransferSide(atKandy, ends, 'SOURCE')
    check('and the source still approves, dispatches', true)
    refusesSync('which the destination may not', () => assertTransferSide(atJaffna, ends, 'SOURCE'))

    const actions = readFileSync('src/features/transfers/actions.ts', 'utf8')
    const request = actions.slice(actions.indexOf('export async function requestTransferAction'), actions.indexOf('export async function approveTransferAction'))
    // The CALL, not the prose: the comment above it records that EITHER was
    // reversed, by name.
    check('requestTransferAction guards the DESTINATION side', /assertTransferSide\([^)]*'DESTINATION'\)/.test(request))
    check('and no longer EITHER', !/assertTransferSide\([^)]*'EITHER'\)/.test(request))
  }

  console.log('\n── 2. The form knows whom it is for ──')
  {
    const confined = await getTransferBuilderData(restaurant.id, [jaffna.id])
    check('a confined requester may act for their own branch only', confined.actableBranchIds?.length === 1 && confined.actableBranchIds[0] === jaffna.id)
    check('but every location is offered as a source — you ask a warehouse you cannot open', confined.locations.some((l) => l.id === kandy.id))
    const open = await getTransferBuilderData(restaurant.id, null)
    check('an owner may act for any', open.actableBranchIds === null)

    const builder = readFileSync('src/features/transfers/components/transfer-builder.tsx', 'utf8')
    check('the form locks the destination when there is exactly one', builder.includes('destinations.length === 1'))
    check('and offers the sources minus it', builder.includes('locations.filter((l) => l.id !== toId)'))
  }

  console.log('\n── 3. Four sections, by status and by side ──')
  {
    const t = (status: string) => ({ status, fromName: 'Kandy', toName: 'Jaffna' })
    const [s1, h1] = sectionFor(t('REQUESTED'), true, false)
    check('requested, at source: pending approval, on you', s1 === 'approval' && /on you/.test(h1))
    const [s2, h2] = sectionFor(t('REQUESTED'), false, true)
    check('requested, at destination: pending approval, waiting for Kandy', s2 === 'approval' && /Waiting for Kandy/.test(h2))
    const [s3, h3] = sectionFor(t('APPROVED'), true, false)
    check('approved, at source: pending dispatch, on you', s3 === 'dispatch' && /on you/.test(h3))
    const [s4, h4] = sectionFor(t('APPROVED'), false, true)
    check('approved, at destination: filed under receive, not a dispatch they cannot do', s4 === 'receive' && /waiting for Kandy to dispatch/.test(h4))
    const [s5, h5] = sectionFor(t('DISPATCHED'), false, true)
    check('dispatched, at destination: pending receive, on you', s5 === 'receive' && /on you/.test(h5))
    const [s6, h6] = sectionFor(t('IN_TRANSIT'), true, false)
    check('in transit, at source: pending receive, waiting for Jaffna', s6 === 'receive' && /waiting for Jaffna/.test(h6))
    const [s7] = sectionFor(t('RECEIVED'), false, true)
    check('received (variance to confirm): still receive', s7 === 'receive')
    check('completed, rejected, cancelled: closed', ['COMPLETED', 'REJECTED', 'CANCELLED'].every((s) => sectionFor(t(s), true, true)[0] === 'closed'))
    check(
      'an owner, at both ends, is "on you" at every open step',
      ['REQUESTED', 'APPROVED', 'DISPATCHED', 'RECEIVED'].every((s) => /on you/.test(sectionFor(t(s), true, true)[1])),
    )
  }

  console.log('\n── 4. The transfer page does not decide; the desk does ──')
  {
    const panel = readFileSync('src/features/transfers/components/transfer-panel.tsx', 'utf8')
    check('no Approve button on the transfer page', !panel.includes('approveTransferAction'))
    check('no hard-coded "Not needed" rejection', !panel.includes("'Not needed'"))
    check('it points at the approvals desk instead', panel.includes('/dashboard/approvals'))
    const page = readFileSync('src/app/dashboard/transfers/[transferId]/page.tsx', 'utf8')
    check('and the page computes no approve flag', !page.includes('approve:'))
  }

  console.log('\n── 5. Every transfer audit names its branch; completion is its own key ──')
  {
    check('TRANSFER_COMPLETED exists', AUDIT_ACTIONS.TRANSFER_COMPLETED === 'transfer.completed')
    const actions = readFileSync('src/features/transfers/actions.ts', 'utf8')
    check('completion is logged under it', actions.includes('AUDIT_ACTIONS.TRANSFER_COMPLETED'))
    const audits = actions.split('audit({').slice(1)
    check(`all ${audits.length} transfer audits carry a branchId`, audits.length >= 7 && audits.every((chunk) => chunk.slice(0, 400).includes('branchId:')))
  }

  console.log('\n── 6. The pull, end to end at the service ──')
  {
    const rice = await prisma.inventoryItem.create({
      data: { restaurantId: restaurant.id, name: `Rice ${stamp}`, unit: 'KG', branchId: kandy.id, costPerUnit: 200_00 },
    })
    await prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId: rice.id, type: 'PURCHASE', quantity: 20,
        branchId: kandy.id, locationId: null, userId: owner.id,
      }),
    )
    const at = async (branchId: string) =>
      (await getLocationBalance({ restaurantId: restaurant.id, itemId: rice.id, branchId })).available

    const transfer = await requestTransfer({
      restaurantId: restaurant.id, fromBranchId: kandy.id, toBranchId: jaffna.id,
      lines: [{ itemId: rice.id, quantity: 8 }], userId: owner.id,
    })
    check('requested moves nothing', (await at(kandy.id)) === 20 && (await at(jaffna.id)) === 0)
    await approveTransfer({ restaurantId: restaurant.id, transferId: transfer.id, userId: owner.id })
    check('approved moves nothing either — it reserves', (await at(kandy.id)) === 20)
    await dispatchTransfer({ restaurantId: restaurant.id, transferId: transfer.id, userId: owner.id })
    check('dispatched: it has left the source', (await at(kandy.id)) === 12)
    check('and not yet arrived', (await at(jaffna.id)) === 0)
    const lines = await prisma.stockTransferLine.findMany({ where: { transferId: transfer.id } })
    await receiveTransfer({
      restaurantId: restaurant.id, transferId: transfer.id, userId: owner.id,
      lines: lines.map((l) => ({ lineId: l.id, receivedQty: 8 })),
    })
    check('received: it is on the destination shelf', (await at(jaffna.id)) === 8)
    const done = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })
    check('and the transfer is closed out', done.status === 'COMPLETED' || done.status === 'RECEIVED')
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
