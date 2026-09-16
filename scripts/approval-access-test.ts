/**
 * Who may sign a request, and what it costs to override that.
 *
 * ── The two rules this protects ────────────────────────────────────────────
 *
 * correctionA.md §9 adds two things to a control whose whole value is that it
 * cannot be worked around, so both halves need holding:
 *
 *   1. An approver list per location. The failure that matters is not "the
 *      list is ignored" — that is loud. It is the opposite: a list that is
 *      read as "nobody" when it is empty, which locks every queue in the
 *      restaurant the moment the feature ships and looks like approvals being
 *      broken rather than a setting being wrong. Empty must mean "the
 *      permission alone decides", which is how every restaurant behaves today.
 *
 *   2. Force approve. An override that is indistinguishable afterwards from an
 *      ordinary decision is the same as having no two-person rule at all, so
 *      the row itself has to say it was forced — not just the audit log, and
 *      not just the UI.
 *
 * And the thing that must NOT change: holding the override permission is not
 * the same as using it. An owner working the queue normally is still refused
 * their own request, or the override becomes the default and stops being
 * visible at all.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/approval-access-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  RESTAURANT_WIDE,
  approversFor,
  decideApproval,
  getApprovalDetail,
  listApprovals,
  requestApproval,
  whyCannotApprove,
  type ApprovalPolicy,
} from '../src/features/approvals/service'

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

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong reason: ${message}`)
  }
}

const stamp = Date.now().toString(36)
const basePolicy = { enabled: true } as ApprovalPolicy

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Approve Co', slug: `approve-${stamp}`, email: `ap-${stamp}@test.local` },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true },
  })
  const jaffna = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Jaffna', code: 'JAF' },
  })

  const mk = (name: string, role: 'OWNER' | 'MANAGER') =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        email: `${name.toLowerCase().replace(/\W/g, '')}-${stamp}@test.local`,
        name,
        passwordHash: 'x',
        role,
      },
    })

  const owner = await mk('Owner', 'OWNER')
  const alice = await mk('Alice', 'MANAGER')
  const bob = await mk('Bob', 'MANAGER')

  /*
   * A distinct entityId every time, and that is not incidental:
   * `requestApproval` deliberately dedupes on (entity, entityId, kind,
   * PENDING) — "one open request per thing, or an impatient user creates five
   * and a manager approves the same refund repeatedly". A fixture that reuses
   * one id gets one row back over and over and quietly tests nothing, which
   * is exactly what the first run of this file did.
   */
  let seq = 0
  const raise = (branchId: string | null, byId: string, reason = 'A thing') =>
    requestApproval({
      restaurantId: restaurant.id,
      branchId,
      kind: 'STOCK_ADJUSTMENT',
      entity: 'InventoryItem',
      entityId: `item-${stamp}-${++seq}`,
      reason,
      userId: byId,
    })

  console.log('\n── 1. An empty list means the permission decides ──')
  {
    /*
     * The state every restaurant is in before anybody opens the settings, and
     * the one most will stay in. If this reads as "nobody may approve", the
     * feature is an outage rather than a control.
     */
    check('no list configured is null, not an empty set', approversFor(basePolicy, kandy.id) === null)
    check(
      'and an explicitly empty list is also null',
      approversFor({ ...basePolicy, approvers: { [kandy.id]: [] } }, kandy.id) === null,
    )

    const request = await raise(kandy.id, alice.id)
    check(
      'so anybody else may decide it',
      whyCannotApprove({ policy: basePolicy, request, userId: bob.id, unconfined: false }) === null,
    )
  }

  console.log('\n── 2. A configured list is the list ──')
  {
    const policy: ApprovalPolicy = { ...basePolicy, approvers: { [kandy.id]: [bob.id] } }
    const request = await raise(kandy.id, alice.id)

    check(
      'somebody on it may decide',
      whyCannotApprove({ policy, request, userId: bob.id, unconfined: false }) === null,
    )
    check(
      'somebody not on it may not',
      whyCannotApprove({ policy, request, userId: owner.id, unconfined: false })?.code ===
        'APPROVAL_NOT_APPROVER',
    )

    // Per location: Kandy's list says nothing about Jaffna.
    const elsewhere = await raise(jaffna.id, alice.id)
    check(
      "and another location's queue is unaffected",
      whyCannotApprove({ policy, request: elsewhere, userId: owner.id, unconfined: false }) === null,
    )

    // A restaurant-wide request has its own key.
    const wide = await raise(null, alice.id)
    const widePolicy: ApprovalPolicy = {
      ...basePolicy,
      approvers: { [RESTAURANT_WIDE]: [bob.id] },
    }
    check(
      'the restaurant-wide queue has its own list',
      whyCannotApprove({ policy: widePolicy, request: wide, userId: owner.id, unconfined: false })
        ?.code === 'APPROVAL_NOT_APPROVER',
    )
  }

  console.log('\n── 3. Self-approval, and the override ──')
  {
    const mine = await raise(kandy.id, alice.id, 'Alice asks')

    await refuses(
      'nobody signs their own request',
      () =>
        decideApproval({
          restaurantId: restaurant.id,
          approvalId: mine.id,
          approve: true,
          userId: alice.id,
        }),
      /cannot approve your own/i,
    )

    /*
     * The distinction the whole feature turns on: holding the permission is
     * not using it. Without this, an owner working the queue normally would
     * silently override their own requests and the badge would appear on
     * decisions nobody meant to force.
     */
    await refuses(
      'and holding the override is not the same as using it',
      () =>
        decideApproval({
          restaurantId: restaurant.id,
          approvalId: mine.id,
          approve: true,
          userId: alice.id,
          mayForce: true,
          force: false,
        }),
      /cannot approve your own/i,
    )

    await refuses(
      'nor is asking for it without the permission',
      () =>
        decideApproval({
          restaurantId: restaurant.id,
          approvalId: mine.id,
          approve: true,
          userId: alice.id,
          unconfined: false,
          force: true,
        }),
      /cannot approve your own/i,
    )

    const forced = await decideApproval({
      restaurantId: restaurant.id,
      approvalId: mine.id,
      approve: true,
      userId: alice.id,
      mayForce: true,
      force: true,
    })
    check('with both, the override goes through', forced.status === 'APPROVED')
    check('and the row says it was forced', forced.forcedAt !== null)
    check('and reports it to the caller, for the audit', forced.forced === true)

    const ordinary = await raise(kandy.id, alice.id)
    const normal = await decideApproval({
      restaurantId: restaurant.id,
      approvalId: ordinary.id,
      approve: true,
      userId: bob.id,
      mayForce: true,
      force: true,
    })
    /*
     * Asked for an override where none was needed. It must not be marked —
     * a badge on a decision that broke no rule teaches people to ignore it.
     */
    check(
      'an override that was not needed is not recorded as one',
      normal.forcedAt === null && normal.forced === false,
    )
  }

  console.log('\n── 4. Filters, including both directions (§9) ──')
  {
    const transfer = await requestApproval({
      restaurantId: restaurant.id,
      branchId: kandy.id, // the SOURCE — transfers/actions.ts sets it so
      kind: 'STOCK_TRANSFER',
      entity: 'StockTransfer',
      reason: 'Kandy to Jaffna',
      payload: { toBranchId: jaffna.id, number: 'TR-1' },
      userId: alice.id,
    })
    await requestApproval({
      restaurantId: restaurant.id,
      branchId: jaffna.id,
      kind: 'STOCK_TRANSFER',
      entity: 'StockTransfer',
      reason: 'Jaffna to Kandy',
      payload: { toBranchId: kandy.id, number: 'TR-2' },
      userId: bob.id,
    })

    const fromKandy = await listApprovals({ restaurantId: restaurant.id, fromBranchId: kandy.id })
    check(
      'From = Kandy finds what Kandy is giving up',
      fromKandy.some((r) => r.id === transfer.id) &&
        fromKandy.every((r) => r.branchId === kandy.id),
      `${fromKandy.length} rows`,
    )

    const toJaffna = await listApprovals({ restaurantId: restaurant.id, toBranchId: jaffna.id })
    check(
      'To = Jaffna finds what Jaffna is receiving',
      toJaffna.length === 1 && toJaffna[0]?.id === transfer.id,
      `${toJaffna.length} rows`,
    )

    // The combination — the question a single "location" filter cannot ask.
    const lane = await listApprovals({
      restaurantId: restaurant.id,
      fromBranchId: kandy.id,
      toBranchId: jaffna.id,
    })
    check('and the two together find the one lane', lane.length === 1 && lane[0]?.id === transfer.id)

    const wrongWay = await listApprovals({
      restaurantId: restaurant.id,
      fromBranchId: jaffna.id,
      toBranchId: jaffna.id,
    })
    check('a lane that does not exist finds nothing', wrongWay.length === 0)

    const byBob = await listApprovals({ restaurantId: restaurant.id, requestedById: bob.id })
    check('requested-by narrows to one person', byBob.every((r) => r.requestedById === bob.id))

    const byKind = await listApprovals({ restaurantId: restaurant.id, kind: 'STOCK_TRANSFER' })
    check('type narrows to one kind', byKind.every((r) => r.kind === 'STOCK_TRANSFER'))

    /*
     * A filter must narrow, never widen. The visibility clause is an OR, and
     * a filter written as a sibling key would have replaced it — which turns
     * "show me Kandy's" into "show me everyone's".
     */
    const confined = await listApprovals({
      restaurantId: restaurant.id,
      branchIds: [jaffna.id],
      fromBranchId: kandy.id,
    })
    check(
      'a filter cannot widen what somebody may see',
      confined.length === 0,
      `${confined.length} rows leaked`,
    )
  }

  console.log('\n── 5. The detail carries enough to decide on ──')
  {
    const request = await raise(kandy.id, alice.id, 'Read me first')
    const { request: full, history } = await getApprovalDetail({
      restaurantId: restaurant.id,
      approvalId: request.id,
    })
    check('the request comes back whole', full.reason === 'Read me first')
    check('with who asked', full.requestedBy?.name === 'Alice')
    check('and its location', full.branch?.name === 'Kandy')
    check('and a history array, even when empty', Array.isArray(history))

    await refuses(
      "another restaurant's request is not readable",
      () => getApprovalDetail({ restaurantId: 'someone-else', approvalId: request.id }),
      /not found|Approval request/i,
    )
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
