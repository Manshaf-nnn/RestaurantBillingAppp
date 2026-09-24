/**
 * The number to DIAL.
 *
 * ── Why this is not in features/customers/phone.ts ──────────────────────────
 *
 * That file refuses to guess a country code, and it is right to: `phoneKey()`
 * is the identity function behind `@@unique([restaurantId, phoneKey])`, so a
 * wrong guess there does not misdial anybody — it merges two real customers
 * into one loyalty balance and one order history, permanently.
 *
 * A gateway, meanwhile, needs an unambiguous international number. Both facts
 * are true at once, so they get two functions. This one is called at the moment
 * of sending and nowhere else. Its output is never stored on `Customer`, never
 * compared for identity, and never used to merge. `SmsMessage` keeps it beside
 * the raw string the human typed precisely so that "the number was right but
 * the dialling was wrong" stays an answerable question.
 *
 * ── It refuses rather than guesses ──────────────────────────────────────────
 *
 * Rule 5 below has no fallback. A number this cannot resolve produces a visible
 * SUPPRESSED row with a readable reason, which is strictly better than dialling
 * a stranger in another country and billing the owner for it.
 *
 * Client-safe: the settings wizard shows `will dial: 94771234567` live.
 */

import type { NumberFormat } from './types'

export interface CountryDialling {
  iso: 'LK'
  /** Without the plus. */
  code: string
  /** Digits after the country code — 9 for Sri Lanka (e.g. 771234567). */
  nsnLength: number
  /** The prefix a local number carries instead of the country code. */
  trunkPrefix: string
}

export const LK: CountryDialling = { iso: 'LK', code: '94', nsnLength: 9, trunkPrefix: '0' }

export const COUNTRIES: Record<'LK', CountryDialling> = { LK }

export type E164Failure = 'EMPTY' | 'AMBIGUOUS' | 'TOO_SHORT' | 'TOO_LONG'

export type E164Result = { ok: true; e164: string } | { ok: false; reason: E164Failure }

/**
 * Resolve a typed number to E.164, or refuse.
 *
 * The rules run in order, and each one only fires where it is unambiguous:
 *
 *   1. Typed with a plus — the human already said which country.
 *   2. Typed with 00 — the same statement in the older notation.
 *   3. Trunk prefix plus exactly a national number's worth of digits.
 *   4. Already carries the country code at exactly the right total length.
 *   5. Anything else is refused.
 *
 * Rule 4 is deliberately length-checked rather than prefix-checked. "94" is
 * also the start of plenty of nine-digit local numbers, so `947712345` would
 * otherwise be read as a country code and dialled as six digits.
 */
export function toE164(raw: string | null | undefined, country: CountryDialling): E164Result {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'EMPTY' }

  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return { ok: false, reason: 'EMPTY' }

  const full = country.code.length + country.nsnLength

  // 1 — an explicit plus is the human telling us the country.
  if (trimmed.startsWith('+')) {
    if (digits.length < 8) return { ok: false, reason: 'TOO_SHORT' }
    if (digits.length > 15) return { ok: false, reason: 'TOO_LONG' }
    return { ok: true, e164: `+${digits}` }
  }

  // 2 — the same statement, written the old way.
  if (digits.startsWith('00')) {
    const rest = digits.slice(2)
    if (rest.length < 8) return { ok: false, reason: 'TOO_SHORT' }
    if (rest.length > 15) return { ok: false, reason: 'TOO_LONG' }
    return { ok: true, e164: `+${rest}` }
  }

  // 3 — a local number: trunk prefix plus exactly one national number.
  if (
    digits.startsWith(country.trunkPrefix) &&
    digits.length === country.trunkPrefix.length + country.nsnLength
  ) {
    return { ok: true, e164: `+${country.code}${digits.slice(country.trunkPrefix.length)}` }
  }

  // 4 — already international, just missing its plus.
  if (digits.startsWith(country.code) && digits.length === full) {
    return { ok: true, e164: `+${digits}` }
  }

  // 5 — no guessing. A refusal the owner can read beats a misdial they cannot.
  return { ok: false, reason: 'AMBIGUOUS' }
}

/**
 * Render an E.164 number the way one particular gateway wants it.
 *
 * The commonest cause of "the log says sent and the phone never rang". Every
 * gateway has an opinion, most accept the wrong shape without complaint, and
 * all of them bill for it either way.
 */
export function formatForGateway(e164: string, format: NumberFormat, country: CountryDialling): string {
  const digits = e164.replace(/\D/g, '')

  switch (format) {
    case 'e164Plus':
      return `+${digits}`
    case 'e164NoPlus':
      return digits
    case 'nationalLeadingZero': {
      /*
       * Only strip the country code when the remainder is exactly a national
       * number. An international number from elsewhere has no local form, so
       * it keeps its digits rather than being mangled into a plausible-looking
       * local number for the wrong network.
       */
      if (digits.startsWith(country.code) && digits.length === country.code.length + country.nsnLength) {
        return `${country.trunkPrefix}${digits.slice(country.code.length)}`
      }
      return digits
    }
  }
}

/** A number safe to print in a log or a console line: `+9477••••567`. */
export function maskNumber(e164: string): string {
  const digits = e164.replace(/\D/g, '')
  if (digits.length < 7) return '•'.repeat(digits.length)
  return `+${digits.slice(0, 4)}${'•'.repeat(digits.length - 7)}${digits.slice(-3)}`
}

export const E164_FAILURE_MESSAGE: Record<E164Failure, string> = {
  EMPTY: 'No phone number was given',
  AMBIGUOUS: 'This number has no country code and is not a valid local number',
  TOO_SHORT: 'This number is too short to dial',
  TOO_LONG: 'This number is too long to dial',
}
