/**
 * The owner→branch channel, and who may touch a transfer.
 *
 * Two things are proved.
 *
 * ── Instructions ────────────────────────────────────────────────────────────
 * There was no way for an owner to tell a branch anything: they could read its
 * takings and move its stock, then had to ring someone. So the app held the
 * facts and WhatsApp held the decisions, and a month later nobody could say
 * whether the stock count they asked for was ever done.
 *
 * ── Transfer sides ──────────────────────────────────────────────────────────
 * The old rule was one line — access to the SOURCE on request, and nothing at
 * all on approve, dispatch, receive or close — and it was wrong in both
 * directions at once. A branch manager could not ask the warehouse for
 * anything, which is the one thing the screen exists for; and anyone holding
 * the permission could dispatch stock out of a location they have nothing to do
 * with. "May this person dispatch" was being asked without ever asking "whose".
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/instructions-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  cancelInstruction,
  completeInstruction,
  countOpenInstructions,
  createInstruction,
  listInstructions,
} from '../src/features/instructions/service'
import { assertTransferSide } from '../src/features/transfers/service'

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

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Inst ${stamp}`, slug: `inst-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true },
  })
  const colombo = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Colombo', code: 'CMB' },
  })
  const warehouse = await prisma.branch.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Warehouse',
      code: 'WH',
      type: 'CENTRAL_WAREHOUSE',
    },
  })

  const owner = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Owner',
      email: `owner-${stamp}@example.com`,
      passwordHash: 'x',
      role: 'OWNER',
    },
  })
  const kandyManager = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Kandy manager',
      email: `kdy-${stamp}@example.com`,
      passwordHash: 'x',
      role: 'MANAGER',
      branchId: kandy.id,
    },
  })
  const colomboManager = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Colombo manager',
      email: `cmb-${stamp}@example.com`,
      passwordHash: 'x',
      role: 'MANAGER',
      branchId: colombo.id,
    },
  })

  console.log('\n── an owner instructs a location ──')

  const task = await createInstruction({
    restaurantId: restaurant.id,
    user: owner,
    branchId: kandy.id,
    title: 'Count the cold room',
    body: 'Chicken and fish especially.',
    priority: 'URGENT',
    dueAt: null,
  })
  check('the instruction is created', Boolean(task.id))
  check('and it remembers who asked', task.createdByName === 'Owner', task.createdByName)

  const groupNotice = await createInstruction({
    restaurantId: restaurant.id,
    user: owner,
    branchId: null,
    title: 'Prices go up on the 1st',
    body: null,
    priority: 'NORMAL',
    dueAt: null,
  })

  const kandySees = await listInstructions({ restaurantId: restaurant.id, user: kandyManager })
  check('the Kandy manager sees what was addressed to them', kandySees.some((i) => i.id === task.id))
  check(
    'and the group-wide notice as well',
    kandySees.some((i) => i.id === groupNotice.id),
    'a notice for everyone reached nobody',
  )

  const colomboSees = await listInstructions({ restaurantId: restaurant.id, user: colomboManager })
  check(
    'the Colombo manager does not see Kandy’s',
    !colomboSees.some((i) => i.id === task.id),
    'one branch read another branch’s instructions',
  )
  check(
    'but does see the group notice',
    colomboSees.some((i) => i.id === groupNotice.id),
  )

  console.log('\n── and only an owner may write one ──')

  await refuses(
    'a site manager cannot instruct their own branch',
    () =>
      createInstruction({
        restaurantId: restaurant.id,
        user: kandyManager,
        branchId: kandy.id,
        title: 'Buy biscuits',
        body: null,
        priority: 'NORMAL',
        dueAt: null,
      }),
    /owner or group manager/i,
  )

  await refuses(
    'nor another branch’s',
    () =>
      createInstruction({
        restaurantId: restaurant.id,
        user: kandyManager,
        branchId: colombo.id,
        title: 'Do my washing up',
        body: null,
        priority: 'NORMAL',
        dueAt: null,
      }),
    /owner or group manager/i,
  )

  console.log('\n── the manager answers ──')

  const openBefore = await countOpenInstructions({ restaurantId: restaurant.id, user: kandyManager })
  check('two are outstanding for Kandy', openBefore === 2, `${openBefore}`)

  const done = await completeInstruction({
    restaurantId: restaurant.id,
    user: kandyManager,
    instructionId: task.id,
    note: '3kg of chicken short, wastage recorded.',
  })
  check('it is marked done', done.status === 'DONE', done.status)
  check('with a name against it', done.doneByName === 'Kandy manager', `${done.doneByName}`)
  check('and what they found', done.doneNote?.includes('3kg') === true, `${done.doneNote}`)

  const openAfter = await countOpenInstructions({ restaurantId: restaurant.id, user: kandyManager })
  check('the badge count drops', openAfter === 1, `${openAfter}`)

  // Two people ticking the same box is not an error worth showing anyone.
  const again = await completeInstruction({
    restaurantId: restaurant.id,
    user: owner,
    instructionId: task.id,
    note: 'me too',
  })
  check(
    'completing it twice is harmless and does not overwrite the first answer',
    again.doneByName === 'Kandy manager',
    `${again.doneByName}`,
  )

  await refuses(
    'a manager cannot complete another branch’s instruction',
    () =>
      completeInstruction({
        restaurantId: restaurant.id,
        user: colomboManager,
        instructionId: task.id,
        note: null,
      }),
    /another location/i,
  )

  await refuses(
    'and cannot withdraw one',
    () =>
      cancelInstruction({
        restaurantId: restaurant.id,
        user: kandyManager,
        instructionId: groupNotice.id,
      }),
    /owner or group manager/i,
  )

  const withdrawn = await cancelInstruction({
    restaurantId: restaurant.id,
    user: owner,
    instructionId: groupNotice.id,
  })
  check('the owner can', withdrawn.status === 'CANCELLED', withdrawn.status)

  console.log('\n── who may touch a transfer ──')

  const warehouseToKandy = { fromBranchId: warehouse.id, toBranchId: kandy.id }

  /*
   * The bug this replaces: `assertBranchAccess(user, fromBranchId)` on request.
   * A Kandy manager asking the warehouse for sugar was refused because they
   * have no access to the warehouse — so the pull-stock screen could not be
   * used by the only people who need it.
   */
  let ok = true
  try {
    assertTransferSide(kandyManager, warehouseToKandy, 'EITHER')
  } catch {
    ok = false
  }
  check('the receiving branch may ask for stock', ok, 'the whole point of the screen')

  await refuses(
    'but a third branch may not',
    async () => assertTransferSide(colomboManager, warehouseToKandy, 'EITHER'),
    /either location/i,
  )

  await refuses(
    'the receiving branch cannot approve its own request',
    async () => assertTransferSide(kandyManager, warehouseToKandy, 'SOURCE'),
    /sending location/i,
  )

  await refuses(
    'nor dispatch stock out of the warehouse',
    async () => assertTransferSide(kandyManager, warehouseToKandy, 'SOURCE'),
    /sending location/i,
  )

  let mayReceive = true
  try {
    assertTransferSide(kandyManager, warehouseToKandy, 'DESTINATION')
  } catch {
    mayReceive = false
  }
  check('but does receive it when the van arrives', mayReceive)

  await refuses(
    'and the sender cannot sign for its own delivery',
    async () =>
      assertTransferSide(
        { role: 'MANAGER', branchId: warehouse.id },
        warehouseToKandy,
        'DESTINATION',
      ),
    /receiving location/i,
  )

  let ownerAnywhere = true
  try {
    assertTransferSide(owner, warehouseToKandy, 'SOURCE')
    assertTransferSide(owner, warehouseToKandy, 'DESTINATION')
    assertTransferSide(owner, warehouseToKandy, 'EITHER')
  } catch {
    ownerAnywhere = false
  }
  check('an owner passes every side', ownerAnywhere)

  await prisma.notification.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branchInstruction.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
