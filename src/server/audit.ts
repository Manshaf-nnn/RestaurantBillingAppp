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
  // The columns this schema actually holds credentials in. `signInCode` IS a
  // password (it is hashed into passwordHash); the rest are second factors,
  // key fingerprints and bank details — none of them belongs in a row every
  // AUDIT_VIEW holder can read.
  'signInCode',
  'mfaSecret',
  'totpSecret',
  'recoveryCodes',
  'keyHash',
  'qrPayload',
  'accountNumber',
  // A third party's SMS gateway credentials, and the codes we text to guests.
  //
  // Note what is NOT here: a bare `code`. Matching is by exact key name, and
  // `code` is an ordinary non-secret field all over this schema — the QR entry
  // payload, coupon codes, branch codes, currency codes. Redacting it would
  // blind the audit log for all of them to protect one field that is spelled
  // out explicitly instead.
  'otp',
  'otpCode',
  'verificationCode',
  'smsCode',
  'codeHash',
  'authToken',
  'apiSecret',
  'credentials',
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
  /** A QR / online order accepted at the till (abc.md §5). */
  ORDER_ACCEPTED_AT_TILL: 'order.accepted_at_till',
  /** A waiter call raised, answered, and closed (abc.md §7). */
  SERVICE_REQUEST_CREATED: 'serviceRequest.created',
  SERVICE_REQUEST_ACKNOWLEDGED: 'serviceRequest.acknowledged',
  SERVICE_REQUEST_RESOLVED: 'serviceRequest.resolved',
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
  /** pro.A.md §10 — money taken off one line of a bill. */
  ORDER_ITEM_DISCOUNT: 'order.item_discount_applied',
  ORDER_HELD: 'order.held',
  ORDER_RESUMED: 'order.resumed',
  ORDER_SPLIT: 'order.split',
  ORDER_MERGED: 'order.merged',
  /** A sitting moved to another table, orders and bill intact (abc.md §3). */
  TABLE_SWAPPED: 'table.swapped',
  PAYMENT_COLLECTED: 'payment.collected',
  PAYMENT_REFUNDED: 'payment.refunded',
  INVOICE_ISSUED: 'invoice.issued',
  STOCK_ADJUSTED: 'inventory.adjusted',
  SETTINGS_UPDATED: 'settings.updated',
  /// ar.md §18 — what a QR menu shows and asks is a change to the guest
  /// experience, so who changed it and to what is worth keeping.
  QR_EXPERIENCE_SAVED: 'qr.experience_saved',
  QR_EXPERIENCE_ACTIVE: 'qr.experience_active',
  QR_EXPERIENCE_REGENERATED: 'qr.experience_regenerated',
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
  /**
   * One person's own allow/deny list changed (staff.A.md §3).
   *
   * Separate from ROLE_UPDATED and needed for the same reason: an override is
   * invisible in the role row, so "why could only Nila do that" has no other
   * answer once the override is edited again.
   */
  STAFF_PERMISSIONS_SET: 'staff.permissions_set',
  REPORT_EXPORTED: 'report.exported',

  ORDER_ITEM_VOIDED: 'order.item_voided',
  /** Dishes added to a bill after it was placed, by staff. */
  ORDER_ITEMS_ADDED: 'order.items_added',
  /** A line's prepared / served counters moved (abc.md §6). */
  ORDER_ITEM_PROGRESS: 'order.item_progress',
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
  /** Withdrawn before anyone accepted; the outgoing drawer re-opened (recorrection.md §2). */
  DRAWER_HANDOVER_CANCELLED: 'cashDrawer.handover_cancelled',
  /**
   * The shift handover for every role (recorrection.md §2). Its own keys, not
   * the drawer's: a waiter's handover has no till in it, and a cashier's is
   * the drawer keys above PLUS one of these — two records for two things.
   */
  SHIFT_HANDOVER_STARTED: 'shiftHandover.started',
  SHIFT_HANDOVER_COMPLETED: 'shiftHandover.completed',
  SHIFT_HANDOVER_REJECTED: 'shiftHandover.rejected',
  SHIFT_HANDOVER_CANCELLED: 'shiftHandover.cancelled',
  /** shifthandover.md §1–3 — templates, the rota, and a session starting/ending. */
  SHIFT_TEMPLATE_CREATED: 'shiftTemplate.created',
  SHIFT_TEMPLATE_UPDATED: 'shiftTemplate.updated',
  SHIFT_ASSIGNED: 'shift.assigned',
  SHIFT_ASSIGNMENT_UPDATED: 'shift.assignment_updated',
  SHIFT_ASSIGNMENT_CANCELLED: 'shift.assignment_cancelled',
  SHIFT_STARTED: 'shift.started',
  SHIFT_ENDED: 'shift.ended',
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
  /** A prepared item came into being because someone made it (redesignkitchenjob.md). */
  INVENTORY_PREPARED_ITEM_CREATED: 'inventory.prepared_item_created',
  /** pro.A.md §19 — an item's own record was edited (not its balance). */
  INVENTORY_ITEM_EDITED: 'inventory.item_edited',

  PO_CREATED: 'purchase.created',
  /** Sent for approval — a draft or a returned request becoming somebody's decision. */
  PO_SUBMITTED: 'purchase.submitted',
  PO_APPROVED: 'purchase.approved',
  /** Refused by an approver, with the reason in `after`. */
  PO_REJECTED: 'purchase.rejected',
  /** Sent back for changes by an approver, with the reason in `after`. */
  PO_RETURNED_FOR_EDIT: 'purchase.returned_for_edit',
  PO_ORDERED: 'purchase.ordered',
  PO_CANCELLED: 'purchase.cancelled',
  PO_RECEIVED: 'purchase.received',
  /** Done with: signed off after receipt, or closed short. */
  PO_CLOSED: 'purchase.closed',
  PO_UPDATED: 'purchase.updated',
  /** Goods sent back to the supplier (a stock movement), not a request sent back. */
  PO_RETURNED: 'purchase.returned',
  SUPPLIER_UPDATED: 'supplier.updated',
  /* ── Internal money accounts (bank.md §3) ─────────────────────────────── */
  ACCOUNT_CREATED: 'account.created',
  ACCOUNT_UPDATED: 'account.updated',
  ACCOUNT_DEPOSIT: 'account.deposit',
  ACCOUNT_TRANSFER: 'account.transfer',
  ACCOUNT_STAFF_SET: 'account.staff_set',
  SUPPLIER_PAID: 'supplier.paid',
  SUPPLIER_PAYMENT_REMOVED: 'supplier.payment_removed',

  TRANSFER_REQUESTED: 'transfer.requested',
  TRANSFER_APPROVED: 'transfer.approved',
  TRANSFER_DISPATCHED: 'transfer.dispatched',
  TRANSFER_RECEIVED: 'transfer.received',
  TRANSFER_CLOSED: 'transfer.closed',
  /**
   * The destination signed for it and the stock is on their shelf
   * (recorrection.md §1). Its own key: completion used to be logged as
   * `transfer.closed` with a flag inside `after`, which made "how long do
   * transfers take end to end" a question the log could not answer.
   */
  TRANSFER_COMPLETED: 'transfer.completed',
  UNIT_UPDATED: 'catalog.unit_updated',
  CATEGORY_CREATED: 'catalog.category_created',
  CATEGORY_UPDATED: 'catalog.category_updated',

  INSTRUCTION_CREATED: 'instruction.created',
  INSTRUCTION_COMPLETED: 'instruction.completed',
  INSTRUCTION_CANCELLED: 'instruction.cancelled',

  PRODUCTION_CREATED: 'production.created',
  /*
   * Starting and cancelling a job. `setProductionStatusAction` wrote no audit
   * row at all before — PRODUCTION_APPROVED was defined and never emitted — so
   * the only trace of a job moving was the row changing shape.
   */
  PRODUCTION_STARTED: 'production.started',
  /** Ingredients issued to a batch — the moment stock left (pro.b.md §4). */
  PRODUCTION_ISSUED: 'production.issued',
  /** How a prepared item is made was saved or changed (pro.b.md §1). */
  PRODUCTION_RECIPE_SAVED: 'production.recipe_saved',
  PRODUCTION_CANCELLED: 'production.cancelled',
  PRODUCTION_SPEC_UPDATED: 'production.spec_updated',
  /// Legacy: approval left the production flow. Kept so historic rows written
  /// under the old flow still resolve to a name.
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
  /** A hand correction to a guest's points, with its reason. */
  LOYALTY_ADJUSTED: 'loyalty.adjusted',
  /** A reward spent against a bill. */
  LOYALTY_REDEEMED: 'loyalty.redeemed',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_DECIDED: 'approval.decided',
  /**
   * A decision that broke the two-person rule (correctionA.md §9).
   *
   * Its own action, not a flag on `approval.decided`, so "show me every
   * override" is a filter on this log rather than a reading of every approval
   * ever made. An override that is only distinguishable by inspecting each row
   * is an override nobody will find.
   */
  APPROVAL_FORCED: 'approval.forced',
  /** An owner changed who may sign off requests at a location (§9). */
  APPROVAL_ACCESS_SET: 'approval.accessSet',

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

  /*
   * SMS. The config action never passes the credential object to `audit()` at
   * all — it records which slots changed, by name. `REDACTED_KEYS` above is the
   * second line of defence, not the first.
   */
  SMS_CONFIG_UPDATED: 'sms.config_updated',
  SMS_TEST_SENT: 'sms.test_sent',
  SMS_DISABLED: 'sms.disabled',
  SMS_RESENT: 'sms.resent',
  ERROR_RESOLVED: 'error.resolved',
  MAINTENANCE_TOGGLED: 'platform.maintenance_toggled',
  RESTORE_TESTED: 'platform.restore_tested',
  MFA_ENABLED: 'user.mfa_enabled',
  MFA_DISABLED: 'user.mfa_disabled',
  /*
   * The second factor at sign-in (athu.md). A challenge is issued when the
   * password is right and the account is enrolled; a failure is a wrong code;
   * a recovery code being spent is worth its own line because there are only
   * ten and each can be used once.
   */
  MFA_CHALLENGED: 'auth.mfa_challenged',
  MFA_FAILED: 'auth.mfa_failed',
  MFA_RECOVERY_USED: 'auth.mfa_recovery_used',
  /*
   * A refresh token presented more than the grace window after it was rotated.
   * A legitimate client has no reason to do that; recorded for one release so
   * the real rate is known before it becomes grounds for revoking the lineage.
   * Written as a literal in session.ts, which audit.ts imports from.
   */
  SESSION_REUSE_DETECTED: 'auth.session_reuse_detected',
  // SESSIONS_REVOKED already exists above under auth.*; the platform console
  // reuses it rather than minting a second name for the same event.
  /*
   * A restaurant's website connection (websiteconnect.md). Three events,
   * because they answer three different questions a month later: when was the
   * key first issued, who rotated it, and who cut the website off. The key
   * itself never appears in a row — `redact` strips `apiKey`, and only the
   * four-character hint is written.
   */
  WEBSITE_CONNECTED: 'platform.website_connected',
  WEBSITE_KEY_REGENERATED: 'platform.website_key_regenerated',
  WEBSITE_DISCONNECTED: 'platform.website_disconnected',
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
