import { NextResponse } from 'next/server'

import { recentErrors } from '@/instrumentation'
import { toAppError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

/**
 * The real cause behind a reference code.
 *
 * A failing page shows a digest and nothing else, because Next strips the
 * message in production — an unfiltered error would name tables, columns and
 * file paths to anyone who can load the page. Behind an owner-only check that
 * same text is exactly what is needed, so this returns it, matched by the digest
 * printed on the error screen.
 *
 * Newest first. In memory only, so it is empty after a cold start and shows only
 * the instance that answered this request — enough to turn "reference 2116762008"
 * into a message and a stack, which is the whole job.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

    // `?digest=` answers the only question that matters when someone is reading
    // a reference code off a screen.
    const digest = new URL(request.url).searchParams.get('digest')?.trim()

    /*
     * The table first, memory second. The table survives the instance that
     * failed; the in-memory list catches anything recorded before the write
     * could land, and covers a database that is itself the problem.
     */
    const persisted = await prisma.errorLog
      .findMany({
        where: digest ? { digest } : {},
        orderBy: { createdAt: 'desc' },
        take: digest ? 10 : 25,
      })
      .catch(() => [])

    const inMemory = recentErrors().filter((e) => !digest || e.digest === digest)

    const seen = new Set(persisted.map((e) => `${e.digest}:${e.message}`))
    const errors = [
      ...persisted.map((e) => ({
        at: e.createdAt.toISOString(),
        digest: e.digest,
        route: e.route,
        kind: e.kind,
        message: e.message,
        stack: e.stack,
      })),
      ...inMemory.filter((e) => !seen.has(`${e.digest}:${e.message}`)),
    ]

    return NextResponse.json({
      count: errors.length,
      summary:
        errors.length === 0
          ? digest
            ? `Nothing recorded for reference ${digest}. If the page timed out rather than threw, there is no error to record — check the hosting function log for a timeout.`
            : 'No server errors recorded. Nothing is failing, or nothing has failed since the last deploy.'
          : `${errors.length} error(s), newest first. The digest matches the reference code shown on screen.`,
      errors: errors.map((e) => ({
        ...e,
        // Trimmed: the useful frames are at the top and the rest is framework noise.
        stack: e.stack?.split('\n').slice(0, 12).join('\n') ?? null,
      })),
    })
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}
