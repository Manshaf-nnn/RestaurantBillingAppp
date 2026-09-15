/**
 * A task can name a person, and only a person you are allowed to name.
 *
 * ── The hole this closes before it opens ────────────────────────────────────
 *
 * correctionA.md §2 adds an assignee to an instruction, which means a new
 * client-supplied id reaching a write. Every one of those in this codebase is
 * validated against the caller's own restaurant before it is stored — the rule
 * `rememberBranch` and `assertBranchAccess` already follow — because the
 * alternative is not merely a bad row. Storing an unchecked user id and then
 * rendering `assigneeName` back into the task list turns the field into an
 * oracle: post another tenant's user id, read their name out of your own
 * screen. Section 2 posts exactly that.
 *
 * ── And the badge means something now ───────────────────────────────────────
 *
 * `countOpenInstructions` feeds the number beside "Things to do". Before
 * assignment, every open task at your location was yours to see and the count
 * was honest. With assignment it would quietly start including work sitting on
 * a colleague's plate, and a badge that counts other people's jobs is a badge
 * people learn to ignore. Section 3 pins what it counts.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/task-assignment-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  countOpenInstructions,
  createInstruction,
  listAssignableStaff,
  listInstructions,
} from '../src/features/instructions/service'

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
    data: { name: 'Tasks Co', slug: `tasks-${stamp}`, email: `tk-${stamp}@test.local` },
  })
  const other = await prisma.restaurant.create({
    data: { name: 'Rival Co', slug: `rival-${stamp}`, email: `rv-${stamp}@test.local` },
  })

  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true },
  })
  const jaffna = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Jaffna', code: 'JAF' },
  })
  const rivalBranch = await prisma.branch.create({
    data: { restaurantId: other.id, name: 'Rival Main', code: 'RM', isDefault: true },
  })

  const mk = (
    restaurantId: string,
    name: string,
    role: 'OWNER' | 'MANAGER' | 'CASHIER',
    branchId: string | null,
  ) =>
    prisma.user.create({
      data: {
        restaurantId,
        email: `${name.toLowerCase().replace(/\W/g, '')}-${stamp}@test.local`,
        name,
        passwordHash: 'x',
        role,
        branchId,
      },
    })

  const owner = await mk(restaurant.id, 'Owner', 'OWNER', null)
  const kandyCashier = await mk(restaurant.id, 'Kandy Cashier', 'CASHIER', kandy.id)
  const jaffnaCashier = await mk(restaurant.id, 'Jaffna Cashier', 'CASHIER', jaffna.id)
  const kandyManager = await mk(restaurant.id, 'Kandy Manager', 'MANAGER', kandy.id)
  const rivalOwner = await mk(other.id, 'Rival Owner', 'OWNER', null)

  console.log('\n── 1. Who an owner may hand work to ──')
  {
    const staff = await listAssignableStaff({ restaurantId: restaurant.id, user: owner })
    const names = staff.map((s) => s.name)

    check('an owner reaches every location', names.includes('Kandy Cashier') && names.includes('Jaffna Cashier'), names.join(', '))
    check(
      "and nobody from another restaurant",
      !names.includes('Rival Owner'),
      names.join(', '),
    )
    // §2 asks for "assignee + branch/location clearly", and this is the query
    // that has to supply the second half.
    check(
      'each one carries their location',
      staff.find((s) => s.name === 'Kandy Cashier')?.branch?.name === 'Kandy',
    )
  }

  console.log('\n── 2. A posted id is never trusted ──')
  {
    await refuses(
      "another restaurant's user cannot be assigned",
      () =>
        createInstruction({
          restaurantId: restaurant.id,
          user: owner,
          branchId: kandy.id,
          assigneeId: rivalOwner.id,
          title: 'Count the cold room',
          body: null,
          priority: 'NORMAL',
          dueAt: null,
        }),
      /not someone you can assign/i,
    )

    await refuses(
      'nor an id that is not a user at all',
      () =>
        createInstruction({
          restaurantId: restaurant.id,
          user: owner,
          branchId: kandy.id,
          assigneeId: 'made-up',
          title: 'Count the cold room',
          body: null,
          priority: 'NORMAL',
          dueAt: null,
        }),
      /not someone you can assign/i,
    )

    const deactivated = await mk(restaurant.id, 'Left Last Month', 'CASHIER', kandy.id)
    await prisma.user.update({ where: { id: deactivated.id }, data: { isActive: false } })
    await refuses(
      'nor somebody who no longer works here',
      () =>
        createInstruction({
          restaurantId: restaurant.id,
          user: owner,
          branchId: kandy.id,
          assigneeId: deactivated.id,
          title: 'Count the cold room',
          body: null,
          priority: 'NORMAL',
          dueAt: null,
        }),
      /not someone you can assign/i,
    )

    // Nothing was written by any of the three refusals.
    const count = await prisma.branchInstruction.count({ where: { restaurantId: restaurant.id } })
    check('and none of them left a row behind', count === 0, `${count}`)
  }

  console.log('\n── 3. What the badge counts ──')
  {
    const mine = await createInstruction({
      restaurantId: restaurant.id,
      user: owner,
      branchId: kandy.id,
      assigneeId: kandyCashier.id,
      title: 'Count the cold room',
      body: null,
      priority: 'NORMAL',
      dueAt: null,
    })
    check('an assigned task stores the name beside the id', mine.assigneeName === 'Kandy Cashier')

    await createInstruction({
      restaurantId: restaurant.id,
      user: owner,
      branchId: kandy.id,
      assigneeId: kandyManager.id,
      title: "Somebody else's job",
      body: null,
      priority: 'NORMAL',
      dueAt: null,
    })
    await createInstruction({
      restaurantId: restaurant.id,
      user: owner,
      branchId: kandy.id,
      assigneeId: null,
      title: 'Anyone at Kandy',
      body: null,
      priority: 'NORMAL',
      dueAt: null,
    })

    const forCashier = await countOpenInstructions({
      restaurantId: restaurant.id,
      user: kandyCashier,
    })
    /*
     * Two: the one with their name on it, and the one addressed to the
     * location. NOT the one given to the manager — that is the whole point.
     */
    check('the badge counts mine plus the unassigned', forCashier === 2, `${forCashier}`)

    const forManager = await countOpenInstructions({
      restaurantId: restaurant.id,
      user: kandyManager,
    })
    check('and counts the other way round for the other person', forManager === 2, `${forManager}`)

    // The list is unchanged: everyone at a location still SEES everything
    // there, because the person who does the job is often not the person the
    // note was addressed to. Only the count narrowed.
    const visible = await listInstructions({ restaurantId: restaurant.id, user: kandyCashier })
    check('but the list still shows the whole location', visible.length === 3, `${visible.length}`)
  }

  console.log('\n── 4. A task for nobody in particular still works ──')
  {
    const notice = await createInstruction({
      restaurantId: restaurant.id,
      user: owner,
      branchId: null,
      assigneeId: null,
      title: 'Prices go up on the 1st',
      body: null,
      priority: 'NORMAL',
      dueAt: null,
    })
    check('a group-wide notice needs no assignee', notice.assigneeId === null)
    check('and stores no name for one', notice.assigneeName === null)

    const jaffnaSees = await listInstructions({
      restaurantId: restaurant.id,
      user: jaffnaCashier,
    })
    check(
      'and reaches a location it was not addressed to',
      jaffnaSees.some((i) => i.title === 'Prices go up on the 1st'),
    )
  }

  console.log('\n── 5. Tenant isolation on the assignable list ──')
  {
    const theirs = await listAssignableStaff({ restaurantId: other.id, user: rivalOwner })
    check(
      "the other restaurant sees only its own staff",
      theirs.length === 1 && theirs[0]?.name === 'Rival Owner',
      theirs.map((s) => s.name).join(', '),
    )
    check('and none of ours', !theirs.some((s) => s.name.startsWith('Kandy')))
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: other.id } })
  void rivalBranch
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
