/**
 * The transfer report reads what it claims to, and the tables screen with it.
 *
 * ── The regression this exists for ─────────────────────────────────────────
 *
 * The transfers export narrowed with `scopeToOne(selection)`, which returns
 * null whenever the viewer can reach more than one branch and has not picked
 * one — and a null branch applied no predicate at all. A manager confined to
 * two of five locations downloaded every transfer in the restaurant, from the
 * button directly above a screen that correctly showed only theirs.
 *
 * `scripts/transfer-report-test.ts` asserts the wiring at source level, which
 * is where that particular mistake is visible. This asserts the behaviour: run
 * the query with a reach and see what comes back.
 *
 * Section 6 covers the tables screen, where the card went from a count of open
 * orders — a number nobody acts on — to the dishes a table is still waiting
 * for. "Still coming" is `quantity − servedQty` per line, which is the only
 * definition that handles a line of three burgers with two already carried out.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/transfer-lines-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { listTransferLines, getTransferBoard, getTransferDetail } from '../src/features/transfers/queries'
import { servedCount, stillComing, type TableOrder } from '../src/features/floor/table-orders'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Lines ${stamp}`, slug: `lines-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const [kandy, jaffna, galle] = await Promise.all([
    prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true } }),
    prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Jaffna', code: 'JAF' } }),
    prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Galle', code: 'GAL' } }),
  ])
  const asha = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `asha-${stamp}@test.dev`, name: 'Asha',
      role: 'MANAGER', passwordHash: 'x',
    },
  })
  const raj = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `raj-${stamp}@test.dev`, name: 'Raj',
      role: 'MANAGER', passwordHash: 'x',
    },
  })

  const [chicken, rice] = await Promise.all([
    prisma.inventoryItem.create({
      data: { restaurantId: restaurant.id, name: 'Chicken', unit: 'KG', quantity: 0, costPerUnit: 500_00 },
    }),
    prisma.inventoryItem.create({
      data: { restaurantId: restaurant.id, name: 'Rice', unit: 'KG', quantity: 0, costPerUnit: 200_00 },
    }),
  ])

  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000)

  // Kandy → Jaffna, received in full, two lines.
  const full = await prisma.stockTransfer.create({
    data: {
      restaurantId: restaurant.id, number: `TR-A-${stamp}`,
      fromBranchId: kandy.id, toBranchId: jaffna.id, status: 'COMPLETED',
      requestedById: raj.id, requestedAt: day(2), createdAt: day(2),
      approvedById: asha.id, approvedAt: day(2),
      dispatchedById: asha.id, dispatchedAt: day(2),
      receivedById: raj.id, receivedAt: day(1),
      notes: 'Weekly run',
      lines: {
        create: [
          { itemId: chicken.id, requestedQty: 6, sentQty: 6, receivedQty: 6, unit: 'KG', unitCost: 500_00 },
          { itemId: rice.id, requestedQty: 10, sentQty: 10, receivedQty: 10, unit: 'KG', unitCost: 200_00 },
        ],
      },
    },
  })

  // Kandy → Jaffna, two cases short, with a reason.
  const short = await prisma.stockTransfer.create({
    data: {
      restaurantId: restaurant.id, number: `TR-B-${stamp}`,
      fromBranchId: kandy.id, toBranchId: jaffna.id, status: 'RECEIVED',
      requestedById: raj.id, requestedAt: day(5), createdAt: day(5),
      dispatchedById: asha.id, dispatchedAt: day(5),
      receivedById: raj.id, receivedAt: day(4),
      lines: {
        create: [
          {
            itemId: chicken.id, requestedQty: 8, sentQty: 8, receivedQty: 6, unit: 'KG',
            unitCost: 500_00, variance: -2, varianceReason: 'MISSING',
            varianceNote: 'Two cases not on the van',
          },
        ],
      },
    },
  })

  // Jaffna → Galle. Neither end is Kandy, so a Kandy manager must never see it.
  const elsewhere = await prisma.stockTransfer.create({
    data: {
      restaurantId: restaurant.id, number: `TR-C-${stamp}`,
      fromBranchId: jaffna.id, toBranchId: galle.id, status: 'COMPLETED',
      requestedById: raj.id, requestedAt: day(3), createdAt: day(3),
      lines: { create: [{ itemId: rice.id, requestedQty: 4, sentQty: 4, receivedQty: 4, unit: 'KG', unitCost: 200_00 }] },
    },
  })

  // Refused, with the reason that was stored and never read back anywhere.
  const rejected = await prisma.stockTransfer.create({
    data: {
      restaurantId: restaurant.id, number: `TR-D-${stamp}`,
      fromBranchId: kandy.id, toBranchId: jaffna.id, status: 'REJECTED',
      requestedById: raj.id, requestedAt: day(9), createdAt: day(9),
      rejectReason: 'Cannot spare it this week',
      lines: { create: [{ itemId: chicken.id, requestedQty: 3, unit: 'KG', unitCost: 500_00 }] },
    },
  })

  /* ── 1. Branch isolation ─────────────────────────────────────────────────── */
  console.log('\n1. A viewer sees only what touches a branch they can reach')

  const everywhere = await listTransferLines({
    restaurantId: restaurant.id, branchIds: null, filter: {},
  })
  check('an unconfined viewer sees all four transfers', everywhere.totals.transfers === 4, `${everywhere.totals.transfers}`)
  // 2 + 1 + 1 + 1. The row is the LINE, which is the whole point.
  check('as five lines', everywhere.totals.lines === 5, `${everywhere.totals.lines}`)

  const atKandy = await listTransferLines({
    restaurantId: restaurant.id, branchIds: [kandy.id], filter: {},
  })
  const kandyNumbers = new Set(atKandy.rows.map((r) => r.number))
  check(
    'a Kandy manager sees the three that touch Kandy',
    atKandy.totals.transfers === 3,
    [...kandyNumbers].join(', '),
  )
  check(
    'and NOT the one between Jaffna and Galle — the leak',
    !kandyNumbers.has(elsewhere.number),
  )

  const twoOfThree = await listTransferLines({
    restaurantId: restaurant.id, branchIds: [kandy.id, galle.id], filter: {},
  })
  check(
    'somebody reaching two of three branches sees only their two',
    twoOfThree.totals.transfers === 4,
    'Kandy’s three plus the Jaffna→Galle one, which touches Galle',
  )

  const nowhere = await listTransferLines({
    restaurantId: restaurant.id, branchIds: [], filter: {},
  })
  check('an empty reach returns nothing — a real answer, not a missing one', nowhere.rows.length === 0)

  /* ── 2. The filters ──────────────────────────────────────────────────────── */
  console.log('\n2. Every filter narrows the file the way it narrows the screen')

  const done = await listTransferLines({
    restaurantId: restaurant.id, branchIds: null, filter: { status: 'DONE_GROUP' },
  })
  check(
    'status: the received/completed group excludes the rejected one',
    !done.rows.some((r) => r.number === rejected.number) && done.totals.transfers === 3,
  )

  const variance = await listTransferLines({
    restaurantId: restaurant.id, branchIds: null, filter: { status: 'VARIANCE' },
  })
  check(
    'status: VARIANCE finds only the short one',
    variance.totals.transfers === 1 && variance.rows[0]?.number === short.number,
  )

  const fromKandy = await listTransferLines({
    restaurantId: restaurant.id, branchIds: null, filter: { fromBranchId: kandy.id },
  })
  check('from: only transfers leaving Kandy', fromKandy.rows.every((r) => r.fromName === 'Kandy'))

  const toGalle = await listTransferLines({
    restaurantId: restaurant.id, branchIds: null, filter: { toBranchId: galle.id },
  })
  check('to: only transfers arriving at Galle', toGalle.rows.every((r) => r.toName === 'Galle'))

  const riceOnly = await listTransferLines({
    restaurantId: restaurant.id, branchIds: null, filter: { itemId: rice.id },
  })
  check(
    'item: only transfers that move rice',
    riceOnly.totals.transfers === 2 && riceOnly.rows.some((r) => r.itemName === 'Rice'),
  )

  const searched = await listTransferLines({
    restaurantId: restaurant.id, branchIds: null, filter: { search: 'Weekly run' },
  })
  check('search: finds it by the note', searched.rows.every((r) => r.number === full.number))

  const windowed = await listTransferLines({
    restaurantId: restaurant.id,
    branchIds: null,
    filter: { fromAt: day(6), toAt: day(0) },
  })
  check(
    'dates: the nine-day-old one is outside a six-day window',
    !windowed.rows.some((r) => r.number === rejected.number),
  )
  check(
    'and the resolved instants win over the date strings',
    (
      await listTransferLines({
        restaurantId: restaurant.id,
        branchIds: null,
        // A string range that would include everything, overridden by instants.
        filter: { from: '2000-01-01', to: '2099-01-01', fromAt: day(6), toAt: day(0) },
      })
    ).rows.every((r) => r.number !== rejected.number),
  )

  /* ── 3. What the row carries ─────────────────────────────────────────────── */
  console.log('\n3. The row answers "what moved, who signed for it, what went missing"')

  const shortLine = (await listTransferLines({
    restaurantId: restaurant.id, branchIds: null, filter: { status: 'VARIANCE' },
  })).rows[0]

  check('the item and its unit', shortLine.itemName === 'Chicken' && shortLine.unit === 'KG')
  check('all three quantities', shortLine.requestedQty === 8 && shortLine.sentQty === 8 && shortLine.receivedQty === 6)
  check('the variance, its reason and its note', shortLine.variance === -2 && shortLine.varianceReason === 'MISSING' && shortLine.varianceNote === 'Two cases not on the van')
  check('who dispatched it and who signed for it', shortLine.dispatchedByName === 'Asha' && shortLine.receivedByName === 'Raj')
  check(
    'and the value on what ARRIVED, not what was sent: 6 × 500.00',
    shortLine.lineValue === 6 * 500_00,
    `${shortLine.lineValue}`,
  )

  const fullLines = (await listTransferLines({
    restaurantId: restaurant.id, branchIds: null, filter: { search: 'Weekly run' },
  }))
  check(
    'a transfer with two lines produces two rows, both carrying its people',
    fullLines.rows.length === 2 && fullLines.rows.every((r) => r.approvedByName === 'Asha'),
  )
  check(
    'and the totals add the lines up: (6 × 500) + (10 × 200)',
    fullLines.totals.value === 6 * 500_00 + 10 * 200_00,
    `${fullLines.totals.value}`,
  )

  /* ── 4. The detail the printable note needs ──────────────────────────────── */
  console.log('\n4. The printable note has what the screen used to drop')

  const detail = await getTransferDetail({ restaurantId: restaurant.id, transferId: rejected.id })
  check(
    'the reject reason is returned — it was stored and never read back',
    detail.rejectReason === 'Cannot spare it this week',
  )
  const line = detail.lines[0]
  check('the line names its item id, unit cost and value', Boolean(line.itemId) && line.unitCost === 500_00 && line.lineValue === 3 * 500_00)
  check('and its variance note field exists even when empty', line.varianceNote === null)

  /* ── 5. Screen and file run the same predicate ───────────────────────────── */
  console.log('\n5. The board and the report cannot disagree')

  for (const filter of [
    {},
    { status: 'DONE_GROUP' },
    { fromBranchId: kandy.id },
    { itemId: rice.id },
    { search: 'Weekly run' },
  ]) {
    const board = await getTransferBoard({
      restaurantId: restaurant.id, branchIds: [kandy.id], filter: { ...filter, perPage: 100 },
    })
    const lines = await listTransferLines({
      restaurantId: restaurant.id, branchIds: [kandy.id], filter,
    })
    const onScreen = new Set(board.rows.map((r) => r.number))
    const inFile = new Set(lines.rows.map((r) => r.number))
    check(
      `the same transfers on screen and in the file for ${JSON.stringify(filter)}`,
      onScreen.size === inFile.size && [...onScreen].every((n) => inFile.has(n)),
      `screen ${[...onScreen].join(',')} · file ${[...inFile].join(',')}`,
    )
  }

  /* ── 6. What a table is still waiting for ────────────────────────────────── */
  console.log('\n6. The tables card shows what is still coming, not a count')

  const order = (id: string, items: TableOrder['items']): TableOrder => ({
    id,
    orderNumber: id,
    status: 'ACCEPTED',
    placedAt: new Date().toISOString(),
    items,
  })

  function plate(
    id: string,
    name: string,
    quantity: number,
    preparedQty: number,
    servedQty: number,
    status = 'QUEUED',
  ) {
    return { id, name, quantity, preparedQty, servedQty, status }
  }

  const table: TableOrder[] = [
    // Fully served: nothing is owed, so it must not appear.
    order('o1', [plate('i1', 'Soup', 2, 2, 2, 'SERVED')]),
    order('o2', [
      // Half a line: one still owed, and only one spare made — not ready to carry.
      plate('i2', 'Burger', 3, 2, 2, 'PREPARING'),
      // Everything made and nothing carried: ready.
      plate('i3', 'Pizza', 1, 1, 0, 'READY'),
      // Not started.
      plate('i4', 'Fries', 2, 0, 0, 'QUEUED'),
      // Voided: owed to nobody.
      plate('i5', 'Cake', 1, 0, 0, 'CANCELLED'),
    ]),
  ]

  const coming = stillComing(table)
  const byName = new Map(coming.map((l) => [l.name, l]))

  check('a fully served line is not still coming', !byName.has('Soup'))
  check('a cancelled line is not still coming', !byName.has('Cake'))
  check('three lines are still owed', coming.length === 3, coming.map((l) => l.name).join(', '))
  check(
    'the half-served burger shows ONE outstanding, not three',
    byName.get('Burger')?.outstanding === 1,
    `${byName.get('Burger')?.outstanding}`,
  )
  check(
    'and reads as still cooking — two made, two carried, one to go',
    byName.get('Burger')?.state === 'PREPARING',
    byName.get('Burger')?.state,
  )
  check('the pizza is ready to carry', byName.get('Pizza')?.state === 'READY')
  check(
    'the fries are queued',
    byName.get('Fries')?.state === 'QUEUED' && byName.get('Fries')?.outstanding === 2,
  )
  check(
    'the served count spans every open order and skips the void',
    servedCount(table) === 4,
    `${servedCount(table)}`,
  )

  /*
   * The trap: enough made to cover what is owed, even though the line is not
   * finished. Three ordered, two carried out, three made — the last one is
   * ready to go NOW, and a waiter told otherwise makes a wasted trip.
   */
  const spare = stillComing([order('o3', [plate('i6', 'Curry', 3, 3, 2, 'PREPARING')])])
  check(
    'a line is ready when enough is made to cover what is still owed',
    spare[0]?.state === 'READY' && spare[0]?.outstanding === 1,
    `${spare[0]?.state} · ${spare[0]?.outstanding}`,
  )

  check('a table with no orders is owed nothing', stillComing([]).length === 0 && servedCount([]) === 0)

  /*
   * Transfer lines hold `onDelete: Restrict` against their item, so the
   * cascade from the restaurant cannot reach them. Clear them first.
   */
  await prisma.stockTransferLine.deleteMany({ where: { transfer: { restaurantId: restaurant.id } } })
  await prisma.stockTransfer.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exitCode = failed > 0 ? 1 : 0
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
