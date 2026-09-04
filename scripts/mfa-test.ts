/**
 * MFA for privileged accounts (production.md §14).
 *
 * The properties worth pinning are the ones that make a second factor either
 * real or a liability:
 *
 *   • a correct code passes and a wrong one does not — including a code from
 *     the wrong time window, which is what an attacker replaying a shoulder-
 *     surfed number a minute later is doing;
 *   • the secret at rest is not the secret, so a database dump alone is not a
 *     set of working second factors;
 *   • enrolment does not take effect until the user has proved they can read a
 *     code, or a dropped phone mid-setup locks them out;
 *   • a recovery code works exactly once, because a reusable one is a password
 *     that never expires and is written on a piece of paper.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/mfa-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  base32Decode, base32Encode, confirmEnrolment, decryptSecret, encryptSecret,
  startEnrolment, totpAt, verifySecondFactor, verifyTotp,
} from '../src/server/auth/mfa'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  const stamp = Date.now().toString(36)
  process.env.JWT_ACCESS_SECRET ||= 'test-secret-for-mfa'

  console.log('\n── 1. The algorithm is RFC 6238 ──')
  {
    // The RFC's own test vector: secret "12345678901234567890", T=59 -> 94287082.
    const secret = Buffer.from('12345678901234567890', 'utf8')
    const counter = Math.floor(59 / 30)
    check('RFC 6238 test vector reproduces', totpAt(secret, counter) === '287082',
      totpAt(secret, counter))

    const round = base32Encode(Buffer.from('hello world!'))
    check('base32 round-trips', base32Decode(round).toString('utf8') === 'hello world!')
  }

  console.log('\n── 2. The stored secret is not the secret ──')
  {
    const plain = base32Encode(Buffer.from('a-real-secret-value'))
    const stored = encryptSecret(plain)
    check('what is stored does not contain the secret', !stored.includes(plain))
    check('…and decrypts back to it', decryptSecret(stored) === plain)
    check('two encryptions of the same secret differ (fresh IV)',
      encryptSecret(plain) !== encryptSecret(plain))
  }

  console.log('\n── 3. Enrolment, and the code that proves it ──')
  {
    const user = await prisma.user.create({
      data: {
        email: `mfa-${stamp}@test.local`, name: 'Operator', passwordHash: 'x',
        role: 'SUPER_ADMIN',
      },
    })

    const enrolment = await startEnrolment({ userId: user.id, email: user.email })
    check('an otpauth URL is produced for the authenticator app',
      enrolment.otpauthUrl.startsWith('otpauth://totp/') &&
        enrolment.otpauthUrl.includes('secret='))

    const started = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    check('MFA is NOT yet on — a dropped phone mid-setup must not lock anyone out',
      started.mfaEnabledAt === null)
    check('and the secret is stored encrypted, never in the clear',
      started.mfaSecret !== null && !started.mfaSecret.includes(enrolment.secret))

    // A wrong code must not complete enrolment.
    let refused = false
    try {
      await confirmEnrolment({ userId: user.id, code: '000000' })
    } catch { refused = true }
    check('a wrong code does not complete enrolment', refused)
    const stillOff = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    check('…and MFA stays off', stillOff.mfaEnabledAt === null)

    const now = Math.floor(Date.now() / 1000 / 30)
    const good = totpAt(base32Decode(enrolment.secret), now)
    const { recoveryCodes } = await confirmEnrolment({ userId: user.id, code: good })
    check('the right code completes enrolment', recoveryCodes.length === 10)

    const on = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    check('…and MFA is now on', on.mfaEnabledAt !== null)

    const stored = await prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } })
    check('recovery codes are stored hashed, not in the clear',
      stored.length === 10 && stored.every((row) => !recoveryCodes.includes(row.codeHash)))

    console.log('\n── 4. Verification at sign-in ──')
    check('the current code is accepted',
      (await verifySecondFactor({ userId: user.id, code: totpAt(base32Decode(enrolment.secret), Math.floor(Date.now() / 1000 / 30)) })).ok)
    check('a wrong code is refused',
      !(await verifySecondFactor({ userId: user.id, code: '123456' })).ok)

    /*
     * A code from ten minutes ago. The accepted window is one step either side
     * of now, so this is the replay an attacker attempts with a number they
     * saw over somebody's shoulder.
     */
    const stale = totpAt(base32Decode(enrolment.secret), Math.floor(Date.now() / 1000 / 30) - 20)
    check('a stale code from outside the window is refused',
      !verifyTotp(enrolment.secret, stale), stale)

    console.log('\n── 5. Recovery codes work once ──')
    const code = recoveryCodes[0]
    const first = await verifySecondFactor({ userId: user.id, code })
    check('a recovery code gets you in', first.ok && first.usedRecoveryCode)
    const second = await verifySecondFactor({ userId: user.id, code })
    check('…and cannot be used a second time', !second.ok)
    const others = await verifySecondFactor({ userId: user.id, code: recoveryCodes[1] })
    check('the other codes still work', others.ok)

    await prisma.user.delete({ where: { id: user.id } })
  }

  console.log('\n── 6. An account without MFA is not blocked by it ──')
  {
    const plain = await prisma.user.create({
      data: {
        email: `nomfa-${stamp}@test.local`, name: 'Ordinary', passwordHash: 'x', role: 'CASHIER',
      },
    })
    const result = await verifySecondFactor({ userId: plain.id, code: '' })
    check('verification passes through when MFA is not enrolled', result.ok)
    await prisma.user.delete({ where: { id: plain.id } })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
