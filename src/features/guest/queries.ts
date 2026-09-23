import 'server-only'

import { cache } from 'react'

import { prisma } from '@/server/db/prisma'
import { readAppearance, type GuestAppearance } from './appearance'

/**
 * How this restaurant meets its guests.
 *
 * Merged over the defaults on read, so a row written before a field existed
 * still yields a complete object and no screen ever has to cope with a missing
 * key. `cache`d per request because both the layout and the page below it ask
 * for it on the same render.
 */
export const getGuestAppearance = cache(async (restaurantId: string): Promise<GuestAppearance> => {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { guestExperience: true },
  })
  return readAppearance(restaurant?.guestExperience ?? null)
})
