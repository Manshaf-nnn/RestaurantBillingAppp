import 'server-only'

import { Prisma, type Coupon } from '@prisma/client'

import { prisma } from '@/server/db/prisma'

/**
 * What a guest is actually offered, in the offers panel.
 *
 * ── Why this is computed and not typed ──────────────────────────────────────
 *
 * `showOffers` has been on `QrExperience` since QR codes were added, stored by
 * the editor and read by nothing. So the panel it was meant to gate never
 * existed, and an owner who turned it on saw no change. This is that panel.
 *
 * The offers themselves come from the real `Coupon` rows, not from a second
 * list the owner keeps in step by hand. That matters more than it sounds: a
 * typed "10% off over 2,000" that the engine will not honour is worse than no
 * panel at all, because the guest reads it, orders, and is charged full price
 * at the table. Everything shown here is something `evaluate()` would accept.
 *
 * The owner's own words live beside it in `offerNote`, for the things the
 * engine cannot express — "students get 5% on Mondays, show your ID at
 * pickup". Free text is the right shape for that precisely because it makes no
 * promise the system has to keep.
 *
 * ── What is deliberately NOT shown ──────────────────────────────────────────
 *
 * Offers aimed at a saved segment or a customer group. They cannot be
 * evaluated for somebody who has not identified themselves, and listing an
 * offer a guest turns out not to qualify for is the same broken promise as a
 * typed one. They still apply at checkout when the guest does qualify — this
 * only decides what the panel advertises.
 */

export interface OfferRow {
  id: string
  code: string
  /** One line a guest can act on: "10% off orders over 2,000". */
  headline: string
  description: string | null
  /** Minor units; 0 when the offer has no minimum. */
  minOrderAmount: number
}

export interface OffersPanel {
  offers: OfferRow[]
  /** The owner's own words, or null. */
  note: string | null
  /** True when there is anything at all to show. */
  hasAny: boolean
}

/**
 * Describe a coupon in one line, in the guest's money.
 *
 * `money` is passed in rather than formatted here so the panel speaks the
 * restaurant's currency and locale — the same formatter the menu and the cart
 * use, so "2,000" reads the same way on all three.
 */
function headlineFor(coupon: Coupon, money: (minor: number) => string): string {
  /*
   * PERCENT is stored in BASIS POINTS, not percent — 10% is 1000. Dividing by
   * 100 is the whole of the conversion and getting it wrong advertises a 1000%
   * discount, so it is written once, here.
   */
  const amount =
    coupon.type === 'PERCENT' ? `${coupon.value / 100}% off` : `${money(coupon.value)} off`

  const cap =
    coupon.type === 'PERCENT' && coupon.maxDiscount
      ? `, up to ${money(coupon.maxDiscount)}`
      : ''

  const floor = coupon.minOrderAmount > 0 ? ` on orders over ${money(coupon.minOrderAmount)}` : ''

  return `${amount}${cap}${floor}`
}

export async function offersFor(params: {
  restaurantId: string
  branchId: string | null
  /** The QR code being used, when there is one. */
  experienceId: string | null
  /** Whether the owner turned the panel on for this code. */
  showOffers: boolean
  offerNote: string | null
  money: (minor: number) => string
  now?: Date
}): Promise<OffersPanel> {
  const empty: OffersPanel = { offers: [], note: null, hasAny: false }
  if (!params.showOffers) return empty

  const now = params.now ?? new Date()

  const rows = await prisma.coupon.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      // A window that has not opened or has closed is not an offer.
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        // Null branch means everywhere; set means only there.
        params.branchId
          ? { OR: [{ branchId: null }, { branchId: params.branchId }] }
          : { branchId: null },
        /*
         * An offer tied to another QR code must not be advertised here — that
         * is the whole point of `Coupon.qrExperienceId`, and showing it would
         * let a guest read a Student offer off a public leaflet.
         */
        params.experienceId
          ? { OR: [{ qrExperienceId: null }, { qrExperienceId: params.experienceId }] }
          : { qrExperienceId: null },
      ],
      // See the note above: unevaluable for an anonymous guest.
      segment: { equals: Prisma.DbNull },
      customerGroup: null,
    },
    orderBy: [{ minOrderAmount: 'asc' }, { code: 'asc' }],
    take: 12,
  })

  const offers = rows
    // A used-up offer is not on. `usedCount` is maintained by the redemption
    // path, so this is the same number the engine refuses on.
    .filter((coupon) => coupon.usageLimit === null || coupon.usedCount < coupon.usageLimit)
    // Happy-hour windows: only advertise what is running right now, otherwise
    // the panel promises a price the cart will not give.
    .filter((coupon) => withinHours(coupon, now))
    .map((coupon) => ({
      id: coupon.id,
      code: coupon.code,
      headline: headlineFor(coupon, params.money),
      description: coupon.description,
      minOrderAmount: coupon.minOrderAmount,
    }))

  const note = params.offerNote?.trim() || null
  return { offers, note, hasAny: offers.length > 0 || note !== null }
}

/**
 * Is this offer running at this moment?
 *
 * Hour and day windows are what happy hour is built on, and an all-day
 * advertisement of an hour-long discount is a costly mistake — the same
 * reasoning `Coupon.startHour` carries on the model.
 *
 * An end hour BELOW the start hour wraps past midnight ("21 to 2"), which is
 * an ordinary late-night offer and reads as empty under a naive comparison.
 */
function withinHours(coupon: Coupon, now: Date): boolean {
  const days = Array.isArray(coupon.daysOfWeek) ? (coupon.daysOfWeek as number[]) : null
  if (days && days.length > 0 && !days.includes(now.getDay())) return false

  if (coupon.startHour === null || coupon.endHour === null) return true
  const hour = now.getHours()
  return coupon.startHour <= coupon.endHour
    ? hour >= coupon.startHour && hour <= coupon.endHour
    : hour >= coupon.startHour || hour <= coupon.endHour
}
