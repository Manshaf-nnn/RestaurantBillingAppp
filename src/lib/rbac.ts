import type { UserRole } from '@prisma/client'

/**
 * Permission model.
 *
 * A user's effective permission set = role defaults ∪ per-user grants.
 * Checks are performed both server-side (every action / route) and client-side
 * (to hide affordances). The server check is the one that matters.
 */
export const PERMISSIONS = {
  // dashboards
  DASHBOARD_VIEW: 'dashboard.view',
  ANALYTICS_VIEW: 'analytics.view',

  // menu
  MENU_VIEW: 'menu.view',
  MENU_MANAGE: 'menu.manage',
  CATEGORY_MANAGE: 'category.manage',

  // floor
  TABLE_VIEW: 'table.view',
  TABLE_MANAGE: 'table.manage',
  RESERVATION_MANAGE: 'reservation.manage',

  // orders
  ORDER_VIEW: 'order.view',
  ORDER_CREATE: 'order.create',
  ORDER_UPDATE_STATUS: 'order.updateStatus',
  ORDER_CANCEL: 'order.cancel',
  KITCHEN_VIEW: 'kitchen.view',
  WAITER_VIEW: 'waiter.view',

  // money
  PAYMENT_VIEW: 'payment.view',
  PAYMENT_COLLECT: 'payment.collect',
  PAYMENT_REFUND: 'payment.refund',
  INVOICE_VIEW: 'invoice.view',
  DISCOUNT_APPLY: 'discount.apply',
  COUPON_MANAGE: 'coupon.manage',

  // people
  CUSTOMER_VIEW: 'customer.view',
  CUSTOMER_MANAGE: 'customer.manage',
  STAFF_VIEW: 'staff.view',
  STAFF_MANAGE: 'staff.manage',

  // supply chain
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_MANAGE: 'inventory.manage',
  SUPPLIER_MANAGE: 'supplier.manage',
  PURCHASE_MANAGE: 'purchase.manage',

  // back office
  REPORT_VIEW: 'report.view',
  REPORT_EXPORT: 'report.export',
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_VIEW: 'audit.view',
  REVIEW_MANAGE: 'review.manage',

  // inventory — moving stock and changing what it cost are separate powers
  // from ordinary stock-keeping, so they are separate permissions.
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_WASTAGE: 'inventory.wastage',
  INVENTORY_TRANSFER: 'inventory.transfer',
  INVENTORY_COUNT: 'inventory.count',
  INVENTORY_COUNT_APPROVE: 'inventory.countApprove',
  INVENTORY_COST_EDIT: 'inventory.costEdit',

  // purchasing — creating an order and committing the restaurant's money to it
  // are separate acts, so they are separate permissions.
  PURCHASE_VIEW: 'purchase.view',
  PURCHASE_CREATE: 'purchase.create',
  PURCHASE_APPROVE: 'purchase.approve',
  PURCHASE_RECEIVE: 'purchase.receive',
  PURCHASE_RETURN: 'purchase.return',

  // branches
  BRANCH_VIEW: 'branch.view',
  BRANCH_MANAGE: 'branch.manage',

  // cash drawer — operating your own drawer is a cashier's job; seeing everyone's
  // variance and force-closing a drawer someone left open is a manager's.
  CASH_DRAWER_OPERATE: 'cashDrawer.operate',
  CASH_DRAWER_MANAGE: 'cashDrawer.manage',
} as const

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

const ALL: Permission[] = Object.values(PERMISSIONS)

const MANAGER: Permission[] = ALL.filter(
  (p) => p !== PERMISSIONS.SETTINGS_MANAGE && p !== PERMISSIONS.PAYMENT_REFUND,
)

// A cashier handles money at the till, not the restaurant's buying. They are
// deliberately given none of the purchasing permissions.

const KITCHEN: Permission[] = [
  PERMISSIONS.KITCHEN_VIEW,
  PERMISSIONS.ORDER_VIEW,
  PERMISSIONS.ORDER_UPDATE_STATUS,
  PERMISSIONS.MENU_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_WASTAGE,
  PERMISSIONS.INVENTORY_COUNT,
]

const CASHIER: Permission[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.ORDER_VIEW,
  PERMISSIONS.ORDER_CREATE,
  PERMISSIONS.ORDER_UPDATE_STATUS,
  PERMISSIONS.PAYMENT_VIEW,
  PERMISSIONS.PAYMENT_COLLECT,
  PERMISSIONS.INVOICE_VIEW,
  PERMISSIONS.DISCOUNT_APPLY,
  PERMISSIONS.CUSTOMER_VIEW,
  PERMISSIONS.MENU_VIEW,
  PERMISSIONS.TABLE_VIEW,
  PERMISSIONS.BRANCH_VIEW,
  PERMISSIONS.CASH_DRAWER_OPERATE,
]

const WAITER: Permission[] = [
  PERMISSIONS.WAITER_VIEW,
  PERMISSIONS.ORDER_VIEW,
  PERMISSIONS.ORDER_CREATE,
  PERMISSIONS.ORDER_UPDATE_STATUS,
  PERMISSIONS.TABLE_VIEW,
  PERMISSIONS.TABLE_MANAGE,
  PERMISSIONS.MENU_VIEW,
  PERMISSIONS.CUSTOMER_VIEW,
]

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: ALL,
  OWNER: ALL,
  MANAGER,
  KITCHEN,
  CASHIER,
  WAITER,
}

export const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: 'Super Admin',
  OWNER: 'Owner',
  MANAGER: 'Manager',
  KITCHEN: 'Kitchen',
  CASHIER: 'Cashier',
  WAITER: 'Waiter',
}

/** Where each role lands after signing in. */
export const ROLE_HOME: Record<UserRole, string> = {
  SUPER_ADMIN: '/admin',
  OWNER: '/dashboard',
  MANAGER: '/dashboard',
  KITCHEN: '/kitchen',
  CASHIER: '/cashier',
  WAITER: '/waiter',
}

export interface PermissionSubject {
  role: UserRole
  permissions?: string[]
}

export function permissionsFor(subject: PermissionSubject): Set<string> {
  return new Set<string>([...ROLE_PERMISSIONS[subject.role], ...(subject.permissions ?? [])])
}

export function can(subject: PermissionSubject | null | undefined, permission: Permission): boolean {
  if (!subject) return false
  return permissionsFor(subject).has(permission)
}

export function canAny(
  subject: PermissionSubject | null | undefined,
  permissions: Permission[],
): boolean {
  if (!subject) return false
  const set = permissionsFor(subject)
  return permissions.some((p) => set.has(p))
}

export function canAll(
  subject: PermissionSubject | null | undefined,
  permissions: Permission[],
): boolean {
  if (!subject) return false
  const set = permissionsFor(subject)
  return permissions.every((p) => set.has(p))
}

/** Roles a given role is allowed to create or edit — prevents privilege escalation. */
export function assignableRoles(role: UserRole): UserRole[] {
  switch (role) {
    case 'SUPER_ADMIN':
      return ['OWNER', 'MANAGER', 'KITCHEN', 'CASHIER', 'WAITER']
    case 'OWNER':
      return ['MANAGER', 'KITCHEN', 'CASHIER', 'WAITER']
    case 'MANAGER':
      return ['KITCHEN', 'CASHIER', 'WAITER']
    default:
      return []
  }
}
