'use server'

import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { requireTenantUser } from '@/server/auth/guard'
import { globalSearch, type SearchHit } from './service'

/**
 * The one action behind the search box.
 *
 * A server action rather than a route handler, so it is authenticated the same
 * way every other mutation is and cannot be reached without a session. It reads
 * nothing from the client but the term — the restaurant, the role and the
 * visible locations all come from the session.
 */
export async function globalSearchAction(
  input: unknown,
): Promise<ActionResult<{ hits: SearchHit[]; truncated: boolean }>> {
  return runAction(
    z.object({ term: z.string().max(80) }),
    input,
    async (data) => {
      const user = await requireTenantUser()
      return globalSearch({ user, term: data.term })
    },
    // No success message: this runs on every keystroke and a toast per
    // character would be intolerable.
  )
}
