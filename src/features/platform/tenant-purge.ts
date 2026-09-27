import { prisma } from '@/server/db/prisma'
import { AppError, NotFoundError } from '@/lib/errors'
import type { TxClient } from '@/server/db/prisma'

/**
 * Enough of a client to read the schema and delete by it.
 *
 * Both the plain client and a transaction client satisfy this. Typing the
 * helpers as `TxClient` would exclude the plain one, and the plan runs
 * outside a transaction on purpose: counting what a purge WOULD remove
 * should not hold locks on eighty tables while somebody reads the answer.
 */
type Queryable = Pick<TxClient, '$queryRaw' | '$queryRawUnsafe'>

/**
 * Removing a tenant's data, deliberately and in the right order.
 *
 * ── Why this is not `DELETE FROM restaurants` ───────────────────────────────
 *
 * `20260917093000_append_only_guards` states that "removing a tenant's data on
 * request is a legitimate operation" and leaves DELETE unblocked so that it
 * stays possible. It is not possible. Forty-three foreign keys in this schema
 * are RESTRICT — mostly onto `branches` and `inventory_items`, the two things
 * every operational record hangs off — and Postgres has no obligation to
 * process a cascade in an order that satisfies them. The delete fails on
 * whichever RESTRICT it happens to reach first:
 *
 *   DELETE FROM restaurants WHERE id = '…'
 *   → ERROR: update or delete on table "inventory_items" violates foreign key
 *     constraint "stock_transfer_lines_itemId_fkey"
 *
 * The tempting repair is to convert those keys to CASCADE. That would be a
 * mistake. RESTRICT on a stock or money table is doing real work: it is what
 * stops a stray delete of one inventory item from silently taking the
 * purchase lines, receipt lines, transfer lines and production records that
 * reference it. Turning the whole schema into a cascade to make one rare
 * operation convenient trades a daily protection for an occasional
 * inconvenience.
 *
 * So the ordering lives here instead, computed rather than hand-written.
 *
 * ── How the order is worked out ─────────────────────────────────────────────
 *
 * The foreign-key graph is read from `pg_constraint` at run time and sorted so
 * that every table is deleted before anything it points at. Computing it
 * beats a hand-maintained list of 104 tables, which would be correct on the
 * day it was written and silently wrong after the next migration — and the
 * failure mode of a stale list is a purge that half-finishes.
 *
 * Tables reach the tenant two ways. Eighty carry `restaurantId` and are
 * narrowed directly. Two dozen more — order items, receipt lines, transfer
 * lines, sessions — carry no tenant of their own and are narrowed through a
 * parent that does.
 *
 * ── What makes it safe to run ───────────────────────────────────────────────
 *
 * It refuses unless the tenant has already been deactivated, so a purge is
 * always a second decision taken after a first one. It refuses unless the
 * caller repeats the slug back, so it cannot be triggered by a mis-click or a
 * stray id. It refuses while anything is still in flight — an open till, an
 * unfinished shift, a bill with money on it — because those are signs someone
 * is still using the account. It runs in one transaction, so a table nobody
 * accounted for aborts the whole thing rather than leaving a half-erased
 * tenant. And it writes what it did to the audit log of the PLATFORM, not the
 * tenant, because the tenant's own log is one of the things being removed.
 */

/** Tables that belong to the platform, never to a tenant. */
const GLOBAL_TABLES = new Set([
  '_prisma_migrations',
  'rate_limit_counters',
  'media_assets',
  'error_logs',
  'jobs',
  'outbox_events',
])

interface ForeignKey {
  child: string
  childColumn: string
  parent: string
}

/** How one table is narrowed to a tenant. */
type Reach =
  | { via: 'column' }
  | { via: 'parent'; column: string; parent: string }

export interface PurgePlan {
  restaurantId: string
  name: string
  slug: string
  /** Why this cannot be purged yet, if anything. */
  blockers: string[]
  /** Tables in the order they will be emptied, with what is in them now. */
  tables: Array<{ table: string; rows: number; reach: Reach }>
  totalRows: number
}

async function foreignKeys(tx: Queryable): Promise<ForeignKey[]> {
  return tx.$queryRaw<ForeignKey[]>`
    SELECT c.conrelid::regclass::text  AS child,
           a.attname                   AS "childColumn",
           c.confrelid::regclass::text AS parent
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f'
       AND c.connamespace = 'public'::regnamespace
  `
}

async function tablesWithRestaurantId(tx: Queryable): Promise<Set<string>> {
  const rows = await tx.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'restaurantId'
  `
  return new Set(rows.map((row) => row.table_name))
}

async function allTables(tx: Queryable): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `
  return rows.map((row) => row.table_name)
}

/**
 * Which tables hold this tenant's rows, and how each one is reached.
 *
 * Direct when the table carries `restaurantId`. Otherwise through a single
 * foreign key to a table that does — and where a child has several such keys
 * (an order item points at an order, a food AND a kitchen station) any one of
 * them narrows correctly, because they all lead into the same tenant. The
 * first is taken rather than OR-ing them, which keeps the delete a plain
 * indexed subquery.
 */
function reachMap(tables: string[], scoped: Set<string>, keys: ForeignKey[]): Map<string, Reach> {
  const reach = new Map<string, Reach>()
  for (const table of tables) {
    if (GLOBAL_TABLES.has(table)) continue
    if (scoped.has(table)) reach.set(table, { via: 'column' })
  }
  /*
   * Shallow links first.
   *
   * The first pass only attaches a child to a parent that carries
   * `restaurantId` itself, so the common case is one hop and one subquery.
   * Later passes allow a parent that is itself only reachable through ITS
   * parent — `production_consumption_lots` reaches the tenant through
   * `stock_batches`, for instance — and `tenantPredicate` below nests the
   * subqueries to match. Doing it the other way round produced a child
   * narrowed by a parent that has no `restaurantId` column, and a raw query
   * that failed with 42703.
   */
  for (let pass = 0; pass < 4; pass += 1) {
    for (const key of keys) {
      if (reach.has(key.child)) continue
      if (GLOBAL_TABLES.has(key.child)) continue
      if (key.child === key.parent) continue
      const parentReach = reach.get(key.parent)
      if (!parentReach) continue
      if (pass === 0 && parentReach.via !== 'column') continue
      reach.set(key.child, { via: 'parent', column: key.childColumn, parent: key.parent })
    }
  }
  return reach
}

/**
 * The WHERE clause that narrows one table to a tenant.
 *
 * Recursive, because a table can be two or three hops from anything carrying
 * `restaurantId`. `$1` is the restaurant id at every depth; the nesting is in
 * the subqueries, not in the parameters.
 */
function tenantPredicate(reach: Map<string, Reach>, table: string, depth = 0): string {
  const how = reach.get(table)
  if (!how) throw new AppError(`No way to narrow "${table}" to a tenant`, 500, 'PURGE_UNREACHABLE')
  if (how.via === 'column') return '"restaurantId" = $1'
  if (depth > 6) {
    throw new AppError(`Foreign-key chain from "${table}" is too deep to follow`, 500, 'PURGE_TOO_DEEP')
  }
  return `"${how.column}" IN (SELECT id FROM "${how.parent}" WHERE ${tenantPredicate(reach, how.parent, depth + 1)})`
}

/**
 * Children before parents.
 *
 * A depth-first walk over the foreign-key graph, emitting each table after
 * everything that points AT it. Self-references and cycles are skipped rather
 * than guessed at: a cycle would make a strict order impossible, and this
 * schema has none, so the honest thing is to notice rather than to invent an
 * order that might be wrong.
 */
function deletionOrder(tables: string[], keys: ForeignKey[]): string[] {
  const dependents = new Map<string, Set<string>>()
  for (const table of tables) dependents.set(table, new Set())
  for (const key of keys) {
    if (key.child === key.parent) continue
    if (!dependents.has(key.parent) || !dependents.has(key.child)) continue
    dependents.get(key.parent)!.add(key.child)
  }

  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (table: string) => {
    if (state.get(table) === 'done') return
    if (state.get(table) === 'visiting') return // a cycle; the outer table still lands after
    state.set(table, 'visiting')
    for (const child of dependents.get(table) ?? []) visit(child)
    state.set(table, 'done')
    order.push(table)
  }

  for (const table of tables) visit(table)
  return order
}

/** Anything still in flight says somebody is still using this account. */
async function blockersFor(restaurantId: string): Promise<string[]> {
  const [restaurant, openDrawers, openShifts, owing, pendingTransfers] = await Promise.all([
    prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { isActive: true, status: true },
    }),
    prisma.cashDrawerSession.count({ where: { restaurantId, status: 'OPEN' } }),
    prisma.staffShift.count({ where: { restaurantId, clockOutAt: null } }),
    prisma.order.count({
      where: { restaurantId, paymentStatus: { in: ['PARTIAL'] }, status: { not: 'CANCELLED' } },
    }),
    prisma.stockTransfer.count({
      where: { restaurantId, status: { in: ['REQUESTED', 'APPROVED', 'DISPATCHED', 'IN_TRANSIT'] } },
    }),
  ])

  const blockers: string[] = []
  if (!restaurant) blockers.push('There is no restaurant with that id.')
  else if (restaurant.isActive) {
    blockers.push(
      'The tenant is still active. Deactivate it first — a purge is a second decision, ' +
      'taken after the account has already been closed.',
    )
  }
  if (openDrawers > 0) blockers.push(`${openDrawers} cash drawer session(s) are still open.`)
  if (openShifts > 0) blockers.push(`${openShifts} staff shift(s) have not been ended.`)
  if (owing > 0) blockers.push(`${owing} bill(s) are part-paid — money has been taken and not settled.`)
  if (pendingTransfers > 0) blockers.push(`${pendingTransfers} stock transfer(s) are still in flight.`)
  return blockers
}

/** What a purge would remove, without removing anything. */
export async function planTenantPurge(restaurantId: string): Promise<PurgePlan> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, name: true, slug: true },
  })
  if (!restaurant) throw new NotFoundError('Restaurant')

  const keys = await foreignKeys(prisma)
  const scoped = await tablesWithRestaurantId(prisma)
  const tables = await allTables(prisma)
  const reach = reachMap(tables, scoped, keys)
  const order = deletionOrder(tables, keys).filter((table) => reach.has(table) && table !== 'restaurants')

  const counted: PurgePlan['tables'] = []
  let totalRows = 0
  for (const table of order) {
    const how = reach.get(table)!
    const rows = await countFor(prisma, table, reach, restaurantId)
    if (rows > 0) {
      counted.push({ table, rows, reach: how })
      totalRows += rows
    }
  }

  return {
    restaurantId,
    name: restaurant.name,
    slug: restaurant.slug,
    blockers: await blockersFor(restaurantId),
    tables: counted,
    totalRows,
  }
}

async function countFor(
  client: Queryable,
  table: string,
  reach: Map<string, Reach>,
  restaurantId: string,
): Promise<number> {
  const sql = `SELECT count(*)::int AS n FROM "${table}" WHERE ${tenantPredicate(reach, table)}`
  const rows = await client.$queryRawUnsafe<Array<{ n: number }>>(sql, restaurantId)
  return rows[0]?.n ?? 0
}

export interface PurgeResult {
  restaurantId: string
  slug: string
  deleted: Array<{ table: string; rows: number }>
  totalRows: number
}

/**
 * Remove every trace of one tenant.
 *
 * `confirmation` must equal the restaurant's slug. That is the whole
 * protection against an accidental call: an id can be pasted from the wrong
 * row, but typing the slug of the restaurant you mean to erase is a sentence
 * you have to mean.
 */
export async function purgeTenant(params: {
  restaurantId: string
  /** The restaurant's slug, typed back by the caller. */
  confirmation: string
  /** Who authorised it. Recorded on the platform's own audit trail. */
  actorId: string | null
  actorName: string | null
}): Promise<PurgeResult> {
  const plan = await planTenantPurge(params.restaurantId)

  if (params.confirmation !== plan.slug) {
    throw new AppError(
      `To purge "${plan.name}", repeat its slug back: ${plan.slug}`,
      400,
      'PURGE_NOT_CONFIRMED',
    )
  }
  if (plan.blockers.length > 0) {
    throw new AppError(
      `This tenant is not ready to be purged:\n  · ${plan.blockers.join('\n  · ')}`,
      409,
      'PURGE_BLOCKED',
    )
  }

  const deleted: PurgeResult['deleted'] = []

  await prisma.$transaction(
    async (tx) => {
      const keys = await foreignKeys(tx)
      const scoped = await tablesWithRestaurantId(tx)
      const tables = await allTables(tx)
      const reach = reachMap(tables, scoped, keys)
      const order = deletionOrder(tables, keys).filter(
        (table) => reach.has(table) && table !== 'restaurants',
      )

      for (const table of order) {
        const sql = `DELETE FROM "${table}" WHERE ${tenantPredicate(reach, table)}`
        const rows = await tx.$executeRawUnsafe(sql, params.restaurantId)
        if (rows > 0) deleted.push({ table, rows })
      }

      /*
       * Last. If anything above was missed, this fails on a foreign key and
       * takes the whole transaction with it — which is the outcome to want.
       * A purge that stops half-way leaves a tenant that is neither present
       * nor gone, and nobody would find out until a report tripped over it.
       */
      await tx.$executeRaw`DELETE FROM "restaurants" WHERE id = ${params.restaurantId}`
    },
    { timeout: 120_000, maxWait: 10_000 },
  )

  /*
   * Recorded AFTER the transaction and with no `restaurantId`, so it belongs
   * to the platform rather than to the tenant. Writing it inside would have
   * been neater and also self-defeating: the row would be deleted by the same
   * transaction that wrote it.
   */
  await prisma.auditLog.create({
    data: {
      restaurantId: null,
      userId: params.actorId,
      actorName: params.actorName,
      action: 'TENANT_PURGED',
      entity: 'Restaurant',
      entityId: params.restaurantId,
      before: { slug: plan.slug, name: plan.name, tables: plan.tables.length, rows: plan.totalRows },
    },
  })

  return {
    restaurantId: params.restaurantId,
    slug: plan.slug,
    deleted,
    totalRows: deleted.reduce((sum, row) => sum + row.rows, 0),
  }
}
