/**
 * One id per user intent, stable across retries.
 *
 * This is the client half of every idempotent write in the system: the caller
 * mints a key when the operator commits to an action, keeps it in a ref, and
 * sends the same value on every attempt. The server's unique constraint then
 * makes the replay lose — `Order.idempotencyKey`, `Payment.clientRequestId`,
 * `Refund.clientRequestId`.
 *
 * The point is that the key survives a failed attempt. A key regenerated on
 * retry is worse than no key at all: it looks like protection and provides
 * none, because the whole failure it exists to stop is the request that
 * committed and then lost its response.
 *
 * `crypto.randomUUID` is not in every browser a counter tablet might be
 * running — it needs a secure context and a recent engine — and the fallback
 * only has to be unique among the handful of operations one till performs,
 * not globally.
 */
export function newRequestKey(prefix = 'req'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
