import { NextResponse } from 'next/server'

import { prisma } from '@/server/db/prisma'
import { isRealtimeReady } from '@/server/realtime/emitter'
import { isRedisEnabled } from '@/server/cache/redis'

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
      version: '1.0.0',
    },
    { status: healthy ? 200 : 503 },
  )
}
