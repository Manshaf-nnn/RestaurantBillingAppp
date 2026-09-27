/**
 * Remove a test tenant completely, the way an operator would.
 *
 * ── Why suites were leaking tenants ─────────────────────────────────────────
 *
 * Several suites ended with this:
 *
 *     try { await prisma.restaurant.delete({ where: { id } }) }
 *     catch { await prisma.restaurant.update({ … isActive: false }) }
 *
 * which reads as "delete it, and if something is still attached, at least
 * switch it off". In practice the delete ALWAYS failed — forty-three foreign
 * keys in this schema are RESTRICT, so a restaurant with any stock, transfer
 * or receipt hanging off it cannot be removed in one statement — and the
 * catch swallowed it every time. `recorrection-ui-test` alone had left 52
 * restaurants behind.
 *
 * That is not merely untidy. Leftover tenants are live rows that other suites
 * then find: `page-render-test` picks "the first active owner" and started
 * picking an abandoned fixture whose branch codes were never normalised, so
 * it failed on a guest link that was fine. A suite that leaks makes a
 * different suite flaky, which is the hardest kind of failure to place.
 *
 * `purgeTenant` is the routine that actually works, deleting in dependency
 * order. This wraps it for fixtures: it clears the in-flight work a test may
 * have left — an open till, an unfinished shift, a transfer mid-air — because
 * those are deliberate refusals aimed at a real operator, and a fixture
 * tidying up after itself is exactly the case they are not aimed at.
 */
import { prisma } from '../src/server/db/prisma'
import { purgeTenant } from '../src/features/platform/tenant-purge'

/**
 * Delete a fixture tenant and everything belonging to it.
 *
 * Safe to call on an id that no longer exists. Returns how many rows went.
 */
export async function purgeFixture(restaurantId: string): Promise<number> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { slug: true },
  })
  if (!restaurant) return 0

  // A purge is a second decision after closing the account; make the first one.
  await prisma.restaurant.update({
    where: { id: restaurantId },
    data: { isActive: false, status: 'SUSPENDED' },
  })

  /*
   * Clear what `planTenantPurge` would refuse on.
   *
   * Each of those blockers exists to stop an operator erasing a restaurant
   * that somebody is still trading in. None of them applies to a test that
   * has just finished, so the fixture closes its own tills and ends its own
   * shifts rather than the purge quietly ignoring them for everyone.
   */
  await prisma.cashDrawerSession.updateMany({
    where: { restaurantId, status: 'OPEN' },
    data: { status: 'CLOSED', closedAt: new Date() },
  })
  await prisma.staffShift.updateMany({
    where: { restaurantId, clockOutAt: null },
    data: { clockOutAt: new Date() },
  })
  await prisma.stockTransfer.updateMany({
    where: { restaurantId, status: { in: ['REQUESTED', 'APPROVED', 'DISPATCHED', 'IN_TRANSIT'] } },
    data: { status: 'CANCELLED' },
  })
  await prisma.order.updateMany({
    where: { restaurantId, paymentStatus: 'PARTIAL' },
    data: { status: 'CANCELLED' },
  })

  const result = await purgeTenant({
    restaurantId,
    confirmation: restaurant.slug,
    actorId: null,
    actorName: 'fixture-cleanup',
  })

  /*
   * The purge records itself on the PLATFORM's audit trail, which is correct
   * for a real erasure and noise for a test. Removed here so a suite does not
   * leave a row behind while cleaning up the rows it left behind.
   */
  await prisma.auditLog.deleteMany({
    where: { action: 'TENANT_PURGED', entityId: restaurantId },
  })

  return result.totalRows
}
