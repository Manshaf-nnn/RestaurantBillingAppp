import type { ShiftHandoverStatus, UserRole } from '@prisma/client'

/**
 * Shapes the shift handover screen and its actions share (recorrection.md §2,
 * shifthandover.md §4). Plain data — ISO dates, integer minor units — so a
 * server page can hand it to the client component whole.
 */

/**
 * What the outgoing person's shift looked like at the moment they confirmed.
 * Stored on the row as JSON; recomputing it later would describe a different
 * evening.
 *
 * Rows written before shifthandover.md lack the newer fields, so readers treat
 * every one of them as optional.
 */
export interface HandoverSummary {
  branchName: string
  /** Their open attendance shift, when they had one. */
  shift: {
    clockInAt: string
    templateName?: string | null
    scheduledStartAt?: string | null
    scheduledEndAt?: string | null
  } | null
  /** Their till, when they had one. Counted/variance are filled in at confirm. */
  drawer: {
    sessionNumber: string
    registerName: string | null
    /** What the session opened with. */
    openingFloat: number
    cashSales?: number
    refunds?: number
    cashIn?: number
    cashOut?: number
    /** How many cash movements were recorded against the session. */
    movements?: number
    /**
     * What the system expected to find. `null` on the wire to the person
     * operating the drawer until their count is submitted (shifthandover.md
     * "Cash drawer — critical"); always a number in the stored snapshot,
     * which is written after submission.
     */
    expectedCash: number | null
    countedCash: number | null
    variance: number | null
    /** Face value in minor units → how many were counted. */
    counts?: Record<string, number> | null
    /** The gap was big enough to stop for a manager. */
    needsReview?: boolean
  } | null
  orders: { today: number; open: number; pending?: number }
  transfers?: { toDispatch: number; toReceive: number }
  deliveriesToReceive?: number
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
  /** The notes and coins to count, largest first. */
  denominations: Array<{ value: number; label: string; kind: 'note' | 'coin' }>
}

export interface ShiftHandoverView {
  id: string
  status: ShiftHandoverStatus
  fromId: string
  fromName: string
  toId: string
  toName: string
  branchId: string
  branchName: string
  /** The rostered shift the outgoing person was on, when they were on one. */
  templateName: string | null
  createdAt: string
  decidedAt: string | null
  decidedByName: string | null
  rejectReason: string | null
  notes: string | null
  summary: HandoverSummary
  cash: { countedAmount: number; expectedAmount: number; variance: number; status: string } | null
}

/** What the wizard shows once the handover is submitted. */
export interface HandoverDone {
  drawer: { countedCash: number; expectedCash: number; variance: number; needsReview: boolean } | null
}
