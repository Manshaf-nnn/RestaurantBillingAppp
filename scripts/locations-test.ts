/**
 * Locations, and the manager who runs one.
 *
 * Two things were true of this database before the change: twenty-four staff
 * accounts, of which two had a location; and a manager picker that existed only
 * on a location's *edit* page. Setting a site up properly meant creating the
 * location, leaving it, creating a person on the Staff screen, coming back and
 * joining the two — so in practice nobody did, and locations had nobody
 * answerable for them.
 *
 * What is asserted here:
 *
 * · Creating a location with a NEW manager makes exactly one ordinary
 *   `role: MANAGER` user — same shape the Staff screen produces, so sign-in,
 *   codes and RBAC keep working with nothing new to know about. The code it
 *   issues really opens the account (`verifyPassword`), which is the same
 *   contract `staff-login-test.ts` holds.
 * · It is ONE transaction. A duplicate email must not leave a half-made
 *   location behind, which is what a create-then-update pair would do.
 * · `User.branchId` is what actually scopes someone; `Branch.managerId` is, in
 *   this codebase's own words, "only a caption". Both are written, and both
 *   stay in step when a manager is later moved from the Staff screen — the
 *   one-way sync that used to leave a location claiming a manager it no longer
 *   had.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/locations-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { createLocationWithManager } from '../src/features/branches/service'
import { generateSignInCode, nextStaffCode } from '../src/features/staff/codes'
import { listLocations, listSwitchableLocations } from '../src/features/transfers/queries'
import { hashPassword, verifyPassword } from '../src/server/auth/password'
import { assignableRoles, canManageLocation, visibleBranchIds } from '../src/lib/rbac'

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

/** The credential helpers the action injects, wired the same way here. */
const credentials = {
  issueCredentials: async () => {
    const signInCode = generateSignInCode()
    return { signInCode, passwordHash: await hashPassword(signInCode) }
  },
  nextStaffCode: (tx: Parameters<typeof nextStaffCode>[0]) => nextStaffCode(tx, restaurantId),
}

let restaurantId = ''

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Loc ${stamp}`, slug: `locs-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  restaurantId = restaurant.id

  console.log('\n── a location with a brand-new manager ──')

  const kandy = await createLocationWithManager({
    restaurantId: restaurant.id,
    name: 'Kandy',
    code: 'kdy',
    type: 'BRANCH',
    phone: '0812222222',
    manager: { mode: 'NEW', name: 'Sunil Perera', email: `sunil-${stamp}@example.com` },
    ...credentials,
  })

  check('the location is created', Boolean(kandy.branch.id))
  check('the code is upper-cased', kandy.branch.code === 'KDY', kandy.branch.code)
  check('the type is set in the same write', kandy.branch.type === 'BRANCH', kandy.branch.type)
  check('the first location becomes the default', kandy.branch.isDefault === true)
  check('and a manager came back', Boolean(kandy.created))

  const sunil = await prisma.user.findUniqueOrThrow({
    where: { id: kandy.created!.userId },
  })
  check('the manager is an ordinary MANAGER account', sunil.role === 'MANAGER', sunil.role)
  check('confined to the new location', sunil.branchId === kandy.branch.id)
  check('with a staff code', sunil.staffCode?.startsWith('W-') === true, `${sunil.staffCode}`)
  check('and the location names them', kandy.branch.managerId === null, 'set after create, checked below')

  const branchAfter = await prisma.branch.findUniqueOrThrow({ where: { id: kandy.branch.id } })
  check('Branch.managerId points at them', branchAfter.managerId === sunil.id)

  /*
   * The credential contract, identical to staff-login-test.ts: the plaintext is
   * kept so a lost card can be reprinted, AND it is the password. If these ever
   * disagree the owner would hand over a code that does not work.
   */
  const code = kandy.created!.signInCode
  check('the code reads as XXXX-XXXX', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code)
  check('it is stored so it can be reprinted', sunil.signInCode === code)
  check(
    'and it actually opens the account',
    await verifyPassword(code, sunil.passwordHash),
    'the manager would be handed a code that does not work',
  )
  check('they skip email verification, like other staff', sunil.emailVerifiedAt !== null)

  console.log('\n── it is one transaction, not two writes ──')

  const before = await prisma.branch.count({ where: { restaurantId: restaurant.id } })

  await refuses(
    'a duplicate email is refused',
    () =>
      createLocationWithManager({
        restaurantId: restaurant.id,
        name: 'Galle',
        code: 'GAL',
        type: 'BRANCH',
        manager: { mode: 'NEW', name: 'Someone Else', email: sunil.email },
        ...credentials,
      }),
    /already has an account/i,
  )

  check(
    'and no half-made location is left behind',
    (await prisma.branch.count({ where: { restaurantId: restaurant.id } })) === before,
    'the location was created and the manager was not — the exact split the transaction prevents',
  )

  await refuses(
    'a duplicate code is refused',
    () =>
      createLocationWithManager({
        restaurantId: restaurant.id,
        name: 'Kandy Two',
        code: 'KDY',
        type: 'BRANCH',
        manager: { mode: 'NONE' },
        ...credentials,
      }),
    /already used/i,
  )

  console.log('\n── a location with somebody who already works here ──')

  const warehouse = await createLocationWithManager({
    restaurantId: restaurant.id,
    name: 'Central Warehouse',
    code: 'WH',
    type: 'CENTRAL_WAREHOUSE',
    manager: { mode: 'NONE' },
    ...credentials,
  })
  check('a second location is not the default', warehouse.branch.isDefault === false)
  check('and can have no manager', warehouse.branch.managerId === null)
  check('with its own type', warehouse.branch.type === 'CENTRAL_WAREHOUSE')

  const spare = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Kamala Silva',
      email: `kamala-${stamp}@example.com`,
      passwordHash: 'x',
      role: 'MANAGER',
    },
  })

  const galle = await createLocationWithManager({
    restaurantId: restaurant.id,
    name: 'Galle',
    code: 'GAL',
    type: 'BRANCH',
    manager: { mode: 'EXISTING', userId: spare.id },
    ...credentials,
  })

  const galleRow = await prisma.branch.findUniqueOrThrow({ where: { id: galle.branch.id } })
  check('the existing person is named', galleRow.managerId === spare.id)
  check('no new account is created', galle.created === null)

  const movedSpare = await prisma.user.findUniqueOrThrow({ where: { id: spare.id } })
  check(
    'and they are moved there, since they ran nowhere',
    movedSpare.branchId === galle.branch.id,
    `${movedSpare.branchId} — Branch.managerId alone is only a caption`,
  )

  console.log('\n── naming someone must not un-scope the site they already run ──')

  const matara = await createLocationWithManager({
    restaurantId: restaurant.id,
    name: 'Matara',
    code: 'MTR',
    type: 'BRANCH',
    // Sunil already runs Kandy.
    manager: { mode: 'EXISTING', userId: sunil.id },
    ...credentials,
  })

  const sunilAfter = await prisma.user.findUniqueOrThrow({ where: { id: sunil.id } })
  check(
    'Matara names them',
    (await prisma.branch.findUniqueOrThrow({ where: { id: matara.branch.id } })).managerId === sunil.id,
  )
  check(
    'but they still SEE Kandy, which they run',
    sunilAfter.branchId === kandy.branch.id,
    `${sunilAfter.branchId} — moving them would have silently changed what Kandy can see`,
  )

  console.log('\n── the switcher has something worth showing ──')

  const switchable = await listSwitchableLocations(restaurant.id)
  check('every active location is offered', switchable.length === 4, `${switchable.length}`)

  const kandyRow = switchable.find((l) => l.id === kandy.branch.id)
  check('with its manager named', kandyRow?.managerName === 'Sunil Perera', `${kandyRow?.managerName}`)
  check('and its headcount', (kandyRow?.staffCount ?? 0) >= 1, `${kandyRow?.staffCount}`)

  const unmanaged = switchable.find((l) => l.id === warehouse.branch.id)
  check('a location with nobody says so rather than guessing', unmanaged?.managerName === null)

  const cards = await listLocations(restaurant.id)
  const kandyCard = cards.find((l) => l.id === kandy.branch.id)
  check('the list card carries the manager too', kandyCard?.managerName === 'Sunil Perera')
  check('and marks the default', kandyCard?.isDefault === true)

  console.log('\n── who may create a manager ──')

  check('an owner may', assignableRoles('OWNER').includes('MANAGER'))
  check('an admin may', assignableRoles('ADMIN').includes('MANAGER'))
  check(
    'a manager may not create another manager',
    !assignableRoles('MANAGER').includes('MANAGER'),
    'a stolen manager account could mint a permanent one',
  )
  check('a waiter may create nobody', assignableRoles('WAITER').length === 0)

  check(
    'and only a role that can run a site is offered as one',
    canManageLocation({ role: 'MANAGER' }) && !canManageLocation({ role: 'WAITER' }),
  )

  console.log('\n── a named manager is genuinely confined ──')

  check(
    'they see only their own location',
    JSON.stringify(visibleBranchIds({ role: 'MANAGER', branchId: kandy.branch.id })) ===
      JSON.stringify([kandy.branch.id]),
  )
  check(
    'while a manager with no location sees the group',
    visibleBranchIds({ role: 'MANAGER', branchId: null }) === null,
  )

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
