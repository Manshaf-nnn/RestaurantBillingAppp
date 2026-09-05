/**
 * The session lifecycle, and the race that used to end it (athu.md).
 *
 * ── What this suite is for ──────────────────────────────────────────────────
 *
 * Users were being logged out too quickly. The cause was a refresh-token
 * rotation race: two tabs refreshed at once, the loser found its token already
 * rotated, could not tell that from a stolen one, and deleted the winner's new
 * cookie. The fix is lineage (`Session.replacedById`), a grace window, and
 * rotating once a day instead of every fifteen minutes.
 *
 * §1 is the test that matters and it is run AS A RACE — two `refreshSession`
 * calls on one token in `Promise.all`, not one after the other. Before the fix
 * the second call returned null; after it, both callers hold a working session
 * and exactly one new row exists.
 *
 * Everything here is cookie-free by design: the DB logic was extracted so it
 * could be tested from a script with no request scope. `createSession`,
 * `rotateSession` and `login()` all touch `cookies()` and are covered by the
 * runtime tier instead.
 *
 * Time is controlled by BACKDATING rows (`createdAt`, `revokedAt`) with the
 * ordinary Prisma client — the columns are writable — so no clock is mocked and
 * the production code path is exactly the one that runs.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/session-lifecycle-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  lookupRefreshSession, refreshSession, rotateSessionRecord,
} from '../src/server/auth/session'
import {
  TRANSIENT_SESSION_TTL_SECONDS, refreshGraceSeconds, refreshTokenTtlSeconds,
  rotateAfterSeconds,
} from '../src/server/auth/jwt'
import { generateToken, hashToken } from '../src/server/auth/password'
import { base32Decode, confirmEnrolment, startEnrolment, totpAt } from '../src/server/auth/mfa'
import { secondFactorGate } from '../src/features/auth/mfa-gate'
import { setRestaurantFeatures } from '../src/features/platform/feature-service'

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

const ctx = { ipAddress: '127.0.0.1', userAgent: 'session-lifecycle-test' }
const HOUR = 3_600_000

async function main() {
  const stamp = Date.now().toString(36)
  process.env.JWT_ACCESS_SECRET ||= 'test-secret-for-session-lifecycle-x'

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Sess ${stamp}`, slug: `sess-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR',
    },
  })
  const staff = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `sess-${stamp}@t.local`, name: 'Till',
      passwordHash: 'x', role: 'CASHIER',
    },
  })
  const admin = await prisma.user.create({
    data: { email: `sess-admin-${stamp}@t.local`, name: 'Operator', passwordHash: 'x', role: 'SUPER_ADMIN' },
  })

  /** A session row exactly as `createSession` would write it, minus the cookies. */
  const mint = async (userId: string, scope: 'staff' | 'admin', ageMs = 0) => {
    const raw = generateToken()
    const row = await prisma.session.create({
      data: {
        userId,
        refreshTokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + refreshTokenTtlSeconds(scope) * 1000),
        ...(ageMs > 0 ? { createdAt: new Date(Date.now() - ageMs) } : {}),
      },
    })
    return { raw, id: row.id }
  }
  const liveRows = (userId: string) => prisma.session.count({ where: { userId, revokedAt: null } })

  console.log('\n── 1. Two tabs refresh a day-old token at once ──')
  {
    const a = await mint(staff.id, 'staff', 25 * HOUR)
    const before = await liveRows(staff.id)

    /*
     * The race, as a race. Before the fix: the first call rotated, the second
     * found `revokedAt` set and returned null — and the route then deleted the
     * cookie the first had just set.
     */
    const [x, y] = await Promise.all([
      refreshSession(a.raw, 'staff', { ctx, allowRotation: true }),
      refreshSession(a.raw, 'staff', { ctx, allowRotation: true }),
    ])
    check('neither caller is refused', x.outcome !== 'refused' && y.outcome !== 'refused',
      `${x.outcome} / ${y.outcome}`)
    const outcomes = [x.outcome, y.outcome].sort()
    check('exactly one rotated and the other was handed the successor',
      outcomes[0] === 'rotated' && outcomes[1] === 'superseded', outcomes.join(' / '))
    check('…and they agree on WHICH session that is',
      x.outcome !== 'refused' && y.outcome !== 'refused' && x.sessionId === y.sessionId)

    const after = await liveRows(staff.id)
    check('one live row replaced one live row — no orphan', after === before, `${before} → ${after}`)

    const old = await prisma.session.findUniqueOrThrow({ where: { id: a.id } })
    const winner = x.outcome === 'rotated' ? x : y
    const successorId = winner.outcome !== 'refused' ? winner.sessionId : null
    check('the old row records why it died and what replaced it',
      old.revokedAt !== null && old.replacedById === successorId)
    check('the rotated caller received a new refresh token',
      winner.outcome === 'rotated' && winner.refreshToken.length > 20)

    console.log('\n── 2. The grace window, and its edge ──')
    const replay = await refreshSession(a.raw, 'staff', { ctx })
    check('replaying the old token inside the window still resolves to the successor',
      replay.outcome === 'superseded' && replay.sessionId === successorId, replay.outcome)

    await prisma.session.update({
      where: { id: a.id },
      data: { revokedAt: new Date(Date.now() - (refreshGraceSeconds() + 1) * 1000) },
    })
    const stale = await refreshSession(a.raw, 'staff', { ctx })
    check('…and outside the window it is refused as reuse',
      stale.outcome === 'refused' && stale.reason === 'reused', JSON.stringify(stale))
    const recorded = await prisma.auditLog.findFirst({
      where: { action: 'auth.session_reuse_detected', entityId: a.id },
    })
    check('…and the reuse is recorded', recorded !== null)
  }

  console.log('\n── 3. A logout inside the window still ends everything ──')
  {
    const a = await mint(staff.id, 'staff', 25 * HOUR)
    const first = await refreshSession(a.raw, 'staff', { ctx })
    check('the day-old token rotates', first.outcome === 'rotated')

    // The user signs out of the successor — a revocation with no replacedById.
    const successorId = first.outcome === 'rotated' ? first.sessionId : ''
    await prisma.session.update({ where: { id: successorId }, data: { revokedAt: new Date() } })

    /*
     * One hop, asserted. A chain that followed the lineage blindly would hand
     * this dead predecessor a live session; requiring the successor itself to
     * be live is what stops a token outliving the logout that should have
     * killed it.
     */
    const ghost = await refreshSession(a.raw, 'staff', { ctx })
    check('the old token is refused because its successor is gone',
      ghost.outcome === 'refused' && ghost.reason === 'successor-gone', JSON.stringify(ghost))

    const plain = await mint(staff.id, 'staff')
    await prisma.session.update({ where: { id: plain.id }, data: { revokedAt: new Date() } })
    const loggedOut = await refreshSession(plain.raw, 'staff', { ctx })
    check('a plain logout-revoked token is refused outright',
      loggedOut.outcome === 'refused' && loggedOut.reason === 'revoked', JSON.stringify(loggedOut))
  }

  console.log('\n── 4. Rotation is daily, not every quarter hour ──')
  {
    const fresh = await mint(staff.id, 'staff')
    const before = await prisma.session.count({ where: { userId: staff.id } })
    const renewed = await refreshSession(fresh.raw, 'staff', { ctx, allowRotation: true })
    check('a fresh token is renewed without rotating',
      renewed.outcome === 'renewed', renewed.outcome)
    check('…so no new refresh token is issued', renewed.outcome === 'renewed' && !('refreshToken' in renewed))
    check('…and no new row is written',
      (await prisma.session.count({ where: { userId: staff.id } })) === before)

    const again = await refreshSession(fresh.raw, 'staff', { ctx, allowRotation: true })
    check('renewing twice is idempotent — same session both times',
      again.outcome === 'renewed' && again.sessionId === fresh.id)

    await prisma.session.update({
      where: { id: fresh.id }, data: { createdAt: new Date(Date.now() - 25 * HOUR) },
    })
    const rotated = await refreshSession(fresh.raw, 'staff', { ctx, allowRotation: true })
    check('the same token rotates once it is a day old', rotated.outcome === 'rotated', rotated.outcome)

    /*
     * `allowRotation: false` is what a page render passes — it cannot persist a
     * new refresh cookie, so it must never revoke the old one.
     */
    const dayOld = await mint(staff.id, 'staff', 25 * HOUR)
    const renderPath = await refreshSession(dayOld.raw, 'staff', { ctx, allowRotation: false })
    check('a caller that cannot persist cookies renews but never rotates',
      renderPath.outcome === 'renewed', renderPath.outcome)
    const untouched = await prisma.session.findUniqueOrThrow({ where: { id: dayOld.id } })
    check('…leaving the row unrevoked', untouched.revokedAt === null)
  }

  console.log('\n── 5. Admin sessions are shorter, and scopes do not mix ──')
  {
    check('a staff session lives thirty days', refreshTokenTtlSeconds('staff') === 30 * 86_400,
      `${refreshTokenTtlSeconds('staff')}`)
    check('an admin session lives twelve hours', refreshTokenTtlSeconds('admin') === 12 * 3_600,
      `${refreshTokenTtlSeconds('admin')}`)
    check('…which is shorter than the rotation threshold, so it is absolute',
      refreshTokenTtlSeconds('admin') < rotateAfterSeconds())

    const adm = await mint(admin.id, 'admin')
    const crossed = await refreshSession(adm.raw, 'staff', { ctx })
    check('an admin token presented as staff is refused',
      crossed.outcome === 'refused' && crossed.reason === 'scope', JSON.stringify(crossed))
    const proper = await refreshSession(adm.raw, 'admin', { ctx })
    check('…and accepted in its own scope', proper.outcome === 'renewed')

    await prisma.session.update({
      where: { id: adm.id }, data: { expiresAt: new Date(Date.now() - 1_000) },
    })
    const expired = await refreshSession(adm.raw, 'admin', { ctx })
    check('an expired session is refused', expired.outcome === 'refused' && expired.reason === 'expired')
  }

  console.log('\n── 6. "Remember me: off" can never become a long session ──')
  {
    check('the transient lifetime is shorter than the rotation threshold',
      TRANSIENT_SESSION_TTL_SECONDS < rotateAfterSeconds(),
      `${TRANSIENT_SESSION_TTL_SECONDS} vs ${rotateAfterSeconds()}`)
    // So a transient row expires before it could ever be rotated into a
    // full-length one — which is why no column has to remember it was transient.
  }

  console.log('\n── 7. Changing a restaurant\'s features signs nobody out ──')
  {
    const s = await mint(staff.id, 'staff')
    await setRestaurantFeatures({
      restaurantId: restaurant.id, featureKeys: ['dashboard', 'orders'], packageId: null,
    })
    const still = await lookupRefreshSession(s.raw, 'staff')
    check('the session is still live after a feature edit', still.kind === 'live', still.kind)
    await setRestaurantFeatures({ restaurantId: restaurant.id, featureKeys: [], packageId: null })
  }

  console.log('\n── 8. The second factor at sign-in ──')
  {
    const unenrolled = await secondFactorGate({ userId: staff.id })
    check('an account without MFA passes straight through', unenrolled.outcome === 'not-enrolled')

    const enrolment = await startEnrolment({ userId: admin.id, email: admin.email })
    const now = () => Math.floor(Date.now() / 1000 / 30)
    const { recoveryCodes } = await confirmEnrolment({
      userId: admin.id, code: totpAt(base32Decode(enrolment.secret), now()),
    })

    const challenged = await secondFactorGate({ userId: admin.id })
    check('an enrolled account with no code is challenged', challenged.outcome === 'code-required')
    const wrong = await secondFactorGate({ userId: admin.id, code: '000000' })
    check('a wrong code is refused', wrong.outcome === 'bad-code')
    const right = await secondFactorGate({
      userId: admin.id, code: totpAt(base32Decode(enrolment.secret), now()),
    })
    check('the right code passes', right.outcome === 'ok' && !right.usedRecoveryCode)
    const recovery = await secondFactorGate({ userId: admin.id, code: recoveryCodes[0] })
    check('a recovery code passes and says so', recovery.outcome === 'ok' && recovery.usedRecoveryCode)
    const spent = await secondFactorGate({ userId: admin.id, code: recoveryCodes[0] })
    check('…and cannot be spent twice', spent.outcome === 'bad-code')
  }

  console.log('\n── 9. The compare-and-swap itself ──')
  {
    const row = await mint(staff.id, 'staff', 25 * HOUR)
    const predecessor = await prisma.session.findUniqueOrThrow({ where: { id: row.id } })
    // Bound the count to rows born in THIS race — earlier sections left live
    // rows of their own for the same user, and `mint` backdates `createdAt`, so
    // a "created in the last few seconds" window is not the same set.
    const raceStartedAt = new Date()
    const [p, q] = await Promise.all([
      rotateSessionRecord({ predecessor, scope: 'staff', ctx }),
      rotateSessionRecord({ predecessor, scope: 'staff', ctx }),
    ])
    check('two concurrent rotations of one row: exactly one wins',
      [p, q].filter(Boolean).length === 1, `${p ? 'won' : 'lost'} / ${q ? 'won' : 'lost'}`)
    const successors = await prisma.session.count({
      where: { userId: staff.id, createdAt: { gte: raceStartedAt } },
    })
    check('…and the loser\'s row was rolled back, not orphaned', successors === 1, `${successors}`)
  }

  await prisma.session.deleteMany({ where: { userId: { in: [staff.id, admin.id] } } })
  await prisma.auditLog.deleteMany({ where: { userId: { in: [staff.id, admin.id] } } })
  await prisma.user.delete({ where: { id: admin.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
