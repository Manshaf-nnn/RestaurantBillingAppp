import 'server-only'

import { prisma } from '@/server/db/prisma'
import { outboxAgeSeconds } from '@/server/realtime/outbox'
import { isRedisEnabled } from '@/server/cache/redis'
import { isRealtimeReady } from '@/server/realtime/emitter'

/**
 * What the platform operator can see (production.md §8–§13).
 *
 * ── The rule these all follow ───────────────────────────────────────────────
 *
 * Every function here reads ACROSS tenants, which is the whole point of a
 * platform console and also the reason each one is dangerous. They are safe
 * only because every caller is a page guarded by `requirePageSuperAdmin`, and
 * because nothing here takes a tenant id from a request: the operator sees
 * everything or nothing, never "whatever id was in the URL".
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 *
 * production.md §10 and §11 are explicit: never expose dangerous database
 * deletion controls, and do not provide arbitrary database editing through
 * Super Admin. So there is no query builder here, no "run SQL" box, no table
 * browser and no delete. Everything is a named, bounded question with a fixed
 * shape. The most destructive thing the console can do is suspend a restaurant
 * or retry a failed job, and both are reversible.
 */

/** Rounded to whole percent; Postgres reports bytes and blocks, not percentages. */
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

const num = (value: bigint | number | null | undefined) => Number(value ?? 0)

// ── §9 Dashboard ────────────────────────────────────────────────────────────

export interface PlatformOverview {
  restaurants: { total: number; active: number; pending: number; suspended: number; trialing: number }
  users: { total: number; activeToday: number }
  ordersToday: number
  revenueToday: number
  criticalErrors: number
  failedJobs: number
  database: { status: 'ok' | 'error'; latencyMs: number; sizeBytes: number; connections: number }
  realtime: { socketsReady: boolean; outboxAgeSeconds: number | null; eventsLastHour: number }
  storage: { mediaCount: number; mediaBytes: number }
  redis: boolean
}

/**
 * Everything the §9 dashboard names, in one round trip's worth of queries.
 *
 * "Orders today" and "revenue today" are deliberately UTC-day figures and are
 * labelled as such on the page. A platform spanning timezones has no single
 * "today", and inventing one — the operator's own timezone, say — would give a
 * number that disagrees with every tenant's own dashboard. Better a figure
 * whose definition is stated than one that looks tenant-accurate and is not.
 */
export async function getPlatformOverview(): Promise<PlatformOverview> {
  const dayAgo = new Date(Date.now() - 86_400_000)
  const hourAgo = new Date(Date.now() - 3_600_000)

  const latencyStart = Date.now()
  let databaseOk = true
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    databaseOk = false
  }
  const latencyMs = Date.now() - latencyStart

  const [
    byStatus, trialing, userTotal, activeToday, ordersToday, revenueToday,
    criticalErrors, failedJobs, dbStats, eventsLastHour, media, outboxAge,
  ] = await Promise.all([
    prisma.restaurant.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.restaurant.count({ where: { plan: 'TRIAL', trialEndsAt: { gt: new Date() } } }),
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { deletedAt: null, lastLoginAt: { gte: dayAgo } } }),
    prisma.order.count({ where: { placedAt: { gte: dayAgo }, status: { not: 'CANCELLED' } } }),
    prisma.order.aggregate({
      where: { placedAt: { gte: dayAgo }, status: { not: 'CANCELLED' } },
      _sum: { grandTotal: true },
    }),
    prisma.errorLog.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.job.count({ where: { status: 'FAILED' } }).catch(() => 0),
    prisma.$queryRaw<Array<{ size: bigint; connections: bigint }>>`
      SELECT pg_database_size(current_database())::bigint AS size,
             (SELECT COUNT(*) FROM pg_stat_activity
               WHERE datname = current_database())::bigint AS connections
    `,
    prisma.outboxEvent.count({ where: { createdAt: { gte: hourAgo } } }),
    prisma.mediaAsset.aggregate({ _count: { _all: true }, _sum: { size: true } }).catch(() => null),
    outboxAgeSeconds(),
  ])

  const count = (status: string) =>
    byStatus.find((row) => row.status === status)?._count._all ?? 0

  return {
    restaurants: {
      total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
      active: count('ACTIVE'),
      pending: count('PENDING'),
      suspended: count('SUSPENDED'),
      trialing,
    },
    users: { total: userTotal, activeToday },
    ordersToday,
    revenueToday: revenueToday._sum.grandTotal ?? 0,
    criticalErrors,
    failedJobs,
    database: {
      status: databaseOk ? 'ok' : 'error',
      latencyMs,
      sizeBytes: num(dbStats[0]?.size),
      connections: num(dbStats[0]?.connections),
    },
    realtime: {
      socketsReady: isRealtimeReady(),
      outboxAgeSeconds: outboxAge,
      eventsLastHour,
    },
    storage: {
      mediaCount: media?._count._all ?? 0,
      mediaBytes: Number(media?._sum?.size ?? 0),
    },
    redis: isRedisEnabled(),
  }
}

// ── §11 Database health ─────────────────────────────────────────────────────

export interface DatabaseHealth {
  status: 'ok' | 'error'
  latencyMs: number
  sizeBytes: number
  connections: { total: number; active: number; idle: number; idleInTransaction: number; max: number }
  cacheHitPercent: number
  /** Postgres exposes no CPU percent to a client; this is the honest proxy. */
  work: { commits: number; rollbacks: number; blocksFromCache: number; blocksFromDisk: number }
  biggestTables: Array<{ name: string; bytes: number; rows: number }>
  slowest: Array<{ query: string; calls: number; meanMs: number; totalMs: number }>
  slowQueriesAvailable: boolean
  migrationsApplied: number
  stuckMigrations: string[]
}

export async function getDatabaseHealth(): Promise<DatabaseHealth> {
  const started = Date.now()
  let status: 'ok' | 'error' = 'ok'
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    status = 'error'
  }
  const latencyMs = Date.now() - started

  const [size, conn, maxConn, stats, tables, migrations] = await Promise.all([
    prisma.$queryRaw<Array<{ size: bigint }>>`
      SELECT pg_database_size(current_database())::bigint AS size
    `,
    prisma.$queryRaw<Array<{ total: bigint; active: bigint; idle: bigint; idle_tx: bigint }>>`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE state = 'active')::bigint AS active,
             COUNT(*) FILTER (WHERE state = 'idle')::bigint AS idle,
             COUNT(*) FILTER (WHERE state = 'idle in transaction')::bigint AS idle_tx
      FROM pg_stat_activity WHERE datname = current_database()
    `,
    prisma.$queryRaw<Array<{ setting: string }>>`
      SELECT setting FROM pg_settings WHERE name = 'max_connections'
    `,
    prisma.$queryRaw<Array<{
      commits: bigint; rollbacks: bigint; hit: bigint; read: bigint
    }>>`
      SELECT xact_commit AS commits, xact_rollback AS rollbacks,
             blks_hit AS hit, blks_read AS read
      FROM pg_stat_database WHERE datname = current_database()
    `,
    prisma.$queryRaw<Array<{ name: string; bytes: bigint; rows: bigint }>>`
      SELECT relname AS name,
             pg_total_relation_size(relid)::bigint AS bytes,
             n_live_tup::bigint AS rows
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 12
    `,
    prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
      SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
    `,
  ])

  /*
   * Slow queries need `pg_stat_statements`, which is an extension the database
   * owner has to enable — it is on by default on Neon, off on a stock local
   * Postgres. When it is missing the page says so and explains how to turn it
   * on, rather than showing an empty table that reads as "no slow queries".
   * An empty state that lies is worse than an absent one.
   */
  let slowest: DatabaseHealth['slowest'] = []
  let slowQueriesAvailable = true
  try {
    slowest = (
      await prisma.$queryRaw<Array<{ query: string; calls: bigint; mean_ms: number; total_ms: number }>>`
        SELECT query, calls, mean_exec_time AS mean_ms, total_exec_time AS total_ms
        FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_stat_statements%'
        ORDER BY mean_exec_time DESC
        LIMIT 10
      `
    ).map((row) => ({
      query: row.query.replace(/\s+/g, ' ').slice(0, 240),
      calls: num(row.calls),
      meanMs: Math.round(Number(row.mean_ms ?? 0)),
      totalMs: Math.round(Number(row.total_ms ?? 0)),
    }))
  } catch {
    slowQueriesAvailable = false
  }

  const hit = num(stats[0]?.hit)
  const read = num(stats[0]?.read)

  return {
    status,
    latencyMs,
    sizeBytes: num(size[0]?.size),
    connections: {
      total: num(conn[0]?.total),
      active: num(conn[0]?.active),
      idle: num(conn[0]?.idle),
      idleInTransaction: num(conn[0]?.idle_tx),
      max: Number(maxConn[0]?.setting ?? 0),
    },
    cacheHitPercent: pct(hit, hit + read),
    work: {
      commits: num(stats[0]?.commits),
      rollbacks: num(stats[0]?.rollbacks),
      blocksFromCache: hit,
      blocksFromDisk: read,
    },
    biggestTables: tables.map((t) => ({ name: t.name, bytes: num(t.bytes), rows: num(t.rows) })),
    slowest,
    slowQueriesAvailable,
    migrationsApplied: migrations.filter((m) => m.finished_at).length,
    stuckMigrations: migrations
      .filter((m) => !m.finished_at && !m.rolled_back_at)
      .map((m) => m.migration_name),
  }
}

// ── §12 Error centre ────────────────────────────────────────────────────────

export interface PlatformError {
  id: string
  createdAt: string
  severity: string
  kind: string
  route: string | null
  operation: string | null
  message: string
  requestId: string | null
  digest: string | null
  restaurantName: string | null
  branchName: string | null
  userName: string | null
  entity: string | null
  entityId: string | null
  resolvedAt: string | null
  stack: string | null
}

export async function listPlatformErrors(params: {
  severity?: string
  restaurantId?: string
  unresolvedOnly?: boolean
  take?: number
} = {}): Promise<PlatformError[]> {
  const rows = await prisma.errorLog.findMany({
    where: {
      ...(params.severity ? { severity: params.severity } : {}),
      ...(params.restaurantId ? { restaurantId: params.restaurantId } : {}),
      ...(params.unresolvedOnly ? { resolvedAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: params.take ?? 100,
    include: {
      restaurant: { select: { name: true } },
      branch: { select: { name: true } },
      user: { select: { name: true } },
    },
  })

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    severity: row.severity,
    kind: row.kind,
    route: row.route,
    operation: row.operation,
    message: row.message,
    requestId: row.requestId,
    digest: row.digest,
    restaurantName: row.restaurant?.name ?? null,
    branchName: row.branch?.name ?? null,
    userName: row.user?.name ?? null,
    entity: row.entity,
    entityId: row.entityId,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    stack: row.stack,
  }))
}

// ── §13 Background jobs ─────────────────────────────────────────────────────

export interface JobRow {
  id: string
  kind: string
  status: string
  attempts: number
  maxAttempts: number
  runAt: string
  startedAt: string | null
  finishedAt: string | null
  lastError: string | null
  restaurantName: string | null
}

export async function listJobs(params: { status?: string; take?: number } = {}) {
  const [counts, rows] = await Promise.all([
    prisma.job.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.job.findMany({
      where: params.status ? { status: params.status as never } : undefined,
      orderBy: [{ status: 'asc' }, { runAt: 'desc' }],
      take: params.take ?? 100,
      include: { restaurant: { select: { name: true } } },
    }),
  ])

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]))

  return {
    counts: {
      QUEUED: byStatus.QUEUED ?? 0,
      RUNNING: byStatus.RUNNING ?? 0,
      DONE: byStatus.DONE ?? 0,
      FAILED: byStatus.FAILED ?? 0,
    },
    jobs: rows.map((row): JobRow => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      runAt: row.runAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      lastError: row.lastError,
      restaurantName: row.restaurant?.name ?? null,
    })),
  }
}

// ── Branches, users, audit ──────────────────────────────────────────────────

export async function listPlatformBranches() {
  const rows = await prisma.branch.findMany({
    orderBy: [{ restaurant: { name: 'asc' } }, { name: 'asc' }],
    take: 500,
    include: {
      restaurant: { select: { name: true, slug: true, status: true } },
      _count: { select: { orders: true, users: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    type: row.type as string,
    isDefault: row.isDefault,
    isActive: row.isActive,
    restaurantName: row.restaurant.name,
    restaurantSlug: row.restaurant.slug,
    restaurantStatus: row.restaurant.status as string,
    orders: row._count.orders,
    users: row._count.users,
  }))
}

export async function listPlatformUsers(params: { query?: string; take?: number } = {}) {
  const rows = await prisma.user.findMany({
    where: {
      deletedAt: null,
      ...(params.query
        ? {
            OR: [
              { name: { contains: params.query, mode: 'insensitive' as const } },
              { email: { contains: params.query, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: params.take ?? 200,
    include: {
      restaurant: { select: { name: true } },
      branch: { select: { name: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as string,
    isActive: row.isActive,
    mfaEnabled: row.mfaEnabledAt !== null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    restaurantName: row.restaurant?.name ?? null,
    branchName: row.branch?.name ?? null,
  }))
}

export async function listPlatformAudit(params: { take?: number; restaurantId?: string } = {}) {
  const rows = await prisma.auditLog.findMany({
    where: params.restaurantId ? { restaurantId: params.restaurantId } : undefined,
    orderBy: { createdAt: 'desc' },
    take: params.take ?? 200,
    include: {
      restaurant: { select: { name: true } },
      branch: { select: { name: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    actorName: row.actorName,
    ipAddress: row.ipAddress,
    restaurantName: row.restaurant?.name ?? null,
    branchName: row.branch?.name ?? null,
  }))
}

// ── §14 Security ────────────────────────────────────────────────────────────

export async function getSecurityOverview() {
  const dayAgo = new Date(Date.now() - 86_400_000)

  const [rateLimited, failedLogins, privileged, mfaOn, sessions, staleSessions] = await Promise.all([
    prisma.rateLimitCounter.findMany({
      where: { windowStart: { gte: dayAgo } },
      orderBy: { count: 'desc' },
      take: 20,
    }),
    prisma.auditLog.count({
      where: { action: { contains: 'login' }, createdAt: { gte: dayAgo } },
    }),
    prisma.user.count({
      where: { deletedAt: null, role: { in: ['SUPER_ADMIN', 'OWNER', 'ADMIN'] } },
    }),
    prisma.user.count({
      where: {
        deletedAt: null,
        role: { in: ['SUPER_ADMIN', 'OWNER', 'ADMIN'] },
        mfaEnabledAt: { not: null },
      },
    }),
    prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.session.count({ where: { revokedAt: null, expiresAt: { lte: new Date() } } }),
  ])

  return {
    rateLimited: rateLimited.map((row) => ({
      key: row.key,
      count: row.count,
      windowStart: row.windowStart.toISOString(),
    })),
    loginEvents: failedLogins,
    privilegedAccounts: privileged,
    privilegedWithMfa: mfaOn,
    mfaCoveragePercent: pct(mfaOn, privileged),
    activeSessions: sessions,
    expiredSessionsNotCleared: staleSessions,
  }
}
