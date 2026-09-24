/**
 * Demo data for the Transfers screen — LOCAL ONLY.
 *
 * The screen was rebuilt around five figures, a filter bar, a table and a
 * drawer, and the demo restaurant has one branch and no transfers, so there is
 * nothing on it to look at. This makes a second location and a spread of
 * transfers across every status, so each stat card, each status pill, the
 * filters and the pagination all have something behind them.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 *
 * It moves no stock. A transfer that has been dispatched or received really
 * did shift inventory, and inventing those ledger movements would put the
 * demo restaurant's stock figures out by whatever these rows claim. So the
 * transfers are written as records only: the list, the drawer and the filters
 * read exactly what they would, and the stock side of the demo stays honest.
 *
 * That has one consequence worth knowing before you click: DISPATCHED rows
 * here can be received through the UI and will then post real stock movements
 * for items that never left anywhere. Fine on a local demo database, which is
 * the only place this is meant to run.
 *
 * Run:    npx tsx --tsconfig tsconfig.test.json scripts/demo-transfers.ts
 * Remove: npx tsx --tsconfig tsconfig.test.json scripts/demo-transfers.ts --clean
 */
import { readFileSync } from 'node:fs'

import type { TransferStatus } from '@prisma/client'

import { prisma } from '../src/server/db/prisma'

const OWNER_EMAIL = 'owner@restaurantos.dev'

/**
 * Local database only — the same rule `scripts/guard-local-db.mjs` applies to
 * `prisma db push`, and for the same reason.
 *
 * This script INVENTS a location and fourteen transfers. Against a real
 * restaurant that is fabricated stock movement history sitting in the middle
 * of their records, which nobody would thank us for and which `--clean` only
 * partly undoes. The owner email would usually not exist in production, but
 * "usually" is not a safety mechanism.
 */
function assertLocalDatabase() {
  const raw =
    process.env.DATABASE_URL ??
    ['.env.local', '.env']
      .map((file) => {
        try {
          return readFileSync(file, 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.+)$/m)?.[1]
        } catch {
          return undefined
        }
      })
      .find(Boolean)
      ?.trim()
      .replace(/^["']|["']$/g, '')

  if (!raw) {
    throw new Error('DATABASE_URL is not set — refusing to write demo rows into the unknown.')
  }

  let host = ''
  try {
    host = new URL(raw).hostname
  } catch {
    throw new Error('DATABASE_URL is not a valid URL, so its host cannot be checked.')
  }

  const LOCAL = ['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'postgres', 'db']
  if (!LOCAL.includes(host) && !host.endsWith('.local')) {
    throw new Error(
      `Refusing to write demo transfers into ${host}. This script is for a local demo database only.`,
    )
  }
}
/** Every row this script makes carries it, so `--clean` can find them again. */
const MARK = '[demo]'

async function main() {
  assertLocalDatabase()
  const clean = process.argv.includes('--clean')

  const owner = await prisma.user.findFirst({
    where: { email: OWNER_EMAIL },
    select: { id: true, name: true, restaurantId: true },
  })
  if (!owner) {
    console.log(`No ${OWNER_EMAIL} on this database — nothing to do.`)
    return
  }
  // Nullable on `User` — a platform admin belongs to no restaurant.
  const restaurantId = owner.restaurantId
  if (!restaurantId) {
    console.log(`${OWNER_EMAIL} belongs to no restaurant — nothing to do.`)
    return
  }

  if (clean) {
    const removed = await prisma.stockTransfer.deleteMany({
      where: { restaurantId, notes: { contains: MARK } },
    })
    console.log(`Removed ${removed.count} demo transfer(s). The second location is left alone.`)
    return
  }

  /* ── A second place to move stock to ──────────────────────────────────── */
  const main = await prisma.branch.findFirstOrThrow({
    where: { restaurantId, deletedAt: null, type: 'BRANCH' },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true },
  })

  let second = await prisma.branch.findFirst({
    where: { restaurantId, code: 'BEACH', deletedAt: null },
    select: { id: true, name: true },
  })
  if (!second) {
    second = await prisma.branch.create({
      data: {
        restaurantId,
        name: 'Beach Road',
        code: 'BEACH',
        type: 'BRANCH',
        isActive: true,
        address: 'Beach Road, Colombo',
      },
      select: { id: true, name: true },
    })
    console.log(`Created a second location: ${second.name}`)
  }

  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId },
    select: { id: true, name: true, unit: true },
    orderBy: { name: 'asc' },
    take: 8,
  })
  if (items.length === 0) {
    console.log('No inventory items on this restaurant — add a few first.')
    return
  }

  const staff = await prisma.user.findMany({
    where: { restaurantId, deletedAt: null },
    select: { id: true, name: true },
    take: 4,
  })
  const who = (index: number) => staff[index % staff.length] ?? { id: owner.id, name: owner.name }

  const existing = await prisma.stockTransfer.count({ where: { restaurantId, notes: { contains: MARK } } })
  if (existing > 0) {
    console.log(`${existing} demo transfer(s) already here. Run with --clean first to rebuild them.`)
    return
  }

  /*
   * One row per state the screen can show, plus enough repeats to fill a
   * second page. Dates walk backwards a day at a time so the date filters and
   * the quick ranges have something to separate.
   */
  const plan: Array<{
    status: TransferStatus
    daysAgo: number
    lines: number
    reverse?: boolean
    variance?: boolean
    note: string
  }> = [
    { status: 'REQUESTED', daysAgo: 0, lines: 4, note: 'Weekend top-up' },
    { status: 'APPROVED', daysAgo: 0, lines: 3, note: 'Ready to send this evening' },
    { status: 'DISPATCHED', daysAgo: 1, lines: 5, note: 'Daily stock run' },
    { status: 'IN_TRANSIT', daysAgo: 1, lines: 2, note: 'On the van' },
    { status: 'RECEIVED', daysAgo: 2, lines: 6, note: 'Checked in by the morning shift' },
    { status: 'COMPLETED', daysAgo: 3, lines: 4, note: 'Signed off' },
    { status: 'RECEIVED', daysAgo: 4, lines: 3, variance: true, note: 'Two cases short on arrival' },
    { status: 'COMPLETED', daysAgo: 5, lines: 2, reverse: true, note: 'Returned surplus' },
    { status: 'CANCELLED', daysAgo: 6, lines: 3, note: 'No longer needed' },
    { status: 'REJECTED', daysAgo: 7, lines: 2, note: 'Cannot spare it this week' },
    { status: 'COMPLETED', daysAgo: 9, lines: 5, note: 'Weekly replenishment' },
    { status: 'COMPLETED', daysAgo: 12, lines: 3, reverse: true, note: 'Rebalanced after the weekend' },
    { status: 'DISPATCHED', daysAgo: 14, lines: 4, note: 'Event stock' },
    { status: 'COMPLETED', daysAgo: 18, lines: 6, note: 'Month-start delivery' },
  ]

  const seq = await nextNumber(restaurantId)
  let made = 0

  for (const [index, entry] of plan.entries()) {
    const at = new Date()
    at.setDate(at.getDate() - entry.daysAgo)
    at.setHours(9 + (index % 9), (index * 7) % 60, 0, 0)

    const from = entry.reverse ? second : main
    const to = entry.reverse ? main : second
    const requester = who(index)
    const mover = who(index + 1)

    const reached = (status: TransferStatus) =>
      ['APPROVED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIVED', 'COMPLETED'].indexOf(entry.status) >=
      ['APPROVED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIVED', 'COMPLETED'].indexOf(status)

    const sent = reached('DISPATCHED')
    const got = reached('RECEIVED')

    await prisma.stockTransfer.create({
      data: {
        restaurantId,
        number: `TR-${String(seq + index).padStart(5, '0')}`,
        fromBranchId: from.id,
        toBranchId: to.id,
        status: entry.status,
        notes: `${entry.note} ${MARK}`,
        requestedById: requester.id,
        requestedAt: at,
        createdAt: at,
        ...(reached('APPROVED')
          ? { approvedById: mover.id, approvedAt: new Date(at.getTime() + 30 * 60_000) }
          : {}),
        ...(sent ? { dispatchedById: mover.id, dispatchedAt: new Date(at.getTime() + 90 * 60_000) } : {}),
        ...(got ? { receivedById: requester.id, receivedAt: new Date(at.getTime() + 210 * 60_000) } : {}),
        ...(entry.status === 'REJECTED' ? { rejectReason: 'Cannot spare it this week' } : {}),
        lines: {
          create: Array.from({ length: entry.lines }, (_, line) => {
            const item = items[(index + line) % items.length]
            const requestedQty = 2 + ((index + line) % 9)
            // One line short on the variance row, the rest arriving in full.
            const short = entry.variance && line === 0 ? 2 : 0
            const sentQty = sent ? requestedQty : null
            const receivedQty = got ? requestedQty - short : null
            return {
              itemId: item.id,
              requestedQty,
              sentQty,
              receivedQty,
              unit: item.unit,
              ...(got && short > 0
                ? { variance: -short, varianceReason: 'MISSING' as const, varianceNote: 'Two cases not on the van' }
                : {}),
            }
          }),
        },
      },
    })
    made += 1
  }

  console.log(`Created ${made} demo transfers between ${main.name} and ${second.name}.`)
  console.log('Remove them again with:  npx tsx --tsconfig tsconfig.test.json scripts/demo-transfers.ts --clean')
}

/** Carry on from whatever numbering is already there, so nothing collides. */
async function nextNumber(restaurantId: string): Promise<number> {
  const last = await prisma.stockTransfer.findFirst({
    where: { restaurantId },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const digits = last?.number.match(/(\d+)$/)?.[1]
  return digits ? Number(digits) + 1 : 115
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
