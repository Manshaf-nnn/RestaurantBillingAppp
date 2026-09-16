import type { ShiftHandoverStatus, UserRole } from '@prisma/client'

/**
 * Shapes the shift handover screen and its actions share (recorrection.md §2).
 * Plain data — ISO dates, integer minor units — so a server page can hand it
 * to the client component whole.
 */

/**
 * What the outgoing person's shift looked like at the moment they confirmed.
 * Stored on the row as JSON; recomputing it later would describe a different
 * evening.
 */
export interface HandoverSummary {
  branchName: string
  /** Their open attendance shift, when they had one. */
  shift: { clockInAt: string } | null
  /** Their till, when they had one. Counted/variance are filled in at confirm. */
  drawer: {
    sessionNumber: string
    registerName: string | null
    /** What the session opened with. */
    openingFloat: number
    expectedCash: number
    countedCash: number | null
    variance: number | null
  } | null
  orders: { today: number; open: number }
  tasks: Array<{ id: string; title: string; assigneeName: string | null; dueAt: string | null }>
  notes: Array<{ body: string; authorName: string }>
}

export interface ReceiverOption {
  id: string
  name: string
  role: UserRole
  roleLabel: string
  branchName: string | null
  /** False when they already have a handover waiting on them. */
  available: boolean
}

/** What the wizard loads when it opens: the summary now, and who may take over. */
export interface HandoverPreview {
  branchId: string
  branchName: string
  summary: HandoverSummary
  receivers: ReceiverOption[]
  /** Whether the outgoing person has a drawer open, so a count is required. */
  hasDrawer: boolean
}

export interface ShiftHandoverView {
  id: string
  status: ShiftHandoverStatus
  fromId: string
  fromName: string
  toId: string
  toName: string
  branchName: string
  createdAt: string
  decidedAt: string | null
  decidedByName: string | null
  rejectReason: string | null
  notes: string | null
  summary: HandoverSummary
  cash: { countedAmount: number; variance: number; status: string } | null
}
