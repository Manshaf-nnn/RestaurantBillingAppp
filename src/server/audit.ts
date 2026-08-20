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
  REPORT_EXPORTED: 'report.exported',

  ORDER_ITEM_VOIDED: 'order.item_voided',
  ORDER_PRICE_OVERRIDE: 'order.price_override',
  INVOICE_REPRINTED: 'invoice.reprinted',

  DRAWER_OPENED: 'cashDrawer.opened',
  DRAWER_CLOSED: 'cashDrawer.closed',
  DRAWER_CASH_IN: 'cashDrawer.cash_in',
  DRAWER_CASH_OUT: 'cashDrawer.cash_out',

  STOCK_RECEIVED: 'inventory.received',
  STOCK_WASTAGE: 'inventory.wastage',
  STOCK_TRANSFER: 'inventory.transfer',
  STOCK_RETURN: 'inventory.return',
  STOCK_OPENING: 'inventory.opening_balance',
  STOCK_COUNT_OPENED: 'inventory.count_opened',
  STOCK_COUNT_APPROVED: 'inventory.count_approved',
  STOCK_COST_EDITED: 'inventory.cost_edited',

  PO_CREATED: 'purchase.created',
  PO_APPROVED: 'purchase.approved',
  PO_ORDERED: 'purchase.ordered',
  PO_CANCELLED: 'purchase.cancelled',
  PO_RECEIVED: 'purchase.received',
  PO_RETURNED: 'purchase.returned',
  SUPPLIER_UPDATED: 'supplier.updated',

  TRANSFER_REQUESTED: 'transfer.requested',
  TRANSFER_APPROVED: 'transfer.approved',
  TRANSFER_DISPATCHED: 'transfer.dispatched',
  TRANSFER_RECEIVED: 'transfer.received',
  TRANSFER_CLOSED: 'transfer.closed',
  PRODUCTION_CREATED: 'production.created',
  PRODUCTION_APPROVED: 'production.approved',
  PRODUCTION_COMPLETED: 'production.completed',

  ROLE_CHANGED: 'user.role_changed',
  USER_DISABLED: 'user.disabled',
  PRICE_CHANGED: 'menu.price_changed',
  RECIPE_CHANGED: 'recipe.changed',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_DECIDED: 'approval.decided',
} as const


/**
 * Audit logs are append-only for everyone below platform level.
 *
 * There is no update or delete path through the application: nothing in the
 * codebase calls `auditLog.update` or `auditLog.delete`, and this guard exists
 * so that stays true. A log an ordinary user can edit is not an audit trail,
 * it is a diary.
 *
 * Retention pruning, if it is ever needed, belongs in a platform-level job that
 * runs outside a user session — not behind a button.
 */
export function assertAuditImmutable(operation: 'update' | 'delete'): never {
  throw new Error(
    `Audit logs are append-only; ${operation} is not permitted from application code`,
  )
}
