import { NextResponse } from 'next/server'

import { recentErrors } from '@/instrumentation'
import { toAppError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePermission } from '@/server/auth/guard'

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

export async function GET() {
  try {
    await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
    const errors = recentErrors()

    return NextResponse.json({
      count: errors.length,
      summary:
        errors.length === 0
          ? 'No server errors recorded on this instance. If a page is failing, load it and refresh here — serverless instances are short-lived and each keeps its own list.'
          : `${errors.length} recent server error(s), newest first. Match the digest to the reference code on the error screen.`,
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
