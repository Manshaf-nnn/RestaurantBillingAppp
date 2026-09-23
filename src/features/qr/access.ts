import 'server-only'

import { getCurrentUser } from '@/server/auth/session'

/**
 * May this request see this QR menu, and may it write anything?
 *
 * ── Preview is the real thing, not a mock-up (ar.md §19) ────────────────────
 *
 * "Do not build a fake preview." So the owner's preview IS `/m/<code>`, served
 * by the same components a guest gets, with three differences and no fourth:
 *
 *   1. it is allowed while the experience is switched off, which is the point
 *      — an owner sets a code up before they print it;
 *   2. it must be the owner, AND of THIS restaurant. Without the tenant check,
 *      `?preview=1` would let any signed-in staff member of any tenant read
 *      any other restaurant's configuration (§25);
 *   3. it writes nothing. No open count, no customer, no order.
 *
 * (3) is enforced by never seating a table in preview rather than by scattering
 * `if (preview)` through the write paths: with no table, the cart bails before
 * it can place anything and `placeGuestOrder` is unreachable. One condition,
 * checked where it is visible, instead of five that each have to stay right.
 */
export interface QrAccess {
  /** Show the screens at all. */
  allowed: boolean
  /** The owner is looking at their own code; nothing may be written. */
  preview: boolean
}

export async function qrAccess(params: {
  experience: { restaurantId: string; isActive: boolean }
  /** `?preview=1` from the URL. */
  asked: boolean
}): Promise<QrAccess> {
  if (!params.asked) {
    return { allowed: params.experience.isActive, preview: false }
  }

  const user = await getCurrentUser().catch(() => null)
  const isOwner = Boolean(user && user.restaurantId === params.experience.restaurantId)

  // A preview request from somebody who is not staff here is not a preview.
  // It falls back to the ordinary rule, so a retired code stays retired.
  if (!isOwner) return { allowed: params.experience.isActive, preview: false }

  return { allowed: true, preview: true }
}

/** `?preview=1`, whatever shape the query arrived in. */
export function askedForPreview(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === '1' || raw === 'true'
}
