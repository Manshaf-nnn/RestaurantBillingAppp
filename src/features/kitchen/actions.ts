'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import {
  assignAllDishesSchema,
  deleteStationSchema,
  saveStationSchema,
  setStationActiveSchema,
} from './schema'
import {
  assignAllDishesToStation,
  deleteStation,
  requireStation,
  saveStation,
  setStationActive,
} from './service'

/** Create or edit a kitchen section, and say who works it. */
export async function saveStationAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    saveStationSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_STATION_MANAGE)
      // A section belongs to a location, so managing one is managing that
      // location — the permission alone never asked which.
      await assertBranchAccess(user, data.branchId)

      const station = await saveStation({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
        branchId: data.branchId,
        name: data.name,
        description: data.description || null,
        printerName: data.printerName || null,
        sortOrder: data.sortOrder,
        staffIds: data.staffIds,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: data.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.KITCHEN_STATION_SAVED,
        entity: 'KitchenStation',
        entityId: station.id,
        after: { name: station.name, staff: data.staffIds.length },
      })

      revalidatePath(`/dashboard/locations/${data.branchId}/kitchen-stations`)
      revalidatePath('/kitchen')
      return { id: station.id }
    },
    'Section saved.',
  )
}

/** Retire a section, or bring it back. Never deletes — old tickets point at it. */
export async function setStationActiveAction(
  input: unknown,
): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  return runAction(
    setStationActiveSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_STATION_MANAGE)
      const existing = await requireStation({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
      })
      await assertBranchAccess(user, existing.branchId)

      const station = await setStationActive({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
        isActive: data.isActive,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: station.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.KITCHEN_STATION_RETIRED,
        entity: 'KitchenStation',
        entityId: station.id,
        before: { isActive: existing.isActive },
        after: { isActive: station.isActive },
      })

      revalidatePath(`/dashboard/locations/${station.branchId}/kitchen-stations`)
      revalidatePath('/kitchen')
      return { id: station.id, isActive: station.isActive }
    },
    'Section updated.',
  )
}

/** Remove a section that has never cooked anything. */
export async function deleteStationAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    deleteStationSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_STATION_MANAGE)
      const station = await requireStation({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
      })
      await assertBranchAccess(user, station.branchId)

      await deleteStation({ restaurantId: user.restaurantId, stationId: data.stationId })

      revalidatePath(`/dashboard/locations/${station.branchId}/kitchen-stations`)
      return { id: data.stationId }
    },
    'Section removed.',
  )
}

/**
 * Send this branch's whole menu to one section.
 *
 * The switch-on shortcut. Creating a first section makes every dish unmapped at
 * once, and an unmapped dish stops the kitchen accepting the order it is on —
 * so without this the feature is unusable the moment it is turned on.
 */
export async function assignAllDishesAction(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return runAction(
    assignAllDishesSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_STATION_MANAGE)
      const station = await requireStation({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
      })
      await assertBranchAccess(user, station.branchId)

      const count = await assignAllDishesToStation({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
        onlyUnassigned: data.onlyUnassigned,
      })

      revalidatePath(`/dashboard/locations/${station.branchId}/kitchen-stations`)
      revalidatePath('/dashboard/menu')
      return { count }
    },
    'Dishes assigned.',
  )
}
