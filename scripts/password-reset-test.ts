/**
 * Forgot password by emailed code (prisma/email.md §13).
 *
 * Service tier: calls `password-reset.ts` directly, with the mail transport
 * replaced by a function that records what would have been sent — or throws,
 * to stand in for a provider that is down. Time is a parameter, so expiry is
 * tested by asking "what if it were later", not by waiting.
 *
 * Every address is unique to the run: the request limits live in Redis or
 * Postgres counters that outlive a test, and a re-run must not inherit them.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/password-reset-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { hashPassword, verifyPassword } from '../src/server/auth/password'
import { refreshSession } from '../src/server/auth/session'
import { generateToken, hashToken } from '../src/server/auth/password'
import { setMailTransportForTests, type MailInput } from '../src/server/mailer'
import {
  CODE_TTL_MS,
  DAILY_FAILURE_BUDGET,
  GRANT_TTL_MS,
  RESEND_COOLDOWN_MS,
  completeReset,
  emailHashOf,
  maskEmail,
  openFlow,
  requestResetCode,
  sealFlow,
  verifyResetCode,
} from '../src/features/auth/password-reset'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function refuses(name: string, run: () => Promise<unknown>, code: string) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const got = (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error))
    check(name, got === code, `got ${got}`)
  }
}

const stamp = Date.now().toString(36)
const restaurantIds: string[] = []

/** The mailbox: every message the flow tried to send, and a switch to make sending fail. */
const inbox: Array<MailInput & { from: string }> = []
let mailDown = false
setMailTransportForTests(async (message) => {
  if (mailDown) throw new Error('smtp: connection refused')
  inbox.push(message)
})
const lastCodeFor = (to: string) => {
  const message = [...inbox].reverse().find((m) => m.to === to)
  return message?.text?.match(/\b(\d{6})\b/)?.[1] ?? null
}

const NOW = new Date()
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

async function main() {
  // SMTP "configured" for the availability check; the transport above intercepts the send.
  process.env.SMTP_HOST = process.env.SMTP_HOST || 'test.invalid'
  await prisma.platformSetting.deleteMany({ where: { key: 'mail.degradedUntil' } })

  const restaurant = await prisma.restaurant.create({
    data: { name: `Reset ${stamp}`, slug: `reset-${stamp}`, status: 'ACTIVE', isActive: true, timezone: 'Asia/Colombo', currency: 'LKR' },
  })
  restaurantIds.push(restaurant.id)
  const other = await prisma.restaurant.create({
    data: {
      name: `Other ${stamp}`, slug: `other-${stamp}`, status: 'ACTIVE', isActive: true, timezone: 'Asia/Colombo', currency: 'LKR',
      customDomain: `other-${stamp}.example.test`, customDomainVerifiedAt: NOW,
    },
  })
  restaurantIds.push(other.id)

  const oldPassword = 'OldPass123'
  const owner = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `owner-${stamp}@reset.test`, name: 'Nila',
      passwordHash: await hashPassword(oldPassword), role: 'OWNER', signInCode: 'ABCD-EFGH',
    },
  })
  const admin = await prisma.user.create({
    data: { email: `admin-${stamp}@reset.test`, name: 'Platform', passwordHash: await hashPassword(oldPassword), role: 'SUPER_ADMIN' },
  })
  const retired = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `gone-${stamp}@reset.test`, name: 'Gone', passwordHash: 'x', role: 'CASHIER', isActive: false },
  })
  const ghost = `nobody-${stamp}@reset.test`

  const request = (email: string, extra: Partial<Parameters<typeof requestResetCode>[0]> = {}) =>
    requestResetCode({ email, ip: null, host: null, now: NOW, ...extra })

  console.log('\n── 1. Existing and non-existing addresses look the same ──')
  const real = await request(owner.email)
  const decoy = await request(ghost)
  check('a real account gets a code row', real.kind === 'issued')
  check('an unknown address gets one too, of the same shape', decoy.kind === 'issued' && Object.keys(decoy).sort().join() === Object.keys(real).sort().join())
  check('one email went to the real account', inbox.filter((m) => m.to === owner.email).length === 1)
  check('none went to the unknown address', inbox.every((m) => m.to !== ghost))
  const realRow = await prisma.passwordResetCode.findUniqueOrThrow({ where: { id: (real as { rowId: string }).rowId } })
  const decoyRow = await prisma.passwordResetCode.findUniqueOrThrow({ where: { id: (decoy as { rowId: string }).rowId } })
  check('the real row names its user; the decoy names nobody', realRow.userId === owner.id && decoyRow.userId === null)
  const code = lastCodeFor(owner.email)!
  check('the email carries six digits', /^\d{6}$/.test(code ?? ''))
  check('the row stores a keyed hash, never the code', !realRow.codeHash.includes(code) && realRow.codeHash.length === 64)
  check('the message is marked sensitive so an unconfigured server would not log it', inbox[0]?.sensitive === true)
  check('the audit trail records the request for the real account only',
    (await prisma.auditLog.count({ where: { userId: owner.id, action: 'auth.password_reset_requested' } })) === 1)

  console.log('\n── 2. Cooldown, then resend supersedes ──')
  const again = await request(owner.email, { now: at(10_000) })
  check('a second request within a minute is a cooldown, not a new code', again.kind === 'cooldown' && again.retryAfterSeconds > 0 && again.retryAfterSeconds <= 60)
  const ghostAgain = await request(ghost, { now: at(10_000) })
  check('…and the unknown address gets the identical cooldown', ghostAgain.kind === 'cooldown')
  check('no second email was sent', inbox.filter((m) => m.to === owner.email).length === 1)
  const resent = await request(owner.email, { now: at(RESEND_COOLDOWN_MS + 1_000) })
  check('after the cooldown a new code is issued', resent.kind === 'issued')
  const code2 = lastCodeFor(owner.email)!
  check('it is a different code', code2 !== code)
  const first = await prisma.passwordResetCode.findUniqueOrThrow({ where: { id: realRow.id } })
  check('the earlier code is superseded', first.usedAt !== null)
  await refuses('…and no longer verifies', () =>
    verifyResetCode({ rowId: realRow.id, nonce: (real as { nonce: string }).nonce, email: owner.email, code, now: at(RESEND_COOLDOWN_MS + 2_000) }), 'RESET_CODE_INVALID')

  const live = resent as { rowId: string; nonce: string }
  const T = RESEND_COOLDOWN_MS + 5_000

  console.log('\n── 3. Wrong, expired, wrong-browser, then right ──')
  await refuses('a wrong code is refused', () => verifyResetCode({ ...live, email: owner.email, code: code2 === '000000' ? '000001' : '000000', now: at(T) }), 'RESET_CODE_INVALID')
  check('…and costs an attempt', (await prisma.passwordResetCode.findUniqueOrThrow({ where: { id: live.rowId } })).attempts === 1)
  await refuses('the right code from another browser (wrong nonce) is refused', () => verifyResetCode({ ...live, nonce: 'someone-else', email: owner.email, code: code2, now: at(T) }), 'RESET_CODE_INVALID')
  // The resent code was issued at cooldown + 1 s, so it dies at cooldown + 1 s + 10 min.
  await refuses('the right code after ten minutes is refused', () => verifyResetCode({ ...live, email: owner.email, code: code2, now: at(RESEND_COOLDOWN_MS + 1_000 + CODE_TTL_MS + 1) }), 'RESET_CODE_INVALID')
  const { grant } = await verifyResetCode({ ...live, email: owner.email, code: code2, now: at(T) })
  check('the right code earns a grant', typeof grant === 'string' && grant.length > 20)
  const verified = await prisma.passwordResetCode.findUniqueOrThrow({ where: { id: live.rowId } })
  check('the grant is stored hashed', verified.grantHash === hashToken(grant) && verified.verifiedAt !== null)
  const { grant: grant2 } = await verifyResetCode({ ...live, email: owner.email, code: code2, now: at(T + 1) })
  check('a double-submitted correct code rotates the grant instead of failing', grant2 !== grant)

  console.log('\n── 4. Sessions, password, sign-in code ──')
  const mint = async (persistent: boolean) => {
    const token = generateToken()
    await prisma.session.create({ data: { userId: owner.id, refreshTokenHash: hashToken(token), expiresAt: at(30 * 86_400_000) } })
    return token
  }
  const tokens = [await mint(true), await mint(true), await mint(false)]
  const done = await completeReset({ grant: grant2, password: 'NewPass456', now: at(T + 2_000) })
  check('every session was revoked', done.sessionsRevoked === 3, String(done.sessionsRevoked))
  check('…including from the database\'s point of view', (await prisma.session.count({ where: { userId: owner.id, revokedAt: null } })) === 0)
  const refresh = await refreshSession(tokens[0]!, 'staff', { ctx: { ipAddress: null, userAgent: null }, allowRotation: true })
  check('an old refresh token is refused', refresh.outcome === 'refused', refresh.outcome)
  const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })
  check('the old password no longer works', !(await verifyPassword(oldPassword, after.passwordHash)))
  check('the new password does', await verifyPassword('NewPass456', after.passwordHash))
  check('the handed-out sign-in code is cleared (it was the old password)', after.signInCode === null)
  check('the mailbox counts as verified', after.emailVerifiedAt !== null)
  check('lockout counters are cleared', after.failedLogins === 0 && after.lockedUntil === null)
  check('the reset is on the audit trail', (await prisma.auditLog.count({ where: { userId: owner.id, action: 'auth.password_reset' } })) === 1)
  await refuses('the grant cannot be used twice', () => completeReset({ grant: grant2, password: 'Another789', now: at(T + 3_000) }), 'RESET_EXPIRED')
  await refuses('the earlier, rotated-away grant never worked either', () => completeReset({ grant, password: 'Another789', now: at(T + 3_000) }), 'RESET_EXPIRED')

  console.log('\n── 5. Two browsers, one grant: exactly one wins ──')
  {
    const r = await request(owner.email, { now: at(2 * RESEND_COOLDOWN_MS + 10_000) }) as { rowId: string; nonce: string }
    const c = lastCodeFor(owner.email)!
    const t = 2 * RESEND_COOLDOWN_MS + 12_000
    const { grant: g } = await verifyResetCode({ ...r, email: owner.email, code: c, now: at(t) })
    const results = await Promise.allSettled([
      completeReset({ grant: g, password: 'RaceWinner1', now: at(t + 1) }),
      completeReset({ grant: g, password: 'RaceLoser22', now: at(t + 1) }),
    ])
    const wins = results.filter((x) => x.status === 'fulfilled').length
    check('one completes and one is refused', wins === 1, results.map((x) => x.status).join(','))
  }

  console.log('\n── 6. Policy is enforced on the server ──')
  {
    const r = await request(owner.email, { now: at(3 * RESEND_COOLDOWN_MS + 10_000) }) as { rowId: string; nonce: string }
    const c = lastCodeFor(owner.email)!
    const t = 3 * RESEND_COOLDOWN_MS + 12_000
    const { grant: g } = await verifyResetCode({ ...r, email: owner.email, code: c, now: at(t) })
    await refuses('a short password is refused', () => completeReset({ grant: g, password: 'Ab1', now: at(t + 1) }), 'WEAK_PASSWORD')
    await refuses('a common password is refused', () => completeReset({ grant: g, password: 'Password1', now: at(t + 1) }), 'WEAK_PASSWORD')
    await refuses('the current password is refused', () => completeReset({ grant: g, password: 'RaceWinner1', now: at(t + 1) }), 'PASSWORD_REUSED')
    check('…and none of those consumed the grant', (await prisma.passwordResetCode.findUniqueOrThrow({ where: { id: r.rowId } })).usedAt === null)
    await refuses('a grant older than ten minutes is refused', () => completeReset({ grant: g, password: 'Fresh12345', now: at(t + GRANT_TTL_MS + 1) }), 'RESET_EXPIRED')
  }

  console.log('\n── 7. Five wrong guesses lock the code; the sixth is refused even when right ──')
  {
    const email = `lock-${stamp}@reset.test`
    const victim = await prisma.user.create({ data: { restaurantId: restaurant.id, email, name: 'Lock', passwordHash: 'x', role: 'CASHIER' } })
    const r = await request(email) as { rowId: string; nonce: string }
    const c = lastCodeFor(email)!
    for (let i = 1; i <= 5; i += 1) {
      const wrong = String((Number(c) + i) % 1_000_000).padStart(6, '0')
      await refuses(`wrong guess ${i}`, () => verifyResetCode({ ...r, email, code: wrong, now: at(1_000 + i) }), i < 5 ? 'RESET_CODE_INVALID' : 'RESET_CODE_LOCKED')
    }
    await refuses('the right code is now refused too', () => verifyResetCode({ ...r, email, code: c, now: at(2_000) }), 'RESET_CODE_LOCKED')
    check('the lockout is audited', (await prisma.auditLog.count({ where: { userId: victim.id, action: 'auth.password_reset_code_locked' } })) === 1)

    // The daily budget: keep burning codes and the address is refused new ones.
    let budgetHit = false
    for (let round = 1; round <= 3 && !budgetHit; round += 1) {
      const t0 = round * (RESEND_COOLDOWN_MS + 5_000)
      try {
        const rr = await request(email, { now: at(t0) }) as { rowId: string; nonce: string }
        const cc = lastCodeFor(email)!
        for (let i = 1; i <= 5; i += 1) {
          const wrong = String((Number(cc) + i) % 1_000_000).padStart(6, '0')
          try { await verifyResetCode({ ...rr, email, code: wrong, now: at(t0 + i) }) } catch (error) {
            if ((error as { code?: string }).code === 'RATE_LIMITED') { budgetHit = true; break }
          }
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'RATE_LIMITED') budgetHit = true
      }
    }
    check(`after ${DAILY_FAILURE_BUDGET} wrong codes in a day the address is refused`, budgetHit)
  }

  console.log('\n── 8. Who is eligible ──')
  {
    const r = await request(retired.email)
    check('a deactivated account gets a decoy', r.kind === 'issued' && (await prisma.passwordResetCode.findUniqueOrThrow({ where: { id: r.rowId } })).userId === null)
    check('…and no email', inbox.every((m) => m.to !== retired.email))
    const cross = await request(`x-${stamp}@reset.test`, { host: other.customDomain })
    check('an unknown address on another restaurant\'s domain: decoy', cross.kind === 'issued')
    const staff = await prisma.user.create({ data: { restaurantId: restaurant.id, email: `staff-${stamp}@reset.test`, name: 'S', passwordHash: 'x', role: 'CASHIER' } })
    const wrongHost = await request(staff.email, { host: other.customDomain }) as { rowId: string }
    check('a real account asked for on another restaurant\'s domain gets a decoy', (await prisma.passwordResetCode.findUniqueOrThrow({ where: { id: wrongHost.rowId } })).userId === null)
    check('…and no email', inbox.every((m) => m.to !== staff.email))
    const adminReq = await request(admin.email, { host: other.customDomain }) as { rowId: string; nonce: string }
    check('the platform admin is at home on every host', (await prisma.passwordResetCode.findUniqueOrThrow({ where: { id: adminReq.rowId } })).userId === admin.id)
    const { grant: g } = await verifyResetCode({ ...adminReq, email: admin.email, code: lastCodeFor(admin.email)!, now: at(1_000) })
    const doneAdmin = await completeReset({ grant: g, password: 'AdminPass9', now: at(2_000) })
    check('…and resets like anyone else, reporting the role for the right sign-in page', doneAdmin.role === 'SUPER_ADMIN')
  }

  console.log('\n── 9. When the email cannot be sent ──')
  {
    const email = `mail-${stamp}@reset.test`
    await prisma.user.create({ data: { restaurantId: restaurant.id, email, name: 'M', passwordHash: 'x', role: 'CASHIER' } })
    mailDown = true
    await refuses('the request fails plainly', () => request(email), 'RESET_SEND_FAILED')
    const rows = await prisma.passwordResetCode.findMany({ where: { emailHash: emailHashOf(email) } })
    check('the row is voided, so the unsent code can never be guessed', rows.length === 1 && rows[0]!.voidedAt !== null)
    await refuses('every address is refused for the next few minutes, identically', () => request(ghost, { now: at(1_000) }), 'RESET_UNAVAILABLE')
    await refuses('…verification too', () => verifyResetCode({ rowId: rows[0]!.id, nonce: 'x', email, code: '000000', now: at(1_000) }), 'RESET_UNAVAILABLE')
    await prisma.platformSetting.deleteMany({ where: { key: 'mail.degradedUntil' } })
    mailDown = false
    const retry = await request(email, { now: at(2_000) })
    check('once the provider is back a retry works with no cooldown from the failed one', retry.kind === 'issued')
  }

  console.log('\n── 10. The flow cookie ──')
  {
    const flow = { rowId: 'r', nonce: 'n', email: owner.email, from: 'staff' as const, iat: NOW.getTime() }
    const sealed = sealFlow(flow)
    check('a sealed flow opens', openFlow(sealed, NOW)?.rowId === 'r')
    check('a tampered flow does not', openFlow(sealed.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')), NOW) === null)
    check('an old flow does not', openFlow(sealed, at(16 * 60_000)) === null)
    check('the address is masked for the screen', maskEmail('nila@gmail.com') === 'n•••@gmail.com')
  }

  console.log('\n── 11. Nothing secret reached a log ──')
  {
    const codes = inbox.map((m) => m.text?.match(/\b(\d{6})\b/)?.[1]).filter(Boolean) as string[]
    const rows = await prisma.passwordResetCode.findMany({ where: { emailHash: { in: [owner.email, admin.email].map(emailHashOf) } } })
    check('no row contains any code that was emailed', rows.every((row) => codes.every((c) => !row.codeHash.includes(c))))
    const logs = await prisma.auditLog.findMany({ where: { userId: { in: [owner.id, admin.id] } } })
    check('no audit row contains a code or a password', logs.every((row) => {
      const text = JSON.stringify(row)
      return codes.every((c) => !text.includes(c)) && !text.includes('NewPass456') && !text.includes('AdminPass9')
    }))
  }
}

main()
  .catch((error) => { console.error(error); failed += 1 })
  .finally(async () => {
    setMailTransportForTests(null)
    await prisma.platformSetting.deleteMany({ where: { key: 'mail.degradedUntil' } }).catch(() => null)
    // Audit rows keep their actor (RESTRICT), so they go before any user does.
    await prisma.auditLog.deleteMany({
      where: { OR: [{ restaurantId: { in: restaurantIds } }, { user: { email: { endsWith: `-${stamp}@reset.test` } } }] },
    }).catch((error) => console.error('cleanup audit', error.message))
    for (const id of restaurantIds) {
      await prisma.restaurant.delete({ where: { id } }).catch((error) => console.error('cleanup restaurant', error.message))
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: `-${stamp}@reset.test` }, restaurantId: null } }).catch((error) => console.error('cleanup admin', error.message))
    await prisma.passwordResetCode.deleteMany({ where: { userId: null, createdAt: { gt: new Date(NOW.getTime() - 60_000) } } }).catch(() => null)
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
