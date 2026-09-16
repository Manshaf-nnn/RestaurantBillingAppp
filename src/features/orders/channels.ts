/**
 * Which orders wait for the cashier (abc.md §5).
 *
 * Pure and client-safe: the cashier board, the KDS and the service all ask
 * the same question and must get the same answer.
 *
 * A guest order — placed from the QR menu or the website — is not the
 * restaurant's own request: nobody at the till has seen it, the guest may
 * be at the wrong table, the card may not go through, the kitchen may be
 * closing. So it goes to the cashier first, as "Pending acceptance", and
 * only the cashier's Accept sends it on to the KDS. An order the staff typed
 * in (at the till, at the table, on the phone) was already accepted by the
 * act of typing it, and goes straight to the kitchen as before.
 *
 * The SAME order row flows on after acceptance — KDS → live floor → stock →
 * billing — nothing is copied and no second system exists.
 */
export const GUEST_CHANNELS = ['QR', 'ONLINE'] as const

export type OrderChannelName = 'QR' | 'STAFF' | 'COUNTER' | 'PHONE' | 'ONLINE'

export function isGuestChannel(channel: string | null | undefined): boolean {
  return channel === 'QR' || channel === 'ONLINE'
}

/** A guest order the cashier has not yet accepted or turned away. */
export function awaitsCashier(order: { status: string; channel: string | null | undefined }): boolean {
  return order.status === 'PENDING' && isGuestChannel(order.channel)
}

/** How the till labels where an order came from. */
export function channelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case 'QR':
      return 'QR'
    case 'ONLINE':
      return 'Online'
    case 'PHONE':
      return 'Phone'
    case 'COUNTER':
      return 'Counter'
    default:
      return 'Staff'
  }
}
