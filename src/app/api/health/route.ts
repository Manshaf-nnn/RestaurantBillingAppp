import { NextResponse } from 'next/server'

import { prisma } from '@/server/db/prisma'
import { isRealtimeReady } from '@/server/realtime/emitter'
import { isRedisEnabled } from '@/server/cache/redis'
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

  const healthy = checks.database === 'ok'

  return NextResponse.json(
    {
      status: healthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
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
