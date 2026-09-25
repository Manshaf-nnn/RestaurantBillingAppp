/**
 * The shape `approvalDetailAction` returns.
 *
 * Its own module because a `'use server'` file may export nothing but async
 * functions — exporting a type from one is not a lint complaint, it breaks
 * every action in the file at runtime, which is what `no-bad-server-exports`
 * exists to catch.
 */
export interface ApprovalDetailPayload {
  id: string
  kind: string
  status: string
  reason: string
  amount: number | null
  branchName: string | null
  requestedByName: string
  requestedAt: string
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  forcedAt: string | null
  href: string | null
  reference: string | null
  details: Array<{ label: string; value: string }>
  history: Array<{ id: string; action: string; actorName: string; createdAt: string; entity: string }>
  blockedReason: string | null
  mayForce: boolean
  /**
   * The transfer this request is about, with its lines (recorrection.md §1).
   * Null for every other kind. What a reader needs in order to decide without
   * being sent to the Transfers tab.
   */
  transfer: {
    number: string
    status: string
    fromBranchName: string
    toBranchName: string
    lines: Array<{
      /** Needed to send an adjusted quantity back for this exact line. */
      id: string
      itemId: string
      name: string
      unit: string
      quantity: number
      /** Free stock at the source right now, in base units. */
      available: number
    }>
  } | null
}
