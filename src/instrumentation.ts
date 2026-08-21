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
  request: { path?: string },
  context: { routePath?: string },
) {
  try {
    const err = error as { message?: string; stack?: string; digest?: string; name?: string }
    store.__recentErrors ??= []
    store.__recentErrors.push({
      at: new Date().toISOString(),
      // The digest is what the browser shows, so it is the join key between the
      // reference code someone reads out and the cause recorded here.
      digest: typeof err?.digest === 'string' ? err.digest : null,
      route: request?.path ?? context?.routePath ?? null,
      kind: err?.name ?? typeof error,
      message: err?.message ?? String(error),
      stack: err?.stack ?? null,
    })
    if (store.__recentErrors.length > LIMIT) store.__recentErrors.shift()
  } catch {
    // Diagnostics must never be able to fail a request.
  }
}
