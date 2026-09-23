/**
 * One sign-in link per role, and a way to hand the counter over.
 *
 * ── The two gaps ────────────────────────────────────────────────────────────
 *
 * A link could already name a custom role — `Invite.staffRoleId` has existed
 * since custom roles did — but neither MODE did what a role needs. PERSONAL is
 * one named person, so a ten-person kitchen needed ten links and another one
 * every time somebody joined. SHARED_DEVICE asks for no credential at all, so
 * the whole shift shares one synthetic account and the audit trail cannot say
 * who did anything. Section 2 is written against that: it signs two different
 * people in through ONE link, each with their own code, and expects two
 * different sessions.
 *
 * And the second: the edge gate sent anybody with a live session away from the
 * login page, so on a shared till the next person could not reach the form at
 * all — they were dropped into the app as whoever worked the last shift.
 * Section 5 pins the escape.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/role-link-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { resolveLink } from '../src/features/access/links'
import { issueSignInCode } from '../src/features/staff/codes'
import { verifyPassword } from '../src/server/auth/password'

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
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.invite.deleteMany({ where: { restaurantId: id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.staffRole.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

/**
 * What `joinWithRole` checks, replayed.
 *
 * The action itself needs cookies and a redirect, neither of which exists in a
 * script — so the two decisions it makes are asserted here directly, exactly
 * as `access-links-test` does for the personal flow.
 */
async function admits(link: Awaited<ReturnType<typeof resolveLink>>, email: string, code: string) {
  const person = await prisma.user.findFirst({
    where: { restaurantId: link.restaurantId, email: email.trim().toLowerCase(), deletedAt: null },
    select: { id: true, passwordHash: true, isActive: true, role: true, staffRoleId: true },
  })
  if (!person || !person.isActive) return false
  if (!(await verifyPassword(code, person.passwordHash))) return false
  return link.staffRoleId ? person.staffRoleId === link.staffRoleId : person.role === link.role
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: 'Links Co', slug: `links-${stamp}`, email: `links-${stamp}@test.local`,
      status: 'ACTIVE', isActive: true, currency: 'LKR', timezone: 'Asia/Colombo',
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })

  const seniorPos = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id, name: `Senior POS ${stamp}`, preset: 'POS',
      branchId: branch.id, isActive: true,
      permissions: ['dashboard.view', 'order.view', 'order.create', 'payment.collect'],
    },
  })
  const kitchen = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id, name: `Kitchen ${stamp}`, preset: 'KITCHEN',
      branchId: branch.id, isActive: true, permissions: ['kitchen.view', 'order.view'],
    },
  })

  const person = (name: string, role: 'POS' | 'KITCHEN', staffRoleId: string | null) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `${name}-${stamp}@test.local`, name,
        passwordHash: 'x', role, branchId: branch.id, staffRoleId,
        emailVerifiedAt: new Date(), isActive: true,
      },
    })

  const nila = await person('nila', 'POS', seniorPos.id)
  const ravi = await person('ravi', 'POS', seniorPos.id)
  // Same preset, NOT the same custom role — the case a preset-only check misses.
  const plainPos = await person('plain', 'POS', null)
  const cook = await person('cook', 'KITCHEN', kitchen.id)

  const codes = {
    nila: await issueSignInCode(nila.id),
    ravi: await issueSignInCode(ravi.id),
    plain: await issueSignInCode(plainPos.id),
    cook: await issueSignInCode(cook.id),
  }

  console.log('\n── 1. A role carries one link, for everybody on it ──')
  const invite = await prisma.invite.create({
    data: {
      token: `role-${stamp}-token-aaaaaaaaaaaa`,
      restaurantId: restaurant.id,
      role: seniorPos.preset,
      mode: 'ROLE',
      branchId: branch.id,
      staffRoleId: seniorPos.id,
      userId: null,
      label: seniorPos.name,
    },
  })
  const link = await resolveLink(invite.token)
  check('it resolves', link.mode === 'ROLE')
  check('it names the role, not a person', link.staffRoleId === seniorPos.id && link.userId === null)
  check('and its location', link.branchId === branch.id)

  console.log('\n── 2. Two different people, one link, their own credentials ──')
  {
    check('Nila is admitted with her own code', await admits(link, nila.email, codes.nila))
    check('Ravi is admitted with his', await admits(link, ravi.email, codes.ravi))
    // Written to fail against PERSONAL, which admits exactly one userId.
    check(
      'and they are two different accounts',
      nila.id !== ravi.id && nila.staffRoleId === ravi.staffRoleId,
    )
    check('a wrong code is refused', !(await admits(link, nila.email, 'WRON-GCDE')))
    check("somebody else's code does not work as Nila", !(await admits(link, nila.email, codes.ravi)))
  }

  console.log('\n── 3. The role is a filter, so it never promotes ──')
  {
    check('a cook is refused', !(await admits(link, cook.email, codes.cook)))
    /*
     * The one a preset-only check gets wrong: same built-in role, not on the
     * custom role the link is for.
     */
    check('a plain POS user is refused too', !(await admits(link, plainPos.email, codes.plain)))

    const after = await prisma.user.findUniqueOrThrow({ where: { id: cook.id } })
    check('and nothing about them was changed', after.staffRoleId === kitchen.id && after.role === 'KITCHEN')

    const source = readFileSync('src/features/access/join-actions.ts', 'utf8')
    const body = source.slice(source.indexOf('export async function joinWithRole'))
    check(
      'the action writes nothing to the account',
      !body.includes('prisma.user.update'),
      'a role link must admit, never promote',
    )
  }

  console.log('\n── 4. Switching the role off closes its door ──')
  {
    await prisma.staffRole.update({ where: { id: seniorPos.id }, data: { isActive: false } })
    await refuses(
      'the link stops resolving',
      () => resolveLink(invite.token),
      /not valid any more/i,
    )
    await prisma.staffRole.update({ where: { id: seniorPos.id }, data: { isActive: true } })
    const back = await resolveLink(invite.token)
    check('and switching it back on reopens it', back.staffRoleId === seniorPos.id)

    // A deleted role is switched off in the same write, so it is covered too.
    const actions = readFileSync('src/features/access/actions.ts', 'utf8')
    check(
      'deleting a role switches it off, which the guard reads',
      /deletedAt: new Date\(\), isActive: false/.test(actions),
    )
  }

  console.log('\n── 5. A second person can reach the login form ──')
  {
    /*
     * The bug: `if (staffClaims) return redirect('/dashboard')` on every auth
     * page. On a shared till the next cashier was dropped into the app as
     * whoever was still signed in, and there was no route to the form.
     */
    const middleware = readFileSync('src/middleware.ts', 'utf8')
    check("'?switch=1' is honoured", middleware.includes("get('switch') === '1'"))
    check(
      'and it is what lets the form render',
      /if \(staffClaims && !switching\) return NextResponse\.redirect/.test(middleware),
    )

    // Discoverable, or it may as well not exist.
    for (const shell of [
      'src/features/dashboard/components/dashboard-shell.tsx',
      'src/components/ops-shell.tsx',
    ]) {
      check(
        `${shell.split('/').pop()} offers it`,
        readFileSync(shell, 'utf8').includes('/login?switch=1'),
      )
    }

    const page = readFileSync('src/app/(auth)/login/page.tsx', 'utf8')
    check('and the form says who is already signed in', page.includes('is signed in on this device'))

    /*
     * The other half of the same complaint: the branch switcher's cookie
     * outlives a sign-out, so the next person opened the app on the last
     * one's location — and a write with no URL reads that same cookie.
     */
    const session = readFileSync('src/server/auth/session.ts', 'utf8')
    check(
      'a new sign-in clears the last person’s branch',
      session.includes('store.delete(BRANCH_COOKIE)'),
    )
    check(
      'and it is cleared where every sign-in ends, not in one of five doors',
      session.indexOf('store.delete(BRANCH_COOKIE)') > session.indexOf('export async function createSession'),
    )
  }

  console.log('\n── 6. A role link comes with the role ──')
  {
    const actions = readFileSync('src/features/access/actions.ts', 'utf8')
    check('creating a role mints one', actions.includes('mintRoleLink(admin, role.id)'))
    check(
      'and a failure there does not lose the role',
      /mintRoleLink\(admin, role\.id\)\.catch/.test(actions),
    )

    const service = readFileSync('src/features/access/service.ts', 'utf8')
    check('one live link per role — it reuses rather than mints', service.includes('if (existing) return'))
    check('and it is shown on the role card', service.includes('signInUrl'))

    const builder = readFileSync('src/features/access/components/role-builder.tsx', 'utf8')
    check('the card can copy it', builder.includes('<CopyLink'))
    check('and make one for a role that predates links', builder.includes('roleSignInLink'))
  }
}

main()
  .catch((error) => {
    failed += 1
    console.error('\n  ✗ crashed:', error)
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
