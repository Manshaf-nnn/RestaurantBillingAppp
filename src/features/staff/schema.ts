import { z } from 'zod'

import { emailSchema, passwordSchema, phoneSchema } from '@/features/auth/schema'
import { ROLE_LABELS } from '@/lib/rbac'

/**
 * Every role that can be given to a member of staff.
 *
 * This was four hard-coded names, and the Staff screen has offered nine since
 * the back-office roles were added: `assignableRoles` put Accountant and
 * Inventory manager in the dropdown, and this Zod enum rejected them on
 * submit. An owner picking Accountant got a validation error naming a field
 * they had filled in correctly, and the permission sets for those roles sat in
 * `rbac.ts` with no user able to hold them.
 *
 * Derived from `ROLE_LABELS` — the list of roles that exist — minus the two
 * nobody is ever *assigned*: OWNER comes from registering the restaurant, and
 * SUPER_ADMIN is the platform operator and belongs to no restaurant. The real
 * authority on who may grant what stays `assignableRoles`, which every action
 * checks; this only stops the schema from being the narrower gate.
 */
const STAFF_ROLES = (Object.keys(ROLE_LABELS) as Array<keyof typeof ROLE_LABELS>).filter(
  (role) => role !== 'OWNER' && role !== 'SUPER_ADMIN',
) as [keyof typeof ROLE_LABELS, ...Array<keyof typeof ROLE_LABELS>]

/**
 * Which location this person works at.
 *
 * `User.branchId` has been in the schema since the beginning and no screen ever
 * wrote it, so it was null for everyone. That is why nothing in the app could
 * be scoped to a site: every `?? user.branchId` fallback resolved to null, and
 * `visibleBranchIds` reads it to decide whether a manager runs one site or the
 * whole group.
 *
 * Empty means every location, and is stored as null. For a manager that is the
 * difference between a group manager and a site manager; for a single-site
 * restaurant it is simply the ordinary answer.
 */
const branchIdField = z.string().trim().max(40).optional().nullable()

/**
 * Extra locations this person may also work (staff.A.md §4).
 *
 * Beyond `branchId`, never instead of it: the home branch is still where their
 * shift opens and their drawer defaults, and `requiresOwnBranch` still insists
 * a floor role has one. This is the answer to "John covers Ampara and Kandy
 * but not Colombo", which one column could not express.
 *
 * Capped at 50 because a restaurant with more sites than that wants a
 * cross-location role, not fifty rows — and an unbounded array from a form is
 * an unbounded write.
 */
const extraBranchesField = z.array(z.string().trim().min(1).max(40)).max(50).optional()

export const inviteStaffSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(80),
  email: emailSchema,
  phone: phoneSchema.optional().or(z.literal('')),
  role: z.enum(STAFF_ROLES),
  branchId: branchIdField,
  branchIds: extraBranchesField,
  /**
   * A custom role, chosen at the same time as the person.
   *
   * It used to be a second step — create the account, reopen the row, use
   * "Custom access" — and the second step is the one people forget. A new hire
   * then works on preset defaults nobody chose for them.
   *
   * When one is given it carries its own base, so `role` above is derived from
   * it server-side rather than trusted from the form.
   */
  staffRoleId: z.string().cuid().optional().nullable(),
})
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>

export const updateStaffSchema = z.object({
  id: z.string().cuid(),
  name: z.string().trim().min(2).max(80),
  phone: phoneSchema.optional().or(z.literal('')),
  role: z.enum(STAFF_ROLES),
  isActive: z.coerce.boolean(),
  branchId: branchIdField,
  branchIds: extraBranchesField,
})
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>

export const customerSchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(2, 'Name is required').max(60),
  phone: phoneSchema,
  email: z.string().email().max(255).optional().or(z.literal('')),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  isBlocked: z.coerce.boolean().default(false),
})
export type CustomerInput = z.infer<typeof customerSchema>

export const adjustLoyaltySchema = z.object({
  customerId: z.string().cuid(),
  points: z.coerce.number().int(),
  /*
   * Required. A hand correction with no reason is the one ledger entry
   * nobody can explain later, and it is the entry most likely to be
   * questioned — the same rule stock adjustments have always had.
   */
  reason: z.string().trim().min(2, 'Give a reason for the adjustment').max(160),
})

export const couponSchema = z
  .object({
    id: z.string().cuid().optional(),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(3, 'Code must be at least 3 characters')
      .max(24)
      .regex(/^[A-Z0-9]+$/, 'Letters and numbers only'),
    description: z.string().trim().max(160).optional().or(z.literal('')),
    type: z.enum(['PERCENT', 'FIXED', 'FREE_ITEM']),
    value: z.coerce.number().int().min(1, 'Enter a value'),
    minOrderAmount: z.coerce.number().int().min(0).default(0),
    maxDiscount: z.coerce.number().int().min(0).optional().nullable(),
    startsAt: z.string().optional().or(z.literal('')),
    endsAt: z.string().optional().or(z.literal('')),
    usageLimit: z.coerce.number().int().min(0).optional().nullable(),
    perCustomerLimit: z.coerce.number().int().min(0).optional().nullable(),
    /**
     * Which location the code works at. Empty means everywhere.
     *
     * `Coupon.branchId` has existed and been enforced at redemption
     * (`customers/discounts.ts:78`) since it was added — and nothing in the app
     * could ever set it. Every coupon made through the UI was `null`, so the
     * check ran on every order and never once matched. Half a feature shipped;
     * this is the other half.
     */
    branchId: z.string().trim().max(40).optional().or(z.literal('')),
    isActive: z.coerce.boolean().default(true),
  })
  .refine((data) => data.type !== 'PERCENT' || data.value <= 10000, {
    message: 'Percentage cannot exceed 100%',
    path: ['value'],
  })
export type CouponInput = z.infer<typeof couponSchema>

export const replyReviewSchema = z.object({
  id: z.string().cuid(),
  reply: z.string().trim().min(1, 'Write a reply').max(500),
})

/**
 * An owner setting a member of staff's password by hand.
 *
 * Held to the same strength rules as any other password (`passwordSchema`), so
 * the manual route cannot become the weak one — the generated sign-in codes it
 * replaces are 8 characters of random.
 */
export const setStaffPasswordSchema = z.object({
  userId: z.string().min(1),
  password: passwordSchema,
})

/**
 * What one person may and may not do, on top of their role (staff.A.md §3).
 *
 * Two lists rather than a single tri-state map, because that is the shape the
 * screen reads back: "inherited + overrides = effective". `allow` adds to
 * whatever the role gives, `deny` takes away whatever granted it, and a key in
 * both is refused rather than silently resolved — an owner who has ticked
 * both has not decided yet, and picking one for them is how a revocation
 * quietly becomes a grant.
 */
export const staffPermissionsSchema = z
  .object({
    userId: z.string().cuid(),
    allow: z.array(z.string().trim().min(1).max(60)).max(400).default([]),
    deny: z.array(z.string().trim().min(1).max(60)).max(400).default([]),
  })
  .refine((value) => !value.allow.some((key) => value.deny.includes(key)), {
    message: 'A permission cannot be both allowed and denied',
    path: ['deny'],
  })
export type StaffPermissionsInput = z.infer<typeof staffPermissionsSchema>
