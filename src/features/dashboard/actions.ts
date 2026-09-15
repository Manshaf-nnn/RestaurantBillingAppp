'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { z } from 'zod'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { ForbiddenError } from '@/lib/errors'
import { visibleBranchIds } from '@/lib/rbac'
import { BRANCH_COOKIE } from './selected-branch'
import { sanitiseFavorites } from './nav'
import { requireTenantUser } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { markAllNotificationsRead, markNotificationRead } from '@/server/notifications'

export async function markAllRead() {
  return runSafe(async () => {
    const user = await requireTenantUser()
    const result = await markAllNotificationsRead(user.restaurantId, user.id)
    return { count: result.count }
  })
}

export async function markRead(id: string) {
  return runSafe(async () => {
    const user = await requireTenantUser()
    await markNotificationRead(id, user.restaurantId, user.id)
    return { id }
  })
}

/*
 * A generous cap on what may be POSTED, separate from MAX_FAVORITES, which is
 * the cap on what may be STORED. The schema's job is only to stop somebody
 * posting a megabyte; `sanitiseFavorites` decides what is actually kept.
 */
const favoritesSchema = z.object({ hrefs: z.array(z.string().max(120)).max(50) })

/**
 * Save this person's sidebar shortcuts (sidebar.md §1, §2).
 *
 * ── Why the whole list, rather than add/remove ──────────────────────────────
 *
 * Starring, unstarring and dragging are then one code path with one race
 * outcome: last write wins, and the list that wins is a list that was actually
 * on somebody's screen. An add/remove pair would need the server to merge two
 * concurrent edits of an *ordered* list, which is the kind of thing that works
 * until two tabs are open. It also self-heals — a shortcut left behind by a
 * permission change is filtered out on the next save rather than needing a
 * cleanup job.
 *
 * ── Why `requireTenantUser` and not `requirePermission` ─────────────────────
 *
 * This writes the caller's own row and grants nothing; there is no permission
 * called "may have favorites". The per-item check is `sanitiseFavorites`, which
 * is the same filter the sidebar renders through — so a hand-made request
 * naming a page this person may not open stores nothing, and a saved shortcut
 * can never become a way in. The page guard would refuse the click anyway; this
 * stops the row existing in the first place.
 *
 * No `revalidatePath`: the client already has the new order on screen, and the
 * next full load reads it from the user row the session query fetches anyway.
 * Revalidating the dashboard layout on every star would re-render every screen
 * in the product to move one row.
 */
export async function setNavFavorites(
  input: unknown,
): Promise<ActionResult<{ hrefs: string[] }>> {
  return runAction(favoritesSchema, input, async (data) => {
    const user = await requireTenantUser()

    /*
     * The server's own filter, and deliberately the stricter one: `user` here
     * carries `availablePermissions`, which the shell's copy does not, so a
     * page the restaurant's plan has not sold is refused even though the client
     * would have offered it.
     */
    const hrefs = sanitiseFavorites(user, data.hrefs)

    await prisma.user.update({ where: { id: user.id }, data: { navFavorites: hrefs } })
    return { hrefs }
  })
  // No success message. Starring is its own feedback, and a toast per click
  // would be intolerable — the same reasoning as `globalSearchAction`.
}

/**
 * Remember which location the user last looked at.
 *
 * The URL remains the source of truth — see `selected-branch.ts` — and this only
 * records the choice so that opening the dashboard fresh lands where they left
 * off rather than on "all locations" every morning.
 *
 * Validated against what this user may see, so the cookie can never widen access
 * even if someone edits it by hand; `selectedBranch` re-checks on the way out
 * regardless.
 */
export async function rememberBranch(branchId: string | null) {
  return runSafe(async () => {
    const user = await requireTenantUser()
    const store = await cookies()

    if (!branchId) {
      store.delete(BRANCH_COOKIE)
      return { branchId: null }
    }

    const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })
    if (allowed !== null && !allowed.includes(branchId)) {
      throw new ForbiddenError('You do not have access to that location')
    }

    store.set(BRANCH_COOKIE, branchId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })
    return { branchId }
  })
}

/**
 * Change the working location and land on it.
 *
 * ── Why the client cannot be trusted to do this ─────────────────────────────
 *
 * The switcher used to `router.push()` the new URL. Picking another branch left
 * the page showing the one you were already on — but pasting the same URL into
 * a second browser worked, which is the tell: the URL and the server were right
 * all along.
 *
 * The cause is Next's client prefetch cache. `router.push` runs as
 * `PrefetchKind.TEMPORARY`, and the cache key for anything short of
 * `PrefetchKind.FULL` is built from the pathname with the **search string
 * dropped** — so `/dashboard?branch=A` and `/dashboard?branch=B` are one entry
 * keyed `/dashboard`, and the second navigation is answered with the first
 * one's tree. The URL bar still updates, because that happens regardless of
 * which entry served the render. Three details make it match the report
 * exactly: the cache is per-tab memory, so a fresh browser is exempt; the
 * aliasing is guarded by `NODE_ENV !== 'development'`, so it only bites in
 * production; and the staleness window slides on every use, so toggling
 * between branches keeps the wrong entry alive rather than ageing it out.
 *
 * `staleTimes.dynamic` is now 0 (see next.config.mjs), which shuts that window.
 * This action is the second half: a server round trip that cannot be answered
 * from a client cache at all. It also fixes a smaller bug on the same path —
 * choosing "All locations" removed the query param and left the *cookie* to
 * decide, while the cookie delete was an unawaited request racing the
 * navigation. Here the write happens before the redirect, in order.
 *
 * `redirect()` throws a control-flow signal that Next catches, so this must sit
 * OUTSIDE `runSafe` — swallowing it as an error would turn every branch change
 * into a silent no-op, which is precisely the failure being fixed.
 */
export async function switchBranch(input: { branchId: string | null; path?: string }) {
  const user = await requireTenantUser()
  const store = await cookies()

  let branchId: string | null = null

  if (input.branchId) {
    // Never trust the posted id: the same check `rememberBranch` makes, so a
    // hand-edited request cannot widen what somebody sees.
    const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })
    if (allowed !== null && !allowed.includes(input.branchId)) {
      throw new ForbiddenError('You do not have access to that location')
    }
    branchId = input.branchId
  }

  if (branchId) {
    store.set(BRANCH_COOKIE, branchId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })
  } else {
    store.delete(BRANCH_COOKIE)
  }

  /*
   * Only same-origin dashboard paths. `path` arrives from the client, and
   * handing an unchecked string to `redirect()` is an open redirect — a link
   * that looks like yours and lands on somebody else's login form.
   */
  const requested = input.path ?? '/dashboard'
  const path = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/dashboard'

  // Drop the client router cache for the whole dashboard tree, so the redirect
  // below cannot be answered from it.
  revalidatePath('/dashboard', 'layout')

  redirect(branchId ? `${path}?branch=${encodeURIComponent(branchId)}` : path)
}
