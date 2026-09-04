import { z } from 'zod'

import { AppError, ValidationError, toAppError } from './errors'

/**
 * Uniform result shape returned by every server action.
 * Forms consume it directly — there is no throwing across the RSC boundary.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; code: string; fieldErrors?: Record<string, string[]> }

export function actionOk<T>(data: T, message?: string): ActionResult<T> {
  return { ok: true, data, message }
}

export function actionFail(
  error: string,
  code = 'BAD_REQUEST',
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> {
  return { ok: false, error, code, fieldErrors }
}

function fromZod(error: z.ZodError): ActionResult<never> {
  const fieldErrors: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_root'
    ;(fieldErrors[key] ||= []).push(issue.message)
  }
  const first = error.issues[0]?.message ?? 'Please check the highlighted fields'
  return actionFail(first, 'VALIDATION_ERROR', fieldErrors)
}

/**
 * Wraps an action body: validates input, normalises every failure mode into an
 * `ActionResult`, and keeps internal error details out of production responses.
 */
export async function runAction<TSchema extends z.ZodTypeAny, TOutput>(
  schema: TSchema,
  input: unknown,
  handler: (data: z.output<TSchema>) => Promise<TOutput> | TOutput,
  successMessage?: string,
  /**
   * What this action is called, for the error record.
   *
   * Optional so no existing call site has to change, and worth passing: a
   * Server Action has no route to speak of, so without it an error in the
   * error centre says only that "something in a POST failed".
   */
  operation?: string,
): Promise<ActionResult<TOutput>> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const data = await handler(parsed.data)
    return actionOk(data, successMessage)
  } catch (error) {
    return handleActionError(error, operation)
  }
}

/** For actions that take no validated payload. */
export async function runSafe<TOutput>(
  handler: () => Promise<TOutput> | TOutput,
  successMessage?: string,
  operation?: string,
): Promise<ActionResult<TOutput>> {
  try {
    return actionOk(await handler(), successMessage)
  } catch (error) {
    return handleActionError(error, operation)
  }
}

export function handleActionError(error: unknown, operation?: string): ActionResult<never> {
  // `redirect()` and `notFound()` signal via a thrown control-flow error which
  // must be allowed to propagate to Next.js.
  if (
    error &&
    typeof error === 'object' &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string' &&
    ((error as { digest: string }).digest.startsWith('NEXT_REDIRECT') ||
      (error as { digest: string }).digest === 'NEXT_NOT_FOUND')
  ) {
    throw error
  }

  if (error instanceof z.ZodError) return fromZod(error)

  if (error instanceof ValidationError) {
    return actionFail(error.message, error.code, error.details as Record<string, string[]>)
  }

  if (error instanceof AppError) return actionFail(error.message, error.code)

  /*
   * ── Where the majority of this application's failures used to disappear ────
   *
   * This was `console.error` and nothing else. Every mutation in the product
   * goes through a Server Action, every Server Action goes through here, and a
   * genuine server-side failure — the settle that would not commit, the goods
   * receipt that refused — was turned into a polite message for the user and
   * then dropped. `ErrorLog` only ever received exceptions that escaped to
   * Next's `onRequestError`, which Server Actions do not reach, so the error
   * centre showed render failures and almost nothing else.
   *
   * Recorded, not awaited: an action must not get slower, or fail differently,
   * because the error store is unavailable. `captureError` swallows its own
   * failures for the same reason.
   *
   * Validation and permission refusals are NOT recorded — they are handled
   * above and return before reaching here. Only genuine unhandled failures
   * land in the log, which is what keeps it worth reading.
   */
  console.error('[action] unhandled error:', error)
  const app = toAppError(error)

  void recordActionFailure(error, app, operation)

  return actionFail(app.message, app.code)
}

/**
 * Persist an action failure with whatever context can be recovered.
 *
 * Imported lazily and inside the try: `action.ts` is imported by client
 * bundles for its types, and a top-level import of the server-only error store
 * would pull Prisma across the RSC boundary. The dynamic import keeps the
 * dependency where it belongs and means a failure to load it costs nothing.
 */
async function recordActionFailure(
  error: unknown,
  app: { message: string; code: string; status: number },
  operation?: string,
): Promise<void> {
  try {
    const [{ captureError }, { currentErrorContext }] = await Promise.all([
      import('@/server/errors'),
      import('@/server/request-context'),
    ])
    const context = await currentErrorContext()

    await captureError({
      message: `${app.code}: ${app.message}`,
      kind: 'action',
      // 5xx means the server broke; a 4xx that reached here is a refusal the
      // user can act on and does not deserve the same weight.
      severity: app.status >= 500 ? 'CRITICAL' : 'ERROR',
      operation: operation ?? null,
      stack: error instanceof Error ? error.stack : null,
      ...context,
    })
  } catch {
    // Never let the error store break the error path.
  }
}

/** Converts a `FormData` payload into a plain object for schema parsing. */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      result[key] = value
      continue
    }
    const existing = result[key]
    if (existing === undefined) result[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else result[key] = [existing, value]
  }
  return result
}
