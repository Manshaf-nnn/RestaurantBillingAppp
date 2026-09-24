import 'server-only'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { AppError } from '@/lib/errors'

/**
 * Credentials that belong to somebody else, stored so we can use them again.
 *
 * ── Encrypted, not hashed ───────────────────────────────────────────────────
 *
 * The same argument `src/server/auth/mfa.ts` makes for a TOTP secret: an SMS
 * gateway key has to be handed back to the gateway on every send, so there is
 * nothing to compare a hash against. Encryption is the honest option, and the
 * key that opens it is the thing that must be protected.
 *
 * ── Why its own key, and not the session secret ─────────────────────────────
 *
 * `mfa.ts` derives its key from `JWT_ACCESS_SECRET`. That is defensible for a
 * second factor a user can re-enrol, and it is the wrong choice here.
 * Rotating `JWT_ACCESS_SECRET` is a routine, expected security action — it
 * signs everybody out, which is annoying and correct. If gateway credentials
 * hang off it too, that routine action ALSO breaks every tenant's SMS with a
 * GCM auth-tag failure, and the breakage surfaces days later as "our OTPs
 * stopped arriving" with nothing to connect it to the rotation. A hygiene
 * action nobody dares perform is not a hygiene action.
 *
 * So: `CREDENTIAL_ENCRYPTION_KEY`, falling back to `JWT_ACCESS_SECRET` so that
 * an existing deployment keeps working the moment this ships. The fallback is
 * a migration aid, not the destination — `credentialKeyStatus()` reports which
 * one is in use so the settings page can say so out loud.
 *
 * ── Why mfa.ts is not refactored to use this ────────────────────────────────
 *
 * It works, it holds live second factors, and rewriting the crypto underneath
 * an enrolled super-admin risks locking somebody out of the platform for a
 * tidiness win. The duplication is deliberate; this note is the record of it.
 * Anything NEW that stores a third-party credential belongs here.
 */

/** Four parts, so a v2 value can never be confused with mfa.ts's `iv.tag.ct`. */
const VERSION = 'v2'

function keyMaterial(): { secret: string; source: 'dedicated' | 'fallback' } {
  const dedicated = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (dedicated && dedicated.length >= 32) return { secret: dedicated, source: 'dedicated' }

  const fallback = process.env.JWT_ACCESS_SECRET
  if (fallback) return { secret: fallback, source: 'fallback' }

  throw new AppError(
    'Neither CREDENTIAL_ENCRYPTION_KEY nor JWT_ACCESS_SECRET is set, so third-party credentials cannot be stored safely',
    500,
    'CREDENTIAL_NO_KEY',
  )
}

/**
 * The AES key for one namespace.
 *
 * Namespacing means a ciphertext sealed for SMS cannot be opened by a future
 * caller that seals something else, even though both derive from one secret.
 */
function keyFor(namespace: string): Buffer {
  const { secret } = keyMaterial()
  return createHash('sha256').update(`${namespace}:${secret}`).digest()
}

/** Stored as `v2.<iv>.<tag>.<ciphertext>`, every part base64. */
export function sealSecret(plain: string, namespace: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(namespace), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.')
}

export function openSecret(stored: string, namespace: string): string {
  const [version, iv, tag, payload] = stored.split('.')

  if (version !== VERSION || !iv || !tag || !payload) {
    /*
     * Deliberately specific. The likeliest cause of a malformed value is a
     * three-part string written by mfa.ts's encryptSecret, and "malformed"
     * alone would send somebody hunting a corrupt database rather than a
     * crossed import.
     */
    throw new AppError(
      `Stored credential is not a ${VERSION} sealed value`,
      500,
      'CREDENTIAL_BAD_STORE',
    )
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(namespace), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString(
      'utf8',
    )
  } catch {
    /*
     * A GCM tag failure means the key changed or the value was tampered with.
     * Both are operational facts worth naming, because the symptom otherwise
     * reaching the owner is "SMS stopped working" with no cause attached.
     */
    throw new AppError(
      'Stored credential could not be decrypted — the encryption key has changed or the value was altered. Re-enter the credential to fix it.',
      500,
      'CREDENTIAL_UNDECRYPTABLE',
    )
  }
}

/** Whether a stored string is one of ours, without attempting to open it. */
export const isSealed = (value: string): boolean => value.startsWith(`${VERSION}.`)

/**
 * The last four characters, for the `•••• 7f3a` display.
 *
 * Not a secret, and worth storing alongside the ciphertext: it is the only way
 * an owner can tell which of their two API keys is in the box without our
 * being able to show them the key.
 */
export function credentialHint(plain: string): string {
  const trimmed = plain.trim()
  return trimmed.length <= 4 ? '••••' : trimmed.slice(-4)
}

/** Which key is in use, so the UI can nudge towards the dedicated one. */
export function credentialKeyStatus(): { configured: boolean; source: 'dedicated' | 'fallback' | 'none' } {
  try {
    return { configured: true, source: keyMaterial().source }
  } catch {
    return { configured: false, source: 'none' }
  }
}
