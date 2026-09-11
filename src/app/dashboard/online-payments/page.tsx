import { permanentRedirect } from 'next/navigation'

/**
 * The old address for what is now "Payment details".
 *
 * Kept as a redirect rather than deleted: this path is in browser histories and
 * bookmarks, and a 404 on a page somebody visited daily reads as the feature
 * having been taken away. The page gained the accounts view and lost nothing.
 */
export default function OnlinePaymentsMoved(): never {
  permanentRedirect('/dashboard/payment-details')
}
