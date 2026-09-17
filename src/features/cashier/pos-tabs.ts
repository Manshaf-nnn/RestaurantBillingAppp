import { PERMISSIONS, can, type PermissionSubject } from '@/lib/rbac'

/**
 * The POS is one screen with four tabs (abc.md §8): taking orders, the
 * cashier's bills and payments, the drawer, and handing the shift on. Which
 * tabs a person sees is a question about their permissions, answered here
 * once — the page, the tab strip and the tests all ask the same function.
 *
 * Handover is last because it is the end of a shift, and it is HERE because
 * that is where the person finishing one is standing. The screen itself is
 * the same component the dashboard page mounts, reading the same server
 * data: one handover system, two doors onto it.
 */
export const POS_TABS = ['orders', 'cashier', 'drawer', 'handover'] as const
export type PosTab = (typeof POS_TABS)[number]

export const POS_TAB_LABEL: Record<PosTab, string> = {
  orders: 'Orders',
  cashier: 'Cashier',
  drawer: 'Drawer',
  handover: 'Shift Handover',
}

/** The tabs this person may open, in the order they are shown. */
export function posTabsFor(user: PermissionSubject): PosTab[] {
  const tabs: PosTab[] = []
  if (can(user, PERMISSIONS.ORDER_CREATE)) tabs.push('orders')
  if (can(user, PERMISSIONS.PAYMENT_COLLECT)) tabs.push('cashier')
  if (can(user, PERMISSIONS.CASH_DRAWER_OPERATE) || can(user, PERMISSIONS.CASH_DRAWER_MANAGE)) {
    tabs.push('drawer')
  }
  /*
   * Only for somebody who is already on this screen.
   *
   * Handing a shift on is not a till job — the kitchen and the stores do it
   * too — and they have their own door to it: the sidebar and the account
   * menu both open `/dashboard/handover`. Offering the tab to somebody the
   * POS page itself turns away would be a tab that cannot be opened, because
   * that gate asks for a till permission, not this one.
   */
  if (tabs.length > 0 && can(user, PERMISSIONS.HANDOVER_VIEW)) tabs.push('handover')
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
