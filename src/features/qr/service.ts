import 'server-only'

import type { Prisma, QrExperience, QrExperienceField } from '@prisma/client'

import { requireBranch } from '@/features/branches/service'
import { findOrCreateCustomer } from '@/features/customers/service'
import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { newPublicId } from './public-id'
import { BUILT_IN_FIELDS, fieldsFor, isBuiltInKey, readIdList } from './queries'

/**
 * The rules behind a QR experience (ar.md).
 *
 * Nothing here decides a price, a discount, a point or a stock movement — the
 * existing services do all of that. What this owns is: which configuration is
 * legal to save, and what happens when a guest answers the owner's questions.
 */

/* ── Saving the configuration ───────────────────────────────────────────── */

export interface FieldInput {
  key: string
  label: string
  type: 'TEXT' | 'PHONE' | 'EMAIL' | 'DATE' | 'NUMBER'
  rule: 'HIDDEN' | 'OPTIONAL' | 'REQUIRED'
  /** Null = asked of everyone; set = only after that customer category is picked. */
  categoryId: string | null
  sortOrder: number
}

export interface SaveExperienceInput {
  name: string
  description?: string | null
  branchId: string
  type: 'ORDERING' | 'MENU_ONLY'
  /** False for a code with no table behind it (ar.md §3). */
  askTable: boolean
  menuMode: 'ALL' | 'CUSTOM'
  menuCategoryIds: string[]
  menuFoodIds: string[]
  identifyCustomer: boolean
  askCustomerCategory: boolean
  customerCategoryIds: string[]
  showSearch: boolean
  showPrices: boolean
  showOffers: boolean
  showLoyalty: boolean
  fields: FieldInput[]
}

/**
 * Create the smallest thing that works (ar.md §21).
 *
 * A name and a branch, and every other answer left at its default: ordering,
 * the whole menu, nobody asked for anything. That reproduces the existing QR
 * behaviour exactly, which is what §2 and §21 between them require — the owner
 * gets a working code before they have configured a single thing.
 */
export async function createExperience(params: {
  restaurantId: string
  branchId: string
  name: string
  type?: 'ORDERING' | 'MENU_ONLY'
}): Promise<QrExperience> {
  const name = params.name.trim()
  if (!name) throw new AppError('Give this QR menu a name', 400, 'QR_NO_NAME')
  await requireBranch(params.restaurantId, params.branchId)

  return prisma.qrExperience.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      publicId: newPublicId(),
      name,
      type: params.type ?? 'ORDERING',
    },
  })
}

/**
 * Save the whole configuration in one transaction.
 *
 * Fields are replaced wholesale rather than diffed: the editor sends the list
 * it is showing, and a field the owner deleted must actually go. They carry no
 * history worth preserving — the answers live on the customer, not here.
 */
export async function saveExperience(params: {
  restaurantId: string
  experienceId: string
  input: SaveExperienceInput
}): Promise<QrExperience> {
  const existing = await prisma.qrExperience.findFirst({
    where: { id: params.experienceId, restaurantId: params.restaurantId },
    select: { id: true },
  })
  if (!existing) throw new NotFoundError('QR menu')

  const input = params.input
  const name = input.name.trim()
  if (!name) throw new AppError('Give this QR menu a name', 400, 'QR_NO_NAME')
  await requireBranch(params.restaurantId, input.branchId)

  const fields = normaliseFields(input)
  await assertCategoriesExist(params.restaurantId, [
    ...input.customerCategoryIds,
    ...fields.map((field) => field.categoryId).filter((id): id is string => id !== null),
  ])

  return prisma.$transaction(async (tx) => {
    await tx.qrExperienceField.deleteMany({ where: { experienceId: params.experienceId } })
    if (fields.length > 0) {
      await tx.qrExperienceField.createMany({
        data: fields.map((field) => ({ ...field, experienceId: params.experienceId })),
      })
    }
    return tx.qrExperience.update({
      where: { id: params.experienceId },
      data: {
        name,
        description: input.description?.trim() || null,
        branchId: input.branchId,
        type: input.type,
        askTable: input.askTable,
        menuMode: input.menuMode,
        menuCategoryIds: input.menuCategoryIds,
        menuFoodIds: input.menuFoodIds,
        identifyCustomer: input.identifyCustomer,
        askCustomerCategory: input.askCustomerCategory,
        customerCategoryIds: input.customerCategoryIds,
        showSearch: input.showSearch,
        showPrices: input.showPrices,
        showOffers: input.showOffers,
        showLoyalty: input.showLoyalty,
      },
    })
  })
}

/**
 * The one configuration that cannot be allowed to save.
 *
 * `findOrCreateCustomer` refuses without a phone number, so an experience that
 * identifies customers while hiding the phone box can never create anybody:
 * the category would have nowhere to go and every custom answer would be
 * dropped on the floor. Rather than fail silently at the table, it is refused
 * here, where the owner is looking at the switch that caused it.
 */
function normaliseFields(input: SaveExperienceInput): Array<Omit<FieldInput, never> & { isBuiltIn: boolean }> {
  if (!input.identifyCustomer) return []

  const seen = new Set<string>()
  const fields = input.fields
    .map((field) => ({
      key: field.key.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''),
      label: field.label.trim(),
      type: field.type,
      rule: field.rule,
      categoryId: field.categoryId,
      sortOrder: field.sortOrder,
    }))
    .filter((field) => {
      if (!field.key || !field.label) return false
      const id = `${field.key}::${field.categoryId ?? ''}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    .map((field) => ({ ...field, isBuiltIn: isBuiltInKey(field.key) }))

  const phone = fields.find((field) => field.key === 'phone' && field.categoryId === null)
  if (!phone || phone.rule === 'HIDDEN') {
    throw new AppError(
      'A phone number is how a customer is recognised — keep it at least optional, or turn off “Ask who they are”',
      400,
      'QR_PHONE_REQUIRED',
    )
  }
  if (fields.length > 40) {
    throw new AppError('That is more questions than anybody will answer at a table', 400, 'QR_TOO_MANY_FIELDS')
  }
  return fields
}

async function assertCategoriesExist(restaurantId: string, ids: string[]): Promise<void> {
  const wanted = [...new Set(ids.filter(Boolean))]
  if (wanted.length === 0) return
  const found = await prisma.customerCategory.count({
    where: { restaurantId, id: { in: wanted } },
  })
  if (found !== wanted.length) {
    throw new AppError('One of those customer categories no longer exists', 404, 'QR_CATEGORY_MISSING')
  }
}

/** Retire or bring back (ar.md §18 — deactivate, never delete). */
export async function setExperienceActive(params: {
  restaurantId: string
  experienceId: string
  isActive: boolean
}): Promise<QrExperience> {
  const updated = await prisma.qrExperience.updateMany({
    where: { id: params.experienceId, restaurantId: params.restaurantId },
    data: { isActive: params.isActive },
  })
  if (updated.count === 0) throw new NotFoundError('QR menu')
  return prisma.qrExperience.findUniqueOrThrow({ where: { id: params.experienceId } })
}

/**
 * A new printed code for the same experience (ar.md §17).
 *
 * The row's `id` does not move, so every order and customer already pointing
 * here keeps pointing here. Only the public handle changes — which is the
 * whole reason the two are separate columns.
 */
export async function regeneratePublicId(params: {
  restaurantId: string
  experienceId: string
}): Promise<QrExperience> {
  const updated = await prisma.qrExperience.updateMany({
    where: { id: params.experienceId, restaurantId: params.restaurantId },
    data: { publicId: newPublicId() },
  })
  if (updated.count === 0) throw new NotFoundError('QR menu')
  return prisma.qrExperience.findUniqueOrThrow({ where: { id: params.experienceId } })
}

/** The default question set an owner gets when they first switch identification on. */
export function starterFields(): FieldInput[] {
  return BUILT_IN_FIELDS.slice(0, 2).map((field, index) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    rule: field.key === 'phone' ? 'REQUIRED' : 'OPTIONAL',
    categoryId: null,
    sortOrder: index,
  }))
}

/* ── The guest answering ────────────────────────────────────────────────── */

/**
 * How much of a stranger's typing is kept (ar.md §25).
 *
 * `Customer.profile` is written from an unauthenticated endpoint, so it is
 * capped in every direction and only accepts keys the owner actually defined
 * on this experience. Without that it is an unbounded Json column anybody with
 * the printed code can grow.
 */
const MAX_PROFILE_KEYS = 20
const MAX_KEY_LENGTH = 64
const MAX_VALUE_LENGTH = 200

export interface ProfileAnswer {
  label: string
  value: string
  at: string
}

/**
 * Merge, never replace.
 *
 * A guest who comes back and fills one box must not erase what they told us
 * last time — the second visit knows less than the first, not more.
 */
export function capProfile(
  existing: Prisma.JsonValue | null,
  additions: Record<string, ProfileAnswer>,
): Record<string, ProfileAnswer> {
  /*
   * Read defensively: this column has been written by earlier versions of this
   * code and by nothing else, but it is still a Json column on a public path,
   * so anything that is not a well-formed answer is dropped rather than trusted.
   */
  const next: Record<string, ProfileAnswer> = {}
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [key, entry] of Object.entries(existing)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const row = entry as Record<string, unknown>
      if (typeof row.label !== 'string' || typeof row.value !== 'string') continue
      next[key] = { label: row.label, value: row.value, at: typeof row.at === 'string' ? row.at : '' }
    }
  }

  for (const [key, answer] of Object.entries(additions)) {
    if (key.length > MAX_KEY_LENGTH) continue
    if (!(key in next) && Object.keys(next).length >= MAX_PROFILE_KEYS) continue
    next[key] = {
      label: answer.label.slice(0, MAX_KEY_LENGTH),
      value: answer.value.slice(0, MAX_VALUE_LENGTH),
      at: answer.at,
    }
  }
  return next
}

export interface EnterResult {
  /**
   * The customer's CANONICAL stored name and phone — not what was just typed.
   *
   * `placeOrder` upserts by the exact phone string and overwrites the name
   * every time, so the cart must send these back verbatim. A regular called
   * "Jonathan Perera" who types "Jon" at the table would otherwise be renamed
   * for good, and a blank name would rewrite them to "Guest".
   *
   * It is also what makes offers work: `quoteCart` looks a customer up by the
   * exact phone string, and without a `customerId` every category-targeted
   * coupon is refused.
   */
  customerId: string | null
  customerName: string
  customerPhone: string
  categoryId: string | null
  created: boolean
}

/**
 * A guest has answered the questions (ar.md §8).
 *
 * Straight into the existing CRM: `findOrCreateCustomer` matches on the digits
 * of the phone, so `077 123 4567` and `0771234567` are one person, and it never
 * overwrites a name that is already there. No second customer database, and no
 * duplicate row for somebody who has eaten here before.
 */
export async function enterExperience(params: {
  experience: { id: string; restaurantId: string; identifyCustomer: boolean; askCustomerCategory: boolean }
  fields: QrExperienceField[]
  categoryId: string | null
  answers: Record<string, string>
}): Promise<EnterResult> {
  const { experience } = params

  if (!experience.identifyCustomer) {
    return { customerId: null, customerName: '', customerPhone: '', categoryId: null, created: false }
  }

  const categoryId = experience.askCustomerCategory ? params.categoryId : null
  const asked = fieldsFor(params.fields, categoryId)

  const value = (key: string) => (params.answers[key] ?? '').trim()

  // Everything the owner marked required must actually be there (§5).
  for (const field of asked) {
    if (field.rule === 'REQUIRED' && !value(field.key)) {
      throw new AppError(`${field.label} is needed`, 400, 'QR_FIELD_REQUIRED')
    }
  }

  const phone = value('phone')
  if (!phone) {
    /*
     * No phone, no record — the existing rule, not a new one. A shared
     * anonymous customer row is what `findOrCreateCustomer`'s `allowBlank`
     * exists to prevent, and pooling every unidentified guest onto one record
     * was a real bug in this system's past.
     */
    return { customerId: null, customerName: value('name'), customerPhone: '', categoryId, created: false }
  }

  const match = await findOrCreateCustomer({
    restaurantId: experience.restaurantId,
    allowBlank: true,
    input: {
      phone,
      name: value('name') || null,
      email: value('email') || null,
      categoryId,
      birthday: readDate(value('birthday')),
      anniversary: readDate(value('anniversary')),
    },
  })
  if (!match) {
    return { customerId: null, customerName: value('name'), customerPhone: '', categoryId, created: false }
  }

  // The owner's own questions, filed beside the customer (§9, §23).
  const now = new Date().toISOString()
  const custom: Record<string, ProfileAnswer> = {}
  for (const field of asked) {
    if (field.isBuiltIn) continue
    const answer = value(field.key)
    if (answer) custom[field.key] = { label: field.label, value: answer, at: now }
  }

  const data: Prisma.CustomerUpdateInput = {}
  if (Object.keys(custom).length > 0) {
    data.profile = capProfile(match.customer.profile, custom) as unknown as Prisma.InputJsonValue
  }
  /*
   * The category is set whenever the guest chose one — including for somebody
   * who already existed, because "I am a student" is news about them, and §8
   * says to update the existing profile by the CRM's own rules.
   */
  if (categoryId && match.customer.categoryId !== categoryId) {
    data.category = { connect: { id: categoryId } }
  }
  /*
   * Where they came from is written once, on the record this code created.
   * A regular who later scans the Student QR did not "come from" it.
   */
  if (match.created && !match.customer.sourceQrExperienceId) {
    data.sourceQrExperience = { connect: { id: experience.id } }
  }

  const customer =
    Object.keys(data).length > 0
      ? await prisma.customer.update({ where: { id: match.customer.id }, data })
      : match.customer

  return {
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    categoryId: customer.categoryId,
    created: match.created,
  }
}

function readDate(raw: string): Date | null {
  if (!raw) return null
  const parsed = new Date(`${raw}T00:00:00.000Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Somebody opened this code (ar.md §18, §22).
 *
 * "Opened", not "scanned": nothing can tell a camera from a forwarded link.
 * Fired once per browser session from the client rather than counted during a
 * server render, which would count prefetches, crawlers and link previews.
 */
export async function recordOpen(publicId: string): Promise<void> {
  await prisma.qrExperience.updateMany({
    where: { publicId, isActive: true },
    data: { openCount: { increment: 1 }, lastOpenedAt: new Date() },
  })
}

/** The ids an experience references, for the editor's pickers. */
export function readExperienceIds(experience: {
  menuCategoryIds: Prisma.JsonValue | null
  menuFoodIds: Prisma.JsonValue | null
  customerCategoryIds: Prisma.JsonValue | null
}): { menuCategoryIds: string[]; menuFoodIds: string[]; customerCategoryIds: string[] } {
  return {
    menuCategoryIds: readIdList(experience.menuCategoryIds),
    menuFoodIds: readIdList(experience.menuFoodIds),
    customerCategoryIds: readIdList(experience.customerCategoryIds),
  }
}
