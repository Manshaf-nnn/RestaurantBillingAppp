/**
 * Server-side error capture.
 *
 * Next calls `onRequestError` with the *unredacted* error and the same digest it
 * shows the browser. That pairing is the whole point: in production the browser
 * is given a hash and nothing else — correctly, since an unfiltered error names
 * tables, columns and file paths to anyone who can load the page — but it leaves
 * whoever has to fix it holding a number.
 *
 * Reference 2116762008 cost four rounds of work for exactly that reason. It was
 * "Functions cannot be passed directly to Client Components", thrown while React
 * encoded the tree on five report pages. Nothing could see it: `next build`
 * passed because those pages are force-dynamic, and the loader health check
 * passed because the queries were fine. Had this file existed, the first failure
 * would have named itself.
 *
 * Kept in memory rather than a table. Errors are frequent enough that writing
 * them would add database load exactly when the database may be the problem,
 * and a serverless instance is short-lived enough that the recent past is what
 * matters. Read it through /api/health/errors.
 */

export interface CapturedError {
  at: string
  digest: string | null
  route: string | null
  kind: string
  message: string
  stack: string | null
  /** Whose request failed, from the session cookie. Null for anonymous pages. */
  restaurantId: string | null
}

const LIMIT = 20

/*
 * Hung off globalThis, not a module const. In dev, and across route bundles in
 * production, the same module can be evaluated more than once; a plain const
 * would give the writer and the reader separate arrays and the endpoint would
 * always look empty.
 */
const store = globalThis as typeof globalThis & { __recentErrors?: CapturedError[] }
store.__recentErrors ??= []

export function recentErrors(): CapturedError[] {
  return [...(store.__recentErrors ?? [])].reverse()
}

export function register() {
  // Required by Next's instrumentation contract; nothing to set up.
}

export async function onRequestError(
  error: unknown,
  request: { path?: string; headers?: Record<string, string | string[] | undefined> },
  context: { routePath?: string },
) {
  /*
   * Whose error this is. A stack trace names tables, columns and file paths,
   * so the row must carry a tenant for /api/health/errors to scope by —
   * without it, every owner reading a reference code was reading every other
   * restaurant's failures too. The session cookie is verified, not merely
   * decoded, so a forged cookie cannot file its errors under someone else.
   * Anonymous surfaces (login, the QR menu before a session) stay null and
   * are visible to nobody through the endpoint.
   */
  let restaurantId: string | null = null
  try {
    const rawCookie = request?.headers?.cookie
    const cookieHeader = Array.isArray(rawCookie) ? rawCookie.join('; ') : rawCookie
    const token = cookieHeader
      ?.split(/;\s*/)
      .find((part) => part.startsWith('ros_at='))
      ?.slice('ros_at='.length)
    if (token) {
      const { verifyAccessToken } = await import('@/server/auth/jwt')
      const claims = await verifyAccessToken(decodeURIComponent(token))
      restaurantId = (claims?.rid as string | undefined) ?? null
    }
  } catch {
    // Attribution is best-effort; the capture below must still happen.
  }

  let captured: CapturedError | null = null
  try {
    const err = error as { message?: string; stack?: string; digest?: string; name?: string }
    captured = {
      at: new Date().toISOString(),
      // The digest is what the browser shows, so it is the join key between the
      // reference code someone reads out and the cause recorded here.
      digest: typeof err?.digest === 'string' ? err.digest : null,
      route: request?.path ?? context?.routePath ?? null,
      kind: err?.name ?? typeof error,
      message: err?.message ?? String(error),
      stack: err?.stack ?? null,
      restaurantId,
    }
    store.__recentErrors ??= []
    store.__recentErrors.push(captured)
    if (store.__recentErrors.length > LIMIT) store.__recentErrors.shift()
  } catch {
    // Diagnostics must never be able to fail a request.
  }

  /*
   * Also persist it.
   *
   * The in-memory list above is per-instance, and serverless instances are
   * short-lived — so the instance that failed is usually not the one answering
   * /api/health/errors, and the endpoint reads empty exactly when someone needs
   * it. Writing the row is what makes a reference code answerable minutes later.
   *
   * Imported lazily so Prisma is never pulled into a runtime that cannot take
   * it, and swallowed entirely: this runs while something is already going
   * wrong, quite possibly the database itself, and a failed log write must not
   * become a second error on top of the first.
   */
  if (!captured) return
  try {
    const { prisma } = await import('@/server/db/prisma')
    await prisma.errorLog.create({
      data: {
        restaurantId: captured.restaurantId,
        digest: captured.digest,
        route: captured.route,
        kind: captured.kind,
        message: captured.message.slice(0, 4_000),
        stack: captured.stack?.slice(0, 8_000) ?? null,
      },
    })

    // Keep the table small without a scheduled job: trim occasionally rather
    // than on every write, since this is already the unhappy path.
    if (Math.abs(captured.at.charCodeAt(captured.at.length - 1)) % 10 === 0) {
      await prisma.$executeRaw`
        DELETE FROM error_logs
        WHERE id IN (
          SELECT id FROM error_logs ORDER BY "createdAt" DESC OFFSET 200
        )
      `
    }
  } catch {
    // Already reported in memory; nothing further to do.
  }
}
