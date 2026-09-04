import 'server-only'

import type { Prisma } from '@prisma/client'

import { prisma, type TxClient } from '@/server/db/prisma'
import type { EventName } from '@/lib/realtime/events'

/**
 * The transactional outbox (production.md §5).
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * `realtime.orderCreated(...)` and its siblings are called after the
 * transaction commits, and on Netlify they are no-ops because there is no
 * Socket.IO server attached. An event therefore had no durable existence: if
 * it was not delivered in the instant it was raised, it was gone. Nothing
 * could say afterwards what had happened, and nothing could replay it.
 *
 * `emitOutbox` writes the event as a row inside the SAME transaction as the
 * order, payment or movement it describes. They commit together or roll back
 * together. An event cannot describe something that did not happen; something
 * that happened cannot lack its event. That is what "realtime failure must not
 * lose an order" actually requires.
 *
 * ── Why the pulse token stays ───────────────────────────────────────────────
 *
 * The obvious next step — let clients rely solely on `seq > lastSeen` — would
 * be wrong, and subtly. Postgres assigns a sequence number at INSERT and makes
 * the row visible at COMMIT, so a slow transaction can commit seq 10 after a
 * fast one already published seq 11. A reader that advanced its cursor past 11
 * would never see 10.
 *
 * Rather than paper over that with a lag window or a visibility flag, the two
 * mechanisms are kept and each does the job it is actually good at:
 *
 *   • the pulse token, derived from MAX(updatedAt), cannot MISS a change — but
 *     it is opaque and cannot say what changed;
 *   • the outbox names what changed and gives each event a stable id to dedup
 *     on — but its cursor can skip.
 *
 * So a skipped event still causes a refresh via the token, and a duplicated
 * event is applied once thanks to the id. Neither alone is sufficient; together
 * they are, and that is why both exist.
 */

export interface OutboxEmit {
  restaurantId: string
  /** Null for restaurant-wide events (a menu change); set it whenever known. */
  branchId?: string | null
  type: EventName | string
  entity: 'Order' | 'Payment' | 'Refund' | 'StockMovement' | 'Table' | 'Menu' | string
  entityId?: string | null
  /**
   * Just enough for a screen to decide whether it cares — an order number, an
   * amount, a status. Never the whole record: this table is read by pollers on
   * every screen and has to stay cheap.
   */
  payload?: Prisma.InputJsonValue | null
}

/**
 * Record an event in the same transaction as the change it describes.
 *
 * Takes a `TxClient` and not the full client, deliberately: an outbox row
 * written outside the transaction is exactly the fire-and-forget emission this
 * replaces, and would reintroduce the failure — an event for an order that
 * then rolled back. The branded `TxClient` type makes passing `prisma` here a
 * compile error.
 */
export async function emitOutbox(tx: TxClient, event: OutboxEmit): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      restaurantId: event.restaurantId,
      branchId: event.branchId ?? null,
      type: event.type,
      entity: event.entity,
      entityId: event.entityId ?? null,
      payload: event.payload ?? undefined,
    },
  })
}

/** One event as a client sees it. */
export interface OutboxRead {
  id: string
  seq: string
  type: string
  entity: string
  entityId: string | null
  branchId: string | null
  at: string
  payload: unknown
}

/** How many events one poll may return before the client should just refresh. */
const PAGE = 50

/**
 * Read events after a cursor, for one restaurant and optionally one branch.
 *
 * `branchId` narrows to that branch PLUS the restaurant-wide events (branchId
 * null) — a menu change matters to every branch's till, and dropping those
 * would leave a screen believing nothing had happened.
 */
export async function readOutbox(params: {
  restaurantId: string
  branchId?: string | null
  since?: bigint | null
}): Promise<{ events: OutboxRead[]; seq: string | null; truncated: boolean }> {
  const rows = await prisma.outboxEvent.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.since != null ? { seq: { gt: params.since } } : {}),
      ...(params.branchId
        ? { OR: [{ branchId: params.branchId }, { branchId: null }] }
        : {}),
    },
    orderBy: { seq: 'asc' },
    // One more than the page, so "is there more" costs nothing extra.
    take: PAGE + 1,
  })

  const truncated = rows.length > PAGE
  const page = truncated ? rows.slice(0, PAGE) : rows

  return {
    events: page.map((row) => ({
      id: row.id,
      seq: row.seq.toString(),
      type: row.type,
      entity: row.entity,
      entityId: row.entityId,
      branchId: row.branchId,
      at: row.createdAt.toISOString(),
      payload: row.payload,
    })),
    seq: page.length > 0 ? page[page.length - 1].seq.toString() : null,
    truncated,
  }
}

/** The newest sequence number a restaurant has, for a client starting fresh. */
export async function latestOutboxSeq(restaurantId: string): Promise<string | null> {
  const row = await prisma.outboxEvent.findFirst({
    where: { restaurantId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  return row ? row.seq.toString() : null
}

/**
 * How far behind the outbox is running, in seconds.
 *
 * Reported on `/api/health` and the platform Realtime page. This is a delivery
 * log rather than a queue with workers, so "lag" here means the age of the
 * newest event: a busy restaurant whose newest event is an hour old is a
 * restaurant whose screens have been told nothing for an hour, which is worth
 * seeing. Null when there are no events at all.
 */
export async function outboxAgeSeconds(restaurantId?: string): Promise<number | null> {
  const row = await prisma.outboxEvent.findFirst({
    where: restaurantId ? { restaurantId } : {},
    orderBy: { seq: 'desc' },
    select: { createdAt: true },
  })
  if (!row) return null
  return Math.round((Date.now() - row.createdAt.getTime()) / 1000)
}

/**
 * Delete events older than `days`.
 *
 * Run by the `outbox-trim` background job. Safe by construction: the order, the
 * payment and the movement are the durable facts and live in their own tables
 * for ever. This is the delivery log, and a client that has been offline for a
 * week gets a full refresh rather than a week of replay.
 */
export async function trimOutbox(days = 7): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000)
  const { count } = await prisma.outboxEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  })
  return count
}
