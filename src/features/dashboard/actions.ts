'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { runSafe } from '@/lib/action'
import { ForbiddenError } from '@/lib/errors'
import { visibleBranchIds } from '@/lib/rbac'
import { BRANCH_COOKIE } from './selected-branch'
import { requireTenantUser } from '@/server/auth/guard'
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
