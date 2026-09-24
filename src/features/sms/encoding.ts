/**
 * How many texts one message actually is.
 *
 * ── Why this is not `text.length / 160` ─────────────────────────────────────
 *
 * A gateway bills per segment, not per message, and the segment count depends
 * on which alphabet the text falls into. Three facts make the naive division
 * wrong in ways that show up on a bill:
 *
 *   1. A single character outside GSM 03.38 drops the whole message to UCS-2,
 *      where a segment holds 70 characters instead of 160. One curly quote
 *      pasted from Word turns a one-part message into a three-part one.
 *   2. Sinhala and Tamil are always UCS-2. An owner writing an OTP in Sinhala
 *      is buying three segments per code, and should learn that while typing
 *      rather than from their statement.
 *   3. Nine GSM-7 characters — ^ { } \ [ ~ ] | € — are stored as an escape plus
 *      the character, so they cost TWO septets each. Miss this and any message
 *      containing a € or a brace is counted short.
 *
 * Concatenated messages also shrink: six septets of each segment go to the
 * header that reassembles them, so it is 153 per part rather than 160, and 67
 * rather than 70. The limits below are the real ones, not the round ones.
 *
 * Client-safe on purpose: the settings wizard runs this on every keystroke to
 * show "2 segments · 178/306 characters" as the owner composes.
 */

/** GSM 03.38 basic set, in code order. Each character costs one septet. */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'

/** The extension table. Each of these costs two septets: ESC, then the glyph. */
const GSM7_EXTENDED = '^{}\\[~]|€'

const BASIC = new Set(GSM7_BASIC.split(''))
const EXTENDED = new Set(GSM7_EXTENDED.split(''))

/* Real limits, header included. */
const GSM7_SINGLE = 160
const GSM7_CONCATENATED = 153
const UCS2_SINGLE = 70
const UCS2_CONCATENATED = 67

export type SmsAlphabet = 'GSM7' | 'UCS2'

export interface SegmentCount {
  alphabet: SmsAlphabet
  /** Septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number
  segments: number
  /** How many more units fit before another segment is bought. */
  remaining: number
}

/** Whether every character survives the 7-bit alphabet. */
export function isGsm7(text: string): boolean {
  for (const char of text) {
    if (!BASIC.has(char) && !EXTENDED.has(char)) return false
  }
  return true
}

/** Septets, counting the extension table's characters as the two they cost. */
function countSeptets(text: string): number {
  let septets = 0
  for (const char of text) {
    septets += EXTENDED.has(char) ? 2 : 1
  }
  return septets
}

/**
 * UTF-16 code units, which is what a UCS-2 segment is measured in.
 *
 * `text.length` rather than `[...text].length`: an emoji is a surrogate pair
 * and genuinely occupies two units of a segment, so the string length is the
 * correct measure here and the iterator's would undercount.
 */
const countUnits = (text: string): number => text.length

/**
 * What this message costs to send.
 *
 * `force` mirrors the gateway's own encoding setting: an owner who has set
 * their gateway to unicode pays the UCS-2 rate even for plain ASCII, and the
 * preview should say so rather than quoting the GSM-7 price.
 */
export function countSegments(text: string, force: 'auto' | 'gsm7' | 'unicode' = 'auto'): SegmentCount {
  const alphabet: SmsAlphabet =
    force === 'unicode' ? 'UCS2' : force === 'gsm7' ? 'GSM7' : isGsm7(text) ? 'GSM7' : 'UCS2'

  const units = alphabet === 'GSM7' ? countSeptets(text) : countUnits(text)
  const single = alphabet === 'GSM7' ? GSM7_SINGLE : UCS2_SINGLE
  const concatenated = alphabet === 'GSM7' ? GSM7_CONCATENATED : UCS2_CONCATENATED

  /* An empty message is still one segment: a gateway handed "" bills for it. */
  if (units === 0) return { alphabet, units: 0, segments: 1, remaining: single }
  if (units <= single) return { alphabet, units, segments: 1, remaining: single - units }

  const segments = Math.ceil(units / concatenated)
  return { alphabet, units, segments, remaining: segments * concatenated - units }
}

/**
 * The characters that forced this message out of GSM-7, de-duplicated.
 *
 * "You have 3 segments" is a fact; "the — and the ’ made this 3 segments" is
 * something an owner can act on, usually by retyping two characters.
 */
export function nonGsm7Characters(text: string): string[] {
  const offenders = new Set<string>()
  for (const char of text) {
    if (!BASIC.has(char) && !EXTENDED.has(char)) offenders.add(char)
  }
  return [...offenders]
}
