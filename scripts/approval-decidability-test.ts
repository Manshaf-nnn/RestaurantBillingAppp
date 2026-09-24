/**
 * Who may rule on what, tested without a browser.
 *
 * ── Why this did not exist before ──────────────────────────────────────────
 *
 * The rule lived inline inside `src/app/dashboard/approvals/page.tsx`: which
 * permission each queue needs, whether the viewer stands at the branch that
 * owns the decision, and what to say when they do not. It was authorization
 * logic in a page component, so the only way to exercise it was to render that
 * page in a browser and look — which is why the one browser test that touches
 * the approvals desk is also the only thing that has ever checked it.
 *
 * `features/approvals/decidability` is pure: a subject and a row in, a verdict
 * out. That makes the rule assertable directly, which is what this does.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 *
 * Not the gate. The guarded action that owns each queue re-checks every one of
 * these, and that is the boundary. This decides whether the button is offered,
 * and getting it wrong means a greyed button or a refused click, not a
 * decision somebody should not have made.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.test.json scripts/approval-decidability-test.ts
 */
import type { UserRole } from '@prisma/client'

import {
  PERMISSION_FOR_KIND,
  decidabilityFor,
  type DecidableRow,
} from '../src/features/approvals/decidability'
import { PERMISSIONS } from '../src/lib/rbac'

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

/** A viewer with exactly the permissions named, confined to the branches given. */
function viewer(options: {
  id?: string
  role?: UserRole
  permissions?: string[]
  branchId?: string | null
  branchIds?: string[]
}) {
  return {
    id: options.id ?? 'viewer-1',
    role: (options.role ?? 'MANAGER') as UserRole,
    // A saved role REPLACES the role defaults, so this is the whole grant.
    rolePermissions: options.permissions ?? [],
    branchId: options.branchId ?? null,
    branchIds: options.branchIds,
  }
}

const KANDY = 'branch-kandy'
const JAFFNA = 'branch-jaffna'

/** A stock transfer from Kandy to Jaffna, raised by Jaffna. */
const transferRow: DecidableRow = {
  kind: 'APPROVAL_REQUEST',
  approvalKind: 'STOCK_TRANSFER',
  // The SOURCE owns the decision — Kandy is being asked to give up the stock.
  branchId: KANDY,
  requestedById: 'someone-else',
  transfer: { fromBranchName: 'Kandy', toBranchName: 'Jaffna' },
}

console.log('\nApproval decidability\n')

/* ── 1. A transfer is decided at the source ───────────────────────────────── */
console.log('1. Where a transfer is decided')

const atSource = decidabilityFor(
  viewer({ permissions: [PERMISSIONS.TRANSFER_APPROVE], branchId: KANDY, branchIds: [KANDY] }),
  transferRow,
)
check('the source branch with transfer.approve may decide it', atSource.canDecide)
check('and is told nothing about waiting', atSource.waitingOn === null)

const atDestination = decidabilityFor(
  viewer({ permissions: [PERMISSIONS.TRANSFER_APPROVE], branchId: JAFFNA, branchIds: [JAFFNA] }),
  transferRow,
)
check(
  'the destination branch holds the permission and still may not decide',
  !atDestination.canDecide && !atDestination.atBranch,
  'A transfer is the source giving up stock; the destination is the one asking.',
)
check(
  'and is told whose decision it is, rather than given a dead button',
  atDestination.waitingOn === 'Waiting for Kandy to approve',
  `got: ${atDestination.waitingOn}`,
)

const wrongPermission = decidabilityFor(
  viewer({ permissions: [PERMISSIONS.PAYMENT_REFUND], branchId: KANDY, branchIds: [KANDY] }),
  transferRow,
)
check(
  'standing at the source is not enough without the permission',
  !wrongPermission.canDecide && wrongPermission.atBranch,
)

/* ── 2. Each kind asks for its own permission ─────────────────────────────── */
console.log('\n2. A kind is decided by the permission for that act')

const KIND_CASES: Array<{ row: DecidableRow; needs: string; notEnough: string }> = [
  {
    row: { kind: 'APPROVAL_REQUEST', approvalKind: 'REFUND', branchId: null, requestedById: 'x', transfer: null },
    needs: PERMISSIONS.PAYMENT_REFUND,
    notEnough: PERMISSIONS.TRANSFER_APPROVE,
  },
  {
    row: { kind: 'APPROVAL_REQUEST', approvalKind: 'DISCOUNT', branchId: null, requestedById: 'x', transfer: null },
    needs: PERMISSIONS.DISCOUNT_APPLY,
    notEnough: PERMISSIONS.PAYMENT_REFUND,
  },
  {
    row: { kind: 'OUTGOING_PAYMENT', approvalKind: null, branchId: null, requestedById: 'x', transfer: null },
    needs: PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE,
    // The obvious wrong answer: money out is not a purchase order.
    notEnough: PERMISSIONS.PURCHASE_APPROVE,
  },
  {
    row: { kind: 'PETTY_CASH', approvalKind: null, branchId: null, requestedById: 'x', transfer: null },
    needs: PERMISSIONS.PETTY_CASH_APPROVE,
    notEnough: PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE,
  },
  {
    row: { kind: 'WASTAGE', approvalKind: null, branchId: null, requestedById: 'x', transfer: null },
    needs: PERMISSIONS.INVENTORY_WASTAGE_APPROVE,
    notEnough: PERMISSIONS.INVENTORY_COUNT_APPROVE,
  },
  {
    row: { kind: 'STOCK_COUNT', approvalKind: null, branchId: null, requestedById: 'x', transfer: null },
    needs: PERMISSIONS.INVENTORY_COUNT_APPROVE,
    notEnough: PERMISSIONS.INVENTORY_WASTAGE_APPROVE,
  },
  {
    row: { kind: 'PURCHASE', approvalKind: null, branchId: null, requestedById: 'x', transfer: null },
    needs: PERMISSIONS.PURCHASE_APPROVE,
    notEnough: PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE,
  },
]

for (const item of KIND_CASES) {
  const label = item.row.approvalKind ?? item.row.kind
  check(
    `${label} is decidable with ${item.needs}`,
    decidabilityFor(viewer({ permissions: [item.needs] }), item.row).canDecide,
  )
  check(
    `${label} is NOT decidable with ${item.notEnough}`,
    !decidabilityFor(viewer({ permissions: [item.notEnough] }), item.row).canDecide,
  )
}

check(
  'an unknown kind claims no permission and is never decidable',
  decidabilityFor(
    viewer({ role: 'OWNER' }),
    { kind: 'APPROVAL_REQUEST', approvalKind: 'NOT_A_KIND', branchId: null, requestedById: 'x', transfer: null },
  ).canDecide === false,
)

/* ── 3. Restaurant-wide requests are in everybody's reach ─────────────────── */
console.log('\n3. Branch reach')

check(
  'a null branch is restaurant-wide and always at branch',
  decidabilityFor(
    viewer({ permissions: [PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE], branchId: KANDY, branchIds: [KANDY] }),
    { kind: 'OUTGOING_PAYMENT', approvalKind: null, branchId: null, requestedById: 'x', transfer: null },
  ).atBranch,
  'It concerns the whole business; nobody is out of reach of it.',
)
check(
  'an owner reaches every branch',
  decidabilityFor(viewer({ role: 'OWNER', permissions: undefined }), transferRow).atBranch,
)

/* ── 4. Your own request is flagged ───────────────────────────────────────── */
console.log('\n4. Your own request')

const own = decidabilityFor(
  viewer({ id: 'me', permissions: [PERMISSIONS.TRANSFER_APPROVE], branchId: KANDY, branchIds: [KANDY] }),
  { ...transferRow, requestedById: 'me' },
)
check('a request you raised is marked as yours', own.isOwnRequest)
check(
  'which is a signal to the screen, not a refusal here',
  own.canDecide,
  'The two-person rule lives in the service, where it is enforced rather than hinted.',
)
check(
  "somebody else's request is not marked as yours",
  !decidabilityFor(
    viewer({ id: 'me', permissions: [PERMISSIONS.TRANSFER_APPROVE], branchIds: [KANDY] }),
    transferRow,
  ).isOwnRequest,
)

/* ── 5. The map covers every queue ────────────────────────────────────────── */
console.log('\n5. Nothing falls through')

for (const kind of ['OUTGOING_PAYMENT', 'PETTY_CASH', 'STOCK_COUNT', 'PURCHASE', 'WASTAGE'] as const) {
  check(`${kind} names a permission`, Boolean(PERMISSION_FOR_KIND[kind]))
}

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exitCode = failed > 0 ? 1 : 0
