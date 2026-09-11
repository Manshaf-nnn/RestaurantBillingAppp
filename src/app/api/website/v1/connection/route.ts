import type { NextRequest } from 'next/server'

import { jsonNoStore, withWebsiteCaller } from '@/features/website/api'
import { listWebsiteBranches } from '@/features/website/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The website's "Test Connection" (websiteconnect.md).
 *   GET /api/website/v1/connection
 *   Authorization: Bearer tfk_…
 *
 * Answers with who the key belongs to. The first successful call is what
 * marks the connection live in the super-admin console — so a developer
 * pasting the details and running this one request is the whole handshake.
 * Everything the website needs to configure itself is in the reply: the
 * restaurant, its branches, and which branch is the default. No id has to be
 * typed anywhere.
 */
export async function GET(request: NextRequest) {
  return withWebsiteCaller(request, 'websiteRead', async ({ connection, restaurant }) => {
    const branches = await listWebsiteBranches(restaurant.id)
    return jsonNoStore({
      connected: true,
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
        currency: restaurant.currency,
        locale: restaurant.locale,
        timezone: restaurant.timezone,
      },
      branch: branches.find((branch) => branch.isDefault) ?? branches[0] ?? null,
      branches,
      key: { hint: connection.keyHint, issuedAt: connection.keyIssuedAt.toISOString() },
    })
  })
}
