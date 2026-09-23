'use server'

import { z } from 'zod'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { AppError, NotFoundError } from '@/lib/errors'
import type { Prisma } from '@prisma/client'

import { PERMISSIONS, can, customersAtBranch, visibleBranchIds } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import {
  findCustomerByPhone,
  findOrCreateCustomer,
  removeCustomerCategory,
  saveCustomerCategory,
  setCustomerCategoryActive,
  updateCustomer,
} from './service'
import { countSegment, describeSegment, type CustomerSegment } from './segments'
import { offersForCustomer, type OfferForCustomer } from './discounts'
import {
  createCampaignSchema,
  customerCategoryIdSchema,
  customerSegmentSchema,
  findCustomerSchema,
  offersForCustomerSchema,
  saveCustomerCategorySchema,
  saveCustomerSchema,
  setCustomerCategoryActiveSchema,
} from './schema'

export interface CustomerSuggestion {
  id: string
  name: string
  phone: string
  loyaltyPoints: number
}

/**
 * Regulars, found by the phone number being typed at the till.
 *
 * ── Why it is worth having ──────────────────────────────────────────────────
 *
 * `placeOrder` keys customers on `(restaurantId, phone)` and upserts — and the
 * update branch overwrites the stored NAME with whatever the cashier typed. So
 * a customer saved as "Jonathan Perera" becomes "Jon" the first time somebody
 * is in a hurry. Filling the name from the record is not only a convenience;
 * it is what stops the record being quietly rewritten a character at a time.
 *
 * Nothing downstream changes. The order still carries a name and a phone, and
 * the upsert still resolves it to the same row, so there is no customer id to
 * thread through the POS.
 *
 * ── Why not the global search action ────────────────────────────────────────
 *
 * `globalSearchAction` already searches customers by phone and is scoped
 * correctly, but it fans out to seven `findMany` queries in one `Promise.all`
 * on every keystroke and returns links into `/dashboard`, which a cashier
 * cannot open. This is the narrow version of the same question.
 */
export async function suggestCustomersByPhone(
  input: unknown,
): Promise<ActionResult<{ matches: CustomerSuggestion[] }>> {
  return runAction(
    z.object({ term: z.string().max(20) }),
    input,
    async (data) => {
      // POS and WAITER both hold this already — no role change needed.
      const user = await requirePermission(PERMISSIONS.CUSTOMER_VIEW)

      const term = data.term.trim()
      // Three, not two. A two-digit fragment matches most of the book and the
      // list would be noise.
      if (term.length < 3) return { matches: [] }

      const allowed = visibleBranchIds(user)
      // `[]` is "sees nothing", which is not the same as no restriction.
      if (allowed && allowed.length === 0) return { matches: [] }

      const matches = await prisma.customer.findMany({
        where: {
          restaurantId: user.restaurantId,
          isBlocked: false,
          /*
           * The AND wrapper is load-bearing. `customersAtBranch` returns an
           * `OR` of its own, and a sibling `OR` key would silently replace it
           * — which is the difference between "regulars at this branch" and
           * "every customer in the group". `search/service.ts` carries the
           * longer version of this warning.
           */
          AND: [
            { phone: { contains: term } },
            /*
             * Every anonymous counter sale collapses into one shared row with
             * an empty phone, because the upsert key is `(restaurantId, phone)`
             * and a walk-in sends ''. Excluding it keeps that row — which holds
             * the accumulated totals of every cash sale ever rung up — out of
             * the first thing a cashier sees.
             */
            { phone: { not: '' } },
            customersAtBranch(allowed),
          ],
        },
        select: { id: true, name: true, phone: true, loyaltyPoints: true },
        orderBy: { totalOrders: 'desc' },
        take: 5,
      })

      return { matches }
    },
    // No success message: this runs on a debounce as somebody types.
  )
}

/* ── the CRM (pro.A.md §1, §2, §5, §6) ────────────────────────────────────── */

/**
 * Who has this number?
 *
 * The answer the Add Customer form needs before it offers to create anybody:
 * "this is Priya, open her instead" rather than a conflict error after the
 * cashier has typed everything in. Matching is on the normalised key, so the
 * way the number was typed cannot hide an existing regular.
 */
export async function findCustomerAction(
  input: unknown,
): Promise<ActionResult<{ customer: CustomerSuggestion | null }>> {
  return runAction(findCustomerSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.CUSTOMER_VIEW)
    const found = await findCustomerByPhone({ restaurantId: user.restaurantId, phone: data.phone })
    if (!found) return { customer: null }
    await assertCustomerReach(user, found.id)
    return {
      customer: {
        id: found.id,
        name: found.name,
        phone: found.phone,
        loyaltyPoints: found.loyaltyPoints,
      },
    }
  })
}

/**
 * What this guest can be offered, right now, on this basket (pro.A.md §4).
 *
 * Called from both order forms the moment a phone resolves to somebody. The
 * cart is sent with it because half the answer depends on it — a minimum spend
 * is not a property of the offer, it is a question about the basket — and
 * because the amount shown has to be the amount taken.
 *
 * `DISCOUNT_APPLY`, because this is the list of discounts somebody may hand
 * out. A cashier without it takes the order at full price, which is what that
 * permission means. It is not `CUSTOMER_VIEW`: reading a guest's name and
 * reading what money may be taken off are different powers.
 */
export async function offersForCustomerAction(
  input: unknown,
): Promise<ActionResult<{ offers: OfferForCustomer[] }>> {
  return runAction(offersForCustomerSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.DISCOUNT_APPLY)
    await assertCustomerReach(user, data.customerId)

    const restaurant = await prisma.restaurant.findUniqueOrThrow({
      where: { id: user.restaurantId },
      select: { timezone: true },
    })

    const offers = await offersForCustomer({
      restaurantId: user.restaurantId,
      customerId: data.customerId,
      branchId: data.branchId || null,
      subtotal: data.lines.reduce((total, line) => total + line.lineTotal, 0),
      lines: data.lines.map((line) => ({
        foodId: line.foodId ?? null,
        categoryId: line.categoryId ?? null,
        quantity: line.quantity,
        lineTotal: line.lineTotal,
      })),
      timeZone: restaurant.timezone,
    })

    return { offers }
  })
}

/**
 * Add or edit a customer — the ONE path, shared by the CRM and the till
 * (pro.A.md §6).
 *
 * Creating with a number that already exists is not an error: it returns the
 * person who has it, because that is what the cashier meant.
 */
export async function saveCustomerAction(
  input: unknown,
): Promise<ActionResult<{ id: string; created: boolean; name: string }>> {
  return runAction(
    saveCustomerSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CUSTOMER_MANAGE)
      const shape = {
        name: data.name || null,
        phone: data.phone,
        email: data.email || null,
        notes: data.notes || null,
        address: data.address || null,
        categoryId: data.categoryId || null,
        birthday: data.birthday,
        anniversary: data.anniversary,
      }

      if (data.id) {
        await assertCustomerReach(user, data.id)
        const before = await prisma.customer.findFirstOrThrow({
          where: { id: data.id, restaurantId: user.restaurantId },
        })
        const customer = await updateCustomer({
          restaurantId: user.restaurantId,
          customerId: data.id,
          input: { ...shape, isBlocked: data.isBlocked },
        })
        await audit({
          restaurantId: user.restaurantId,
          userId: user.id,
          actorName: user.name,
          action: AUDIT_ACTIONS.UPDATE,
          entity: 'Customer',
          entityId: customer.id,
          before: { name: before.name, phone: before.phone, categoryId: before.categoryId, isBlocked: before.isBlocked },
          after: { name: customer.name, phone: customer.phone, categoryId: customer.categoryId, isBlocked: customer.isBlocked },
        })
        revalidateCustomers(customer.id)
        return { id: customer.id, created: false, name: customer.name }
      }

      const match = await findOrCreateCustomer({ restaurantId: user.restaurantId, input: shape })
      if (!match) throw new AppError('A phone number is needed', 400, 'CUSTOMER_NO_PHONE')

      if (match.created) {
        await audit({
          restaurantId: user.restaurantId,
          userId: user.id,
          actorName: user.name,
          action: AUDIT_ACTIONS.CREATE,
          entity: 'Customer',
          entityId: match.customer.id,
          after: { name: match.customer.name, phone: match.customer.phone, categoryId: match.customer.categoryId },
        })
      }
      revalidateCustomers(match.customer.id)
      return { id: match.customer.id, created: match.created, name: match.customer.name }
    },
    undefined,
    'customers.save',
  )
}

/* ── categories ───────────────────────────────────────────────────────────── */

export async function saveCustomerCategoryAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    saveCustomerCategorySchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CUSTOMER_MANAGE)
      const category = await saveCustomerCategory({
        restaurantId: user.restaurantId,
        id: data.id ?? null,
        name: data.name,
        colour: data.colour || null,
        sortOrder: data.sortOrder,
      })
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: data.id ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE,
        entity: 'CustomerCategory',
        entityId: category.id,
        after: { name: category.name, colour: category.colour, sortOrder: category.sortOrder },
      })
      revalidateCustomers()
      return { id: category.id }
    },
    'Category saved.',
    'customers.category.save',
  )
}

export async function setCustomerCategoryActiveAction(
  input: unknown,
): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  return runAction(
    setCustomerCategoryActiveSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CUSTOMER_MANAGE)
      const category = await setCustomerCategoryActive({
        restaurantId: user.restaurantId,
        id: data.id,
        isActive: data.isActive,
      })
      revalidateCustomers()
      return { id: category.id, isActive: category.isActive }
    },
    undefined,
    'customers.category.toggle',
  )
}

/** Delete a category nothing uses; retire one that customers point at. */
export async function removeCustomerCategoryAction(
  input: unknown,
): Promise<ActionResult<{ deleted: boolean; customers: number }>> {
  return runAction(
    customerCategoryIdSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CUSTOMER_MANAGE)
      const result = await removeCustomerCategory({ restaurantId: user.restaurantId, id: data.id })
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.UPDATE,
        entity: 'CustomerCategory',
        entityId: data.id,
        after: { deleted: result.deleted, retiredWith: result.customers },
      })
      revalidateCustomers()
      return { deleted: result.deleted, customers: result.customers }
    },
    undefined,
    'customers.category.remove',
  )
}

/* ── pieces ───────────────────────────────────────────────────────────────── */

function revalidateCustomers(customerId?: string) {
  revalidatePath('/dashboard/customers')
  if (customerId) revalidatePath(`/dashboard/customers/${customerId}`)
  revalidatePath('/cashier/pos')
}

/**
 * A customer is reachable when this person could see them in the list — which
 * for a branch-confined user means the customer has ordered somewhere they can
 * see, or has never ordered at all. The same rule `customersAtBranch` applies
 * to every listing, applied to one row.
 */
async function assertCustomerReach(
  user: Awaited<ReturnType<typeof requirePermission>>,
  customerId: string,
) {
  const reach = visibleBranchIds(user)
  if (reach === null) return
  const found = await prisma.customer.findFirst({
    where: {
      id: customerId,
      restaurantId: user.restaurantId,
      ...customersAtBranch(reach),
    },
    select: { id: true },
  })
  if (!found) throw new NotFoundError('Customer')
}

/* ── campaigns: a discount aimed at a group (pro.A.md §4) ─────────────────── */

/**
 * How many people a filter reaches, so the button can say so before anybody
 * commits to it. Cheap — one indexed count.
 */
export async function countCustomerSegmentAction(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return runAction(customerSegmentSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.CUSTOMER_VIEW)
    const count = await countSegment({
      restaurantId: user.restaurantId,
      branchIds: visibleBranchIds(user),
      segment: toSegment(data),
    })
    return { count }
  })
}

/**
 * Give a filtered group of customers an offer.
 *
 * It creates a COUPON with the segment saved on it. Not a second discount
 * engine: every rule `evaluate` already enforces — dates, minimum spend,
 * per-customer limit, usage cap, branch, and now the segment — applies
 * unchanged, and the discount only ever touches future orders. Historical
 * invoices are not reachable from here at all.
 */
/**
 * A code nobody had to think of, that still reads as something.
 *
 * Not exported: a 'use server' module may only export async functions meant to
 * be called from a browser, and handing out coupon codes is not one.
 *
 * Shaped from the group the offer names — REGULARS-7K3Q, LAPSED-2M8P — so the
 * Coupons screen stays readable and an owner can still tell two campaigns
 * apart at a glance. The tail is what makes it unique; the head is only there
 * so it is not a meaningless string. Ambiguous characters are left out because
 * these do end up read aloud occasionally, and 0/O and 1/I are where that goes
 * wrong.
 */
async function freeCampaignCode(restaurantId: string, segment: CustomerSegment): Promise<string> {
  const head =
    (segment.kind ? segment.kind.toUpperCase() : describeSegment(segment).toUpperCase())
      .replace(/[^A-Z]/g, '')
      .slice(0, 8) || 'OFFER'

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const tail = () =>
    Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('')

  /*
   * A handful of attempts, then let the unique index decide. Looping forever
   * on a collision would turn a full code space into a hung request, and the
   * caller's P2002 catch already turns the last word into a clear refusal.
   */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${head}-${tail()}`
    const taken = await prisma.coupon.findFirst({
      where: { restaurantId, code: candidate },
      select: { id: true },
    })
    if (!taken) return candidate
  }
  return `${head}-${Date.now().toString(36).toUpperCase().slice(-6)}`
}

export async function createCustomerCampaignAction(
  input: unknown,
): Promise<ActionResult<{ id: string; code: string; reaches: number }>> {
  return runAction(
    createCampaignSchema,
    input,
    async (data) => {
      /*
       * Two permissions, because this is two powers: deciding what a discount
       * is (DISCOUNT_APPLY) and deciding which customers get it
       * (CUSTOMER_MANAGE). Somebody who may do one but not the other should
       * not be able to do this by combining screens.
       */
      const user = await requirePermission(PERMISSIONS.DISCOUNT_APPLY)
      if (!can(user, PERMISSIONS.CUSTOMER_MANAGE)) {
        throw new AppError(
          'You need permission to manage customers to aim an offer at a group',
          403,
          'CAMPAIGN_FORBIDDEN',
        )
      }

      const segment = toSegment(data.segment)
      const reaches = await countSegment({
        restaurantId: user.restaurantId,
        branchIds: visibleBranchIds(user),
        segment,
      })

      /*
       * A code the owner did not have to invent (pro.A.md §4).
       *
       * `Coupon.code` is how redemption finds the row, so it cannot go away —
       * but a targeted offer is never typed by a guest, it is offered to the
       * cashier when the phone is recognised. Generated from the group the
       * offer names plus a short random tail, so the Coupons screen still
       * reads as something rather than as a UUID, and retried on the unique
       * index rather than checked first: two owners pressing the button at the
       * same second is exactly the race a pre-check loses.
       */
      const code = data.code?.trim()
        ? data.code.trim().toUpperCase()
        : await freeCampaignCode(user.restaurantId, segment)

      try {
        const coupon = await prisma.coupon.create({
          data: {
            restaurantId: user.restaurantId,
            code,
            description: data.description || null,
            type: data.type,
            value: data.value,
            minOrderAmount: data.minOrderAmount,
            maxDiscount: data.maxDiscount ?? null,
            startsAt: data.startsAt ? new Date(`${data.startsAt}T00:00:00.000Z`) : null,
            endsAt: data.endsAt ? new Date(`${data.endsAt}T23:59:59.999Z`) : null,
            usageLimit: data.usageLimit ?? null,
            perCustomerLimit: data.perCustomerLimit ?? null,
            segment: segment as unknown as Prisma.InputJsonValue,
            isActive: true,
          },
        })

        await audit({
          restaurantId: user.restaurantId,
          userId: user.id,
          actorName: user.name,
          action: AUDIT_ACTIONS.CREATE,
          entity: 'Coupon',
          entityId: coupon.id,
          after: {
            code: coupon.code,
            type: coupon.type,
            value: coupon.value,
            segment,
            // The size of the group AT THE TIME. It will drift as people
            // visit, which is the point of a filter — but what was intended
            // when somebody pressed the button is worth keeping.
            reaches,
          },
        })

        revalidateCustomers()
        revalidatePath('/dashboard/coupons')
        return { id: coupon.id, code: coupon.code, reaches }
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          throw new AppError(`There is already an offer with the code ${code}`, 409, 'COUPON_EXISTS')
        }
        throw error
      }
    },
    undefined,
    'customers.campaign.create',
  )
}

/** Drop the empty strings a form sends, so an untouched field is not a filter. */
function toSegment(raw: Record<string, unknown>): CustomerSegment {
  const segment: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === '' || value === undefined || value === null) continue
    segment[key] = value
  }
  return segment as CustomerSegment
}
