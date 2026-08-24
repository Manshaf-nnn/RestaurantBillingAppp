/**
 * A link is an account. It has to be as hard to forge as one.
 *
 * ── What the old one did ────────────────────────────────────────────────────
 *
 * `GET /api/invite/accept?token=…` looked up the token, created a user called
 * "WAITER (shared link)" and handed out a 30-day session — and the record
 * behind it held four fields: token, role, expiry, active. No branch, so
 * `visibleBranchIds` returned `[]` and every screen the new account opened was
 * empty for ever with nothing anywhere to say why. No person, so the link was
 * the credential and forwarding the message forwarded the access. And the
 * creating endpoint cast `body.role` straight out of the request with no
 * check, so `{"role":"ADMIN"}` was one curl away for anybody holding
 * `staff.manage` — which every manager does.
 *
 * Sections 1 and 5 are written around those two: a personal link that refuses
 * the wrong code, and a shared-device link whose account actually has a branch.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/access-links-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { resolveLink, joinUrl, landingFor, stampUse } from '../src/features/access/links'
import { issueSignInCode } from '../src/features/staff/codes'
import { verifyPassword, generateToken } from '../src/server/auth/password'
import { visibleBranchIds, permissionsFor, ROLE_HOME, PERMISSIONS } from '../src/lib/rbac'

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

/** Assert that resolving a token is refused, and for the right reason. */
async function refuses(name: string, token: string, expect = /not valid|not active/i) {
  try {
    await resolveLink(token)
    check(name, false, 'it resolved')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

/**
 * The check `joinWithCode` performs, without a request scope.
 *
 * The action itself calls `enforceRateLimit` and `createSession`, both of which
 * need cookies and headers, so it cannot run here — that half is proved over
 * HTTP. What is proved here is the part that decides whether somebody gets in:
 * the email must belong to the account the LINK points at, and the code must
 * verify against that account's hash.
 */
async function credentialsMatch(token: string, email: string, code: string): Promise<boolean> {
  const link = await resolveLink(token).catch(() => null)
  if (!link || link.mode !== 'PERSONAL' || !link.userId) return false
  const person = await prisma.user.findFirst({
    where: { id: link.userId, deletedAt: null },
    select: { email: true, passwordHash: true, isActive: true },
  })
  if (!person || !person.isActive) return false
  if (person.email.toLowerCase() !== email.trim().toLowerCase()) return false
  const bare = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  const normalised = bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : code.trim().toUpperCase()
  return verifyPassword(normalised, person.passwordHash)
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Links ${stamp}`, slug: `links-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const second = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Branch 02', code: 'BR02' },
  })

  const waiter = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `nadia-${stamp}@test.local`,
      name: 'Nadia',
      passwordHash: 'x',
      role: 'WAITER',
      branchId: second.id,
    },
  })
  const code = await issueSignInCode(waiter.id)

  const stockRole = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id,
      name: `Stock Controller ${stamp}`,
      preset: 'WAREHOUSE_STAFF',
      branchId: second.id,
      permissions: [PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.TRANSFER_VIEW],
    },
  })

  const mkLink = (data: Record<string, unknown>) =>
    prisma.invite.create({
      data: {
        token: generateToken(24),
        restaurantId: restaurant.id,
        role: 'WAITER',
        ...data,
      } as never,
    })

  // ── 1. a personal link is not a credential on its own ─────────────────────
  console.log('\n── 1. a personal link needs the email and the code ──')

  const personal = await mkLink({
    mode: 'PERSONAL',
    userId: waiter.id,
    branchId: second.id,
    label: 'Nadia — Branch 02',
  })

  const resolved = await resolveLink(personal.token)
  check('the link resolves', resolved.mode === 'PERSONAL' && resolved.userId === waiter.id)
  check('and names its branch', resolved.branchName === 'Branch 02', `${resolved.branchName}`)
  check(
    'the URL is the /join route, not the old API redirect',
    joinUrl(personal.token).includes('/join/'),
    joinUrl(personal.token),
  )

  check('the right code is accepted', await credentialsMatch(personal.token, waiter.email, code))
  check(
    'and accepted without the dash, in lower case',
    await credentialsMatch(personal.token, waiter.email, code.replace('-', '').toLowerCase()),
  )
  check('a wrong code is refused', !(await credentialsMatch(personal.token, waiter.email, 'AAAA-BBBB')))
  check(
    'a wrong email is refused even with the right code',
    !(await credentialsMatch(personal.token, `someone-else-${stamp}@test.local`, code)),
  )

  /*
   * The one that matters: the link is bound to ONE account. Holding the URL
   * and somebody else's valid credentials must not get you in through it.
   */
  const other = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `raj-${stamp}@test.local`,
      name: 'Raj',
      passwordHash: 'x',
      role: 'KITCHEN',
      branchId: main.id,
    },
  })
  const otherCode = await issueSignInCode(other.id)
  check(
    "another person's valid code does not open this link",
    !(await credentialsMatch(personal.token, other.email, otherCode)),
  )

  // ── 2. expiry, revocation and switching off ───────────────────────────────
  console.log('\n── 2. every way a link stops working ──')

  const expired = await mkLink({
    mode: 'SHARED_DEVICE',
    branchId: main.id,
    expiresAt: new Date(Date.now() - 1000),
  })
  await refuses('an expired link is refused', expired.token)

  const disabled = await mkLink({ mode: 'SHARED_DEVICE', branchId: main.id, isActive: false })
  await refuses('a disabled link is refused', disabled.token)

  await refuses('a token that never existed is refused', `made-up-${stamp}`)

  check(
    'and all three say the same thing',
    await (async () => {
      const messages = await Promise.all(
        [expired.token, disabled.token, `made-up-${stamp}`].map((t) =>
          resolveLink(t).then(
            () => 'resolved',
            (e) => (e instanceof Error ? e.message : String(e)),
          ),
        ),
      )
      return new Set(messages).size === 1
    })(),
    'a different message per reason tells a guesser which guess was closest',
  )

  // ── 3. a suspended restaurant hands out nothing ───────────────────────────
  console.log('\n── 3. a suspended restaurant ──')

  await prisma.restaurant.update({ where: { id: restaurant.id }, data: { status: 'SUSPENDED' } })
  await refuses('a link into a suspended restaurant is refused', personal.token, /not active/i)
  await prisma.restaurant.update({ where: { id: restaurant.id }, data: { status: 'ACTIVE' } })
  check('and works again once it is live', Boolean(await resolveLink(personal.token)))

  // ── 4. a personal link dies with its person ───────────────────────────────
  console.log('\n── 4. a personal link follows the account ──')

  await prisma.user.update({ where: { id: waiter.id }, data: { isActive: false } })
  await refuses('a link to a switched-off account is refused', personal.token)
  await prisma.user.update({ where: { id: waiter.id }, data: { isActive: true } })
  check('and comes back when they do', Boolean(await resolveLink(personal.token)))

  // ── 5. a shared-device link carries a branch ──────────────────────────────
  console.log('\n── 5. the empty-screen bug ──')

  const device = await mkLink({
    mode: 'SHARED_DEVICE',
    role: 'KITCHEN',
    branchId: second.id,
    staffRoleId: stockRole.id,
    label: 'Kitchen tablet',
  })
  const deviceLink = await resolveLink(device.token)

  check('a shared link carries its branch', deviceLink.branchId === second.id)
  check('and its custom role', deviceLink.staffRoleId === stockRole.id)

  /*
   * The account such a link creates used to have no branch at all. For KITCHEN
   * that means `visibleBranchIds` returns [] — sees nothing — so the screen was
   * blank for ever. Asserting on the reach the link produces is asserting the
   * bug is gone.
   */
  const reachWithBranch = visibleBranchIds({ role: 'KITCHEN', branchId: deviceLink.branchId })
  const reachWithout = visibleBranchIds({ role: 'KITCHEN', branchId: null })
  check(
    'so its account sees exactly one location',
    Array.isArray(reachWithBranch) && reachWithBranch.length === 1,
    `${JSON.stringify(reachWithBranch)}`,
  )
  check(
    'where the old branchless account saw nothing',
    Array.isArray(reachWithout) && reachWithout.length === 0,
    'this is the empty-screen bug, kept as a regression guard',
  )

  // ── 6. a switched-off role is not silently applied ────────────────────────
  console.log('\n── 6. a switched-off role falls back ──')

  await prisma.staffRole.update({ where: { id: stockRole.id }, data: { isActive: false } })
  const withDeadRole = await resolveLink(device.token)
  check(
    'the role stops applying',
    withDeadRole.staffRoleId === null,
    'the same rule the session uses — demote, do not blind',
  )
  check(
    'and the preset still grants something',
    permissionsFor({ role: withDeadRole.role }).size > 0,
  )
  await prisma.staffRole.update({ where: { id: stockRole.id }, data: { isActive: true } })

  // ── 7. where a link lands ─────────────────────────────────────────────────
  console.log('\n── 7. landing ──')

  check('a kitchen link lands on the kitchen rail', landingFor('KITCHEN') === ROLE_HOME.KITCHEN)
  check('a waiter link on the waiter station', landingFor('WAITER') === '/waiter')

  // ── 8. use is recorded ────────────────────────────────────────────────────
  console.log('\n── 8. an unused link is visible as unused ──')

  const before = await prisma.invite.findUniqueOrThrow({ where: { id: device.id } })
  check('a fresh link has never been opened', before.lastUsedAt === null && before.useCount === 0)
  await stampUse(device.id)
  await stampUse(device.id)
  const after = await prisma.invite.findUniqueOrThrow({ where: { id: device.id } })
  check('opening it is counted', after.useCount === 2, `${after.useCount}`)
  check('and dated', after.lastUsedAt !== null)

  // ── 9. links are branch-scoped like everything else ───────────────────────
  console.log('\n── 9. an admin sees only their own location’s links ──')

  const { listAccessLinks } = await import('../src/features/access/links')

  const atSecond = await listAccessLinks(restaurant.id, [second.id])
  check(
    "Branch 02's list holds its own links",
    atSecond.some((l) => l.id === personal.id) && atSecond.some((l) => l.id === device.id),
  )
  check(
    "and none of Main's",
    !atSecond.some((l) => l.id === expired.id),
    'the expired link is pinned to Main',
  )

  const everywhere = await listAccessLinks(restaurant.id, null)
  check('an owner sees them all', everywhere.length >= 4, `${everywhere.length}`)

  const blind = await listAccessLinks(restaurant.id, [])
  check(
    'and a confined admin with no branch sees none',
    blind.length === 0,
    'an empty allow-list must never be read as "no filter"',
  )

  // ── cleanup ───────────────────────────────────────────────────────────────
  await prisma.invite.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.updateMany({
    where: { restaurantId: restaurant.id },
    data: { staffRoleId: null },
  })
  await prisma.staffRole.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
