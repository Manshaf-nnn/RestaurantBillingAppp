/**
 * Staff sign-in by email and code.
 *
 * A waiter is handed a card with their email and an 8-character code, and that
 * code IS their password — hashed into `passwordHash`, so there is one
 * authentication path and the ordinary login form works with no special case.
 *
 * The dangerous part is the credential boundary, so most of what follows is
 * about who may reset whom. Without the role check a manager could reset the
 * owner's password and take the restaurant.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/staff-login-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { generateSignInCode, issueSignInCode, nextStaffCode } from '../src/features/staff/codes'
import { hashPassword, verifyPassword } from '../src/server/auth/password'
import { assignableRoles } from '../src/lib/rbac'

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
    data: {
      name: `Codes Test ${stamp}`,
      slug: `codes-test-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
    },
  })

  const mk = async (role: 'OWNER' | 'MANAGER' | 'WAITER', label: string) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        email: `${label}-${stamp}@codes.test`,
        name: label,
        role,
        passwordHash: await hashPassword('PlaceHolder1'),
        staffCode: await nextStaffCode(prisma, restaurant.id),
        emailVerifiedAt: new Date(),
      },
    })

  const owner = await mk('OWNER', 'owner')
  const manager = await mk('MANAGER', 'manager')
  const waiter = await mk('WAITER', 'waiter')

  console.log('\nThe code is a credential, so it must look like one')

  const sample = Array.from({ length: 200 }, () => generateSignInCode())
  check('formatted as XXXX-XXXX', sample.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)), sample[0])
  check(
    'no characters that get misread aloud (O/0, I/1)',
    sample.every((c) => !/[O0I1]/.test(c)),
  )
  check('not sequential — 200 codes, 200 distinct', new Set(sample).size === 200)

  console.log('\nIssuing a code sets the password')

  const code = await issueSignInCode(waiter.id)
  const afterIssue = await prisma.user.findUniqueOrThrow({ where: { id: waiter.id } })
  check('the code is stored so a lost card can be reprinted', afterIssue.signInCode === code)
  check('and it is the password', await verifyPassword(code, afterIssue.passwordHash))
  check('the placeholder password no longer works', !(await verifyPassword('PlaceHolder1', afterIssue.passwordHash)))
  check(
    'the stored code is never the password hash itself',
    afterIssue.signInCode !== afterIssue.passwordHash,
  )

  console.log('\nRe-issuing invalidates the previous code')

  const second = await issueSignInCode(waiter.id)
  const afterSecond = await prisma.user.findUniqueOrThrow({ where: { id: waiter.id } })
  check('a different code is issued', second !== code)
  check('the new code signs in', await verifyPassword(second, afterSecond.passwordHash))
  check('the old code does not', !(await verifyPassword(code, afterSecond.passwordHash)))

  console.log('\nWho may reset whom')

  check('an owner may reset a waiter', assignableRoles('OWNER').includes('WAITER'))
  check('an owner may reset a manager', assignableRoles('OWNER').includes('MANAGER'))
  check('a manager may reset a waiter', assignableRoles('MANAGER').includes('WAITER'))
  check(
    'a manager may NOT reset the owner — otherwise they could take the restaurant',
    !assignableRoles('MANAGER').includes('OWNER'),
  )
  check('a manager may NOT reset another manager', !assignableRoles('MANAGER').includes('MANAGER'))
  check('a waiter may reset nobody', assignableRoles('WAITER').length === 0)
  check('nobody may reset an owner', !assignableRoles('OWNER').includes('OWNER'))

  console.log('\nCodes are scoped to one restaurant')

  const other = await prisma.restaurant.create({
    data: { name: `Other ${stamp}`, slug: `other-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const otherWaiter = await prisma.user.create({
    data: {
      restaurantId: other.id,
      email: `other-waiter-${stamp}@codes.test`,
      name: 'other waiter',
      role: 'WAITER',
      passwordHash: await hashPassword('PlaceHolder1'),
      staffCode: await nextStaffCode(prisma, other.id),
      emailVerifiedAt: new Date(),
    },
  })
  check(
    'two restaurants can both have W-0001',
    otherWaiter.staffCode === 'W-0001' && owner.staffCode === 'W-0001',
    `${otherWaiter.staffCode} vs ${owner.staffCode}`,
  )
  const otherCode = await issueSignInCode(otherWaiter.id)
  const ours = await prisma.user.findUniqueOrThrow({ where: { id: waiter.id } })
  check("another restaurant's code does not open this account", !(await verifyPassword(otherCode, ours.passwordHash)))

  console.log('\nThe staff code stays an identifier, not a credential')

  check('staff codes are still the readable sequence', /^W-\d{4}$/.test(String(manager.staffCode)))
  check(
    'and are not accepted as a password',
    !(await verifyPassword(String(ours.staffCode), ours.passwordHash)),
  )

  // Clean up: sessions and users first, both restaurants last.
  await prisma.session.deleteMany({ where: { user: { restaurantId: { in: [restaurant.id, other.id] } } } })
  await prisma.user.deleteMany({ where: { restaurantId: { in: [restaurant.id, other.id] } } })
  await prisma.restaurant.deleteMany({ where: { id: { in: [restaurant.id, other.id] } } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
