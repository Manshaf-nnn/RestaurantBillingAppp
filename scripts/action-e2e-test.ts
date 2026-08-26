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

/*
 * Defaults to the port `npm start` uses.
 *
 * This said 3210 while five of its sibling runtime suites said 3000, so a
 * server left running on the other port meant this file quietly tested a build
 * from hours ago — passing, against code that no longer existed. One port, or
 * pass BASE_URL.
 */
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


/**
 * A session minted for one call.
 *
 * The run-wide cookie is created once at the top and several checks in between
 * create, revoke and delete accounts — so by the time the later blocks run it
 * can be stale. A fresh grant makes each check independent of the order the
 * file happens to be in.
 */
async function freshCookie(u: { id: string; restaurantId: string | null; role: string; name: string | null; email: string }) {
  const refresh = generateToken()
  const session = await prisma.session.create({
    data: { userId: u.id, refreshTokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + 86_400_000) },
  })
  const access = await signAccessToken({
    sub: u.id, rid: u.restaurantId, role: u.role, name: u.name, email: u.email, sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
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

  /*
   * Prefer an owner whose restaurant has somewhere ELSE to put a table.
   *
   * The table checks below need two orderable branches to mean anything, and
   * picking the first owner in the database meant they reported "one orderable
   * location" and skipped — a green run that had checked nothing about the bug
   * it was written for.
   */
  const eligible = {
    role: 'OWNER' as const,
    isActive: true,
    deletedAt: null,
    restaurant: {
      status: 'ACTIVE' as const,
      isActive: true,
      OR: [{ plan: { not: 'TRIAL' as const } }, { trialEndsAt: null }, { trialEndsAt: { gt: new Date() } }],
    },
  }

  const orderable = await prisma.branch.groupBy({
    by: ['restaurantId'],
    where: { deletedAt: null, isActive: true, type: 'BRANCH' },
    _count: { _all: true },
  })
  const multiSite = orderable.filter((row) => row._count._all > 1).map((row) => row.restaurantId)

  const user =
    (multiSite.length
      ? await prisma.user.findFirst({
          where: { ...eligible, restaurantId: { in: multiSite } },
        })
      : null) ?? (await prisma.user.findFirst({ where: eligible }))
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

  /*
   * A table lands at the branch it was asked for, not at the default one.
   *
   * This is the reported bug, and it can only be tested here: `saveTable` goes
   * through `requirePermission`, which reads the session cookie, so a
   * service-level test cannot reach it at all. The owner signing in below has
   * no `branchId` of their own — which is exactly the case that broke, because
   * the old fallback chain ended at the restaurant's DEFAULT branch.
   */
  console.log('\nAdd a table at a specific location')

  const saveTableId = ids.get('saveTable')
  const moveTableId = ids.get('moveTable')

  const branches = await prisma.branch.findMany({
    where: { restaurantId: user.restaurantId, deletedAt: null, isActive: true, type: 'BRANCH' },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, isDefault: true },
  })
  const other = branches.find((b) => !b.isDefault)

  if (!saveTableId) {
    check('saveTable found in the bundle', false, 'not present')
  } else if (!other) {
    console.log('  · this tenant has one orderable location — nothing to add a table AT')
  } else {
    const number = `E${stamp}`
    const made = await callAction(
      '/dashboard/tables',
      saveTableId,
      [{ branchId: other.id, number, capacity: 4, status: 'AVAILABLE', label: '', area: '', notes: '' }],
      cookie,
    )
    check(
      'the action replies with an RSC payload',
      made.status === 200 && made.type.includes('text/x-component'),
      `HTTP ${made.status}, content-type ${made.type || '(none)'}`,
    )

    const row = await prisma.restaurantTable.findFirst({
      where: { restaurantId: user.restaurantId, number },
      select: { id: true, branchId: true },
    })
    check('the table exists', Boolean(row), 'no row found')
    check(
      `and it is at ${other.name}, not the default location`,
      row?.branchId === other.id,
      row?.branchId === branches[0]?.id
        ? 'it landed on the default branch — the reported bug'
        : `${row?.branchId}`,
    )

    // Moving it back is the recovery path for the tables already stranded at
    // the default branch by that bug.
    if (row && moveTableId) {
      const moved = await callAction(
        '/dashboard/tables',
        moveTableId,
        [{ id: row.id, branchId: branches[0].id }],
        cookie,
      )
      check(
        'an idle table moves to another location',
        moved.status === 200 && !moved.body.includes('"ok":false'),
        moved.body.slice(0, 160).replace(/\s+/g, ' '),
      )
      const after = await prisma.restaurantTable.findUnique({
        where: { id: row.id },
        select: { branchId: true },
      })
      check('and the move actually landed', after?.branchId === branches[0].id)
    }

    if (row) await prisma.restaurantTable.delete({ where: { id: row.id } }).catch(() => {})
  }

  /*
   * A kitchen account cannot be created without a location.
   *
   * `homeBranchFor` used to ask only whether the ADMIN could grant "every
   * location". An owner can, so leaving the field on its default produced a
   * KITCHEN account with no branch — and `visibleBranchIds` gives those roles
   * an EMPTY list, so every screen they opened was blank. No error at the time;
   * the symptom turned up hours later on a display in another room.
   *
   * Driven here rather than in the service suite because `inviteStaff` goes
   * through `requirePermission`, which reads the session cookie.
   */
  console.log('\nA role that would be blinded cannot be created without a location')

  const inviteId = ids.get('inviteStaff')
  // `stamp` is upper-case (it doubles as a branch code) and emails are stored
  // lower-cased, so a case-sensitive lookup afterwards would miss the row and
  // report "not created" for an account that was.
  const mark = stamp.toLowerCase()
  if (!inviteId) {
    check('inviteStaff found in the bundle', false, 'not present')
  } else {
    const blind = await callAction(
      '/dashboard/staff',
      inviteId,
      [{ name: `Blind chef ${mark}`, email: `blind-${mark}@e2e.test`, phone: '', role: 'KITCHEN', branchId: null }],
      cookie,
    )
    check(
      'a KITCHEN account with no location is refused',
      blind.body.includes('"ok":false') || blind.body.includes('must be assigned to a location'),
      blind.body.slice(0, 200).replace(/\s+/g, ' '),
    )
    const leaked = await prisma.user.findFirst({ where: { email: `blind-${mark}@e2e.test` } })
    check('and no account was created', !leaked)
    if (leaked) await prisma.user.delete({ where: { id: leaked.id } }).catch(() => {})

    // A MANAGER with no location is a group manager and must still work.
    const groupManager = await callAction(
      '/dashboard/staff',
      inviteId,
      [{ name: `Group mgr ${mark}`, email: `group-${mark}@e2e.test`, phone: '', role: 'MANAGER', branchId: null }],
      cookie,
    )
    check(
      'a MANAGER with no location is still allowed — that is a group manager',
      !groupManager.body.includes('"ok":false'),
      groupManager.body.slice(0, 200).replace(/\s+/g, ' '),
    )
    const made = await prisma.user.findFirst({ where: { email: `group-${mark}@e2e.test` } })
    check('and that account exists', Boolean(made))
    if (made) await prisma.user.deleteMany({ where: { id: made.id } }).catch(() => {})
  }

  await prisma.session.delete({ where: { id: session.id } }).catch(() => {})
  await prisma.$disconnect()


  console.log('\nOrder details in a modal — read-only, and its own branch only')

  const fetchId = ids.get('fetchOrderDetail')
  if (!fetchId) {
    check('fetchOrderDetail found in the bundle', false, 'not present — is the dialog imported?')
  } else {
    /*
     * Seeded rather than found. Relying on whatever orders happen to be in the
     * database meant this whole section skipped on a fresh one — a green run
     * that had checked nothing about the leak it exists for. Two branches, two
     * orders, removed at the end.
     */
    const floors = await prisma.branch.findMany({
      where: { restaurantId: user.restaurantId!, deletedAt: null, isActive: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 2,
    })

    const seeded: string[] = []
    const makeOrder = async (branchId: string, suffix: string) => {
      const row = await prisma.order.create({
        data: {
          restaurantId: user.restaurantId!, branchId,
          orderNumber: `E2E-${stamp}-${suffix}`,
          type: 'DINE_IN', channel: 'STAFF', status: 'PENDING',
          customerName: 'E2E', customerPhone: '', subtotal: 1000, grandTotal: 1000,
          placedAt: new Date(),
        },
        select: { id: true, branchId: true },
      })
      seeded.push(row.id)
      return row
    }

    const mine = floors[0] ? await makeOrder(floors[0].id, 'A') : null

    if (!mine) {
      console.log('  · the fixture tenant has no branches — order-detail checks skipped')
    } else {
      const ok = await callAction('/dashboard/live', fetchId, [mine.id], await freshCookie(user))
      check('an owner can open an order on their own floor', ok.body.includes('"ok":true'),
        ok.body.slice(0, 120))
      /*
       * Read-only is enforced at the ENDPOINT, not at the call site. If this
       * ever comes back true, a modal over a floor plan that repaints every
       * second has grown a cancel button.
       */
      check('and it comes back read-only', ok.body.includes('"canUpdate":false'), ok.body.slice(0, 160))
      check('cancel too', ok.body.includes('"canCancel":false'))

      /*
       * The ported cross-branch check. Nothing else covers it: the page's own
       * version is exercised by page-render-test, and this action repeats the
       * predicate — so deleting one line here would reopen the leak silently.
       */
      const elsewhere = floors[1] ? await makeOrder(floors[1].id, 'B') : null

      if (!elsewhere) {
        console.log('  · one branch has orders — the cross-branch refusal needs two, skipped')
      } else {
        const confined = await prisma.user.create({
          data: {
            restaurantId: user.restaurantId!, name: 'Confined', role: 'MANAGER',
            email: `confined-${stamp}@e2e.test`, passwordHash: 'x',
            branchId: mine.branchId, isActive: true, emailVerifiedAt: new Date(),
          },
        })
        const theirRefresh = generateToken()
        const theirSession = await prisma.session.create({
          data: {
            userId: confined.id, refreshTokenHash: hashToken(theirRefresh),
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        })
        const theirAccess = await signAccessToken({
          sub: confined.id, rid: confined.restaurantId, role: confined.role,
          name: confined.name, email: confined.email, sid: theirSession.id,
        })
        const theirs = `${ACCESS_COOKIE}=${theirAccess}; ${REFRESH_COOKIE}=${theirRefresh}`

        const refused = await callAction('/dashboard/live', fetchId, [elsewhere.id], theirs)
        check(
          'a manager cannot open another branch’s order',
          refused.body.includes('"ok":false'),
          refused.body.slice(0, 160),
        )
        check(
          'and is told nothing about whether it exists',
          refused.body.includes('Order was not found'),
          refused.body.slice(0, 160),
        )

        await prisma.session.deleteMany({ where: { userId: confined.id } })
        await prisma.user.delete({ where: { id: confined.id } })
      }
    }

    if (seeded.length) await prisma.order.deleteMany({ where: { id: { in: seeded } } })
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
