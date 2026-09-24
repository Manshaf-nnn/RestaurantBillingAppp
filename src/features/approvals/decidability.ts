import type { ApprovalKind } from '@prisma/client'

import type { InboxKind } from '@/features/accounting/inbox'
import { DECIDE_PERMISSION } from './permissions'
import {
  PERMISSIONS,
  can,
  canAccessBranch,
  type Permission,
  type PermissionSubject,
} from '@/lib/rbac'

/**
 * Whether a given person may rule on a given request, and if not, why not.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * This lived inline inside `src/app/dashboard/approvals/page.tsx`. That is
 * authorization logic sitting in a page component: it could only be exercised
 * by rendering that page in a browser, it had no test of its own, and rendering
 * the same rows anywhere else meant copying it — which is how two answers to
 * one question get into a codebase.
 *
 * It is pure on purpose. No Prisma, no `server-only`, no `'use server'`: a
 * subject and a row in, a verdict out. That is what makes it testable at all.
 *
 * ── It decides nothing ──────────────────────────────────────────────────────
 *
 * This answers "should the button be offered". The actual gate is still the
 * guarded action that owns each queue — `decideApprovalAction`,
 * `decidePaymentAction`, `decidePettyRequestAction`, `reviewWastageAction` —
 * and every one of them re-checks. Offering a button that the server then
 * refuses teaches people the app is broken; hiding one they could have used is
 * merely unhelpful. Neither is a security boundary, and this is not one.
 */

/**
 * Which permission rules each of the non-generic queues.
 *
 * The generic queue is per KIND (`DECIDE_PERMISSION`), because a transfer and
 * a refund are different acts with different owners.
 */
export const PERMISSION_FOR_KIND: Record<Exclude<InboxKind, 'APPROVAL_REQUEST'>, Permission> = {
  OUTGOING_PAYMENT: PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE,
  PETTY_CASH: PERMISSIONS.PETTY_CASH_APPROVE,
  STOCK_COUNT: PERMISSIONS.INVENTORY_COUNT_APPROVE,
  PURCHASE: PERMISSIONS.PURCHASE_APPROVE,
  WASTAGE: PERMISSIONS.INVENTORY_WASTAGE_APPROVE,
}

/** Just enough of a row to judge it — so a test needs no database. */
export interface DecidableRow {
  kind: InboxKind
  /** For the generic queue, which kind of request it is. */
  approvalKind: string | null
  /** The branch that owns the DECISION. For a transfer, the source. */
  branchId: string | null
  requestedById: string | null
  /** A transfer's two ends, for the "waiting on them" line. */
  transfer: { fromBranchName: string; toBranchName: string } | null
}

export interface Decidability {
  /** The permission this row needs, or null when no queue claims it. */
  permission: Permission | null
  /** Whether the viewer stands at the branch that owns the decision. */
  atBranch: boolean
  /** Whether the viewer raised it themselves. */
  isOwnRequest: boolean
  /** Whether to offer the decision buttons at all. */
  canDecide: boolean
  /** Whose decision it is, when it is plainly not this viewer's. */
  waitingOn: string | null
}

export function decidabilityFor(
  user: PermissionSubject & { id?: string },
  row: DecidableRow,
): Decidability {
  const permission =
    row.kind === 'APPROVAL_REQUEST'
      ? (DECIDE_PERMISSION[row.approvalKind as ApprovalKind] ?? null)
      : PERMISSION_FOR_KIND[row.kind]

  /*
   * A null branch is a restaurant-wide request and concerns everybody, so it
   * is never out of reach. Anything else has to be somewhere this viewer can
   * act — a transfer's decision belongs to the SOURCE branch, and the
   * destination watches its own request rather than approving it.
   */
  const atBranch = row.branchId === null || canAccessBranch(user, row.branchId)
  const canDecide = permission !== null && can(user, permission) && atBranch

  return {
    permission,
    atBranch,
    isOwnRequest: Boolean(user.id) && row.requestedById === user.id,
    canDecide,
    /*
     * Said plainly rather than left as a greyed-out button. "You cannot do
     * this" is a dead end; "Kandy has to approve it" is something the person
     * reading it can act on.
     */
    waitingOn:
      row.transfer && !atBranch ? `Waiting for ${row.transfer.fromBranchName} to approve` : null,
  }
}
