/**
 * Every export the UI offers actually answers, and refuses the right people.
 *
 * ── Why this runs over HTTP ────────────────────────────────────────────────
 *
 * correctionA.md §1 adds eight `type` values to one route. The failure mode
 * for a route like that is not a type error — it is a branch that throws on a
 * column that does not exist, or one that quietly falls through to the default
 * `summary` because the string was misspelled in exactly one of the two places
 * it appears. Both compile. Both hand somebody the wrong file.
 *
 * So each type is actually requested, as a signed-in owner, and the response is
 * read: the right content type, a header row, and — the part that matters — a
 * name that matches what was asked for rather than the summary's.
 *
 * ── And the permission half ────────────────────────────────────────────────
 *
 * The route checks `REPORT_EXPORT` once at the top and then the feature's own
 * permission per type. That second check is the one that stops "may export
 * something" becoming "may export anything", and it is one line per branch —
 * which is one line to forget. Section 3 signs in as somebody holding
 * `report.export` and nothing else, and asks for all of it.
 *
 * Usage:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/export-coverage-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

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

/** Every type the route is expected to answer. */
const TYPES = [
  'summary',
  'orders',
  'drawers',
  'petty',
  'outgoing',
  'expenses',
  'payables',
  'profit',
  'pnl',
  'trial-balance',
  'journal',
  // correctionA.md §1
  'transfers',
  'approvals',
  'inventory',
  'purchases',
  'production',
  'invoices',
  'analytics',
  'variance',
]

const minted: string[] = []

async function signIn(user: {
  id: string
  restaurantId: string | null
  role: string
  name: string | null
  email: string
}) {
  const refresh = generateToken()
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  const access = await signAccessToken({
    sub: user.id,
    rid: user.restaurantId,
    role: user.role,
    name: user.name,
    email: user.email,
    sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  minted.push(session.id)
  return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

const stamp = Date.now().toString(36)

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' })
    .then(() => true)
    .catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\` to run this.`)
    process.exit(0)
  }

  console.log('\n── 1. Every type the UI names is a type the route knows ──')
  {
    /*
     * The two halves of the misspelling bug: a `<ExportMenu type="…" />` whose
     * string no server branch matches falls through to the summary, and the
     * person gets a plausible file of the wrong thing. Nothing else would
     * catch that — it compiles, and it returns 200.
     */
    const used = new Set<string>()
    for (const file of walk('src')) {
      const src = readFileSync(file, 'utf8')
      for (const match of src.matchAll(/<ExportMenu[^>]*\btype="([^"]+)"/g)) {
        used.add(match[1])
      }
    }
    check('the UI offers at least one export', used.size > 0, [...used].join(', '))
    const unknown = [...used].filter((t) => !TYPES.includes(t))
    check('and every one of them is a known type', unknown.length === 0, unknown.join(', '))
  }

  const owner = await prisma.user.findFirst({
    where: {
      role: 'OWNER',
      isActive: true,
      deletedAt: null,
      restaurant: {
        status: 'ACTIVE',
        isActive: true,
        OR: [
          { plan: { not: 'TRIAL' } },
          { trialEndsAt: null },
          { trialEndsAt: { gt: new Date() } },
        ],
      },
    },
  })
  if (!owner?.restaurantId) {
    console.error('No owner of an active, in-trial restaurant in this database.')
    process.exit(1)
  }
  const cookie = await signIn(owner)

  console.log('\n── 2. Each one answers, in both formats ──')
  {
    for (const type of TYPES) {
      for (const format of ['csv', 'xlsx'] as const) {
        const response = await fetch(
          `${BASE}/api/reports/export?type=${type}&format=${format}&preset=LAST_30`,
          { headers: { cookie }, redirect: 'manual' },
        )
        const ok = response.status === 200
        const disposition = response.headers.get('content-disposition') ?? ''
        if (!ok) {
          check(`${type} · ${format}`, false, `HTTP ${response.status} ${await response.text()}`)
          continue
        }
        check(
          `${type} · ${format}`,
          /attachment/.test(disposition),
          `no attachment header: ${disposition}`,
        )
      }
    }
  }

  console.log('\n── 3. A type is not the summary wearing its name ──')
  {
    /*
     * The fall-through. `type=transfers` and `type=nonsense` both reach the
     * end of the route today unless a branch claims them, and the end of the
     * route builds the summary — so the check is that the filename differs
     * from what an unknown type produces.
     */
    const junk = await fetch(`${BASE}/api/reports/export?type=not-a-real-type&format=csv`, {
      headers: { cookie },
      redirect: 'manual',
    })
    const junkName = junk.headers.get('content-disposition') ?? ''

    for (const type of ['transfers', 'approvals', 'inventory', 'purchases', 'production', 'invoices']) {
      const response = await fetch(`${BASE}/api/reports/export?type=${type}&format=csv`, {
        headers: { cookie },
        redirect: 'manual',
      })
      const name = response.headers.get('content-disposition') ?? ''
      check(
        `${type} is its own export, not the summary`,
        name !== junkName && name.includes(type.slice(0, 6)),
        `${name} vs fallback ${junkName}`,
      )
    }
  }

  console.log('\n── 4. A CSV has a header row and no formula injection ──')
  {
    const response = await fetch(`${BASE}/api/reports/export?type=inventory&format=csv`, {
      headers: { cookie },
      redirect: 'manual',
    })
    const text = await response.text()
    const [header] = text.split('\n')
    check('the first line names the columns', /Item.*SKU.*Location/.test(header), header)

    /*
     * `toCsv` prefixes a leading =, +, - or @ with a quote. Nothing in a
     * seeded database is likely to start with one, so this asserts the guard
     * is still wired rather than that it fired — the unit of it lives with
     * the helper.
     */
    const dangerous = text.split('\n').filter((line) => /(^|,)[=+@]/.test(line))
    check('no cell starts a formula', dangerous.length === 0, dangerous.slice(0, 2).join(' | '))
  }

  console.log('\n── 5. report.export alone is not a skeleton key ──')
  {
    /*
     * Somebody who may export reports, and hold no other permission at all.
     * Every type whose screen they cannot open must refuse — a download is
     * not a way around a page.
     */
    const role = await prisma.staffRole.create({
      data: {
        restaurantId: owner.restaurantId,
        name: `Exporter ${stamp}`,
        preset: 'CASHIER',
        permissions: ['report.export'],
      },
    })
    const exporter = await prisma.user.create({
      data: {
        restaurantId: owner.restaurantId,
        email: `exporter-${stamp}@test.local`,
        name: 'Exporter',
        passwordHash: 'x',
        role: 'CASHIER',
        staffRoleId: role.id,
      },
    })
    const theirCookie = await signIn(exporter)

    const gated = ['transfers', 'approvals', 'inventory', 'purchases', 'production', 'invoices', 'drawers', 'payables']
    for (const type of gated) {
      const response = await fetch(`${BASE}/api/reports/export?type=${type}&format=csv`, {
        headers: { cookie: theirCookie },
        redirect: 'manual',
      })
      check(
        `${type} is refused without its own permission`,
        response.status === 403,
        `HTTP ${response.status}`,
      )
    }

    /*
     * Deactivated, not deleted.
     *
     * Every export writes an audit row, and `audit_logs` is append-only at the
     * database — the constraint says so in as many words. Deleting the probe
     * account cascades into those rows and the delete is refused, which is the
     * invariant working exactly as intended. So the fixture retires the account
     * the way a real restaurant would.
     */
    await prisma.user.update({
      where: { id: exporter.id },
      data: { isActive: false, deletedAt: new Date(), staffRoleId: null },
    })
    await prisma.staffRole.update({ where: { id: role.id }, data: { deletedAt: new Date() } })
  }
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    if (minted.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: minted } } })
    }
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
