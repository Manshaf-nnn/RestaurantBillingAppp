import 'server-only'

import type { InstructionPriority, InstructionStatus, UserRole } from '@prisma/client'

import { ForbiddenError, NotFoundError } from '@/lib/errors'
import { visibleBranchIds } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { notify } from '@/server/notifications'

/**
 * Instructions from an owner to a location, and the answer back.
 *
 * The gap this fills: an owner could see every branch's numbers and move every
 * branch's stock, and had no way to tell a branch anything. So the app held the
 * facts and WhatsApp held the decisions, and a month later nobody could say
 * whether the stock count they had asked Kandy for was ever done.
 *
 * The rules are deliberately blunt:
 *
 *   · Whoever can see a location can read its instructions.
 *   · Only an unrestricted user — owner, admin, group manager — writes one.
 *     A site manager cannot instruct themselves, and cannot instruct anyone
 *     else's site either.
 *   · Anyone who can see it can mark it done, because the person who actually
 *     does the job is rarely the person the note was addressed to.
 *
 * A `branchId` of null means every location. Those are the group-wide notices —
 * "prices go up on the 1st" — and they show on everyone's list.
 */

export interface InstructionScope {
  role: UserRole
  branchId?: string | null
}

/** Everything this person is allowed to see, newest first. */
export async function listInstructions(params: {
  restaurantId: string
  user: InstructionScope
  /** Narrow further, e.g. from the top-bar switcher. */
  branchId?: string | null
  status?: InstructionStatus
  limit?: number
}) {
  const allowed = visibleBranchIds(params.user)

  /*
   * Three cases, and the middle one is the one that bites.
   *
   *   allowed === null   unrestricted — everything
   *   allowed === []     confined with no location — nothing but group notices
   *   otherwise          their locations, plus group notices
   *
   * `[]` must never be read as "no filter". Elsewhere in this codebase it was,
   * and an unassigned worker saw every transfer in the restaurant.
   */
  const visible =
    allowed === null
      ? {}
      : { OR: [{ branchId: { in: allowed } }, { branchId: null }] }

  const narrowed = params.branchId
    ? { OR: [{ branchId: params.branchId }, { branchId: null }] }
    : {}

  return prisma.branchInstruction.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.status ? { status: params.status } : {}),
      AND: [visible, narrowed],
    },
    orderBy: [
      // Urgent first, then oldest — an instruction that has sat open for a week
      // should not be pushed down the page by one raised this morning.
      { status: 'asc' },
      { priority: 'desc' },
      { createdAt: 'asc' },
    ],
    take: params.limit ?? 100,
    include: {
      branch: { select: { id: true, name: true } },
      // The assignee's own location, not the task's: §2 asks for "assignee +
      // branch", and an owner reading the list wants to know where the person
      // is, which for a group-wide task is the only location on the row.
      assignee: { select: { id: true, name: true, branch: { select: { name: true } } } },
    },
  })
}

/**
 * How many are still open for this person — for the nav badge.
 *
 * "For this person" got narrower with assignment (correctionA.md §2). A task
 * addressed to somebody by name is theirs; a task addressed to a location is
 * everybody-at-that-location's, as it always was. So the badge counts what is
 * assigned to me plus what is assigned to nobody in particular, and stops
 * counting the ones sitting on a colleague's plate — a number that included
 * other people's work is a number nobody acts on.
 */
export async function countOpenInstructions(params: {
  restaurantId: string
  user: InstructionScope & { id: string }
}): Promise<number> {
  const allowed = visibleBranchIds(params.user)
  const visible =
    allowed === null ? {} : { OR: [{ branchId: { in: allowed } }, { branchId: null }] }

  return prisma.branchInstruction.count({
    where: {
      restaurantId: params.restaurantId,
      status: 'OPEN',
      AND: [visible, { OR: [{ assigneeId: null }, { assigneeId: params.user.id }] }],
    },
  })
}

/**
 * The staff this person may hand a task to (correctionA.md §2).
 *
 * Only an unrestricted user writes an instruction at all — see the check in
 * `createInstruction` — so in practice this is "everyone active in the
 * restaurant". It is still filtered by `visibleBranchIds` rather than assumed,
 * because that is the rule the rest of the module obeys and because the day
 * somebody loosens the write check, this must not silently become a directory
 * of every branch's staff.
 *
 * Their location comes back with them: §2 asks for the assignee and their
 * branch shown together, and an owner picking between two people called Nuwan
 * needs to know which site each one is at.
 */
export async function listAssignableStaff(params: {
  restaurantId: string
  user: InstructionScope
}) {
  const allowed = visibleBranchIds(params.user)
  return prisma.user.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      deletedAt: null,
      ...(allowed === null ? {} : { branchId: { in: allowed } }),
    },
    select: {
      id: true,
      name: true,
      role: true,
      branch: { select: { id: true, name: true } },
    },
    orderBy: { name: 'asc' },
  })
}

/**
 * Check an assignee before it is written, and return the name to store.
 *
 * Never trust the posted id. The same rule `rememberBranch` follows for a
 * branch: the row must be in the caller's own restaurant, active, and at a
 * location the caller may reach. Without the restaurant clause this is a way
 * to attach another tenant's user to your task and learn their name back out
 * of the list.
 */
async function resolveAssignee(params: {
  restaurantId: string
  user: InstructionScope
  assigneeId: string
}): Promise<{ id: string; name: string }> {
  const allowed = visibleBranchIds(params.user)
  const assignee = await prisma.user.findFirst({
    where: {
      id: params.assigneeId,
      restaurantId: params.restaurantId,
      isActive: true,
      deletedAt: null,
      ...(allowed === null ? {} : { branchId: { in: allowed } }),
    },
    select: { id: true, name: true },
  })
  if (!assignee) {
    throw new NotFoundError('That person is not someone you can assign a task to')
  }
  return assignee
}

export async function createInstruction(params: {
  restaurantId: string
  user: { id: string; name: string; role: UserRole; branchId?: string | null }
  branchId: string | null
  /** Null keeps the original meaning: the task is for the location. */
  assigneeId?: string | null
  title: string
  body: string | null
  priority: InstructionPriority
  dueAt: Date | null
}) {
  /*
   * Only someone who oversees more than one location may write one. A site
   * manager writing their own to-do list is a different feature; letting them
   * do it here would turn the owner's channel into a shared notepad and destroy
   * the one thing it is for — knowing who asked for what.
   */
  if (visibleBranchIds(params.user) !== null) {
    throw new ForbiddenError('Only an owner or group manager can set instructions for a location')
  }

  if (params.branchId) {
    const branch = await prisma.branch.findFirst({
      where: { id: params.branchId, restaurantId: params.restaurantId, deletedAt: null },
      select: { id: true, name: true },
    })
    if (!branch) throw new NotFoundError('Location')
  }

  const assignee = params.assigneeId
    ? await resolveAssignee({
        restaurantId: params.restaurantId,
        user: params.user,
        assigneeId: params.assigneeId,
      })
    : null

  const instruction = await prisma.branchInstruction.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      assigneeId: assignee?.id ?? null,
      assigneeName: assignee?.name ?? null,
      title: params.title,
      body: params.body,
      priority: params.priority,
      dueAt: params.dueAt,
      createdById: params.user.id,
      createdByName: params.user.name,
    },
    include: {
      branch: { select: { id: true, name: true } },
      assignee: { select: { id: true, name: true, branch: { select: { name: true } } } },
    },
  })

  const urgent = params.priority === 'URGENT'
  const title = urgent ? `Urgent: ${params.title}` : params.title

  if (assignee) {
    /*
     * Addressed to one person, so it goes to that person and to nobody else.
     * Sending it to the location as well would put "you have been asked to do
     * this" in front of everybody at the site, which is both noise and, for a
     * task about somebody's own till, none of their colleagues' business.
     */
    await notify({
      restaurantId: params.restaurantId,
      userId: assignee.id,
      branchId: params.branchId,
      type: 'SYSTEM',
      title,
      body: `${params.user.name} assigned this to you.`,
      data: { instructionId: instruction.id, href: '/dashboard/tasks' },
    })
  } else {
    await notifyLocation({
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      title,
      body: `${params.user.name} left an instruction${instruction.branch ? ` for ${instruction.branch.name}` : ''}.`,
      data: { instructionId: instruction.id, href: '/dashboard/tasks' },
    })
  }

  return instruction
}

export async function completeInstruction(params: {
  restaurantId: string
  user: { id: string; name: string; role: UserRole; branchId?: string | null }
  instructionId: string
  note: string | null
}) {
  const instruction = await readVisible(params)

  if (instruction.status !== 'OPEN') {
    // Not an error worth shouting about — two people ticked the same box.
    return instruction
  }

  return prisma.branchInstruction.update({
    where: { id: instruction.id },
    data: {
      status: 'DONE',
      doneById: params.user.id,
      doneByName: params.user.name,
      doneAt: new Date(),
      doneNote: params.note,
    },
    include: { branch: { select: { id: true, name: true } } },
  })
}

/** Withdrawing an instruction. Only the people who may write one may cancel one. */
export async function cancelInstruction(params: {
  restaurantId: string
  user: { id: string; name: string; role: UserRole; branchId?: string | null }
  instructionId: string
}) {
  if (visibleBranchIds(params.user) !== null) {
    throw new ForbiddenError('Only an owner or group manager can withdraw an instruction')
  }

  const instruction = await readVisible(params)

  return prisma.branchInstruction.update({
    where: { id: instruction.id },
    data: { status: 'CANCELLED' },
    include: { branch: { select: { id: true, name: true } } },
  })
}

/** Reads one, refusing anything outside what this person may see. */
async function readVisible(params: {
  restaurantId: string
  user: InstructionScope
  instructionId: string
}) {
  const instruction = await prisma.branchInstruction.findFirst({
    where: { id: params.instructionId, restaurantId: params.restaurantId },
    include: { branch: { select: { id: true, name: true } } },
  })
  if (!instruction) throw new NotFoundError('Instruction')

  const allowed = visibleBranchIds(params.user)
  const maySee =
    allowed === null || instruction.branchId === null || allowed.includes(instruction.branchId)

  if (!maySee) throw new ForbiddenError('That instruction is for another location')

  return instruction
}

/**
 * Tell the people who work at a location that something has happened there.
 *
 * Notifications carry a user or an audience, never a branch, so this resolves
 * the location to the people standing in it and notifies each of them. A null
 * branch means the whole group, which is the MANAGEMENT audience.
 */
export async function notifyLocation(params: {
  restaurantId: string
  branchId: string | null
  title: string
  body: string
  data?: Record<string, unknown>
}) {
  if (!params.branchId) {
    await notify({
      restaurantId: params.restaurantId,
      audience: 'MANAGEMENT',
      type: 'SYSTEM',
      title: params.title,
      body: params.body,
      data: params.data,
    })
    return
  }

  const staff = await prisma.user.findMany({
    where: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      deletedAt: null,
      isActive: true,
      role: { in: ['MANAGER', 'ADMIN'] },
    },
    select: { id: true },
  })

  /*
   * Nobody assigned to that location yet. Fall back to management rather than
   * dropping the message on the floor — a new branch with no manager is exactly
   * when the owner most needs to be told their instruction went nowhere.
   */
  if (staff.length === 0) {
    await notify({
      restaurantId: params.restaurantId,
      audience: 'MANAGEMENT',
      type: 'SYSTEM',
      title: params.title,
      body: `${params.body} (nobody is assigned to that location yet)`,
      data: params.data,
    })
    return
  }

  await Promise.all(
    staff.map((person) =>
      notify({
        restaurantId: params.restaurantId,
        userId: person.id,
        type: 'SYSTEM',
        title: params.title,
        body: params.body,
        data: params.data,
      }),
    ),
  )
}
