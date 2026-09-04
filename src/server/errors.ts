import 'server-only'

import { randomUUID } from 'node:crypto'

import { prisma } from '@/server/db/prisma'

/**
 * Where errors go (production.md §7, §12).
 *
 * ── What was missing ────────────────────────────────────────────────────────
 *
 * `ErrorLog` existed, and almost nothing reached it. The only writer was
 * `src/instrumentation.ts`, hooked into Next's `onRequestError`, which sees
 * exceptions that escape a route or a render. Server Actions — which is how
 * every mutation in this application happens — were handled by `runAction`,
 * which caught the error, turned it into a friendly `{ok:false}` for the user
 * and `console.error`'d the rest. On a serverless host that console line goes
 * to a log nobody keeps.
 *
 * So the failures an operator most needed to see were precisely the ones that
 * were never recorded: the settle that would not go through, the receipt that
 * refused, the count that could not be approved.
 *
 * ── Request ids ─────────────────────────────────────────────────────────────
 *
 * §7 asks that every important error carry one. There was none anywhere. A
 * request id is what turns "it broke around half two" into one lookup, and what
 * ties a user's screenshot to a row in this table.
 *
 * ── The one rule about content ──────────────────────────────────────────────
 *
 * Never log secrets or payment details (§7). Nothing here writes a payload:
 * the message, the operation and the ids of the records involved, and that is
 * all. If a caller wants to add context it goes through `redact()` first, the
 * same filter the audit trail uses.
 */

export type Severity = 'CRITICAL' | 'ERROR' | 'WARNING'

export interface CaptureInput {
  message: string
  kind: string
  severity?: Severity
  /** The named operation — 'collectPayment', 'receiveGoods'. */
  operation?: string | null
  requestId?: string | null
  route?: string | null
  digest?: string | null
  stack?: string | null
  restaurantId?: string | null
  branchId?: string | null
  userId?: string | null
  entity?: string | null
  entityId?: string | null
}

/** A new correlation id for one request. */
export function newRequestId(): string {
  return randomUUID()
}

/**
 * Record an error, and never make things worse by trying.
 *
 * Swallows its own failures exactly as `audit()` does: an error captured while
 * handling an error must not replace the original, and a database that has
 * stopped accepting writes is the moment this is most likely to be called and
 * least likely to work.
 */
export async function captureError(input: CaptureInput): Promise<void> {
  try {
    /*
     * The foreign keys are ON DELETE CASCADE / SET NULL, so a stale id would
     * throw and lose the error entirely. Anything that no longer exists is
     * dropped to null rather than being allowed to sink the capture — the
     * message is what matters and it survives either way.
     */
    const [restaurant, branch, user] = await Promise.all([
      input.restaurantId
        ? prisma.restaurant.findUnique({ where: { id: input.restaurantId }, select: { id: true } })
        : null,
      input.branchId
        ? prisma.branch.findUnique({ where: { id: input.branchId }, select: { id: true } })
        : null,
      input.userId
        ? prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } })
        : null,
    ])

    await prisma.errorLog.create({
      data: {
        message: input.message.slice(0, 4_000),
        kind: input.kind,
        severity: input.severity ?? 'ERROR',
        operation: input.operation ?? null,
        requestId: input.requestId ?? null,
        route: input.route ?? null,
        digest: input.digest ?? null,
        stack: input.stack?.slice(0, 8_000) ?? null,
        restaurantId: restaurant?.id ?? null,
        branchId: branch?.id ?? null,
        userId: user?.id ?? null,
        entity: input.entity ?? null,
        entityId: input.entityId ?? null,
      },
    })
  } catch (error) {
    console.error('[errors] capture failed', error)
  }
}

/**
 * Mark an error dealt with (§12: "allow safe investigation and resolution").
 *
 * Resolution is an annotation, never a deletion: what went wrong and what was
 * done about it are both worth keeping, and a centre where inconvenient rows
 * can be removed is a centre that reports what its operator wants to see.
 */
export async function resolveError(params: {
  id: string
  userId: string
  resolution: string
}): Promise<void> {
  await prisma.errorLog.update({
    where: { id: params.id },
    data: {
      resolvedAt: new Date(),
      resolvedById: params.userId,
      resolution: params.resolution.slice(0, 1_000),
    },
  })
}

/**
 * Should this error wake somebody up?
 *
 * Deliberately narrow. An alert for everything is an alert for nothing, and the
 * fastest way to make an operator ignore this channel is to send them a
 * validation failure at 3am. Only CRITICAL — integrity findings, exhausted
 * jobs — qualifies, and only once per digest per hour, so one broken thing
 * failing repeatedly sends one message rather than a hundred.
 */
export async function shouldAlert(input: {
  severity: Severity
  digest?: string | null
  kind: string
}): Promise<boolean> {
  if (input.severity !== 'CRITICAL') return false

  const key = input.digest ?? input.kind
  const hourAgo = new Date(Date.now() - 3_600_000)
  const recent = await prisma.errorLog.count({
    where: {
      severity: 'CRITICAL',
      createdAt: { gte: hourAgo },
      ...(input.digest ? { digest: input.digest } : { kind: input.kind }),
    },
  })
  // The row for this error is already written, so 1 means "the first one".
  return recent <= 1 && Boolean(key)
}
