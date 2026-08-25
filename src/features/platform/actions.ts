'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { NotFoundError, AppError, ConflictError } from '@/lib/errors'
import { audit } from '@/server/audit'
import { requireSuperAdmin } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { notify } from '@/server/notifications'

const idSchema = z.object({ restaurantId: z.string().cuid() })
const rejectSchema = idSchema.extend({ reason: z.string().trim().min(3, 'Give a reason').max(300) })
const domainSchema = idSchema.extend({
  // Empty clears it; anything else is normalised and validated in the action,
  // where a bad value can be reported by name rather than as a regex failure.
  domain: z.string().trim().max(253),
})

/**
 * Approve a pending restaurant: enable it, start its trial, and notify the
 * owner. Idempotent — approving an already-active tenant is a no-op.
 */
export async function approveRestaurant(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    idSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const restaurant = await prisma.restaurant.findUnique({ where: { id: data.restaurantId } })
      if (!restaurant) throw new NotFoundError('Restaurant')

      await prisma.restaurant.update({
        where: { id: restaurant.id },
        data: {
          status: 'ACTIVE',
          isActive: true,
          approvedAt: new Date(),
          approvedById: admin.id,
          rejectionReason: null,
          trialEndsAt: restaurant.trialEndsAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      })

      await notify({
        restaurantId: restaurant.id,
        type: 'SYSTEM',
        title: 'Your restaurant is approved 🎉',
        body: 'Welcome to TableFlow. Your dashboard is now live.',
        audience: 'MANAGEMENT',
      })

      await audit({
        restaurantId: restaurant.id,
        userId: admin.id,
        actorName: admin.name,
        action: 'platform.approved',
        entity: 'Restaurant',
        entityId: restaurant.id,
      })

      revalidatePath('/admin')
      return { id: restaurant.id }
    },
    'Restaurant approved.',
  )
}

export async function rejectRestaurant(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    rejectSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const result = await prisma.restaurant.updateMany({
        where: { id: data.restaurantId },
        data: { status: 'REJECTED', isActive: false, rejectionReason: data.reason },
      })
      if (result.count === 0) throw new NotFoundError('Restaurant')

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: 'platform.rejected',
        entity: 'Restaurant',
        entityId: data.restaurantId,
        after: { reason: data.reason },
      })

      revalidatePath('/admin')
      return { id: data.restaurantId }
    },
    'Registration rejected.',
  )
}

export async function suspendRestaurant(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    idSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const result = await prisma.restaurant.updateMany({
        where: { id: data.restaurantId },
        data: { status: 'SUSPENDED', isActive: false },
      })
      if (result.count === 0) throw new NotFoundError('Restaurant')

      // Cut every live staff session for the suspended tenant.
      await prisma.session.updateMany({
        where: { user: { restaurantId: data.restaurantId }, revokedAt: null },
        data: { revokedAt: new Date() },
      })

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: 'platform.suspended',
        entity: 'Restaurant',
        entityId: data.restaurantId,
      })

      revalidatePath('/admin')
      return { id: data.restaurantId }
    },
    'Restaurant suspended.',
  )
}

export async function reactivateRestaurant(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    idSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: data.restaurantId },
        select: { plan: true },
      })
      if (!restaurant) throw new NotFoundError('Restaurant')

      const trialReactivation =
        restaurant.plan === 'TRIAL'
          ? { trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) }
          : {}

      const result = await prisma.restaurant.updateMany({
        where: { id: data.restaurantId },
        data: { status: 'ACTIVE', isActive: true, ...trialReactivation },
      })
      if (result.count === 0) throw new NotFoundError('Restaurant')

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: 'platform.reactivated',
        entity: 'Restaurant',
        entityId: data.restaurantId,
      })

      revalidatePath('/admin')
      return { id: data.restaurantId }
    },
    'Restaurant reactivated.',
  )
}

/**
 * Give a restaurant its own domain.
 *
 * ── Stored bare, and unverified until proved ────────────────────────────────
 *
 * The value is normalised to the one shape the resolver compares against —
 * lower case, no scheme, no `www.`, no path, no port — so an operator can
 * paste `https://www.Nilaza.LK/` and it lands as `nilaza.lk`.
 *
 * Saving does NOT make it live. `customDomainVerifiedAt` stays null until
 * `verifyCustomDomain` has asked the domain itself who it thinks it is. Until
 * then `resolvePublicTenant` ignores the row entirely — otherwise writing a
 * hostname here would be enough to aim it at another restaurant's menu, with
 * nothing ever testing the claim against reality.
 */
export async function setCustomDomain(input: unknown): Promise<ActionResult<{ domain: string | null }>> {
  return runAction(
    domainSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const domain = normaliseDomain(data.domain)
      if (data.domain.trim() && !domain) {
        throw new AppError('That does not look like a domain name', 400, 'BAD_DOMAIN')
      }

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: data.restaurantId },
        select: { id: true, name: true, customDomain: true },
      })
      if (!restaurant) throw new NotFoundError('Restaurant')

      if (domain) {
        // A hostname can only mean one restaurant. The unique index would catch
        // this, but a named error beats a constraint violation.
        const taken = await prisma.restaurant.findFirst({
          where: { customDomain: domain, id: { not: data.restaurantId } },
          select: { name: true },
        })
        if (taken) {
          throw new ConflictError(`${domain} is already set up for ${taken.name}`)
        }
      }

      await prisma.restaurant.update({
        where: { id: data.restaurantId },
        data: {
          customDomain: domain,
          // Any change re-opens the question, including clearing it.
          customDomainVerifiedAt: null,
        },
      })

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: 'platform.domain_set',
        entity: 'Restaurant',
        entityId: data.restaurantId,
        before: { customDomain: restaurant.customDomain },
        after: { customDomain: domain },
      })

      revalidatePath('/admin')
      return { domain }
    },
    'Domain saved. Add it in Netlify, then press Check.',
  )
}

/**
 * Ask the domain who it thinks it is.
 *
 * One request proves the whole chain — DNS, TLS, that it reached this
 * deployment, and that our resolver matched the right restaurant. A failure
 * reports what actually came back rather than "verification failed", because
 * the difference between "no DNS yet" and "it resolved to the wrong
 * restaurant" is the difference between waiting and fixing something.
 */
export async function verifyCustomDomain(
  input: unknown,
): Promise<ActionResult<{ verified: boolean; detail: string }>> {
  return runAction(
    idSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: data.restaurantId },
        select: { id: true, name: true, customDomain: true },
      })
      if (!restaurant) throw new NotFoundError('Restaurant')
      if (!restaurant.customDomain) {
        throw new ConflictError('Set a domain first')
      }

      const url = `https://${restaurant.customDomain}/api/public/whoami`
      type WhoAmI = { resolved?: boolean; id?: string; name?: string }
      let seen: WhoAmI | null = null
      let reason = ''

      try {
        // Bounded: a domain pointing at a black hole must not hang the console.
        const response = await fetch(url, {
          cache: 'no-store',
          signal: AbortSignal.timeout(8_000),
        })
        seen = (await response.json().catch(() => null)) as WhoAmI | null
        if (!response.ok && !seen) reason = `the domain answered ${response.status}`
      } catch (error) {
        reason =
          error instanceof Error && error.name === 'TimeoutError'
            ? 'the domain did not answer in time'
            : 'the domain could not be reached — DNS may not have propagated yet'
      }

      const verified = Boolean(seen?.resolved && seen.id === restaurant.id)

      if (verified) {
        await prisma.restaurant.update({
          where: { id: data.restaurantId },
          data: { customDomainVerifiedAt: new Date() },
        })
        await audit({
          restaurantId: data.restaurantId,
          userId: admin.id,
          actorName: admin.name,
          action: 'platform.domain_verified',
          entity: 'Restaurant',
          entityId: data.restaurantId,
          after: { customDomain: restaurant.customDomain },
        })
        revalidatePath('/admin')
        return { verified: true, detail: `${restaurant.customDomain} is live.` }
      }

      const detail = reason
        ? `Not live yet — ${reason}.`
        : seen?.resolved
          ? `That domain currently reaches ${seen.name ?? 'another restaurant'}, not ${restaurant.name}.`
          : 'The domain reached the app but matched no restaurant. Add it in Netlify as a domain alias.'

      return { verified: false, detail }
    },
  )
}

/**
 * A hostname, reduced to the shape the resolver stores.
 *
 * Tolerant of what an operator will actually paste: a full URL, a trailing
 * slash, capitals, a `www.` prefix. Returns null for anything that is not a
 * hostname, so the caller can say so rather than saving nonsense.
 */
function normaliseDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null

  const withoutScheme = trimmed.replace(/^https?:\/\//, '')
  const host = withoutScheme.split('/')[0].split(':')[0].replace(/\.$/, '')
  const bare = host.startsWith('www.') ? host.slice(4) : host

  // At least one dot, and only the characters a hostname may contain.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(bare)) {
    return null
  }
  return bare
}
