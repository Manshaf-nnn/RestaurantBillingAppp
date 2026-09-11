'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requireSuperAdmin } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { connectWebsiteSchema, websiteRestaurantSchema, websiteUrlSchema } from './schema'
import {
  disconnectWebsite,
  getWebsiteConnection,
  issueWebsiteKey,
  setWebsiteUrl,
} from './service'

/**
 * The super-admin side of Connect Website (websiteconnect.md).
 *
 * Four actions, each a thin guard around the service: issue or rotate the
 * key, record the site's address, check whether the site has actually
 * called in, and cut it off. Every write is audited with the four-character
 * hint and never the key — `audit()` would redact an `apiKey` field anyway,
 * and this does not give it the chance.
 */

export async function connectWebsiteAction(
  input: unknown,
): Promise<ActionResult<{ key: string; hint: string; regenerated: boolean }>> {
  return runAction(
    connectWebsiteSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: data.restaurantId },
        select: { id: true, status: true },
      })
      if (!restaurant) throw new NotFoundError('Restaurant')
      if (restaurant.status !== 'ACTIVE') {
        throw new ConflictError('Approve the restaurant before connecting its website')
      }

      const issued = await issueWebsiteKey({
        restaurantId: data.restaurantId,
        websiteUrl: data.websiteUrl || null,
        actorId: admin.id,
      })

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: issued.regenerated
          ? AUDIT_ACTIONS.WEBSITE_KEY_REGENERATED
          : AUDIT_ACTIONS.WEBSITE_CONNECTED,
        entity: 'WebsiteConnection',
        entityId: issued.connection.id,
        before: issued.regenerated ? { keyHint: issued.previousHint } : undefined,
        after: { keyHint: issued.connection.keyHint, websiteUrl: issued.connection.websiteUrl },
      })

      revalidatePath('/admin')
      return {
        key: issued.key,
        hint: issued.connection.keyHint,
        regenerated: issued.regenerated,
      }
    },
  )
}

export async function setWebsiteUrlAction(input: unknown): Promise<ActionResult<{ websiteUrl: string | null }>> {
  return runAction(
    websiteUrlSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()
      const before = await getWebsiteConnection(data.restaurantId)
      if (!before) throw new ConflictError('Generate a key first')

      const after = await setWebsiteUrl(data.restaurantId, data.websiteUrl || null)

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'WebsiteConnection',
        entityId: after.id,
        before: { websiteUrl: before.websiteUrl },
        after: { websiteUrl: after.websiteUrl },
      })

      revalidatePath('/admin')
      return { websiteUrl: after.websiteUrl }
    },
    'Website address saved.',
  )
}

/**
 * Has the website actually called in?
 *
 * Reads what the key has proved — the same idea as `verifyCustomDomain`, which
 * asks the domain rather than trusting the row. Here the proof already exists
 * or it does not: `connectedAt` is written by the first authenticated request.
 * When an address is recorded, the site itself is pinged too, so "the site is
 * down" and "the site has never called us" read differently.
 */
export async function checkWebsiteConnectionAction(
  input: unknown,
): Promise<ActionResult<{ connected: boolean; detail: string }>> {
  return runAction(
    websiteRestaurantSchema,
    input,
    async (data) => {
      await requireSuperAdmin()

      const connection = await getWebsiteConnection(data.restaurantId)
      if (!connection) throw new ConflictError('Generate a key first')

      let reach = ''
      if (connection.websiteUrl) {
        try {
          // Bounded: a site pointing at a black hole must not hang the console.
          const response = await fetch(connection.websiteUrl, {
            method: 'HEAD',
            redirect: 'follow',
            cache: 'no-store',
            signal: AbortSignal.timeout(8_000),
          })
          reach = response.ok || response.status === 405
            ? ` The site at ${connection.websiteUrl} is reachable.`
            : ` The site at ${connection.websiteUrl} answered ${response.status}.`
        } catch {
          reach = ` The site at ${connection.websiteUrl} could not be reached.`
        }
      }

      if (connection.connectedAt) {
        return {
          connected: true,
          detail:
            `Connected — the website last called TableFlow ${relative(connection.lastSeenAt ?? connection.connectedAt)}` +
            ` and has placed ${connection.orderCount} order${connection.orderCount === 1 ? '' : 's'}.` +
            reach,
        }
      }

      return {
        connected: false,
        detail:
          `Waiting — the key was issued ${relative(connection.keyIssuedAt)} and nothing has used it yet. ` +
          'Once the developer adds the details and their site calls GET /connection, this turns green.' +
          reach,
      }
    },
  )
}

export async function disconnectWebsiteAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    websiteRestaurantSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const removed = await disconnectWebsite(data.restaurantId)
      if (!removed) throw new ConflictError('No website is connected')

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.WEBSITE_DISCONNECTED,
        entity: 'WebsiteConnection',
        entityId: removed.id,
        before: {
          keyHint: removed.keyHint,
          websiteUrl: removed.websiteUrl,
          orderCount: removed.orderCount,
        },
      })

      revalidatePath('/admin')
      return { id: removed.id }
    },
    'Website disconnected. Its key no longer works.',
  )
}

/** "3 minutes ago" — for a sentence, not a table. */
function relative(at: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
