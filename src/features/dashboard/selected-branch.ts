import 'server-only'
import { cookies } from 'next/headers'

import { visibleBranchIds } from '@/lib/rbac'
import type { TenantUser } from '@/server/auth/guard'

/**
 * Which location the dashboard is currently showing.
 *
 * One helper, used by every page, because the alternative — each page reading
 * `?branch=` and validating it itself — is how the switcher ended up decorative:
 * five pages did the work and thirty did not, so the control visibly changed and
 * no number moved.
 *
 * The URL stays the source of truth. That is deliberate and predates this
 * helper: a filtered view can then be bookmarked or sent to an accountant, and
 * the back button behaves the way people expect. The cookie is only a memory of
 * the last choice, so opening the dashboard fresh lands where you left off. URL
 * beats cookie whenever both are present.
 *
 * Always validated against what this user may see, so a branch id typed into the
 * address bar cannot widen anyone's access.
 */

export const BRANCH_COOKIE = 'ros_branch'

export interface BranchSelection {
  /** The chosen location, or null for "all locations". */
  branchId: string | null
  /** What the page should scope to: null means unrestricted. */
  branchIds: string[] | null
  /** True when the user is confined and has no location assigned yet. */
  confinedWithNoBranch: boolean
}

export async function selectedBranch(
  user: Pick<TenantUser, 'role' | 'branchId'>,
  searchParams?: Record<string, string | string[] | undefined>,
): Promise<BranchSelection> {
  const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })

  /*
   * An empty allow-list means "sees nothing", and it must not be mistaken for
   * "no filter". That confusion was a live bug on the transfers page: an
   * unassigned warehouse worker saw every transfer in the restaurant, because
   * `[]` was read as "unrestricted". Failing closed is the only safe reading.
   */
  const confinedWithNoBranch = allowed !== null && allowed.length === 0

  const fromUrl = typeof searchParams?.branch === 'string' ? searchParams.branch : null
  const fromCookie = fromUrl ? null : (await cookies()).get(BRANCH_COOKIE)?.value ?? null
  const requested = fromUrl ?? fromCookie

  const branchId =
    requested && (allowed === null || allowed.includes(requested)) ? requested : null

  return {
    branchId,
    branchIds: branchId ? [branchId] : allowed,
    confinedWithNoBranch,
  }
}

/**
 * The same answer for a page that only needs one id, e.g. a loader whose
 * parameter is `branchId?: string | null`.
 *
 * A confined user with no location gets a value that can match nothing rather
 * than null, so their queries return nothing instead of everything.
 */
export function scopeToOne(selection: BranchSelection): string | null {
  if (selection.branchId) return selection.branchId
  if (selection.confinedWithNoBranch) return '__none__'
  if (selection.branchIds && selection.branchIds.length === 1) return selection.branchIds[0]
  return null
}
