import 'server-only'
import Redis from 'ioredis'

/**
 * Optional Redis. When `REDIS_URL` is absent (local dev, single-instance
 * deployments) every consumer degrades to an in-process implementation, so the
 * application never hard-depends on Redis being up.
 */
const globalForRedis = globalThis as unknown as {
  redis?: Redis | null
  redisWarned?: boolean
}

export function getRedis(): Redis | null {
  if (globalForRedis.redis !== undefined) return globalForRedis.redis

  const url = process.env.REDIS_URL
  if (!url) {
    globalForRedis.redis = null
    return null
  }

  try {
    const client = new Redis(url, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      enableOfflineQueue: false,
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
    })

    client.on('error', (error) => {
      if (!globalForRedis.redisWarned) {
        globalForRedis.redisWarned = true
        console.warn('[redis] unavailable, falling back to in-process cache:', error.message)
      }
    })

    globalForRedis.redis = client
    return client
  } catch {
    globalForRedis.redis = null
    return null
  }
}

export const isRedisEnabled = () => getRedis() !== null

// ── in-process fallback store ────────────────────────────────────────────────

interface MemoryEntry {
  value: string
  expiresAt: number
}

const memory = new Map<string, MemoryEntry>()

function sweep() {
  const now = Date.now()
  for (const [key, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(key)
  }
}

/** Cache read-through helper. Values are JSON-serialised. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis()
  if (redis) {
    try {
      const raw = await redis.get(key)
      return raw ? (JSON.parse(raw) as T) : null
    } catch {
      return null
    }
  }
  sweep()
  const entry = memory.get(key)
  return entry ? (JSON.parse(entry.value) as T) : null
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 60): Promise<void> {
  const payload = JSON.stringify(value)
  const redis = getRedis()
  if (redis) {
    try {
      await redis.set(key, payload, 'EX', ttlSeconds)
      return
    } catch {
      /* fall through to memory */
    }
  }
  memory.set(key, { value: payload, expiresAt: Date.now() + ttlSeconds * 1000 })
}

export async function cacheDelete(pattern: string): Promise<void> {
  const redis = getRedis()
  if (redis) {
    try {
      if (pattern.includes('*')) {
        const keys = await redis.keys(pattern)
        if (keys.length) await redis.del(...keys)
      } else {
        await redis.del(pattern)
      }
      return
    } catch {
      /* fall through */
    }
  }
  if (pattern.includes('*')) {
    const prefix = pattern.replace('*', '')
    for (const key of memory.keys()) if (key.startsWith(prefix)) memory.delete(key)
  } else {
    memory.delete(pattern)
  }
}

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  producer: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key)
  if (hit !== null) return hit
  const value = await producer()
  await cacheSet(key, value, ttlSeconds)
  return value
}

/** Atomic counter used by the rate limiter. */
export async function incrementCounter(
  key: string,
  windowSeconds: number,
): Promise<{ count: number; resetAt: number }> {
  const redis = getRedis()
  if (redis) {
    try {
      const pipeline = redis.multi()
      pipeline.incr(key)
      pipeline.ttl(key)
      const results = await pipeline.exec()
      const count = Number(results?.[0]?.[1] ?? 1)
      let ttl = Number(results?.[1]?.[1] ?? -1)
      if (ttl < 0) {
        await redis.expire(key, windowSeconds)
        ttl = windowSeconds
      }
      return { count, resetAt: Date.now() + ttl * 1000 }
    } catch {
      /* fall through */
    }
  }

  sweep()
  const now = Date.now()
  const entry = memory.get(key)
  if (entry && entry.expiresAt > now) {
    const count = Number(entry.value) + 1
    memory.set(key, { value: String(count), expiresAt: entry.expiresAt })
    return { count, resetAt: entry.expiresAt }
  }
  const resetAt = now + windowSeconds * 1000
  memory.set(key, { value: '1', expiresAt: resetAt })
  return { count: 1, resetAt }
}
