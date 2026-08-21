/**
 * Drive real Server Actions over HTTP, the way a browser does.
 *
 * This is the harness the test suite was missing. `qa-suite.ts` and the phase
 * scripts call *services* directly — `reconcileOrderDepletion`, `requestTransfer`
 * — which is why several genuinely broken user-facing paths sat green in 636
 * tests. Everything between the button and the service was untested: argument
 * encoding, the guards, `runAction`, RSC serialisation of the result, and the
 * page re-render Next performs inside the action's own POST.
 *
 * That last one is what broke "Add location". The action succeeded and the
 * response failed, which no service-level test can see.
 *
 * Action ids are read out of the client bundle, where Next emits them next to
 * the function name:
 *
 *     createServerReference)("40f01da3…", h.callServer, …, "createLocationAction")
 *
 * Requires a build and a running server:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/action-e2e-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'

const BASE = process.env.BASE_URL ?? 'http://localhost:3210'

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

/** name → action id, harvested from the built client chunks. */
function actionIds(): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.js')) {
        const src = readFileSync(full, 'utf8')
        const re = /createServerReference\)\("([0-9a-f]{40,42})"[^)]*?,"([A-Za-z0-9_$]+)"\)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(src))) if (!found.has(m[2])) found.set(m[2], m[1])
      }
    }
  }
  try {
    walk('.next/static/chunks')
  } catch {
    // no build
  }
  return found
}

/** POST a Server Action exactly as the browser would. */
async function callAction(path: string, actionId: string, args: unknown[], cookie: string) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      cookie,
      'Next-Action': actionId,
      'Content-Type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify(args),
    redirect: 'manual',
  })
  const body = await response.text()
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    body,
  }
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\`.`)
    process.exit(0)
  }

  const ids = actionIds()
  if (ids.size === 0) {
    console.error('No action ids found in .next/static/chunks — run `npx next build` first.')
    process.exit(1)
  }
  console.log(`server actions discovered in the client bundle: ${ids.size}\n`)

  const user = await prisma.user.findFirst({
    where: {
      role: 'OWNER',
      isActive: true,
      deletedAt: null,
      restaurant: {
        status: 'ACTIVE',
        isActive: true,
        OR: [{ plan: { not: 'TRIAL' } }, { trialEndsAt: null }, { trialEndsAt: { gt: new Date() } }],
      },
    },
  })
  if (!user?.restaurantId) {
    console.error('No owner of an active, in-trial restaurant — every action would redirect.')
    process.exit(1)
  }

  const refresh = generateToken()
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  const access = await signAccessToken({
    sub: user.id, rid: user.restaurantId, role: user.role,
    name: user.name, email: user.email, sid: session.id,
  })
  const cookie = `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`

  const stamp = Date.now().toString(36).toUpperCase().slice(-5)
  const createId = ids.get('createLocationAction')

  console.log('Add location — the whole round trip, not just the service')

  if (!createId) {
    check('createLocationAction found in the bundle', false, 'not present')
  } else {
    const result = await callAction(
      '/dashboard/locations',
      createId,
      [{ name: `E2E ${stamp}`, code: `E${stamp}`, type: 'BRANCH', address: '', phone: '' }],
      cookie,
    )

    // The response must be a Flight payload. A 500, an HTML error page or a
    // platform timeout all arrive as something else, and the client turns every
    // one of them into the same unhelpful toast.
    check(
      'the action replies with an RSC payload',
      result.status === 200 && result.type.includes('text/x-component'),
      `HTTP ${result.status}, content-type ${result.type || '(none)'}`,
    )
    check(
      'and reports success rather than an error result',
      result.body.includes('"ok":true') || result.body.includes('Location created'),
      result.body.slice(0, 160).replace(/\s+/g, ' '),
    )

    const created = await prisma.branch.findFirst({
      where: { restaurantId: user.restaurantId, code: `E${stamp}` },
    })
    check('the location is actually in the database', Boolean(created), 'no row found')

    // A second attempt with the same code must be refused *as a result*, not as
    // a rejection — this is the path that used to hang the button.
    const dup = await callAction(
      '/dashboard/locations',
      createId,
      [{ name: `E2E ${stamp}`, code: `E${stamp}`, type: 'BRANCH', address: '', phone: '' }],
      cookie,
    )
    check(
      'a duplicate code comes back as a readable message, not a crash',
      dup.status === 200 && dup.type.includes('text/x-component') && dup.body.includes('already used'),
      `HTTP ${dup.status} ${dup.body.slice(0, 120).replace(/\s+/g, ' ')}`,
    )

    if (created) {
      await prisma.inventoryStock.deleteMany({ where: { branchId: created.id } })
      await prisma.branch.delete({ where: { id: created.id } }).catch(() => {})
    }
  }

  console.log('\nAn unauthenticated action must be refused, not crash')

  if (createId) {
    const anon = await callAction(
      '/dashboard/locations',
      createId,
      [{ name: 'nope', code: 'NOPE', type: 'BRANCH', address: '', phone: '' }],
      '',
    )
    check(
      'no session — refused without creating anything',
      anon.status !== 200 || !anon.body.includes('"ok":true'),
      `HTTP ${anon.status}`,
    )
    const leaked = await prisma.branch.findFirst({ where: { code: 'NOPE' } })
    check('and nothing was written', !leaked)
    if (leaked) await prisma.branch.delete({ where: { id: leaked.id } }).catch(() => {})
  }

  await prisma.session.delete({ where: { id: session.id } }).catch(() => {})
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
