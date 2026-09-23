import { randomBytes } from 'node:crypto'

/**
 * The code that goes in a QR image (ar.md §17, §25).
 *
 * ── Why not the row's `id` ──────────────────────────────────────────────────
 *
 * These are printed, laminated, taped to tables and photographed. §25 says not
 * to put internal database identifiers on them, and a cuid also leaks roughly
 * when the row was made and roughly how many exist. A separate code is also
 * what makes §17's "regenerate" possible at all: the identity of the
 * experience stays put while the public handle changes, so the orders and
 * customers already pointing at it are undisturbed.
 *
 * ── Crockford's alphabet ────────────────────────────────────────────────────
 *
 * No I, L, O or U. The first three because a code gets read aloud down a phone
 * or re-typed from a photo of a card, where `1/I/l` and `0/O` are the same
 * character; the fourth because excluding it is how Crockford avoids printing
 * an accidental obscenity on a restaurant table.
 *
 * Ten characters of a 32-letter alphabet is 50 bits — about 10^15 codes. These
 * addresses are unauthenticated, so the point is not secrecy (anybody who scans
 * the card has it) but that guessing one at random is hopeless.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
const LENGTH = 10

/** What a code looks like, for route validation and tests. */
export const PUBLIC_ID_PATTERN = /^[0-9abcdefghjkmnpqrstvwxyz]{10}$/

/**
 * A fresh code.
 *
 * Rejection sampling rather than `% 32`: a byte is 0-255, which is not a whole
 * number of alphabets, so the modulo would make the first 8 letters fractionally
 * likelier than the rest. Cheap to do properly.
 */
export function newPublicId(): string {
  let out = ''
  while (out.length < LENGTH) {
    for (const byte of randomBytes(LENGTH)) {
      if (byte >= 248) continue
      out += ALPHABET[byte % ALPHABET.length]
      if (out.length === LENGTH) break
    }
  }
  return out
}

/** Normalise what somebody typed or a route captured. Null when it is not a code. */
export function readPublicId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = raw.trim().toLowerCase()
  return PUBLIC_ID_PATTERN.test(value) ? value : null
}
