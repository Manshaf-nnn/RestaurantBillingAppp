/**
 * Demo data for the Approvals desk — LOCAL ONLY.
 *
 * The desk was rebuilt around five figures, a filter bar, one table with a
 * heading row per category, and a drawer. The demo restaurant has nothing
 * waiting, so there is nothing on it to look at: the empty state is all you
 * see. This raises a spread of requests across several categories so each stat
 * card, each group heading, the filters and the drawer all have something
 * behind them.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 *
 * It decides nothing and it moves nothing. Every row is a PENDING request, so
 * approving one from the screen runs the real consequence through the real
 * action — which is the point: the desk is worth testing precisely because the
 * buttons do something.
 *
 * The stock-transfer requests point at transfers that genuinely exist and are
 * genuinely awaiting approval, so approving one really does reserve the stock.
 * The petty cash and payment rows are their own records and cost nothing.
 *
 * Run:    npx tsx --tsconfig tsconfig.test.json scripts/demo-approvals.ts
 * Remove: npx tsx --tsconfig tsconfig.test.json scripts/demo-approvals.ts --clean
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'

const OWNER_EMAIL = 'owner@restaurantos.dev'

/**
 * Local database only — the same rule `scripts/guard-local-db.mjs` applies to
 * `prisma db push`, and for the same reason.
 *
 * This INVENTS requests for money and stock. Against a real restaurant that is
 * fabricated financial history sitting in the middle of their records, and
 * `--clean` only partly undoes it. The owner email would usually not exist in
 * production, but "usually" is not a safety mechanism.
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
      `Refusing to write demo approvals into ${host}. This script is for a local demo database only.`,
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
  const restaurantId = owner.restaurantId
  if (!restaurantId) {
    console.log(`${OWNER_EMAIL} belongs to no restaurant — nothing to do.`)
    return
  }

  if (clean) {
    const requests = await prisma.approvalRequest.deleteMany({
      where: { restaurantId, reason: { contains: MARK } },
    })
    const petty = await prisma.pettyCashRequest.deleteMany({
      where: { restaurantId, description: { contains: MARK } },
    })
    console.log(`Removed ${requests.count} approval request(s) and ${petty.count} petty cash request(s).`)
    return
  }

  const already = await prisma.approvalRequest.count({
    where: { restaurantId, reason: { contains: MARK } },
  })
  if (already > 0) {
    console.log(`${already} demo request(s) already here. Run with --clean first to rebuild them.`)
    return
  }

  const branches = await prisma.branch.findMany({
    where: { restaurantId, deletedAt: null, isActive: true, type: 'BRANCH' },
    select: { id: true, name: true },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    take: 2,
  })
  if (branches.length === 0) {
    console.log('No locations on this restaurant — nothing to raise a request against.')
    return
  }
  const [main, second = branches[0]] = branches

  const staff = await prisma.user.findMany({
    where: { restaurantId, deletedAt: null, isActive: true },
    select: { id: true, name: true },
    take: 4,
  })
  const who = (index: number) => staff[index % staff.length] ?? { id: owner.id, name: owner.name }

  let made = 0
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)

  /* ── Stock transfers ──────────────────────────────────────────────────────
   *
   * Pointed at transfers that are really waiting to be approved, so the drawer
   * shows their actual lines and approving one really reserves the stock.
   */
  const waiting = await prisma.stockTransfer.findMany({
    where: { restaurantId, status: 'REQUESTED' },
    select: { id: true, number: true, fromBranchId: true, toBranchId: true, requestedById: true },
    take: 2,
  })
  for (const [index, transfer] of waiting.entries()) {
    const existing = await prisma.approvalRequest.findFirst({
      where: { restaurantId, entity: 'StockTransfer', entityId: transfer.id, status: 'PENDING' },
    })
    if (existing) continue
    await prisma.approvalRequest.create({
      data: {
        restaurantId,
        // The SOURCE decides: it is the branch being asked to give up stock.
        branchId: transfer.fromBranchId,
        kind: 'STOCK_TRANSFER',
        entity: 'StockTransfer',
        entityId: transfer.id,
        status: 'PENDING',
        reason: `Weekend rush at the far end ${MARK}`,
        payload: { toBranchId: transfer.toBranchId, lines: 1 },
        requestedById: transfer.requestedById ?? who(index).id,
        createdAt: ago(40 + index * 90),
      },
    })
    made += 1
  }

  /* ── Refunds and discounts ────────────────────────────────────────────── */
  const generic: Array<{
    kind: 'REFUND' | 'DISCOUNT' | 'PRICE_OVERRIDE'
    branchId: string
    amount: number
    reason: string
    minutesAgo: number
  }> = [
    { kind: 'REFUND', branchId: main.id, amount: 1_450_00, reason: 'Guest sent the fish back — cooked through', minutesAgo: 25 },
    { kind: 'REFUND', branchId: second.id, amount: 620_00, reason: 'Order never collected; card already charged', minutesAgo: 220 },
    { kind: 'DISCOUNT', branchId: main.id, amount: 2_000_00, reason: 'Regular of eight years, birthday table', minutesAgo: 95 },
    { kind: 'DISCOUNT', branchId: second.id, amount: 850_00, reason: 'Long wait on a full house — comped the starters', minutesAgo: 310 },
    { kind: 'PRICE_OVERRIDE', branchId: main.id, amount: 300_00, reason: 'Set menu priced for a booked party of twelve', minutesAgo: 480 },
  ]

  for (const [index, row] of generic.entries()) {
    await prisma.approvalRequest.create({
      data: {
        restaurantId,
        branchId: row.branchId,
        kind: row.kind,
        entity: row.kind === 'PRICE_OVERRIDE' ? 'Food' : 'Order',
        entityId: null,
        amount: row.amount,
        status: 'PENDING',
        reason: `${row.reason} ${MARK}`,
        requestedById: who(index + 1).id,
        createdAt: ago(row.minutesAgo),
      },
    })
    made += 1
  }

  /* ── Petty cash ───────────────────────────────────────────────────────────
   *
   * Its own table and its own action, which is exactly why the desk groups it
   * separately from the generic queue.
   */
  const petty: Array<{
    amount: number
    category: string
    description: string
    minutesAgo: number
    branchId: string
  }> = [
    { amount: 4_500_00, category: 'Utilities', description: 'Gas cylinder, emergency refill', minutesAgo: 60, branchId: main.id },
    { amount: 1_200_00, category: 'Transport', description: 'Taxi for the late shift', minutesAgo: 150, branchId: second.id },
  ]
  for (const [index, row] of petty.entries()) {
    await prisma.pettyCashRequest.create({
      data: {
        restaurantId,
        branchId: row.branchId,
        amount: row.amount,
        // Free text on this table, not an enum — the form offers a list.
        category: row.category,
        description: `${row.description} ${MARK}`,
        status: 'PENDING',
        requestedById: who(index + 2).id,
        requestedAt: ago(row.minutesAgo),
      },
    })
    made += 1
  }

  console.log(`Raised ${made} request(s) across transfers, refunds, discounts and petty cash.`)
  console.log('Remove them again with:  npx tsx --tsconfig tsconfig.test.json scripts/demo-approvals.ts --clean')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
