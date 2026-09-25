'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { NotFoundError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { getOrCreateGuestSessionId } from '@/server/auth/session'
import { prisma } from '@/server/db/prisma'
import { enforceRateLimit } from '@/server/security/rate-limit'
import { resolveExperience } from './queries'
import {
  createExperienceSchema,
  enterExperienceSchema,
  experienceIdSchema,
  recordOpenSchema,
  saveExperienceSchema,
  setExperienceActiveSchema,
} from './schema'
import {
  createExperience,
  enterExperience,
  recordOpen,
  regeneratePublicId,
  saveExperience,
  setExperienceActive,
} from './service'

/**
 * QR menus: the owner's actions, and the two a guest may call.
 *
 * The owner's are gated on `QR_MANAGE` and scoped to the branch the row
 * belongs to. The guest's are unauthenticated by necessity — whoever scans the
 * card has no account — so they are rate-limited and take the printed public
 * code rather than any internal id (ar.md §25).
 */

function revalidateQr(experienceId?: string) {
  revalidatePath('/dashboard/qr/experiences')
  if (experienceId) revalidatePath(`/dashboard/qr/experiences/${experienceId}`)
}

/** Create the smallest working code: a name and a branch (ar.md §21). */
export async function createQrExperience(
  input: unknown,
): Promise<ActionResult<{ id: string; publicId: string }>> {
  return runAction(
    createExperienceSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.QR_MANAGE)
      await assertBranchAccess(user, data.branchId)

      const created = await createExperience({
        restaurantId: user.restaurantId,
        branchId: data.branchId,
        name: data.name,
        type: data.type,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.QR_EXPERIENCE_SAVED,
        entity: 'QrExperience',
        entityId: created.id,
        branchId: created.branchId,
        after: { name: created.name, type: created.type },
      })

      revalidateQr(created.id)
      return { id: created.id, publicId: created.publicId }
    },
    undefined,
    'qr.experience.create',
  )
}

export async function saveQrExperience(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    saveExperienceSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.QR_MANAGE)
      const existing = await prisma.qrExperience.findFirst({
        where: { id: data.experienceId, restaurantId: user.restaurantId },
        select: { branchId: true },
      })
      if (!existing) throw new NotFoundError('QR menu')
      // Both ends: where it is now, and where it is being moved to.
      await assertRecordBranch(user, existing, 'QR menu')
      await assertBranchAccess(user, data.branchId)

      const saved = await saveExperience({
        restaurantId: user.restaurantId,
        experienceId: data.experienceId,
        input: {
          name: data.name,
          description: data.description || null,
          branchId: data.branchId,
          type: data.type,
          askTable: data.askTable,
          menuMode: data.menuMode,
          menuCategoryIds: data.menuCategoryIds,
          menuFoodIds: data.menuFoodIds,
          identifyCustomer: data.identifyCustomer,
          askCustomerCategory: data.askCustomerCategory,
          customerCategoryIds: data.customerCategoryIds,
          showSearch: data.showSearch,
          showPrices: data.showPrices,
          showOffers: data.showOffers,
          askLocation: data.askLocation,
          requireLocation: data.requireLocation,
          offerNote: data.offerNote,
          showLoyalty: data.showLoyalty,
          fields: data.fields,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.QR_EXPERIENCE_SAVED,
        entity: 'QrExperience',
        entityId: saved.id,
        branchId: saved.branchId,
        after: {
          name: saved.name,
          type: saved.type,
          askTable: saved.askTable,
          menuMode: saved.menuMode,
          identifyCustomer: saved.identifyCustomer,
          askCustomerCategory: saved.askCustomerCategory,
          fields: data.fields.length,
        },
      })

      revalidateQr(saved.id)
      return { id: saved.id }
    },
    'QR menu saved.',
    'qr.experience.save',
  )
}

export async function setQrExperienceActive(
  input: unknown,
): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  return runAction(
    setExperienceActiveSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.QR_MANAGE)
      const existing = await prisma.qrExperience.findFirst({
        where: { id: data.experienceId, restaurantId: user.restaurantId },
        select: { branchId: true },
      })
      if (!existing) throw new NotFoundError('QR menu')
      await assertRecordBranch(user, existing, 'QR menu')

      const updated = await setExperienceActive({
        restaurantId: user.restaurantId,
        experienceId: data.experienceId,
        isActive: data.isActive,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.QR_EXPERIENCE_ACTIVE,
        entity: 'QrExperience',
        entityId: updated.id,
        branchId: updated.branchId,
        after: { isActive: updated.isActive },
      })

      revalidateQr(updated.id)
      return { id: updated.id, isActive: updated.isActive }
    },
    undefined,
    'qr.experience.active',
  )
}

/** A new printed code, same experience — the old card stops working (ar.md §17). */
export async function regenerateQrCode(input: unknown): Promise<ActionResult<{ publicId: string }>> {
  return runAction(
    experienceIdSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.QR_MANAGE)
      const existing = await prisma.qrExperience.findFirst({
        where: { id: data.experienceId, restaurantId: user.restaurantId },
        select: { branchId: true, publicId: true },
      })
      if (!existing) throw new NotFoundError('QR menu')
      await assertRecordBranch(user, existing, 'QR menu')

      const updated = await regeneratePublicId({
        restaurantId: user.restaurantId,
        experienceId: data.experienceId,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.QR_EXPERIENCE_REGENERATED,
        entity: 'QrExperience',
        entityId: updated.id,
        branchId: updated.branchId,
        before: { publicId: existing.publicId },
        after: { publicId: updated.publicId },
      })

      revalidateQr(updated.id)
      return { publicId: updated.publicId }
    },
    'New QR code generated — reprint the old cards.',
    'qr.experience.regenerate',
  )
}

/* ── The guest's two ────────────────────────────────────────────────────── */

/**
 * A guest has answered the entry questions (ar.md §8).
 *
 * Unauthenticated: whoever scanned the card has no account, and requiring one
 * would defeat the feature. So it is rate-limited per device and per venue,
 * takes the printed code rather than an id, and hands everything else to the
 * existing CRM.
 */
export async function enterQrExperience(input: unknown): Promise<
  ActionResult<{
    customerId: string | null
    customerName: string
    customerPhone: string
    categoryId: string | null
  }>
> {
  return runAction(
    enterExperienceSchema,
    input,
    async (data) => {
      const guestSessionId = await getOrCreateGuestSessionId()
      await enforceRateLimit('qrEnter', `guest:${guestSessionId}`)
      await enforceRateLimit('qrEnterBurst')

      const experience = await resolveExperience(data.code)
      if (!experience || !experience.isActive) throw new NotFoundError('QR menu')

      const result = await enterExperience({
        experience,
        fields: experience.fields,
        categoryId: data.categoryId ?? null,
        answers: data.answers,
      })

      return {
        customerId: result.customerId,
        customerName: result.customerName,
        customerPhone: result.customerPhone,
        categoryId: result.categoryId,
      }
    },
    undefined,
    'qr.enter',
  )
}

/** One per browser session, from the client. Never counted during a render. */
export async function recordQrOpen(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return runAction(
    recordOpenSchema,
    input,
    async (data) => {
      await enforceRateLimit('qrOpenBurst')
      await recordOpen(data.code.trim().toLowerCase())
      return { ok: true as const }
    },
    undefined,
    'qr.open',
  )
}
