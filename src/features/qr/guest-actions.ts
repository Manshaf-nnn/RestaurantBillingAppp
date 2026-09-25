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
 *   · it returns the NAME and nothing else. Not the email, not the address,
 *     not the spend, not the points — none of which the checkout needs;
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
        return { found: false, name: null }
      }

      const customer = await findCustomerByPhone({
        restaurantId: restaurant.id,
        phone: data.phone,
      })

      // Blocked customers are not recognised. Greeting somebody the restaurant
      // has barred by name is the wrong moment to be friendly.
      if (!customer || customer.isBlocked) return { found: false, name: null }

      return { found: true, name: customer.name }
    },
    undefined,
    'lookupGuestIdentity',
  )
}

/**
 * Where this guest may have it delivered.
 *
 * Asked at the checkout rather than baked into the page, because the answer
 * depends on the customer CATEGORY the guest chose on the way in — which the
 * page was rendered before they picked.
 *
 * Not secret: these are the names of buildings, printed on the leaflet the
 * code came from. No rate limit beyond the platform's, and an unknown code
 * returns an empty list rather than an error, so a stale bookmark degrades to
 * "no locations" instead of a broken checkout.
 */
const locationsSchema = z.object({
  code: z.string().trim().min(1).max(40),
  categoryId: z.string().cuid().optional().or(z.literal('')),
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
        categoryId: data.categoryId || null,
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
