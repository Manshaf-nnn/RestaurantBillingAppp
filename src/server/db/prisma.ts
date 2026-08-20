import { PrismaClient, Prisma } from '@prisma/client'

/**
 * Singleton Prisma client. In development Next.js hot-reloads modules, which
 * would otherwise open a new connection pool on every edit.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/**
 * Tune the connection string for serverless Postgres (Neon behind Netlify).
 *
 * Every serverless invocation is its own short-lived process, so the defaults —
 * which assume one long-running server owning a pool of connections — are the
 * wrong shape and are the usual reason a dashboard feels slow:
 *
 *  - `connection_limit=5`: small, because each invocation keeps its own pool, but
 *    NOT 1. A single request needs more than one connection whenever it runs
 *    queries in parallel or opens an interactive transaction while other work is
 *    in flight, and a warm instance can be handling several requests at once.
 *    At 1 the second caller waits for the first to finish; Prisma only waits
 *    `maxWait` (2s by default) before giving up with P2028, which surfaces to a
 *    guest as "Something went wrong". Measured: at limit 1, five of eight
 *    concurrent order placements failed; at 5, none did.
 *  - `pgbouncer=true`: Neon's pooled endpoint runs PgBouncer in transaction
 *    mode, which cannot hold Prisma's prepared statements between statements.
 *    Without this flag you eventually get "prepared statement s0 already
 *    exists" errors under concurrency.
 *  - `connect_timeout`: fail fast and retry instead of hanging a page render on
 *    a cold database.
 *
 * Anything not recognised as Neon (a local Postgres in development, a VPS) is
 * left exactly as configured.
 */
function resolveDatabaseUrl(): string | undefined {
  return buildConnectionUrl(process.env.DATABASE_URL)
}

/**
 * Exported so the connection string can be asserted directly in a test. The
 * Neon-specific branch below never runs against a local database, so without a
 * test that calls this with a Neon-shaped URL it is entirely unexercised — and
 * a change there once took production down while every test passed.
 */
export function buildConnectionUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }

  if (!url.hostname.includes('neon.tech')) return raw

  if (!url.hostname.includes('-pooler') && process.env.NODE_ENV === 'production') {
    // Not fatal, but it costs a full TCP + TLS handshake on every cold request.
    console.warn(
      '[db] DATABASE_URL points at a direct Neon endpoint. Use the *pooled* ' +
        'connection string (the host containing "-pooler") for serverless hosting.',
    )
  }

  const params = url.searchParams
  const pooled = url.hostname.includes('-pooler')

  /*
   * Connection limit.
   *
   * A back-office page fans out: the inventory report alone issues five
   * queries in parallel and several of those issue more. With a limit of 5 the
   * sixth waited on the pool, and since the pool timeout was longer than the
   * serverless function timeout the request died before the query ever ran —
   * which surfaced as "a server-side exception has occurred" on exactly the
   * data-heavy pages while simple ones were fine.
   *
   * Behind PgBouncer a higher client limit is cheap: the pooler multiplexes
   * onto far fewer real Postgres connections, which is the entire point of it.
   * Direct connections stay conservative because there the limit is per
   * instance against a real server.
   */
  if (!params.has('connection_limit')) {
    params.set('connection_limit', process.env.DB_CONNECTION_LIMIT ?? (pooled ? '15' : '5'))
  }
  /*
   * Every timeout here must be comfortably shorter than the serverless function
   * timeout, which on Netlify is 10 seconds by default.
   *
   * connect_timeout was 10 — exactly the function budget. A slow connect
   * therefore consumed the whole invocation and the caller saw nothing at all:
   * a server action that never responded and a button stuck on "Adding…".
   * Failing at 5 leaves the request time to return a real error instead.
   */
  if (!params.has('pool_timeout')) params.set('pool_timeout', '5')
  if (!params.has('connect_timeout')) params.set('connect_timeout', '5')
  if (pooled && !params.has('pgbouncer')) params.set('pgbouncer', 'true')
  /*
   * Statement and lock timeouts are NOT set here.
   *
   * They were, briefly, as `options=-c lock_timeout=...` on the connection
   * string — and that took the whole site down. PgBouncer rejects unknown
   * startup parameters, and because this block only runs for neon.tech hosts
   * the local test suite never exercised it: every test passed against
   * localhost while production could not open a single connection.
   *
   * The timeouts still matter, so they are applied with `SET LOCAL` inside the
   * transactions that actually take locks. `SET LOCAL` is plain SQL over an
   * established connection, scoped to the transaction, and reverts on commit —
   * so it works behind a pooler and cannot leak into another tenant's session.
   */
  if (!params.has('sslmode')) params.set('sslmode', 'require')

  return url.toString()
}

const databaseUrl = resolveDatabaseUrl()

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    /*
     * An interactive transaction that cannot get a connection used to wait
     * longer than the request that opened it, so the work was abandoned
     * mid-flight and the client hung. These bounds make a contended
     * transaction fail loudly and quickly instead.
     */
    transactionOptions: { maxWait: 4_000, timeout: 8_000 },
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
    log:
      process.env.NODE_ENV === 'development'
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export { Prisma }
export type { PrismaClient }

/** Prisma transaction client — accepted anywhere a repository takes a `tx`. */
export type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

export type DbClient = PrismaClient | TxClient

/** Narrow a Prisma error to its known-request form. */
export function isPrismaError(
  error: unknown,
  code?: string,
): error is Prisma.PrismaClientKnownRequestError {
  const isKnown = error instanceof Prisma.PrismaClientKnownRequestError
  return code ? isKnown && (error as Prisma.PrismaClientKnownRequestError).code === code : isKnown
}

/** True when the error is a unique-constraint violation. */
export const isUniqueViolation = (error: unknown) => isPrismaError(error, 'P2002')

/** Fields involved in a unique-constraint violation, if any. */
export function uniqueViolationTargets(error: unknown): string[] {
  if (!isPrismaError(error, 'P2002')) return []
  const target = error.meta?.target
  if (Array.isArray(target)) return target as string[]
  return typeof target === 'string' ? [target] : []
}


/**
 * Bound how long a transaction may wait on a lock, and how long any single
 * statement may run.
 *
 * `SET LOCAL` is scoped to the current transaction and reverts on commit, so it
 * is safe behind a connection pooler and cannot leak into another request's
 * session. Called at the top of every transaction that takes a row lock, so a
 * contended lock fails with a clear database error instead of hanging until
 * the serverless function is killed with nothing returned to the caller.
 */
export async function guardLocks(tx: TxClient): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'")
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '9s'")
}
