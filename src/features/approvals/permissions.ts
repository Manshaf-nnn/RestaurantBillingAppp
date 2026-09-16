import type { ApprovalKind } from '@prisma/client'

import { PERMISSIONS, type Permission } from '@/lib/rbac'

/**
 * Which permission decides each kind of request (recorrection.md §1).
 *
 * ── Why not one permission for the whole desk ──────────────────────────────
 *
 * Deciding used to be gated on `settings.manage`, which in practice meant
 * owner or admin. `MANAGER` held `approvals.view`, `approvals.manage` and
 * `approvals.force` — could open the desk, configure its approvers, hold the
 * override — and could decide nothing, because the one gate that mattered
 * was a settings permission they do not have. The spec's "branch manager
 * approves transfers for their own branch" was unreachable.
 *
 * The rule everywhere else in the product is that an action is gated on the
 * permission FOR THAT ACTION (`no-parent-permission-actions`): refunding is
 * `payment.refund`, discounting is `discount.apply`, approving a transfer is
 * `transfer.approve`. A request of a kind is a deferred act of that kind, so
 * deciding it takes the same permission the act does. That is what lets a
 * branch manager rule on transfers and not on refunds.
 *
 * `approvals.view` still governs opening the desk at all, and the branch
 * guard still governs whose requests are in reach. This only says which.
 *
 * Shared by the page (to grey the buttons) and the action (to refuse the
 * click). Its own module because neither may export a non-function from a
 * `'use server'` file, and the page must not import a service.
 */
export const DECIDE_PERMISSION: Record<ApprovalKind, Permission> = {
  STOCK_TRANSFER: PERMISSIONS.TRANSFER_APPROVE,
  REFUND: PERMISSIONS.PAYMENT_REFUND,
  DISCOUNT: PERMISSIONS.DISCOUNT_APPLY,
  PRICE_OVERRIDE: PERMISSIONS.DISCOUNT_APPLY,
  STOCK_ADJUSTMENT: PERMISSIONS.INVENTORY_COUNT_APPROVE,
  PURCHASE_ORDER: PERMISSIONS.PURCHASE_APPROVE,
}
