import { NextResponse } from 'next/server'

import { prisma } from '@/server/db/prisma'
import { isRealtimeReady } from '@/server/realtime/emitter'
import { isRedisEnabled } from '@/server/cache/redis'
import { outboxAgeSeconds } from '@/server/realtime/outbox'
import { buildInfo } from '@/lib/build-info'

export const dynamic = 'force-dynamic'

/** Liveness + dependency probe for load balancers and uptime monitors. */
export async function GET() {
  const checks: Record<string, 'ok' | 'error' | 'disabled'> = {
    database: 'ok',
    realtime: isRealtimeReady() ? 'ok' : 'disabled',
    redis: isRedisEnabled() ? 'ok' : 'disabled',
  }

  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    checks.database = 'error'
  }

  /*
   * How long ago the newest outbox event was written (production.md §5, §7).
   *
   * This is the one number that says whether the realtime channel is actually
   * carrying anything. It is deliberately platform-wide and carries no tenant
   * detail, because this endpoint is unauthenticated for uptime monitors — an
   * age in seconds tells a monitor what it needs and identifies nobody.
   *
   * Null means the outbox is empty, which is normal on a quiet night and on a
   * fresh install, so it is reported as `idle` rather than as a fault.
   */
  let outboxAge: number | null = null
  try {
    outboxAge = await outboxAgeSeconds()
  } catch {
    checks.outbox = 'error'
  }
  if (checks.outbox !== 'error') checks.outbox = outboxAge === null ? 'disabled' : 'ok'

  const healthy = checks.database === 'ok'

  return NextResponse.json(
    {
      status: healthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
      /** Seconds since the newest realtime event; null when the outbox is idle. */
      outboxAgeSeconds: outboxAge,
      /*
       * The commit this build came from — the answer to "did my fix reach the
       * site". It used to be the string '1.0.0', which was the same on every
       * deploy and so could never tell anyone anything.
       */
      build: buildInfo(),
    },
    { status: healthy ? 200 : 503 },
  )
}
