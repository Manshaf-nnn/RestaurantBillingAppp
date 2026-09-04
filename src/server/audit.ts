import 'server-only'
import type { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { requestContext } from '@/server/auth/session'

export interface AuditInput {
  restaurantId?: string | null
  /// Which location the action happened at, where that is meaningful.
  branchId?: string | null
  userId?: string | null
  actorName?: string | null
  action: string
  entity: string
  entityId?: string | null
  before?: unknown
  after?: unknown
}

const REDACTED_KEYS = new Set([
  'password',
  'passwordHash',
  'confirmPassword',
  'refreshTokenHash',
  'tokenHash',
  'token',
  'secret',
  'apiKey',
])

/** Strips credentials before anything is persisted to the audit trail. */
function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString()
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        REDACTED_KEYS.has(key) ? '[redacted]' : redact(val),
      ]),
    )
  }
  return value
}

/**
 * Records an administrative action. Auditing must never break the operation it
 * describes, so failures are logged and swallowed.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    const ctx = await requestContext().catch(() => ({ ipAddress: null, userAgent: null }))
    await prisma.auditLog.create({
      data: {
        restaurantId: input.restaurantId ?? null,
        branchId: input.branchId ?? null,
        userId: input.userId ?? null,
        actorName: input.actorName ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        before: (redact(input.before) ?? null) as Prisma.InputJsonValue,
        after: (redact(input.after) ?? null) as Prisma.InputJsonValue,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent?.slice(0, 500) ?? null,
      },
    })
  } catch (error) {
    console.error('[audit] failed to record entry', input.action, error)
  }
}

export const AUDIT_ACTIONS = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  REGISTER: 'auth.register',
  PASSWORD_RESET: 'auth.password_reset',
  PASSWORD_CHANGED: 'auth.password_changed',
  SESSIONS_REVOKED: 'auth.sessions_revoked',

  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',

  ORDER_PLACED: 'order.placed',
  ORDER_STATUS: 'order.status_changed',
  ORDER_CANCELLED: 'order.cancelled',
  OUTGOING_CREATED: 'outgoingPayment.created',
  OUTGOING_SUBMITTED: 'outgoingPayment.submitted',
  OUTGOING_APPROVED: 'outgoingPayment.approved',
  OUTGOING_REJECTED: 'outgoingPayment.rejected',
  OUTGOING_SENT_BACK: 'outgoingPayment.sent_back',
  OUTGOING_PAID: 'outgoingPayment.paid',
  OUTGOING_REVERSED: 'outgoingPayment.reversed',
  OUTGOING_CANCELLED: 'outgoingPayment.cancelled',
  EXPENSE_CATEGORY_SAVED: 'expenseCategory.saved',
  ACCOUNTANT_NOTE_ADDED: 'accounting.note_added',
  BANK_STATEMENT_IMPORTED: 'accounting.bank_statement_imported',
  BANK_LINE_MATCHED: 'accounting.bank_line_matched',
  BANK_LINE_UNMATCHED: 'accounting.bank_line_unmatched',
  BANK_LINE_IGNORED: 'accounting.bank_line_ignored',
  FOOD_COST_TARGET_SET: 'accounting.food_cost_target_set',
  DAY_CLOSED: 'accounting.dayClosed',
  PERIOD_CLOSED: 'accounting.periodClosed',
  PERIOD_REOPENED: 'accounting.periodReopened',
  ORDER_DISCOUNT: 'order.discount_applied',
  ORDER_HELD: 'order.held',
  ORDER_RESUMED: 'order.resumed',
  ORDER_SPLIT: 'order.split',
  ORDER_MERGED: 'order.merged',
  PAYMENT_COLLECTED: 'payment.collected',
  PAYMENT_REFUNDED: 'payment.refunded',
  INVOICE_ISSUED: 'invoice.issued',
  STOCK_ADJUSTED: 'inventory.adjusted',
  SETTINGS_UPDATED: 'settings.updated',
  STAFF_INVITED: 'staff.invited',
  /*
   * Changing what a role may do is a permission change, and permission changes
   * are the ones an owner most needs to be able to reconstruct afterwards —
   * "who gave the new starter the refund button" is not answerable from the
   * role row alone, because it only holds the current answer.
   */
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  ROLE_ASSIGNED: 'role.assigned',
  REPORT_EXPORTED: 'report.exported',

  ORDER_ITEM_VOIDED: 'order.item_voided',
  ORDER_PRICE_OVERRIDE: 'order.price_override',
  INVOICE_REPRINTED: 'invoice.reprinted',

  DRAWER_OPENED: 'cashDrawer.opened',
  DRAWER_CLOSED: 'cashDrawer.closed',
  DRAWER_REVIEWED: 'cashDrawer.reviewed',
  DRAWER_FORCE_CLOSED: 'cashDrawer.force_closed',
  DRAWER_CASH_IN: 'cashDrawer.cash_in',
  DRAWER_CASH_OUT: 'cashDrawer.cash_out',
  DRAWER_HANDED_OVER: 'cashDrawer.handed_over',
  DRAWER_HANDOVER_ACCEPTED: 'cashDrawer.handover_accepted',
  DRAWER_HANDOVER_DECLINED: 'cashDrawer.handover_declined',
  REGISTER_CREATED: 'cashRegister.created',
  REGISTER_TOGGLED: 'cashRegister.toggled',

  PETTY_CASH_REQUESTED: 'pettyCash.requested',
  PETTY_CASH_APPROVED: 'pettyCash.approved',
  PETTY_CASH_REJECTED: 'pettyCash.rejected',
  PETTY_CASH_PAID: 'pettyCash.paid',
  PETTY_CASH_CANCELLED: 'pettyCash.cancelled',

  STOCK_RECEIVED: 'inventory.received',
  STOCK_WASTAGE: 'inventory.wastage',
  STOCK_TRANSFER: 'inventory.transfer',
  STOCK_RETURN: 'inventory.return',
  STOCK_OPENING: 'inventory.opening_balance',
  SHIFT_CORRECTED: 'shift.corrected',

  STOCK_COUNT_OPENED: 'inventory.count_opened',
  STOCK_COUNT_APPROVED: 'inventory.count_approved',
  STOCK_COUNT_CANCELLED: 'inventory.count_cancelled',
  STOCK_COST_EDITED: 'inventory.cost_edited',

  PO_CREATED: 'purchase.created',
  PO_APPROVED: 'purchase.approved',
  PO_ORDERED: 'purchase.ordered',
  PO_CANCELLED: 'purchase.cancelled',
  PO_RECEIVED: 'purchase.received',
  PO_UPDATED: 'purchase.updated',
  PO_RETURNED: 'purchase.returned',
  SUPPLIER_UPDATED: 'supplier.updated',
  SUPPLIER_PAID: 'supplier.paid',
  SUPPLIER_PAYMENT_REMOVED: 'supplier.payment_removed',

  TRANSFER_REQUESTED: 'transfer.requested',
  TRANSFER_APPROVED: 'transfer.approved',
  TRANSFER_DISPATCHED: 'transfer.dispatched',
  TRANSFER_RECEIVED: 'transfer.received',
  TRANSFER_CLOSED: 'transfer.closed',
  UNIT_UPDATED: 'catalog.unit_updated',
  CATEGORY_CREATED: 'catalog.category_created',
  CATEGORY_UPDATED: 'catalog.category_updated',

  INSTRUCTION_CREATED: 'instruction.created',
  INSTRUCTION_COMPLETED: 'instruction.completed',
  INSTRUCTION_CANCELLED: 'instruction.cancelled',

  PRODUCTION_CREATED: 'production.created',
  PRODUCTION_SPEC_UPDATED: 'production.spec_updated',
  PRODUCTION_APPROVED: 'production.approved',
  PRODUCTION_COMPLETED: 'production.completed',

  PLATFORM_FEATURES_CHANGED: 'platform.features_changed',

  KITCHEN_STATION_SAVED: 'kitchen.station_saved',
  KITCHEN_STATION_RETIRED: 'kitchen.station_retired',
  KITCHEN_ORDER_ACCEPTED: 'kitchen.order_accepted',
  /// A supervisor overriding the menu's own routing. Carries the section it
  /// came from, the one it went to, and why.
  KITCHEN_ITEM_REASSIGNED: 'kitchen.item_reassigned',
  ORDER_PRIORITY_CHANGED: 'order.priority_changed',

  ROLE_CHANGED: 'user.role_changed',
  USER_DISABLED: 'user.disabled',
  PRICE_CHANGED: 'menu.price_changed',
  RECIPE_CHANGED: 'recipe.changed',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_DECIDED: 'approval.decided',

  /*
   * Platform-operator actions (production.md §8–§14).
   *
   * An operator acts across every tenant, which makes them the actor whose
   * actions most need a trail — including the ones that only change what a
   * screen reads afterwards.
   */
  PLATFORM_PLAN_CHANGED: 'platform.plan_changed',
  USER_REACTIVATED: 'user.reactivated',
  JOB_RETRIED: 'job.retried',
  JOBS_RUN: 'job.run',
  ERROR_RESOLVED: 'error.resolved',
  MAINTENANCE_TOGGLED: 'platform.maintenance_toggled',
  RESTORE_TESTED: 'platform.restore_tested',
  MFA_ENABLED: 'user.mfa_enabled',
  MFA_DISABLED: 'user.mfa_disabled',
  // SESSIONS_REVOKED already exists above under auth.*; the platform console
  // reuses it rather than minting a second name for the same event.
} as const


/**
 * Audit logs are append-only, and that is now enforced rather than asserted.
 *
 * This used to be a function — `assertAuditImmutable` — that threw if it was
 * ever called, and nothing ever called it. Its own doc comment explained that
 * immutability held because "nothing in the codebase calls `auditLog.update`",
 * which is a description of the current source, not a guarantee: the next
 * person to write that line would have met no resistance at all, and the
 * function's existence made it look like they would.
 *
 * It is enforced in two places that cannot be bypassed by writing code:
 *
 *  1. A `BEFORE UPDATE` trigger on `audit_logs` (migration
 *     20260917093000_append_only_guards) raises rather than letting a row
 *     change — against application code, a script, or a psql session alike.
 *     `refunds` are frozen the same way; `stock_movements` have their ledger
 *     facts frozen while their link columns stay writable; a settled
 *     `payment`'s amount cannot move.
 *  2. `scripts/no-audit-mutation.ts` fails the build if application code
 *     acquires an `auditLog.update`/`delete`/`upsert` call site, so the
 *     failure arrives in CI rather than at runtime in front of a user.
 *
 * DELETE is deliberately still permitted: deleting a restaurant cascades to
 * its audit rows, and removing a tenant's data on request is legitimate. The
 * property protected here is that a row's content cannot change, not that
 * tenants are permanent.
 */
