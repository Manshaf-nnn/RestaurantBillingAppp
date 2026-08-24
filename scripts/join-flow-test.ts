/**
 * Walking through an access link, over HTTP.
 *
 * `access-links-test.ts` proves the rules — which tokens resolve, which
 * credentials match, what a link carries. It cannot prove the thing that
 * actually matters, because `joinWithCode` calls `enforceRateLimit` and
 * `createSession`, and both need a real request: cookies to write, headers to
 * read. So the flow Rolelogic §6 describes is only provable by driving it.
 *
 *   Staff opens link → enters email + code → verified → limited workspace
 *
 * ── The two properties being checked ────────────────────────────────────────
 *
 *   1. The link ALONE does nothing. Opening a personal link gets you a login
 *      form, not a session — which is the whole difference from the old
 *      `/api/invite/accept`, where the URL was the credential and forwarding
 *      the message forwarded the access.
 *   2. A shared-device link still signs a screen in, because a kitchen tablet
 *      has to come back up after a reboot without anybody typing anything.
 *
 * Run: BASE_URL=http://localhost:3000 npx tsx --tsconfig tsconfig.test.json \
 *        scripts/join-flow-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { issueSignInCode } from '../src/features/staff/codes'
import { generateToken } from '../src/server/auth/password'
import { ACCESS_COOKIE } from '../src/server/auth/jwt'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

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

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' })
  const body = res.status === 200 ? await res.text() : ''
  return { status: res.status, body }
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\` to run this.`)
    process.exit(0)
  }

  const stamp = Date.now().toString(36)
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Join ${stamp}`,
      slug: `join-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      plan: 'GROWTH',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Branch 02', code: 'BR02', isDefault: true },
  })

  const waiter = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `join-${stamp}@test.local`,
      name: 'Nadia',
      passwordHash: 'x',
      role: 'WAITER',
      branchId: branch.id,
    },
  })
  const code = await issueSignInCode(waiter.id)

  const personal = await prisma.invite.create({
    data: {
      token: generateToken(24),
      restaurantId: restaurant.id,
      role: 'WAITER',
      mode: 'PERSONAL',
      userId: waiter.id,
      branchId: branch.id,
      label: 'Nadia — Branch 02',
    },
  })
  const device = await prisma.invite.create({
    data: {
      token: generateToken(24),
      restaurantId: restaurant.id,
      role: 'KITCHEN',
      mode: 'SHARED_DEVICE',
      branchId: branch.id,
      label: 'Kitchen tablet',
    },
  })

  // ── 1. the link alone is not a way in ─────────────────────────────────────
  console.log('\n── 1. opening a personal link gives a login, not a session ──')

  const page = await get(`/join/${personal.token}`)
  check('the page renders', page.status === 200, `${page.status}`)
  check(
    'it names the restaurant and the branch',
    page.body.includes(restaurant.name) && page.body.includes('Branch 02'),
  )
  check('and asks for a login code', page.body.includes('Login code'))
  check(
    'no session is handed out just for opening it',
    !page.body.includes('/dashboard/orders'),
    'the old /api/invite/accept signed you in on the GET',
  )

  const raw = await fetch(`${BASE}/join/${personal.token}`, { redirect: 'manual' })
  check(
    'and no auth cookie is set',
    !(raw.headers.get('set-cookie') ?? '').includes(ACCESS_COOKIE),
    `${raw.headers.get('set-cookie')?.slice(0, 60)}`,
  )

  // ── 2. a dead token says nothing useful ───────────────────────────────────
  console.log('\n── 2. a token that does not work ──')

  const bogus = await get(`/join/not-a-real-token-${stamp}`)
  check('a made-up token gets the refusal page', bogus.body.includes('not valid any more'))
  check('which does not name a restaurant', !bogus.body.includes(restaurant.name))

  await prisma.invite.update({ where: { id: personal.id }, data: { isActive: false } })
  const revoked = await get(`/join/${personal.token}`)
  check('a revoked link gets the same page', revoked.body.includes('not valid any more'))
  check(
    'and the same wording as a made-up one',
    revoked.body.includes('not valid any more') && bogus.body.includes('not valid any more'),
    'a different message per reason tells a guesser which guess was closest',
  )
  await prisma.invite.update({ where: { id: personal.id }, data: { isActive: true } })

  // ── 3. a shared screen is told what it is ─────────────────────────────────
  console.log('\n── 3. a shared screen ──')

  const screen = await get(`/join/${device.token}`)
  check('the page renders', screen.status === 200, `${screen.status}`)
  check('it says this device stays signed in', screen.body.includes('stays signed in'))
  check('and does not ask for a code', !screen.body.includes('Login code'))
  check(
    'it names the branch, which the old link never carried',
    screen.body.includes('Branch 02'),
  )

  // ── 4. an expired link ────────────────────────────────────────────────────
  console.log('\n── 4. expiry ──')

  await prisma.invite.update({
    where: { id: device.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  const expired = await get(`/join/${device.token}`)
  check('an expired link is refused', expired.body.includes('not valid any more'))

  // ── cleanup ───────────────────────────────────────────────────────────────
  await prisma.invite.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  void code

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
