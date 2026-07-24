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
): Promise<ActionResult<TOutput>> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return fromZod(parsed.error)

  try {
    const data = await handler(parsed.data)
    return actionOk(data, successMessage)
  } catch (error) {
    return handleActionError(error)
  }
}

/** For actions that take no validated payload. */
export async function runSafe<TOutput>(
  handler: () => Promise<TOutput> | TOutput,
  successMessage?: string,
): Promise<ActionResult<TOutput>> {
  try {
    return actionOk(await handler(), successMessage)
  } catch (error) {
    return handleActionError(error)
  }
}

export function handleActionError(error: unknown): ActionResult<never> {
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

  console.error('[action] unhandled error:', error)
  const app = toAppError(error)
  return actionFail(app.message, app.code)
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
