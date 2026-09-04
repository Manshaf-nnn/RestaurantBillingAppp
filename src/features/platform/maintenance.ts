import 'server-only'

import { prisma } from '@/server/db/prisma'

export const MAINTENANCE_KEY = 'maintenance'

export interface Maintenance {
  enabled: boolean
  message: string
}

/**
 * The maintenance notice, read wherever a banner might be shown.
 *
 * Fails to `disabled` on any error, and that direction is deliberate: if this
 * lookup breaks, every tenant seeing no banner is a small loss, while every
 * tenant seeing a stuck "we are down for maintenance" they cannot dismiss is a
 * platform that looks broken to every one of its customers at once.
 */
export async function readMaintenance(): Promise<Maintenance> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: MAINTENANCE_KEY } })
    if (!row) return { enabled: false, message: '' }
    const parsed = JSON.parse(row.value) as Partial<Maintenance>
    return { enabled: Boolean(parsed.enabled), message: String(parsed.message ?? '') }
  } catch {
    return { enabled: false, message: '' }
  }
}
