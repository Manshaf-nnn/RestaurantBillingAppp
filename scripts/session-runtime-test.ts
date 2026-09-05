/**
 * The session lifecycle over HTTP, against a built server (athu.md).
 *
 * `session-lifecycle-test.ts` proves the database logic. This file proves the
 * part a service-tier test cannot reach: the middleware redirect, the refresh
 * route, and the Set-Cookie headers a real browser would store. The bug being
 * fixed lived exactly in that seam — the loser of a refresh race deleting the
 * cookie the winner had just set — so a test that never sends a cookie header
 * cannot say whether it is fixed.
 *
 * A tiny cookie jar follows the 307 chain by hand (`redirect: 'manual'`,
 * `getSetCookie()`, `Max-Age=0` deletes), because a browser would and `fetch`
 * does not.
 *
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/session-runtime-test.ts
 *
 * Skips itself when nothing answers at BASE_URL.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { prisma } from '../src/server/db/prisma'
import {
  ACCESS_COOKIE, ADMIN_ACCESS_COOKIE, ADMIN_REFRESH_COOKIE, REFRESH_COOKIE,
  accessTokenTtlSeconds, refreshTokenTtlSeconds, signAccessToken,
} from '../src/server/auth/jwt'
import { generateToken, hashPassword, hashToken } from '../src/server/auth/password'
import { base32Decode, confirmEnrolment, startEnrolment, totpAt } from '../src/server/auth/mfa'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const HOUR = 3_600_000

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

/* ── A browser's cookie jar, in twenty lines ─────────────────────────────── */

type SetCookie = { name: string; value: string; attrs: Map<string, string> }

function parseSetCookie(header: string): SetCookie {
  const [pair, ...rest] = header.split(';')
  const eq = pair.indexOf('=')
  const attrs = new Map<string, string>()
  for (const part of rest) {
    const [k, v = ''] = part.trim().split('=')
    attrs.set(k.toLowerCase(), v)
  }
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attrs }
}

class Jar {
  cookies = new Map<string, string>()
  /** Every Set-Cookie ever applied, for asserting on attributes. */
  history: SetCookie[] = []

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.cookies.set(k, v)
  }
  apply(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const parsed = parseSetCookie(raw)
      this.history.push(parsed)
      if (parsed.attrs.get('max-age') === '0' || parsed.value === '') this.cookies.delete(parsed.name)
      else this.cookies.set(parsed.name, parsed.value)
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  setsFor(name: string) {
    return this.history.filter((c) => c.name === name)
  }
}

/** One request, cookies applied, no redirect following. */
async function hit(jar: Jar, path: string, init: RequestInit = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { cookie: jar.header(), ...(init.headers as Record<string, string> | undefined) },
    redirect: 'manual',
  })
  jar.apply(response)
  return response
}

/** Follow same-origin 3xx by hand, as a browser would, up to five hops. */
async function navigate(jar: Jar, path: string) {
  const hops: string[] = [path]
  let response = await hit(jar, path)
  for (let i = 0; i < 5 && response.status >= 300 && response.status < 400; i += 1) {
    const location = response.headers.get('location') ?? ''
    const next = location.startsWith('http') ? new URL(location).pathname + new URL(location).search : location
    hops.push(next)
    response = await hit(jar, next)
  }
  const body = response.status === 200 ? await response.text() : ''
  return { status: response.status, hops, final: hops[hops.length - 1], body }
}

/* ── Minting ─────────────────────────────────────────────────────────────── */

type Who = { id: string; restaurantId: string | null; role: string; name: string; email: string }

/** A session row plus an ALREADY-EXPIRED access token — the state 45 minutes into every hour used to be. */
async function mintExpired(user: Who, scope: 'staff' | 'admin', ageMs = 0) {
  const raw = generateToken()
  const row = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + refreshTokenTtlSeconds(scope) * 1000),
      ...(ageMs > 0 ? { createdAt: new Date(Date.now() - ageMs) } : {}),
    },
  })
  const access = await signAccessToken(
    { sub: user.id, rid: user.restaurantId, role: user.role, name: user.name, email: user.email, sid: row.id } as Parameters<typeof signAccessToken>[0],
    { ttl: '-1m' },
  )
  const [at, rt] = scope === 'admin' ? [ADMIN_ACCESS_COOKIE, ADMIN_REFRESH_COOKIE] : [ACCESS_COOKIE, REFRESH_COOKIE]
  return { row, raw, jar: new Jar({ [at]: access, [rt]: raw }) }
}

/** name → action id, harvested from the built client chunks (as action-e2e-test does). */
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
  try { walk('.next/static/chunks') } catch { /* no build */ }
  return found
}

async function callAction(path: string, actionId: string, args: unknown[], jar: Jar) {
  const response = await hit(jar, path, {
    method: 'POST',
    headers: { 'Next-Action': actionId, 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(args),
  })
  return { status: response.status, body: await response.text() }
}

/* ── The run ─────────────────────────────────────────────────────────────── */

async function main() {
  try {
    await fetch(`${BASE}/api/health`, { redirect: 'manual' })
  } catch {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\`.`)
    return
  }

  const stamp = Date.now().toString(36)
  const password = `Rt-${stamp}-Pass!9`
  const restaurant = await prisma.restaurant.create({
    data: { name: `Rt ${stamp}`, slug: `rt-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
  })
  const owner = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `rt-owner-${stamp}@t.local`, name: 'Owner',
      passwordHash: await hashPassword(password), role: 'OWNER',
    },
  })
  const admin = await prisma.user.create({
    data: {
      email: `rt-admin-${stamp}@t.local`, name: 'Operator',
      passwordHash: await hashPassword(password), role: 'SUPER_ADMIN',
    },
  })
  const who = (u: typeof owner): Who => ({ id: u.id, restaurantId: u.restaurantId, role: u.role, name: u.name ?? '', email: u.email })

  try {
    console.log('\n── 1. Two tabs, one day-old token, at the same moment ──')
    {
      const { row, jar } = await mintExpired(who(owner), 'staff', 25 * HOUR)

      // Both tabs hit a protected page with the dead JWT: middleware sends each
      // to the refresh route. Then both refresh requests race with the SAME
      // cookies, exactly as two tabs sharing a jar would.
      const [firstA, firstB] = await Promise.all([hit(jar, '/dashboard'), hit(jar, '/dashboard')])
      check('an expired access token is sent to the refresh route',
        [firstA, firstB].every((r) => r.status === 307 && (r.headers.get('location') ?? '').includes('/api/auth/refresh')),
        `${firstA.status} ${firstA.headers.get('location')}`)

      const path = new URL(firstA.headers.get('location') ?? '', BASE)
      const refreshPath = path.pathname + path.search
      const before = jar.header()
      const [a, b] = await Promise.all([
        fetch(`${BASE}${refreshPath}`, { headers: { cookie: before }, redirect: 'manual' }),
        fetch(`${BASE}${refreshPath}`, { headers: { cookie: before }, redirect: 'manual' }),
      ])
      jar.apply(a)
      jar.apply(b)

      const landings = [a, b].map((r) => r.headers.get('location') ?? '')
      check('neither tab is sent to the login page',
        landings.every((l) => l.includes('/dashboard') && !l.includes('/login')), landings.join(' | '))
      check('no response deleted the refresh cookie',
        jar.setsFor(REFRESH_COOKIE).every((c) => c.attrs.get('max-age') !== '0'))
      check('the jar still holds a refresh token', jar.cookies.has(REFRESH_COOKIE))

      const live = await prisma.session.findUnique({ where: { refreshTokenHash: hashToken(jar.cookies.get(REFRESH_COOKIE) ?? '') } })
      const old = await prisma.session.findUniqueOrThrow({ where: { id: row.id } })
      check('…and it is a live row', live !== null && live.revokedAt === null)
      check('…whose predecessor recorded the rotation', old.revokedAt !== null && old.replacedById === live?.id)

      const landed = await navigate(jar, '/dashboard')
      check('the next navigation is served, not bounced', landed.status === 200 && !landed.final.includes('/login'), landed.hops.join(' → '))
    }

    console.log('\n── 2. A fresh token renews without rotating ──')
    {
      const { raw, jar } = await mintExpired(who(owner), 'staff')
      const landed = await navigate(jar, '/dashboard')
      check('served after a silent renewal', landed.status === 200 && landed.final === '/dashboard', landed.hops.join(' → '))
      check('the refresh cookie was not re-issued', jar.setsFor(REFRESH_COOKIE).length === 0)
      check('…and still holds the original token', jar.cookies.get(REFRESH_COOKIE) === raw)
      check('the access cookie was re-issued', jar.setsFor(ACCESS_COOKIE).length >= 1)

      const at = jar.setsFor(ACCESS_COOKIE)[0]
      check(`access cookie Max-Age equals the JWT lifetime (${accessTokenTtlSeconds()}s)`,
        at?.attrs.get('max-age') === String(accessTokenTtlSeconds()), at?.attrs.get('max-age'))
      check('access cookie is HttpOnly, SameSite=Lax, Path=/',
        at !== undefined && at.attrs.has('httponly') && at.attrs.get('samesite')?.toLowerCase() === 'lax' && at.attrs.get('path') === '/',
        [...(at?.attrs ?? [])].map(([k, v]) => `${k}=${v}`).join(';'))
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.URL ?? ''
      if (appUrl.startsWith('http://')) {
        check('Secure is off for an http app URL (local)', !at?.attrs.has('secure'))
      } else {
        console.log(`  · Secure=${at?.attrs.has('secure')} (app URL ${appUrl || 'unset'}; production must be https)`)
      }
    }

    console.log('\n── 3. RSC fetches (prefetch or soft navigation) are not fed into the refresh route ──')
    {
      // Exactly what a browser sends for Next's router fetch: the flight
      // headers, the `_rsc` cache-buster, and — the part Next cannot strip —
      // the Fetch Metadata for a `fetch()` call. Next removes the first two
      // before middleware sees the request; this check is what found that out.
      const rsc = {
        RSC: '1', 'Next-Router-Prefetch': '1',
        'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
      }
      const { jar } = await mintExpired(who(owner), 'staff')
      const prefetch = await hit(jar, '/dashboard?_rsc=1a2b3c', { headers: rsc })
      check('a prefetch with an expired access token is not redirected to refresh',
        !(prefetch.status === 307 && (prefetch.headers.get('location') ?? '').includes('/api/auth/refresh')),
        `${prefetch.status} ${prefetch.headers.get('location') ?? ''}`)
      check('…and is served with the user resolved read-only from the refresh token',
        prefetch.status === 200, String(prefetch.status))
      check('…without writing any cookie (a render cannot)', jar.history.length === 0)

      const anonymous = await hit(new Jar(), '/dashboard?_rsc=1a2b3c', { headers: rsc })
      check('…but an RSC fetch with NO session is still turned away',
        anonymous.status === 307 && (anonymous.headers.get('location') ?? '').includes('/login'),
        `${anonymous.status} ${anonymous.headers.get('location') ?? ''}`)

      const document = await hit(jar, '/dashboard', {
        headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' },
      })
      check('a document navigation with the same cookies still takes the refresh path',
        document.status === 307 && (document.headers.get('location') ?? '').includes('/api/auth/refresh'),
        `${document.status} ${document.headers.get('location') ?? ''}`)
    }

    console.log('\n── 4. A revoked session forces a login ──')
    {
      const { row, jar } = await mintExpired(who(owner), 'staff')
      await prisma.session.update({ where: { id: row.id }, data: { revokedAt: new Date() } })
      const landed = await navigate(jar, '/dashboard')
      check('the navigation ends at the login page', landed.final.startsWith('/login'), landed.hops.join(' → '))
      check('both cookies were cleared',
        !jar.cookies.has(REFRESH_COOKIE) && !jar.cookies.has(ACCESS_COOKIE), jar.header())
    }

    console.log('\n── 5. The admin scope: its own cookies, its own lifetime ──')
    {
      const { jar } = await mintExpired(who(admin), 'admin')
      const landed = await navigate(jar, '/admin')
      check('an expired admin token is renewed and the console served',
        landed.status === 200 && landed.final === '/admin', landed.hops.join(' → '))
      check('the admin refresh cookie was not touched (12h is absolute — no rotation)',
        jar.setsFor(ADMIN_REFRESH_COOKIE).length === 0)
      check('no staff cookie was written for an admin', jar.setsFor(REFRESH_COOKIE).length === 0 && jar.setsFor(ACCESS_COOKIE).length === 0)
    }

    console.log('\n── 6. /logout only for a real navigation from this site ──')
    {
      const { row, jar } = await mintExpired(who(owner), 'staff')
      await hit(jar, '/logout', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'image' } })
      const afterImage = await prisma.session.findUniqueOrThrow({ where: { id: row.id } })
      check('an <img src=/logout> planted elsewhere signs nobody out', afterImage.revokedAt === null)

      await hit(jar, '/logout', { headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document' } })
      const afterClick = await prisma.session.findUniqueOrThrow({ where: { id: row.id } })
      check('a typed or clicked /logout does', afterClick.revokedAt !== null)
      check('…and clears the cookies', !jar.cookies.has(REFRESH_COOKIE) && !jar.cookies.has(ACCESS_COOKIE))
    }

    console.log('\n── 7. The poller sees a 401, not a redirect ──')
    {
      const response = await hit(new Jar(), '/api/pulse?scope=ops', { headers: { accept: 'application/json' } })
      check('/api/pulse without a session answers 401', response.status === 401, String(response.status))
    }

    console.log('\n── 8. Sign-in through the real action: cookies and the second factor ──')
    {
      const ids = actionIds()
      const loginId = ids.get('login')
      if (!loginId) {
        console.log('  · no `login` action id in .next/static/chunks — build first; skipping this section')
      } else {
        const jar = new Jar()
        const first = await callAction('/admin/login', loginId, [{ email: admin.email, password, remember: true }], jar)
        check('a plain sign-in succeeds', first.status === 200 && first.body.includes('redirectTo'), first.body.slice(0, 160))
        const rt = jar.setsFor(ADMIN_REFRESH_COOKIE)[0]
        check(`admin refresh cookie Max-Age is the admin lifetime (${refreshTokenTtlSeconds('admin')}s)`,
          rt?.attrs.get('max-age') === String(refreshTokenTtlSeconds('admin')), rt?.attrs.get('max-age'))
        check('admin access cookie Max-Age is the JWT lifetime',
          jar.setsFor(ADMIN_ACCESS_COOKIE)[0]?.attrs.get('max-age') === String(accessTokenTtlSeconds()))

        // Enrol, then sign in again: the password alone must no longer be enough.
        const enrolment = await startEnrolment({ userId: admin.id, email: admin.email })
        const now = () => Math.floor(Date.now() / 30_000)
        await confirmEnrolment({ userId: admin.id, code: totpAt(base32Decode(enrolment.secret), now()) })

        const challenged = new Jar()
        const second = await callAction('/admin/login', loginId, [{ email: admin.email, password, remember: true }], challenged)
        check('an enrolled account is challenged for a code', second.body.includes('"mfaRequired":true'), second.body.slice(0, 160))
        check('…and no session cookie is set before the code', challenged.setsFor(ADMIN_REFRESH_COOKIE).length === 0)

        const wrong = await callAction('/admin/login', loginId, [{ email: admin.email, password, remember: true, code: '000000' }], new Jar())
        check('a wrong code is refused as MFA_BAD_CODE', wrong.body.includes('MFA_BAD_CODE'), wrong.body.slice(0, 160))

        const right = new Jar()
        const third = await callAction('/admin/login', loginId,
          [{ email: admin.email, password, remember: true, code: totpAt(base32Decode(enrolment.secret), now()) }], right)
        check('the right code signs in', third.body.includes('redirectTo') && right.cookies.has(ADMIN_REFRESH_COOKIE), third.body.slice(0, 160))
      }
    }
  } finally {
    await prisma.session.deleteMany({ where: { userId: { in: [owner.id, admin.id] } } })
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: [owner.id, admin.id] } }, { restaurantId: restaurant.id }] } })
    await prisma.mfaRecoveryCode.deleteMany({ where: { userId: admin.id } })
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, admin.id] } } })
    await prisma.restaurant.delete({ where: { id: restaurant.id } })
    await prisma.$disconnect()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
