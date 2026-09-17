import { PERMISSIONS, can, type PermissionSubject } from '@/lib/rbac'

/**
 * The POS is one screen with three tabs (abc.md §8): taking orders, the
 * cashier's bills and payments, and the drawer. Which tabs a person sees is
 * a question about their permissions, answered here once — the page, the
 * tab strip and the tests all ask the same function.
 */
export const POS_TABS = ['orders', 'cashier', 'drawer'] as const
export type PosTab = (typeof POS_TABS)[number]

export const POS_TAB_LABEL: Record<PosTab, string> = {
  orders: 'Orders',
  cashier: 'Cashier',
  drawer: 'Drawer',
}

/** The tabs this person may open, in the order they are shown. */
export function posTabsFor(user: PermissionSubject): PosTab[] {
  const tabs: PosTab[] = []
  if (can(user, PERMISSIONS.ORDER_CREATE)) tabs.push('orders')
  if (can(user, PERMISSIONS.PAYMENT_COLLECT)) tabs.push('cashier')
  if (can(user, PERMISSIONS.CASH_DRAWER_OPERATE) || can(user, PERMISSIONS.CASH_DRAWER_MANAGE)) {
    tabs.push('drawer')
  }
  return tabs
}

export function isPosTab(value: unknown): value is PosTab {
  return typeof value === 'string' && (POS_TABS as readonly string[]).includes(value)
}

/**
 * Which tab to show for `?tab=`: the one asked for if allowed, else the first
 * this person may open, else null (nothing here is theirs).
 */
export function resolvePosTab(user: PermissionSubject, requested: unknown): PosTab | null {
  const allowed = posTabsFor(user)
  if (allowed.length === 0) return null
  if (isPosTab(requested) && allowed.includes(requested)) return requested
  return allowed[0]
}
