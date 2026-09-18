import 'server-only'

import type { Prisma, ShiftHandover, UserRole } from '@prisma/client'

import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { ROLE_LABELS, canAccessBranch } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { notify } from '@/server/notifications'
import { computeDrawerTotals } from '@/features/cashdrawer/service'
import { listInstructions } from '@/features/instructions/service'
import { listShiftNotes } from './queries'
import {
  HANDOVER_ROLES,
  acceptHandover,
  cancelHandover,
  declineHandover,
  requestHandover,
  type HandoverActor,
} from './cash-service'
import type { HandoverSummary, ReceiverOption, ShiftHandoverView } from './shift-types'

/**
 * A shift handover for every role (recorrection.md §2).
 *
 *   Start → Select who takes over → Review the summary → Confirm
 *     → PENDING_ACCEPTANCE → the receiver accepts (COMPLETED) or rejects with a
 *       reason (REJECTED); the outgoing person, or a manager, may withdraw it
 *       first (CANCELLED).
 *
 * ── What existed, and why it was not this ───────────────────────────────────
 *
 * A cashier's handover has always existed as `CashHandover`: the till going
 * from one drawer session to the next, with both counts on the record. It is
 * well guarded and it stays exactly as it is — `requestHandover`,
 * `acceptHandover` and `declineHandover` are called from here, unchanged, and
 * the tests that pin them still pass. What it never was is a handover of a
 * SHIFT: nobody but a cashier could do one, there was no review step, accept
 * lived on a third screen, decline recorded no reason, and nobody was told.
 *
 * ── One record, with the till inside it ─────────────────────────────────────
 *
 * The shift handover is the general record — who, to whom, where, what the
 * floor looked like at confirm, what was decided. When the outgoing person
 * has a drawer open, the cash handover is nested by `cashHandoverId` and the
 * two move together: confirm requests the till, accept takes it, reject
 * declines it, withdraw cancels it and re-opens the outgoing drawer so the
 * cash is never in no session.
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 *
 * Every transition is `updateMany` with the status in the WHERE, as the cash
 * flow does, so two decisions on one row cannot both land. Where the till is
 * involved the cash handover's own status is the arbiter, and it is settled
 * BEFORE the shift row on every path — so a withdraw racing an accept settles
 * the cash first and the accept's cash step refuses, or the reverse; neither
 * can end with a taken till on a cancelled shift.
 */

const MANAGERS: UserRole[] = ['MANAGER', 'ADMIN', 'OWNER']

/**
 * Who may take over from whom. A shift is handed to somebody who can do the
 * job, or to a manager who can cover it; a waiter's shift does not go to the
 * kitchen. Cashiers are further narrowed by `HANDOVER_ROLES` when a till is
 * involved.
 */
export const RECEIVER_ROLES: Record<UserRole, UserRole[]> = {
  CASHIER: ['CASHIER', ...MANAGERS],
  WAITER: ['WAITER', ...MANAGERS],
  KITCHEN: ['KITCHEN', ...MANAGERS],
  MANAGER: MANAGERS,
  ADMIN: MANAGERS,
  OWNER: MANAGERS,
  INVENTORY_MANAGER: ['INVENTORY_MANAGER', 'WAREHOUSE_STAFF', 'STOCK_KEEPER', ...MANAGERS],
  WAREHOUSE_STAFF: ['WAREHOUSE_STAFF', 'STOCK_KEEPER', 'INVENTORY_MANAGER', ...MANAGERS],
  // A store shift passes to whoever else keeps the store, or up to a manager.
  STOCK_KEEPER: ['STOCK_KEEPER', 'WAREHOUSE_STAFF', 'INVENTORY_MANAGER', ...MANAGERS],
  PURCHASING_MANAGER: ['PURCHASING_MANAGER', ...MANAGERS],
  ACCOUNTANT: ['ACCOUNTANT', 'ADMIN', 'OWNER'],
  // Platform operators are not on anybody's rota.
  SUPER_ADMIN: [],
}

export interface HandoverPerson {
  id: string
  name: string
  role: UserRole
  branchId: string | null
}

const OPEN_ORDER_STATUSES = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'] as const

/**
 * Who may take this shift over: same site, active, not the outgoing person,
 * role-compatible, and — when a till goes with it — able to work a till.
 * Somebody who already has a handover waiting on them is listed but not
 * available, so the picker can say why rather than hide them.
 */
export async function listEligibleReceivers(params: {
  restaurantId: string
  from: HandoverPerson
  branchId: string
  withTill: boolean
}): Promise<ReceiverOption[]> {
  const roles = (RECEIVER_ROLES[params.from.role] ?? []).filter(
    (role) => !params.withTill || HANDOVER_ROLES.has(role),
  )
  if (roles.length === 0) return []

  const people = await prisma.user.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      deletedAt: null,
      id: { not: params.from.id },
      role: { in: roles },
    },
    select: { id: true, name: true, role: true, branchId: true, branch: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })
  const here = people.filter((p) => canAccessBranch({ role: p.role, branchId: p.branchId }, params.branchId))

  const busy = new Set(
    (
      await prisma.shiftHandover.findMany({
        where: {
          restaurantId: params.restaurantId,
          status: 'PENDING_ACCEPTANCE',
          toUserId: { in: here.map((p) => p.id) },
        },
        select: { toUserId: true },
      })
    ).map((row) => row.toUserId),
  )

  return here.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    roleLabel: ROLE_LABELS[p.role] ?? p.role,
    branchName: p.branch?.name ?? null,
    available: !busy.has(p.id),
  }))
}

/**
 * What the shift looks like right now, for Review and for the record.
 *
 * Built on the server from the ledger, the attendance row, the orders and
 * the open tasks and notes — never posted from the client, so the snapshot
 * on the row is what the system saw and not what a browser said.
 */
export async function buildHandoverSummary(params: {
  restaurantId: string
  branchId: string
  user: HandoverPerson
  timeZone: string
}): Promise<{ summary: HandoverSummary; sessionId: string | null; shiftId: string | null }> {
  const dayStart = startOfDayIn(params.timeZone)

  const [branch, shift, session, ordersToday, ordersOpen, tasks, notes] = await Promise.all([
    prisma.branch.findFirst({
      where: { id: params.branchId, restaurantId: params.restaurantId },
      select: { name: true },
    }),
    prisma.staffShift.findUnique({
      where: { activeShiftKey: params.user.id },
      select: { id: true, clockInAt: true, restaurantId: true },
    }),
    prisma.cashDrawerSession.findUnique({
      where: { activeCashierKey: params.user.id },
      include: { register: { select: { name: true } } },
    }),
    prisma.order.count({
      where: { restaurantId: params.restaurantId, branchId: params.branchId, placedAt: { gte: dayStart } },
    }),
    prisma.order.count({
      where: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        status: { in: [...OPEN_ORDER_STATUSES] },
      },
    }),
    listInstructions({
      restaurantId: params.restaurantId,
      user: { role: params.user.role, branchId: params.user.branchId },
      branchId: params.branchId,
      status: 'OPEN',
      limit: 20,
    }),
    listShiftNotes(params.restaurantId, [params.branchId]),
  ])
  if (!branch) throw new NotFoundError('Location')

  const drawer =
    session && session.restaurantId === params.restaurantId && session.status === 'OPEN'
      ? session
      : null
  const totals = drawer ? await computeDrawerTotals(drawer.id) : null

  return {
    sessionId: drawer?.id ?? null,
    shiftId: shift && shift.restaurantId === params.restaurantId ? shift.id : null,
    summary: {
      branchName: branch.name,
      shift: shift && shift.restaurantId === params.restaurantId ? { clockInAt: shift.clockInAt.toISOString() } : null,
      drawer: drawer
        ? {
            sessionNumber: drawer.sessionNumber,
            registerName: drawer.register?.name ?? null,
            openingFloat: drawer.openingFloat,
            expectedCash: totals?.expectedCash ?? 0,
            countedCash: null,
            variance: null,
          }
        : null,
      orders: { today: ordersToday, open: ordersOpen },
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        assigneeName: task.assigneeName ?? null,
        dueAt: task.dueAt?.toISOString() ?? null,
      })),
      notes: notes.map((note) => ({ body: note.body, authorName: note.authorName })),
    },
  }
}

/**
 * Confirm: the outgoing person hands over.
 *
 * Refuses, in order: handing to yourself; somebody who cannot do this job;
 * somebody at another site; a second handover while one is in flight
 * (either from this person, or already waiting on the receiver). Then, if
 * the outgoing person has a drawer open, the till goes with the shift: a
 * count is required, the receiver must be able to work a till, and the cash
 * handover is requested through the existing, unchanged path — same
 * variance rule, same one-in-flight guard.
 *
 * The cash request and the shift row are two writes, deliberately: the cash
 * path runs its own transaction with its own retries. If the shift row then
 * fails to be created the cash handover stands alone and is still accepted
 * the old way, on the session screen — a coherent state, not a stranded one.
 */
export async function startShiftHandover(params: {
  restaurantId: string
  from: HandoverPerson
  actor: HandoverActor
  branchId: string
  toUserId: string
  notes?: string | null
  /** Minor units. Required when the outgoing person has a drawer open. */
  countedAmount?: number | null
  varianceReason?: string | null
  timeZone: string
}): Promise<ShiftHandover> {
  if (params.toUserId === params.from.id) {
    throw new AppError('Hand over to somebody else', 400, 'HANDOVER_SELF')
  }

  const receiver = await prisma.user.findFirst({
    where: { id: params.toUserId, restaurantId: params.restaurantId, isActive: true, deletedAt: null },
    select: { id: true, name: true, role: true, branchId: true },
  })
  if (!receiver) throw new NotFoundError('Colleague')

  const allowed = RECEIVER_ROLES[params.from.role] ?? []
  if (!allowed.includes(receiver.role)) {
    throw new AppError(
      `${receiver.name} cannot take over a ${ROLE_LABELS[params.from.role] ?? params.from.role} shift`,
      403,
      'HANDOVER_ROLE_MISMATCH',
    )
  }
  if (!canAccessBranch({ role: receiver.role, branchId: receiver.branchId }, params.branchId)) {
    throw new AppError('That person does not work at this location', 403, 'HANDOVER_CROSSES_BRANCH')
  }

  const inFlight = await prisma.shiftHandover.findFirst({
    where: {
      restaurantId: params.restaurantId,
      status: 'PENDING_ACCEPTANCE',
      OR: [{ fromUserId: params.from.id }, { toUserId: params.toUserId }],
    },
    include: { toUser: { select: { name: true } } },
  })
  if (inFlight) {
    throw new AppError(
      inFlight.fromUserId === params.from.id
        ? `You already have a handover waiting for ${inFlight.toUser.name} to accept. Withdraw it first.`
        : `${receiver.name} already has a handover waiting for them to accept.`,
      409,
      'HANDOVER_ALREADY_PENDING',
    )
  }

  const built = await buildHandoverSummary({
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    user: params.from,
    timeZone: params.timeZone,
  })
  const summary = built.summary

  let cashHandoverId: string | null = null
  if (built.sessionId && summary.drawer) {
    if (params.countedAmount === null || params.countedAmount === undefined) {
      throw new AppError('Count the drawer before handing your shift over — the till goes with it', 400, 'HANDOVER_NO_COUNT')
    }
    if (!HANDOVER_ROLES.has(receiver.role)) {
      throw new AppError(`${receiver.name} does not work a till, and yours goes with this shift`, 403, 'HANDOVER_NOT_A_CASHIER')
    }
    const cash = await requestHandover({
      restaurantId: params.restaurantId,
      sessionId: built.sessionId,
      toUserId: receiver.id,
      countedAmount: params.countedAmount,
      varianceReason: params.varianceReason ?? null,
      note: params.notes ?? null,
      userId: params.from.id,
      actor: params.actor,
    })
    cashHandoverId = cash.id
    summary.drawer.countedCash = cash.countedAmount
    summary.drawer.variance = cash.variance
  }

  const row = await prisma.shiftHandover.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      fromUserId: params.from.id,
      toUserId: receiver.id,
      fromShiftId: built.shiftId,
      cashHandoverId,
      summary: summary as unknown as Prisma.InputJsonValue,
      notes: params.notes?.trim() || null,
    },
  })

  // Told, not left to find out. `notify` was used for forgotten drawers and
  // never for a handover; the receiver is the one person who has to act.
  await notify({
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    userId: receiver.id,
    type: 'SYSTEM',
    title: `${params.from.name} is handing their shift to you`,
    body: summary.drawer
      ? `At ${summary.branchName}, with the till (counted ${summary.drawer.countedCash}). Review and accept on Shift handover.`
      : `At ${summary.branchName}. Review and accept on Shift handover.`,
    data: { shiftHandoverId: row.id, href: '/dashboard/handover' },
  })

  return row
}

/** Accept: the receiver takes the shift, and the till with it when there is one. */
export async function acceptShiftHandover(params: {
  restaurantId: string
  handoverId: string
  user: HandoverPerson
  actor: HandoverActor
}): Promise<{ handover: ShiftHandover; sessionId: string | null }> {
  const row = await requireShiftHandover(params.restaurantId, params.handoverId, params.user)
  if (row.status !== 'PENDING_ACCEPTANCE') {
    throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
  }
  if (row.toUserId !== params.user.id) {
    throw new ForbiddenError('That shift was handed to somebody else')
  }

  // The till first: its own status is the arbiter, and a refusal there (a
  // drawer already open in this person's name, a race) leaves the shift
  // pending rather than completed-without-a-till.
  let sessionId: string | null = null
  if (row.cashHandoverId) {
    const taken = await acceptHandover({
      restaurantId: params.restaurantId,
      handoverId: row.cashHandoverId,
      userId: params.user.id,
      actor: params.actor,
    })
    sessionId = taken.sessionId
  }

  const now = new Date()
  const settled = await prisma.shiftHandover.updateMany({
    where: { id: row.id, status: 'PENDING_ACCEPTANCE' },
    data: { status: 'COMPLETED', decidedAt: now, decidedById: params.user.id },
  })
  if (settled.count === 0) {
    throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
  }

  await notify({
    restaurantId: params.restaurantId,
    branchId: row.branchId,
    userId: row.fromUserId,
    type: 'SYSTEM',
    title: `${params.user.name} accepted your shift handover`,
    body: sessionId ? 'The till is theirs now.' : null,
    data: { shiftHandoverId: row.id, href: '/dashboard/handover' },
  })

  const handover = await prisma.shiftHandover.findUniqueOrThrow({ where: { id: row.id } })
  return { handover, sessionId }
}

/**
 * Reject: the receiver refuses, and says why.
 *
 * The reason is the whole point — a decline that recorded nothing was the
 * defect. The till, when there is one, is declined through the existing
 * path, whose semantics stand: the outgoing session stays closed with the
 * outgoing count on it, and management is told the drawer needs a hand.
 */
export async function rejectShiftHandover(params: {
  restaurantId: string
  handoverId: string
  user: HandoverPerson
  actor: HandoverActor
  reason: string
}): Promise<ShiftHandover> {
  const reason = params.reason.trim()
  if (reason.length < 2) {
    throw new AppError('Say why you are not accepting it', 400, 'HANDOVER_NO_REASON')
  }
  const row = await requireShiftHandover(params.restaurantId, params.handoverId, params.user)
  if (row.status !== 'PENDING_ACCEPTANCE') {
    throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
  }
  if (row.toUserId !== params.user.id) {
    throw new ForbiddenError('That shift was handed to somebody else')
  }

  if (row.cashHandoverId) {
    await declineHandover({
      restaurantId: params.restaurantId,
      handoverId: row.cashHandoverId,
      userId: params.user.id,
      actor: params.actor,
    })
  }

  const now = new Date()
  const settled = await prisma.shiftHandover.updateMany({
    where: { id: row.id, status: 'PENDING_ACCEPTANCE' },
    data: { status: 'REJECTED', rejectReason: reason, decidedAt: now, decidedById: params.user.id },
  })
  if (settled.count === 0) {
    throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
  }

  await notify({
    restaurantId: params.restaurantId,
    branchId: row.branchId,
    userId: row.fromUserId,
    type: 'SYSTEM',
    title: `${params.user.name} did not accept your shift handover`,
    body: reason,
    data: { shiftHandoverId: row.id, href: '/dashboard/handover' },
  })
  if (row.cashHandoverId) {
    await notify({
      restaurantId: params.restaurantId,
      branchId: row.branchId,
      audience: 'MANAGEMENT',
      type: 'SYSTEM',
      title: 'A till handover was refused',
      body: `${params.user.name} did not accept the drawer: ${reason}. The closed session needs a manager.`,
      data: { shiftHandoverId: row.id, href: '/dashboard/cash-drawer' },
    })
  }

  return prisma.shiftHandover.findUniqueOrThrow({ where: { id: row.id } })
}

/**
 * Withdraw: the outgoing person changes their mind, or a manager clears one
 * that the receiver never showed up for. With a till attached the cash
 * handover is withdrawn too, and the outgoing drawer re-opens with the
 * counted amount — see `cancelHandover`.
 */
export async function cancelShiftHandover(params: {
  restaurantId: string
  handoverId: string
  user: HandoverPerson
  actor: HandoverActor
  /** A manager clearing somebody else's stale handover. */
  mayCancelOthers: boolean
}): Promise<{ handover: ShiftHandover; reopenedSessionId: string | null }> {
  const row = await requireShiftHandover(params.restaurantId, params.handoverId, params.user)
  if (row.status !== 'PENDING_ACCEPTANCE') {
    throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
  }
  if (row.fromUserId !== params.user.id && !params.mayCancelOthers) {
    throw new ForbiddenError('Only the person handing over, or a manager, can withdraw it')
  }

  let reopenedSessionId: string | null = null
  if (row.cashHandoverId) {
    const withdrawn = await cancelHandover({
      restaurantId: params.restaurantId,
      handoverId: row.cashHandoverId,
      userId: params.user.id,
      // The shift-level permission carries to the till: a manager who may
      // withdraw the shift may withdraw its drawer.
      actor: { ...params.actor, canManageOthers: params.actor.canManageOthers || params.mayCancelOthers },
    })
    reopenedSessionId = withdrawn.reopenedSessionId
  }

  const now = new Date()
  const settled = await prisma.shiftHandover.updateMany({
    where: { id: row.id, status: 'PENDING_ACCEPTANCE' },
    data: { status: 'CANCELLED', decidedAt: now, decidedById: params.user.id },
  })
  if (settled.count === 0) {
    throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
  }

  await notify({
    restaurantId: params.restaurantId,
    branchId: row.branchId,
    userId: row.toUserId,
    type: 'SYSTEM',
    title: 'A shift handover to you was withdrawn',
    body: params.user.id === row.fromUserId ? `${params.user.name} withdrew it.` : `Withdrawn by ${params.user.name}.`,
    data: { shiftHandoverId: row.id, href: '/dashboard/handover' },
  })

  const handover = await prisma.shiftHandover.findUniqueOrThrow({ where: { id: row.id } })
  return { handover, reopenedSessionId }
}

/**
 * The history, scoped (correctionA.md §11's rule, carried over): a manager
 * sees the floor's; everyone else the ones they were part of. `participantId`
 * undefined means no narrowing — the caller decides, because whether somebody
 * may see all of it is a permission question and services do not read
 * permissions.
 */
export async function listShiftHandovers(params: {
  restaurantId: string
  branchIds?: string[] | null
  participantId?: string
  status?: 'PENDING_ACCEPTANCE'
  limit?: number
}): Promise<ShiftHandoverView[]> {
  const rows = await prisma.shiftHandover.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      ...(params.participantId
        ? { OR: [{ fromUserId: params.participantId }, { toUserId: params.participantId }] }
        : {}),
      ...(params.status ? { status: params.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 50,
    include: {
      fromUser: { select: { name: true } },
      toUser: { select: { name: true } },
      branch: { select: { name: true } },
      cashHandover: { select: { countedAmount: true, variance: true, status: true } },
    },
  })
  const deciderIds = [...new Set(rows.map((r) => r.decidedById).filter((id): id is string => Boolean(id)))]
  const deciders = deciderIds.length
    ? await prisma.user.findMany({ where: { id: { in: deciderIds } }, select: { id: true, name: true } })
    : []
  const nameOf = new Map(deciders.map((d) => [d.id, d.name]))

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    fromId: row.fromUserId,
    fromName: row.fromUser.name,
    toId: row.toUserId,
    toName: row.toUser.name,
    branchName: row.branch.name,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByName: row.decidedById ? nameOf.get(row.decidedById) ?? null : null,
    rejectReason: row.rejectReason,
    notes: row.notes,
    summary: row.summary as unknown as HandoverSummary,
    cash: row.cashHandover
      ? { countedAmount: row.cashHandover.countedAmount, variance: row.cashHandover.variance, status: row.cashHandover.status }
      : null,
  }))
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

async function requireShiftHandover(
  restaurantId: string,
  handoverId: string,
  actor: { role: UserRole; branchId?: string | null },
): Promise<ShiftHandover> {
  const row = await prisma.shiftHandover.findFirst({ where: { id: handoverId, restaurantId } })
  if (!row) throw new NotFoundError('Handover')
  if (!canAccessBranch({ role: actor.role, branchId: actor.branchId }, row.branchId)) {
    throw new ForbiddenError('That handover belongs to another location')
  }
  return row
}

/** Midnight today in the restaurant's own time zone (server time is UTC). */
function startOfDayIn(timeZone: string): Date {
  const now = new Date()
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now)
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const sinceMidnight = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000
  return new Date(now.getTime() - sinceMidnight - now.getMilliseconds())
}
