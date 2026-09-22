import 'server-only'

import { actingBranchId, scopeToOne, type BranchSelection } from '@/features/dashboard/selected-branch'
import { listShiftHandovers } from '@/features/handover/shift-service'
import type { ShiftHandoverView } from '@/features/handover/shift-types'
import { PERMISSIONS, can, type PermissionSubject } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { getCurrentShift, listShiftHistory, listShiftTemplates } from './queries'
import { zonedToUtc } from './service'
import type { CurrentShiftView, ShiftHistoryRow } from './types'

/**
 * Everything the Shift tab shows, loaded once (shifthandover.md "UI").
 *
 * One loader for the two doors — `/dashboard/handover` and the POS tab — so
 * the tab is the same tab wherever it is opened, and a filter or a rule
 * added here reaches both. Neither page decides scope itself: the viewer's
 * own rows unless they manage staff or drawers, and never a site they may
 * not see.
 */

export interface ShiftPanelFilters {
  q: string
  from: string
  to: string
  staff: string
  shift: string
  status: string
}

export interface ShiftPanelData {
  current: CurrentShiftView
  waiting: ShiftHandoverView[]
  mine: ShiftHandoverView | null
  handovers: ShiftHandoverView[]
  shiftHistory: ShiftHistoryRow[]
  filters: ShiftPanelFilters
  staffOptions: Array<{ id: string; name: string }>
  templateOptions: Array<{ id: string; name: string }>
  canSeeAll: boolean
  branchId: string | null
}

type Param = string | string[] | undefined

function one(value: Param): string {
  return typeof value === 'string' ? value.trim() : ''
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

export async function loadShiftPanel(params: {
  user: PermissionSubject & { id: string; restaurantId: string; branchId: string | null }
  timeZone: string
  selection: BranchSelection
  searchParams: Record<string, Param>
}): Promise<ShiftPanelData> {
  const { user, selection, searchParams } = params
  const canSeeAll = can(user, PERMISSIONS.CASH_DRAWER_MANAGE) || can(user, PERMISSIONS.STAFF_MANAGE)

  const scoped = scopeToOne(selection)
  const branchId = scoped === '__none__' ? null : scoped
  // The card is about ONE shift at ONE site, so an owner on "All locations"
  // is shown the site they are acting at.
  const cardBranchId = branchId ?? (await actingBranchId(user))

  const filters: ShiftPanelFilters = {
    q: one(searchParams.q).slice(0, 80),
    from: DATE_KEY.test(one(searchParams.from)) ? one(searchParams.from) : '',
    to: DATE_KEY.test(one(searchParams.to)) ? one(searchParams.to) : '',
    staff: canSeeAll ? one(searchParams.staff) : '',
    shift: one(searchParams.shift),
    status: one(searchParams.status),
  }
  const from = filters.from ? zonedToUtc(filters.from, '00:00', params.timeZone) : undefined
  const to = filters.to ? new Date(zonedToUtc(filters.to, '23:59', params.timeZone).getTime() + 59_999) : undefined
  const status = ['PENDING_ACCEPTANCE', 'COMPLETED', 'REJECTED', 'CANCELLED'].includes(filters.status)
    ? (filters.status as ShiftHandoverView['status'])
    : undefined

  const [current, waiting, handovers, shiftHistory, templates, staff] = await Promise.all([
    getCurrentShift({
      restaurantId: user.restaurantId,
      user: { id: user.id, role: user.role, branchId: user.branchId },
      branchId: cardBranchId,
      timeZone: params.timeZone,
    }),
    // Waiting on THIS person, whatever the switcher says: a handover to you
    // is yours to answer wherever you are standing.
    listShiftHandovers({ restaurantId: user.restaurantId, participantId: user.id, status: 'PENDING_ACCEPTANCE', limit: 10 }),
    listShiftHandovers({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
      participantId: canSeeAll ? filters.staff || undefined : user.id,
      status,
      q: filters.q || undefined,
      from,
      to,
      templateId: filters.shift || undefined,
      limit: 100,
    }),
    listShiftHistory({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
      userId: canSeeAll ? filters.staff || undefined : user.id,
      templateId: filters.shift || undefined,
      from,
      to,
      q: filters.q || undefined,
      limit: 100,
    }),
    listShiftTemplates({ restaurantId: user.restaurantId, branchIds: selection.branchIds, includeInactive: true }),
    canSeeAll
      ? prisma.user.findMany({
          where: {
            restaurantId: user.restaurantId,
            deletedAt: null,
            role: { not: 'SUPER_ADMIN' },
            ...(selection.branchIds ? { OR: [{ branchId: null }, { branchId: { in: selection.branchIds } }] } : {}),
          },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ])

  return {
    current,
    waiting: waiting.filter((row) => row.toId === user.id),
    mine: waiting.find((row) => row.fromId === user.id) ?? null,
    handovers,
    shiftHistory,
    filters,
    staffOptions: staff,
    templateOptions: templates.map((t) => ({ id: t.id, name: t.name })),
    canSeeAll,
    branchId,
  }
}
