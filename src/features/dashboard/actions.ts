'use server'

import { runSafe } from '@/lib/action'
import { requireTenantUser } from '@/server/auth/guard'
import { markAllNotificationsRead, markNotificationRead } from '@/server/notifications'

export async function markAllRead() {
  return runSafe(async () => {
    const user = await requireTenantUser()
    const result = await markAllNotificationsRead(user.restaurantId, user.id)
    return { count: result.count }
  })
}

export async function markRead(id: string) {
  return runSafe(async () => {
    const user = await requireTenantUser()
    await markNotificationRead(id, user.restaurantId, user.id)
    return { id }
  })
}
