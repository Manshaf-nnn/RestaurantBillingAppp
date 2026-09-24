/**
 * Which screen the waiter station is showing.
 *
 * Serve, Requests and Tables are three views of one board and switch in the
 * browser — a waiter taps between them constantly and a round trip each time
 * would be felt. Taking an order is different: it is a mode, it fills the
 * screen, and it holds a half-typed cart.
 *
 * ── Why the order pad lives in the URL ──────────────────────────────────────
 *
 * `WaiterBoard` mounts `<AutoRefresh intervalMs={3000} />`. A cart held in
 * local state inside that component would be re-rendered against fresh server
 * props every three seconds while somebody is still adding dishes to it. So
 * the pad is a SIBLING of the board, not a panel inside it: `?tab=order`
 * renders the pad and the board (with its refresh loop) is not mounted at all.
 *
 * Plain module, not `'use server'` — it is read by a server page and by a
 * client component, and an action file may only export async functions.
 */

export type WaiterTab = 'board' | 'order'

/** `?tab=order` opens the pad; anything else is the board. */
export function resolveWaiterTab(raw: string | string[] | undefined): WaiterTab {
  return raw === 'order' ? 'order' : 'board'
}

/**
 * A link to one tab, keeping the station on its own floor.
 *
 * `?branch=` is how a station says which location it is standing in, and
 * losing it on a tab change would send the waiter back to the branch picker
 * mid-service.
 */
export function waiterHref(tab: WaiterTab, branchId: string | null): string {
  const params = new URLSearchParams()
  if (tab !== 'board') params.set('tab', tab)
  if (branchId) params.set('branch', branchId)
  const query = params.toString()
  return query ? `/waiter?${query}` : '/waiter'
}
