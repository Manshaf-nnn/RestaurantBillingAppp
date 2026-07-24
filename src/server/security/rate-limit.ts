import 'server-only'
import { headers } from 'next/headers'

import { RateLimitError } from '@/lib/errors'
import { incrementCounter } from '@/server/cache/redis'

export interface RateLimitRule {
  /** Requests allowed inside the window. */
  limit: number
  /** Window length in seconds. */
  windowSeconds: number
}

/** Tuned per surface: auth is strict, browsing is generous. */
export const RATE_LIMITS = {
  login: { limit: 8, windowSeconds: 300 },
  register: { limit: 5, windowSeconds: 3600 },
  passwordReset: { limit: 5, windowSeconds: 3600 },
  placeOrder: { limit: 12, windowSeconds: 600 },
  serviceRequest: { limit: 10, windowSeconds: 300 },
  publicRead: { limit: 240, windowSeconds: 60 },
  mutation: { limit: 120, windowSeconds: 60 },
  upload: { limit: 30, windowSeconds: 300 },
} satisfies Record<string, RateLimitRule>

export type RateLimitName = keyof typeof RATE_LIMITS

export async function clientIp(): Promise<string> {
  const h = await headers()
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip') ??
    h.get('cf-connecting-ip') ??
    'unknown'
  )
}

export interface RateLimitResult {
  ok: boolean
  remaining: number
  retryAfterSeconds: number
}

/**
 * Fixed-window rate limit. Backed by Redis when available so the limit is
 * shared across instances; falls back to per-process counters otherwise.
 */
export async function rateLimit(
  name: RateLimitName,
  identifier?: string,
): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[name]
  const id = identifier ?? (await clientIp())
  const key = `rl:${name}:${id}`

  const { count, resetAt } = await incrementCounter(key, rule.windowSeconds)
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))

  return {
    ok: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds,
  }
}

/** Throwing variant for server actions and route handlers. */
export async function enforceRateLimit(
  name: RateLimitName,
  identifier?: string,
): Promise<void> {
  const result = await rateLimit(name, identifier)
  if (!result.ok) throw new RateLimitError(result.retryAfterSeconds)
}
