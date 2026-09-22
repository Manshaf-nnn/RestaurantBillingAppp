import type { ShiftAssignmentStatus, ShiftCloseReason, ShiftSource, UserRole } from '@prisma/client'

/**
 * Shapes the shift screens and their actions share (shifthandover.md).
 * Plain data — ISO dates, integer minor units — so a server page can hand
 * them to a client component whole.
 */

export interface ShiftTemplateView {
  id: string
  name: string
  /** "HH:mm" in the restaurant's zone. */
  startTime: string
  endTime: string
  /** True when the shift ends on the following day. */
  overnight: boolean
  roles: UserRole[]
  branchId: string | null
  branchName: string | null
  isActive: boolean
  sortOrder: number
}

export interface ShiftAssignmentView {
  id: string
  userId: string
  userName: string
  role: UserRole
  roleLabel: string
  branchId: string
  branchName: string
  templateId: string
  templateName: string
  /** "YYYY-MM-DD" in the restaurant's zone. */
  date: string
  scheduledStartAt: string
  scheduledEndAt: string
  status: ShiftAssignmentStatus
  notes: string | null
  /** The session that worked it, once started. */
  actualStartAt: string | null
  actualEndAt: string | null
}

/** Somebody who may be put on the rota, with what the picker needs to filter. */
export interface RotaStaffOption {
  id: string
  name: string
  role: UserRole
  roleLabel: string
  branchId: string | null
}

export type ShiftStatus = 'ON_SHIFT' | 'NOT_STARTED' | 'UNSCHEDULED' | 'OFF'

/** The Shift tab's top card (shifthandover.md "UI"). */
export interface CurrentShiftView {
  branchId: string
  branchName: string
  status: ShiftStatus
  /** The session being worked, when there is one. */
  session: {
    id: string
    clockInAt: string
    templateName: string | null
    scheduledStartAt: string | null
    scheduledEndAt: string | null
    source: ShiftSource
  } | null
  /** Rostered shifts the person has not started yet — the prompt, never a gate. */
  toStart: Array<{
    id: string
    templateName: string
    scheduledStartAt: string
    scheduledEndAt: string
    branchName: string
  }>
  /** Everyone rostered at this location today, and where they are with it. */
  assignedStaff: Array<{
    id: string
    userId: string
    name: string
    roleLabel: string
    templateName: string
    scheduledStartAt: string
    scheduledEndAt: string
    status: ShiftAssignmentStatus
    /** Started, and still on it. */
    working: boolean
  }>
  drawer: { status: 'NONE' | 'OPEN' | 'PENDING_REVIEW'; sessionNumber: string | null; registerName: string | null }
  handover: { status: 'NONE' | 'WAITING_ON_THEM' | 'WAITING_ON_YOU'; withName: string | null; handoverId: string | null }
  pending: {
    openOrders: number
    openTasks: number
    transfersToDispatch: number
    transfersToReceive: number
    deliveriesToReceive: number
    notes: number
  }
}

export interface ShiftHistoryRow {
  id: string
  userId: string
  userName: string
  role: UserRole | null
  roleLabel: string
  branchId: string
  branchName: string
  templateName: string | null
  /** "YYYY-MM-DD" business date. */
  date: string
  scheduledStartAt: string | null
  scheduledEndAt: string | null
  startedAt: string
  endedAt: string | null
  minutes: number
  onShift: boolean
  source: ShiftSource
  closedBy: ShiftCloseReason | null
  corrected: boolean
}

export interface ShiftHistoryFilters {
  from?: string
  to?: string
  branchId?: string
  userId?: string
  templateId?: string
  q?: string
}
