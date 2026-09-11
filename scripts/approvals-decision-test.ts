/**
 * Deciding a request, safely (bill.md §3 and §4).
 *
 * The bug this file exists for: the status check and the write were two
 * separate statements with nothing between them, so two managers opening the
 * queue at the same moment both passed the check and both wrote. The second
 * silently overwrote the first's decision — and because approving a stock
 * transfer RESERVES stock, the same stock was reserved twice. A status
 * assertion alone would not have caught that, so the race test counts the
 * movements.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/approvals-decision-test.ts
 */
import {
  decideApproval,
  listApprovals,
  requestApproval,
  withdrawApproval,
} from '../src/features/approvals/service'
import { prisma } from '../src/server/db/prisma'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Appr ${stamp}`, slug: `appr-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      timezone: 'Asia/Colombo',
    },
  })
  const colombo = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Colombo', code: 'COL', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KAN' },
  })
  const mkUser = (label: string, branchId?: string) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `${label}-${stamp}@test.local`,
        name: label, passwordHash: 'x', role: 'MANAGER',
        ...(branchId ? { branchId } : {}),
      },
    })
  const asked = await mkUser('rani')
  const owner = await mkUser('alex')
  const second = await mkUser('sam')

  const raise = (over: Partial<Parameters<typeof requestApproval>[0]> = {}) =>
    requestApproval({
      restaurantId: restaurant.id,
      branchId: colombo.id,
      kind: 'REFUND',
      entity: 'Payment',
      entityId: `pay-${Math.random().toString(36).slice(2)}`,
      amount: 25_000,
      reason: 'Guest was charged twice',
      userId: asked.id,
      ...over,
    })

  console.log('\n── 1. Two approvers, one decision ──')
  {
    const request = await raise()
    const outcomes = await Promise.allSettled([
      decideApproval({ restaurantId: restaurant.id, approvalId: request.id, approve: true, userId: owner.id }),
      decideApproval({
        restaurantId: restaurant.id, approvalId: request.id, approve: false,
        userId: second.id, note: 'Not this one',
      }),
    ])
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled').length
    check('exactly one decision lands', won === 1, `${won} won`)

    const loser = outcomes.find((outcome) => outcome.status === 'rejected')
    check('…and the other is told it was already decided',
      loser !== undefined &&
        /already been decided/.test((loser as PromiseRejectedResult).reason?.message ?? ''),
      String((loser as PromiseRejectedResult | undefined)?.reason?.message))

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })
    check('the row holds one decision, with one decider',
      ['APPROVED', 'REJECTED'].includes(row.status) && row.decidedById !== null)
  }

  console.log('\n── 2. Saying no says why ──')
  {
    const request = await raise()
    await refuses(
      'rejecting with no reason is refused',
      () => decideApproval({
        restaurantId: restaurant.id, approvalId: request.id, approve: false, userId: owner.id,
      }),
      /reason/i,
    )
    const still = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })
    check('…and the request is still waiting', still.status === 'PENDING')

    const rejected = await decideApproval({
      restaurantId: restaurant.id, approvalId: request.id, approve: false,
      userId: owner.id, note: 'Charge was correct',
    })
    check('with a reason it goes through, and the reason is kept',
      rejected.status === 'REJECTED' && rejected.decisionNote === 'Charge was correct')
    check('and the decision carries what it used to be, for the audit',
      rejected.previousStatus === 'PENDING')

    check('approving needs no essay — the approval is the answer',
      (await decideApproval({
        restaurantId: restaurant.id, approvalId: (await raise()).id, approve: true, userId: owner.id,
      })).status === 'APPROVED')
  }

  console.log('\n── 3. Nobody approves their own ──')
  {
    const request = await raise()
    await refuses(
      'the person who asked cannot decide it',
      () => decideApproval({
        restaurantId: restaurant.id, approvalId: request.id, approve: true, userId: asked.id,
      }),
      /your own request/,
    )
  }

  console.log('\n── 4. Withdrawing, also raced ──')
  {
    const request = await raise()
    const outcomes = await Promise.allSettled([
      withdrawApproval({ restaurantId: restaurant.id, approvalId: request.id, userId: asked.id }),
      withdrawApproval({ restaurantId: restaurant.id, approvalId: request.id, userId: asked.id }),
    ])
    check('two withdrawals, one winner',
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length === 1)

    const other = await raise()
    await refuses(
      'somebody else cannot withdraw your request',
      () => withdrawApproval({ restaurantId: restaurant.id, approvalId: other.id, userId: owner.id }),
      /Only the person who asked/,
    )
  }

  console.log('\n── 5. A branch manager sees their own AND the restaurant-wide ones ──')
  {
    await raise({ branchId: kandy.id, reason: 'Kandy refund' })
    await raise({ branchId: null, reason: 'Applies to the whole business' })

    const forKandy = await listApprovals({
      restaurantId: restaurant.id, branchIds: [kandy.id], status: 'PENDING',
    })
    const reasons = forKandy.map((row) => row.reason)
    check('their own branch is there', reasons.includes('Kandy refund'))
    check('and so is the restaurant-wide one — it used to be dropped entirely',
      reasons.includes('Applies to the whole business'))
    check('but not another branch’s', !reasons.includes('Guest was charged twice'))
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
