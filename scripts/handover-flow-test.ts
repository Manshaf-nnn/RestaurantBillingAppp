/**
 * A till is handed to one person at a time, and the record of it is shown to
 * the people entitled to read it.
 *
 * ── What correctionA.md §11 adds to what was already here ─────────────────
 *
 * The handover already refused a self-handover, somebody who does not work a
 * till, and somebody at another location — those are checked below because
 * they must not regress, not because they are new.
 *
 * Two things were missing, and both produce the same bad afternoon: two people
 * each believing the drawer is coming to them.
 *
 *   · The same session could be offered twice. Whichever cashier accepts
 *     first takes the till; the other presses accept, is refused, and has
 *     already walked across the floor to do it.
 *   · The same person could be offered two different tills. Accepting either
 *     opens a session in their name that blocks the other.
 *
 * And the history was scoped by branch alone, so every cashier could read
 * every colleague's count and variance. Who was short last Tuesday is a
 * disciplinary matter between that person and their manager; it is not shift
 * information, and a screen that publishes it to the whole floor is a screen
 * people learn to be careful in front of.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/handover-flow-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { openDrawer } from '../src/features/cashdrawer/service'
import {
  acceptHandover,
  listHandovers,
  requestHandover,
} from '../src/features/handover/cash-service'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong reason: ${message}`)
  }
}

const stamp = Date.now().toString(36)

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Handover Co', slug: `hand-${stamp}`, email: `hd-${stamp}@test.local` },
  })
  const main_ = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Other', code: 'OTH' },
  })

  const mk = (name: string, role: 'CASHIER' | 'KITCHEN' | 'MANAGER', branchId: string) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        email: `${name.toLowerCase()}-${stamp}@test.local`,
        name,
        passwordHash: 'x',
        role,
        branchId,
      },
    })

  const alice = await mk('Alice', 'CASHIER', main_.id)
  const bob = await mk('Bob', 'CASHIER', main_.id)
  const cara = await mk('Cara', 'CASHIER', main_.id)
  const porter = await mk('Porter', 'KITCHEN', main_.id)
  const faraway = await mk('Faraway', 'CASHIER', other.id)
  const manager = await mk('Manager', 'MANAGER', main_.id)

  const actorFor = (u: typeof alice) => ({
    id: u.id,
    role: u.role,
    branchId: u.branchId,
    canManageOthers: u.role === 'MANAGER',
  })

  const openFor = async (u: typeof alice, float = 5_000_00) => {
    await openDrawer({
      restaurantId: restaurant.id,
      branchId: u.branchId!,
      openingFloat: float,
      userId: u.id,
      userBranchId: u.branchId,
    })
    return prisma.cashDrawerSession.findFirstOrThrow({
      where: { restaurantId: restaurant.id, openedById: u.id, status: 'OPEN' },
    })
  }

  const aliceSession = await openFor(alice)

  console.log('\n── 1. The refusals that already existed, and must not regress ──')
  {
    await refuses(
      'a till cannot be handed to yourself',
      () =>
        requestHandover({
          restaurantId: restaurant.id,
          sessionId: aliceSession.id,
          toUserId: alice.id,
          countedAmount: 5_000_00,
          userId: alice.id,
          actor: actorFor(alice),
        }),
      /somebody else/i,
    )

    await refuses(
      'nor to somebody who does not work a till',
      () =>
        requestHandover({
          restaurantId: restaurant.id,
          sessionId: aliceSession.id,
          toUserId: porter.id,
          countedAmount: 5_000_00,
          userId: alice.id,
          actor: actorFor(alice),
        }),
      /does not work a till/i,
    )

    await refuses(
      'nor to somebody at another location',
      () =>
        requestHandover({
          restaurantId: restaurant.id,
          sessionId: aliceSession.id,
          toUserId: faraway.id,
          countedAmount: 5_000_00,
          userId: alice.id,
          actor: actorFor(alice),
        }),
      /does not work at this location/i,
    )
  }

  console.log('\n── 2. One handover in flight at a time (§11) ──')
  {
    const first = await requestHandover({
      restaurantId: restaurant.id,
      sessionId: aliceSession.id,
      toUserId: bob.id,
      countedAmount: 5_000_00,
      userId: alice.id,
      actor: actorFor(alice),
    })
    check('the first one is raised', first.status === 'PENDING')

    /*
     * The same till offered twice was already impossible, and it is worth
     * recording WHY rather than assuming the new guard is what stops it:
     * raising a handover closes the outgoing session then and there, so the
     * second attempt is refused for a different and older reason. The guard
     * added for §11 is the one below.
     */
    await refuses(
      'the same till cannot be offered again — its session is already closed',
      () =>
        requestHandover({
          restaurantId: restaurant.id,
          sessionId: aliceSession.id,
          toUserId: cara.id,
          countedAmount: 5_000_00,
          userId: alice.id,
          actor: actorFor(alice),
        }),
      /already closed/i,
    )

    /*
     * The case that WAS possible: a second, different till offered to the
     * same person while they still have one waiting. Accepting either opens
     * a session in their name that blocks the other, so two colleagues each
     * believe Bob is taking their drawer.
     *
     * Cara can open at Main now because Alice's session was closed by the
     * handover above — the register is free.
     */
    const caraSession = await openFor(cara, 2_000_00)
    await refuses(
      'one person cannot be offered two tills at once',
      () =>
        requestHandover({
          restaurantId: restaurant.id,
          sessionId: caraSession.id,
          toUserId: bob.id,
          countedAmount: 2_000_00,
          userId: cara.id,
          actor: actorFor(cara),
        }),
      /already has a till waiting/i,
    )

    const pending = await prisma.cashHandover.count({
      where: { restaurantId: restaurant.id, status: 'PENDING' },
    })
    check('so exactly one is pending', pending === 1, String(pending))

    /*
     * And the one legitimately raised still completes. Cara's drawer is
     * closed first so the register is free for Bob's incoming session — the
     * uniqueness on the register key is a real constraint, not a test artefact.
     */
    await prisma.cashDrawerSession.updateMany({
      where: { id: caraSession.id },
      data: { status: 'CLOSED', closedAt: new Date(), activeRegisterKey: null, activeCashierKey: null },
    })

    const accepted = await acceptHandover({
      restaurantId: restaurant.id,
      handoverId: first.id,
      userId: bob.id,
      actor: actorFor(bob),
    })
    check('and the real one is accepted', accepted.handover.status === 'ACCEPTED', accepted.handover.status)
    const opened = await prisma.cashDrawerSession.findUniqueOrThrow({
      where: { id: accepted.sessionId },
    })
    check('which opens a session for the incoming cashier', opened.openedById === bob.id)
    check('carrying the count that was handed over as its float', opened.openingFloat === 5_000_00, String(opened.openingFloat))
  }

  console.log('\n── 3. Who may read the history (§11) ──')
  {
    const everything = await listHandovers({ restaurantId: restaurant.id })
    check('a manager sees every handover', everything.length >= 1, String(everything.length))

    const alices = await listHandovers({ restaurantId: restaurant.id, participantId: alice.id })
    check(
      'Alice sees the one she handed over',
      alices.length === 1 && alices[0]?.fromUserId === alice.id,
      String(alices.length),
    )

    const bobs = await listHandovers({ restaurantId: restaurant.id, participantId: bob.id })
    check('Bob sees the one he received', bobs.length === 1 && bobs[0]?.toUserId === bob.id)

    /*
     * The point of the filter: Cara was never part of it, and the count and
     * variance on that row are not hers to read.
     */
    const caras = await listHandovers({ restaurantId: restaurant.id, participantId: cara.id })
    check('and Cara, who was not involved, sees none of it', caras.length === 0, String(caras.length))
  }

  console.log('\n── 4. What is still to do, at the moment of handing over (§11) ──')
  {
    /*
     * §11 lists outstanding tasks among what a handover must show. The point
     * is not a new feature — it is putting the existing list at the one
     * moment somebody about to go home will read it.
     *
     * What matters here is that it is the SAME permission-filtered list, so
     * the handover screen cannot become a way to read another location's
     * instructions.
     */
    const { createInstruction, listInstructions } = await import(
      '../src/features/instructions/service'
    )
    const owner = await mk('Owner', 'MANAGER', main_.id)
    await prisma.user.update({ where: { id: owner.id }, data: { role: 'OWNER', branchId: null } })
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })

    await createInstruction({
      restaurantId: restaurant.id,
      user: ownerRow,
      branchId: main_.id,
      assigneeId: alice.id,
      title: 'Restock the napkins',
      body: null,
      priority: 'URGENT',
      dueAt: null,
    })
    await createInstruction({
      restaurantId: restaurant.id,
      user: ownerRow,
      branchId: other.id,
      assigneeId: null,
      title: "Another site's job",
      body: null,
      priority: 'NORMAL',
      dueAt: null,
    })

    const here = await listInstructions({
      restaurantId: restaurant.id,
      user: alice,
      branchId: main_.id,
      status: 'OPEN',
    })
    check(
      "the handover list shows this location's open task",
      here.some((t) => t.title === 'Restock the napkins'),
      here.map((t) => t.title).join(', '),
    )
    check(
      "and not another location's",
      !here.some((t) => t.title === "Another site's job"),
      here.map((t) => t.title).join(', '),
    )
    check(
      'with who it is on, so it can be said out loud',
      here.find((t) => t.title === 'Restock the napkins')?.assigneeName === 'Alice',
    )
  }

  console.log('\n── 5. Tenant isolation ──')
  {
    const elsewhere = await prisma.restaurant.create({
      data: { name: 'Rival', slug: `rivalh-${stamp}`, email: `rh-${stamp}@test.local` },
    })
    const theirs = await listHandovers({ restaurantId: elsewhere.id })
    check('another restaurant sees none of ours', theirs.length === 0, String(theirs.length))
    await prisma.restaurant.delete({ where: { id: elsewhere.id } })
  }

  await prisma.branchInstruction.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.cashHandover.deleteMany({ where: { restaurantId: restaurant.id } })
  // CashMovement hangs off the session, not the restaurant.
  await prisma.cashMovement.deleteMany({
    where: { session: { restaurantId: restaurant.id } },
  })
  await prisma.cashDrawerSession.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
