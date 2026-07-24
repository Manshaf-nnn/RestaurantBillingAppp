/** Typed application errors shared by server actions and route handlers. */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(message: string, status = 400, code = 'BAD_REQUEST', details?: Record<string, unknown>) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'You must sign in to continue') {
    super(message, 401, 'UNAUTHORIZED')
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN')
    this.name = 'ForbiddenError'
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} was not found`, 404, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Please check the highlighted fields', fieldErrors?: Record<string, string[]>) {
    super(message, 422, 'VALIDATION_ERROR', fieldErrors)
    this.name = 'ValidationError'
  }
}

export class ConflictError extends AppError {
  constructor(message = 'That record already exists') {
    super(message, 409, 'CONFLICT')
    this.name = 'ConflictError'
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super(`Too many requests. Try again in ${retryAfterSeconds}s.`, 429, 'RATE_LIMITED')
    this.name = 'RateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (error instanceof Error) {
    // Never leak internals to the client in production.
    return new AppError(
      process.env.NODE_ENV === 'production' ? 'Something went wrong. Please try again.' : error.message,
      500,
      'INTERNAL_ERROR',
    )
  }
  return new AppError('Something went wrong. Please try again.', 500, 'INTERNAL_ERROR')
}
