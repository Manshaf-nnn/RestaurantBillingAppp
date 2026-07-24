import 'server-only'
import type { NotificationAudience, NotificationType, Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { realtime } from '@/server/realtime/emitter'

export interface NotifyInput {
  restaurantId: string
  type: NotificationType
  title: string
  body?: string | null
  audience?: NotificationAudience
  userId?: string | null
  /** Also push to the guest tracking screen for this order. */
  orderId?: string | null
  data?: Record<string, unknown>
}

const AUDIENCE_ROOMS: Record<
  NotificationAudience,
  Array<'kitchen' | 'waiter' | 'cashier' | 'management'>
> = {
  KITCHEN: ['kitchen'],
  WAITER: ['waiter'],
  CASHIER: ['cashier'],
  MANAGEMENT: ['management'],
  CUSTOMER: [],
}

/**
 * Persists a notification and pushes it over the websocket in one step, so the
 * bell icon and the live toast never disagree.
 */
export async function notify(input: NotifyInput) {
  const record = await prisma.notification.create({
    data: {
      restaurantId: input.restaurantId,
      userId: input.userId ?? null,
      audience: input.audience ?? null,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      data: (input.data ?? null) as Prisma.InputJsonValue,
    },
  })

  const payload = {
    id: record.id,
    type: record.type,
    title: record.title,
    body: record.body,
    data: input.data ?? null,
    createdAt: record.createdAt.toISOString(),
  }

  if (input.userId) {
    realtime.notifyUser(input.userId, payload)
  } else if (input.audience) {
    const rooms = AUDIENCE_ROOMS[input.audience]
    if (rooms.length) realtime.notify(input.restaurantId, rooms, payload)
  }

  if (input.orderId) realtime.notifyOrder(input.orderId, payload)

  return record
}

/** Fan-out helper for events that several roles care about. */
export async function notifyAudiences(
  audiences: NotificationAudience[],
  input: Omit<NotifyInput, 'audience'>,
) {
  return Promise.all(audiences.map((audience) => notify({ ...input, audience })))
}

export async function markNotificationRead(id: string, restaurantId: string, userId: string) {
  return prisma.notification.updateMany({
    where: { id, restaurantId, OR: [{ userId }, { userId: null }] },
    data: { readAt: new Date() },
  })
}

export async function markAllNotificationsRead(restaurantId: string, userId: string) {
  return prisma.notification.updateMany({
    where: { restaurantId, readAt: null, OR: [{ userId }, { userId: null }] },
    data: { readAt: new Date() },
  })
}
