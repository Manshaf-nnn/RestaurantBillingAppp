import 'server-only'

import { prisma } from '@/server/db/prisma'
import { LK, formatForGateway, isMobile, toE164 } from '@/features/sms/msisdn'

import { buildSegmentWhere, type CustomerSegment } from './segments'

/**
 * The customers' phone numbers, as a list that leaves the building.
 *
 * ── What goes in the file ───────────────────────────────────────────────────
 *
 * Numbers an SMS or WhatsApp tool can use as they are: E.164 without the
 * plus (`94771234567`). No plus, because the CSV writer defends against
 * spreadsheet formulas by quoting a leading `+`, and because every bulk
 * tool accepts digits. Anything `toE164` refuses — blank, too short, an
 * ambiguous local shape — is left out and counted, not guessed at; a
 * blocked customer is left out; with `mobileOnly` a landline is left out.
 * The same number written two ways (`0771234567`, `+94771234567`) is one
 * entry.
 *
 * ── Which customers ─────────────────────────────────────────────────────────
 *
 * Exactly the screen's: the page's segment (search, visit and spend filters,
 * kind) through `buildSegmentWhere`, at the branches this person may see,
 * narrowed by the category the owner picked — including "no category",
 * which the page itself cannot select.
 */

export const EXPORT_LIMIT = 10_000

export type CategoryFilter = { kind: 'all' } | { kind: 'none' } | { kind: 'one'; id: string }

export interface CustomerNumberRow {
  name: string
  /** Digits only, country code first: 94771234567. */
  number: string
  category: string | null
  group: string
  lastOrderAt: string | null
}

export interface CustomerNumbersResult {
  rows: CustomerNumberRow[]
  skipped: { invalid: number; blocked: number; landline: number; duplicate: number }
  /** True when the cap cut the list short. */
  truncated: boolean
}

/** `?category=` as the page sends it: empty = all, `none` = uncategorised, else an id. */
export function categoryFilterFrom(raw: string | undefined | null): CategoryFilter {
  const value = (raw ?? '').trim()
  if (!value) return { kind: 'all' }
  if (value === 'none') return { kind: 'none' }
  return { kind: 'one', id: value }
}

export async function listCustomerNumbers(params: {
  restaurantId: string
  branchIds: string[] | null
  segment: CustomerSegment
  category: CategoryFilter
  mobileOnly: boolean
  includeBlocked?: boolean
}): Promise<CustomerNumbersResult> {
  const { category } = params
  const where = buildSegmentWhere({
    restaurantId: params.restaurantId,
    branchIds: params.branchIds,
    // The category is decided here, not by the page's own filter.
    segment: { ...params.segment, categoryId: undefined },
  })

  const customers = await prisma.customer.findMany({
    where: {
      AND: [
        where,
        category.kind === 'none' ? { categoryId: null } : category.kind === 'one' ? { categoryId: category.id } : {},
        params.includeBlocked ? {} : { isBlocked: false },
        { phoneKey: { not: null } },
      ],
    },
    orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    // One over the cap, so "was it cut short" is a fact rather than a guess.
    take: EXPORT_LIMIT + 1,
    select: {
      name: true,
      phone: true,
      group: true,
      lastOrderAt: true,
      category: { select: { name: true } },
    },
  })

  const truncated = customers.length > EXPORT_LIMIT
  const skipped = { invalid: 0, blocked: 0, landline: 0, duplicate: 0 }
  const seen = new Set<string>()
  const rows: CustomerNumberRow[] = []

  for (const customer of customers.slice(0, EXPORT_LIMIT)) {
    const parsed = toE164(customer.phone, LK)
    if (!parsed.ok) {
      skipped.invalid += 1
      continue
    }
    if (params.mobileOnly && !isMobile(parsed.e164, LK)) {
      skipped.landline += 1
      continue
    }
    const number = formatForGateway(parsed.e164, 'e164NoPlus', LK)
    if (seen.has(number)) {
      skipped.duplicate += 1
      continue
    }
    seen.add(number)
    rows.push({
      name: customer.name,
      number,
      category: customer.category?.name ?? null,
      group: customer.group,
      lastOrderAt: customer.lastOrderAt?.toISOString() ?? null,
    })
  }

  if (!params.includeBlocked) {
    skipped.blocked = await prisma.customer.count({
      where: {
        AND: [
          where,
          category.kind === 'none' ? { categoryId: null } : category.kind === 'one' ? { categoryId: category.id } : {},
          { isBlocked: true },
        ],
      },
    })
  }

  return { rows, skipped, truncated }
}

/** The plain-text shape: one number per line, nothing else, so it pastes anywhere. */
export function numbersAsText(rows: CustomerNumberRow[]): string {
  return rows.map((row) => row.number).join('\r\n') + (rows.length ? '\r\n' : '')
}
