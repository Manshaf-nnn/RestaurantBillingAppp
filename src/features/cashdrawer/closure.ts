/**
 * What a closed drawer reconciled to (correctionA.md §4).
 *
 * Its own module because a `'use server'` file may export nothing but async
 * functions, and because both the action that produces it and the printable
 * preview that renders it need the same shape.
 *
 * Every figure here is revealed only AFTER the close is committed. Before it,
 * the cashier sees the count boxes and nothing else — see `closeDrawer`.
 */
export interface DrawerClosure {
  id: string
  sessionNumber: string
  openingFloat: number
  cashSales: number
  cashIn: number
  cashOut: number
  expectedCash: number
  countedCash: number
  /** Face value in minor units → how many were counted. */
  counts: Record<string, number>
  variance: number
  /** True when the gap was large enough to stop for a manager. */
  needsReview: boolean
  closedAt: string
}
