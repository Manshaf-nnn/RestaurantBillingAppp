'use server'

import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { NotFoundError } from '@/lib/errors'
import { findCustomerByPhone } from '@/features/customers/service'
import { getGuestSessionId } from '@/server/auth/session'
import { prisma } from '@/server/db/prisma'
import { resolvePublicTenant } from '@/server/db/tenant'
import { enforceRateLimit } from '@/server/security/rate-limit'
import { locationsForGuest, type GuestLocation } from './locations'
import { readPublicId } from './public-id'

/**
 * The two things a guest's checkout asks the server, before they order.
 *
 * ── Recognising somebody, without becoming a directory ──────────────────────
 *
 * A returning guest types the mobile number the restaurant already has, and
 * the name comes back so they do not retype it. That is the whole feature, and
 * it is also — read unkindly — an endpoint that turns a phone number into a
 * person's name. Four things keep it from being one:
 *
 *   · the owner has to have turned `identifyCustomer` on for that code. A
 *     restaurant not collecting names cannot leak them;
 *   · it returns the name and the POINTS BALANCE, and nothing else. Not the
 *     email, not the address, not the spend, not the order history. The
 *     balance is here because the checkout now shows it, and it is the same
 *     fact `lookupLoyalty` has always returned for a typed number under the
 *     same limits — so this widens where that is asked, not what is answered.
 *     Spending it is a separate question with a separate proof: see
 *     `canRedeem`;
 *   · it is rate-limited twice, per device and per venue, at 6 in ten minutes.
 *     A guest fixing a typo is fine; a harvest is not;
 *   · an unknown number returns `found: false` with no name, which is what an
 *     unknown number returns anyway, so the endpoint answers the same shape
 *     whether or not somebody is there.
 *
 * This is the same bargain `lookupLoyalty` already struck for points, and it
 * is struck deliberately rather than inherited: the alternative is a delivery
 * guest retyping their name every single order, which is the thing the owner
 * asked to fix.
 */

const identitySchema = z.object({
  /** The QR code this is being asked from. Its settings are the permission. */
  code: z.string().trim().min(1).max(40),
  phone: z
    .string()
    .trim()
    .min(7, 'Enter the mobile number you use here')
    .max(20)
    .regex(/^[+\d][\d\s-]{6,}$/, 'Enter a valid mobile number'),
})

export interface GuestIdentityView {
  found: boolean
  name: string | null
  /**
   * What this number has on it, when loyalty is running. Zero otherwise.
   *
   * The same exposure `lookupLoyalty` already makes, under the same two rate
   * limits: a balance, for a number the caller typed, and nothing else about
   * the person.
   */
  points: number
  /**
   * May this DEVICE spend those points on this order?
   *
   * ── Why a balance can be shown but not always spent ────────────────────────
   *
   * Typing a phone number is not proof of owning it. `redeemPoints` was taken
   * out of the public order schema for exactly that reason — anyone could have
   * posted an order under a stranger's number and spent their points — and
   * `redeemRewardAsGuest` only works after the fact, because by then the bill
   * names whose it is.
   *
   * At the checkout there is no bill yet, so the proof has to be something the
   * device already did: an order placed EARLIER from this same guest session
   * carrying this same number. That is the same evidence the after-the-fact
   * path relies on, one step sooner. A stranger on a fresh device typing
   * somebody's number gets the balance and no way to touch it; a returning
   * customer on their own phone gets what the owner asked for.
   *
   * Advisory only. The server checks it again when the order is placed —
   * a client saying `true` proves nothing.
   */
  canRedeem: boolean
}

export async function lookupGuestIdentity(
  input: unknown,
  slug?: string,
): Promise<ActionResult<GuestIdentityView>> {
  return runAction(
    identitySchema,
    input,
    async (data) => {
      const session = await getGuestSessionId().catch(() => null)
      await enforceRateLimit('guestIdentity', session ? `guest:${session}` : undefined)
      await enforceRateLimit('guestIdentityBurst')

      const restaurant = await resolvePublicTenant(slug)
      if (!restaurant) throw new NotFoundError('Restaurant')

      /*
       * The code's own setting is the permission. A code that does not ask who
       * the guest is has no business answering who a number belongs to.
       */
      const publicId = readPublicId(data.code)
      const experience = publicId
        ? await prisma.qrExperience.findFirst({
            where: { publicId, restaurantId: restaurant.id, isActive: true },
            select: { identifyCustomer: true },
          })
        : null

      if (!experience?.identifyCustomer) {
        // Not an error: the screen simply learns nothing, and says nothing.
        return { found: false, name: null, points: 0, canRedeem: false }
      }

      const customer = await findCustomerByPhone({
        restaurantId: restaurant.id,
        phone: data.phone,
      })

      // Blocked customers are not recognised. Greeting somebody the restaurant
      // has barred by name is the wrong moment to be friendly.
      if (!customer || customer.isBlocked) {
        return { found: false, name: null, points: 0, canRedeem: false }
      }

      /*
       * Has this device ordered under this number before? One earlier order in
       * this guest session, carrying this customer, is the proof the checkout
       * has available — see `canRedeem`.
       */
      const points = restaurant.loyaltyEnabled ? customer.loyaltyPoints : 0
      const proven =
        restaurant.loyaltyEnabled && points > 0 && session
          ? (await prisma.order.count({
              where: {
                restaurantId: restaurant.id,
                guestSessionId: session,
                customerId: customer.id,
                status: { not: 'CANCELLED' },
              },
            })) > 0
          : false

      return { found: true, name: customer.name, points, canRedeem: proven }
    },
    undefined,
    'lookupGuestIdentity',
  )
}

/**
 * Where this guest may have it delivered.
 *
 * Asked at the checkout rather than baked into the page so the list is live:
 * a place the owner added a minute ago is offered without a redeploy or a
 * re-scan.
 *
 * Not secret: these are the names of buildings, printed on the leaflet the
 * code came from. No rate limit beyond the platform's, and an unknown code
 * returns an empty list rather than an error, so a stale bookmark degrades to
 * "no locations" instead of a broken checkout.
 */
const locationsSchema = z.object({
  code: z.string().trim().min(1).max(40),
})

export async function listGuestLocations(
  input: unknown,
  slug?: string,
): Promise<ActionResult<{ locations: GuestLocation[]; required: boolean }>> {
  return runAction(
    locationsSchema,
    input,
    async (data) => {
      const restaurant = await resolvePublicTenant(slug)
      if (!restaurant) throw new NotFoundError('Restaurant')

      const publicId = readPublicId(data.code)
      const experience = publicId
        ? await prisma.qrExperience.findFirst({
            where: { publicId, restaurantId: restaurant.id, isActive: true },
            select: { branchId: true, askLocation: true, requireLocation: true },
          })
        : null

      if (!experience?.askLocation) return { locations: [], required: false }

      const locations = await locationsForGuest({
        restaurantId: restaurant.id,
        branchId: experience.branchId,
      })

      /*
       * Required only when there is something to require. A code set to demand
       * a location whose list the owner has not filled in yet would be a
       * checkout nobody could complete.
       */
      return { locations, required: experience.requireLocation && locations.length > 0 }
    },
    undefined,
    'listGuestLocations',
  )
}
