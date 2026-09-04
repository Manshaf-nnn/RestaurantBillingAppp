import 'server-only'

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { prisma } from '@/server/db/prisma'
import { AppError } from '@/lib/errors'

/**
 * TOTP for privileged accounts (production.md §14).
 *
 * ── Why this is written out rather than installed ───────────────────────────
 *
 * TOTP is RFC 6238 and it is about forty lines: an HMAC, a truncation and a
 * time step. Everything security-relevant about it is in those forty lines, so
 * they are here where they can be read, rather than behind a dependency that
 * would have to be audited anyway and updated for ever.
 *
 * ── The secret is encrypted, not hashed ─────────────────────────────────────
 *
 * Unlike a password, verification has to recompute the code from the original
 * secret, so a one-way digest is not an option. It is encrypted at rest with
 * AES-256-GCM under a key derived from `JWT_ACCESS_SECRET`, which means a
 * database dump alone does not yield anybody's second factor. That is a real
 * but limited protection — an attacker holding both the dump and the
 * application secret has both — and it is stated plainly here rather than
 * implied to be more.
 *
 * ── Recovery codes are not optional ─────────────────────────────────────────
 *
 * MFA on the platform super-admin is, without a way back in, a mechanism for
 * locking the owner out of their own platform permanently the day they lose a
 * phone. Ten single-use codes are generated at enrolment, shown once, and
 * stored hashed exactly like passwords.
 */

const DIGITS = 6
const STEP_SECONDS = 30
/** How many steps either side of now are accepted, for clock drift. */
const WINDOW = 1

/** RFC 4648 base32, which is what every authenticator app expects. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += B32[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of clean) {
    const index = B32.indexOf(char)
    if (index === -1) throw new AppError('That is not a valid secret', 400, 'MFA_BAD_SECRET')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** The code for one time step. */
export function totpAt(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8)
  // Counter is well inside 2^53, so the high word is only non-zero far beyond
  // any date this software will see; written out rather than using BigInt so
  // the arithmetic stays obvious.
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buffer.writeUInt32BE(counter >>> 0, 4)

  const digest = createHmac('sha1', secret).update(buffer).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

/**
 * Is this the code for now, or near enough?
 *
 * Compared with `timingSafeEqual`: a plain `===` leaks, through how long it
 * takes to fail, how many leading digits were right, and six digits is a small
 * enough space that this matters.
 */
export function verifyTotp(secretBase32: string, code: string): boolean {
  const cleaned = code.replace(/\D/g, '')
  if (cleaned.length !== DIGITS) return false

  const secret = base32Decode(secretBase32)
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS)
  const given = Buffer.from(cleaned)

  for (let drift = -WINDOW; drift <= WINDOW; drift += 1) {
    const expected = Buffer.from(totpAt(secret, counter + drift))
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true
  }
  return false
}

/** The AES key, derived from the application secret. */
function encryptionKey(): Buffer {
  const secret = process.env.JWT_ACCESS_SECRET
  if (!secret) {
    throw new AppError(
      'JWT_ACCESS_SECRET is not set, so MFA secrets cannot be stored safely',
      500,
      'MFA_NO_KEY',
    )
  }
  return createHash('sha256').update(`mfa:${secret}`).digest()
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.')
}

export function decryptSecret(stored: string): string {
  const [iv, tag, payload] = stored.split('.')
  if (!iv || !tag || !payload) throw new AppError('Stored MFA secret is malformed', 500, 'MFA_BAD_STORE')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8')
}

const hashCode = (code: string) =>
  createHash('sha256').update(code.replace(/\s|-/g, '').toUpperCase()).digest('hex')

export interface EnrolmentStart {
  secret: string
  otpauthUrl: string
}

/**
 * Begin enrolment: mint a secret and the URL an authenticator app scans.
 *
 * `mfaEnabledAt` stays null until the user proves they can read a code from it.
 * Enabling on generation would let a half-finished enrolment — the QR scanned
 * on a phone that is then dropped — lock somebody out of their own account.
 */
export async function startEnrolment(params: {
  userId: string
  email: string
  issuer?: string
}): Promise<EnrolmentStart> {
  const secret = base32Encode(randomBytes(20))
  await prisma.user.update({
    where: { id: params.userId },
    data: { mfaSecret: encryptSecret(secret), mfaEnabledAt: null },
  })

  const issuer = params.issuer ?? 'TableFlow'
  const label = encodeURIComponent(`${issuer}:${params.email}`)
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  })

  return { secret, otpauthUrl: `otpauth://totp/${label}?${query.toString()}` }
}

/**
 * Finish enrolment, and hand back the recovery codes.
 *
 * The codes are returned once and never again — only their hashes are kept, so
 * nothing, including this application, can show them to anybody later.
 */
export async function confirmEnrolment(params: {
  userId: string
  code: string
}): Promise<{ recoveryCodes: string[] }> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { mfaSecret: true },
  })
  if (!user?.mfaSecret) {
    throw new AppError('Start setting up authentication first', 400, 'MFA_NOT_STARTED')
  }
  if (!verifyTotp(decryptSecret(user.mfaSecret), params.code)) {
    throw new AppError('That code is not right — check the clock on your phone', 400, 'MFA_BAD_CODE')
  }

  const codes = Array.from({ length: 10 }, () =>
    randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g)!.join('-'),
  )

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: params.userId }, data: { mfaEnabledAt: new Date() } })
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: params.userId } })
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((code) => ({ userId: params.userId, codeHash: hashCode(code) })),
    })
  })

  return { recoveryCodes: codes }
}

/**
 * Check a code at sign-in — either a TOTP or a recovery code.
 *
 * A recovery code is consumed as it is used, in one conditional update, so two
 * simultaneous attempts cannot both spend the same one.
 */
export async function verifySecondFactor(params: {
  userId: string
  code: string
}): Promise<{ ok: boolean; usedRecoveryCode: boolean }> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { mfaSecret: true, mfaEnabledAt: true },
  })
  if (!user?.mfaEnabledAt || !user.mfaSecret) return { ok: true, usedRecoveryCode: false }

  if (verifyTotp(decryptSecret(user.mfaSecret), params.code)) {
    return { ok: true, usedRecoveryCode: false }
  }

  const { count } = await prisma.mfaRecoveryCode.updateMany({
    where: { userId: params.userId, codeHash: hashCode(params.code), usedAt: null },
    data: { usedAt: new Date() },
  })
  return { ok: count === 1, usedRecoveryCode: count === 1 }
}

/** Does this account have MFA switched on? */
export async function mfaRequired(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mfaEnabledAt: true },
  })
  return Boolean(user?.mfaEnabledAt)
}

/**
 * Which roles this platform expects to hold a second factor.
 *
 * Reported on the security page as coverage rather than enforced as a hard
 * block at sign-in, and that is a deliberate sequencing decision: switching on
 * mandatory MFA for every existing owner and admin in one deploy locks out
 * every one of them who has not enrolled yet, which on a live platform means
 * every one of them. Coverage first, enforcement once it reads 100%.
 */
export const PRIVILEGED_ROLES = ['SUPER_ADMIN', 'OWNER', 'ADMIN'] as const
