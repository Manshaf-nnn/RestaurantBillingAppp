/**
 * What a printed bill shows (bill.md §1).
 *
 * ── The rule, and why it inverts what was here before ───────────────────────
 *
 * `buildReceipt` used to drop a row whenever its value was zero, on the sound
 * reasoning that a narrow roll of paper should not spend a line establishing
 * nothing. But an owner who has switched Service Charge ON is asking a
 * different question — they want the guest to SEE that no service charge was
 * added, because a bill that simply omits it invites the argument about
 * whether it was quietly included. So: hidden when the owner says hidden,
 * printed when the owner says printed, at zero or not.
 *
 * Enabled ⇒ shown, even at 0.00. Disabled ⇒ absent. Nothing in between.
 *
 * ── Why this is not in `printerConfig` ──────────────────────────────────────
 *
 * That column is the hardware — 58mm or 80mm — written by its own form. Two
 * settings forms writing one JSON column is how one form silently deletes the
 * other's keys, and separate columns make that impossible rather than merely
 * fixed.
 *
 * Neither `server-only` nor `use client`: server pages read it, client
 * components render from it, exactly like `paper.ts` beside it.
 */

export interface ReceiptFields {
  /* Who the bill is from */
  logo: boolean
  /**
   * Raise contrast and drop colour before the printer sees it. A thermal head
   * is one bit deep and its driver dithers whatever it is handed; lifting
   * contrast first is the one thing that measurably helps a mid-grey logo.
   * Off prints the image as-is, which is what an already black-and-white logo
   * wants.
   */
  logoMono: boolean
  restaurantName: boolean
  address: boolean
  phone: boolean

  /* Who served it, and which document this is */
  cashierName: boolean
  invoiceNumber: boolean
  dateTime: boolean
  customer: boolean

  /* The food */
  itemNames: boolean
  quantity: boolean
  unitPrice: boolean

  /* The money. Each of these is a row that prints at zero when enabled. */
  discount: boolean
  subtotal: boolean
  serviceCharge: boolean
  tax: boolean
  rounding: boolean
  grandTotal: boolean

  /* How it was settled */
  paymentMethod: boolean
  paidAmount: boolean
  /** Both the balance still due and the change handed back. */
  balance: boolean

  /* The last line */
  footer: boolean
  footerText: string
}

/**
 * Exactly what a receipt prints today.
 *
 * `logo`, `cashierName` and `unitPrice` start OFF because no receipt has ever
 * carried them; switching them on for every restaurant on deploy would change
 * paper nobody asked to change. The money rows start ON, which does mean a
 * restaurant with no service charge begins printing `Service 0.00` — that is
 * precisely what §1 asks for, it is one click to turn off, and the alternative
 * (defaulting them off) would stop printing a discount that prints today,
 * which is the worse regression.
 */
export const DEFAULT_RECEIPT_FIELDS: ReceiptFields = {
  logo: false,
  logoMono: true,
  restaurantName: true,
  address: true,
  phone: true,

  cashierName: false,
  invoiceNumber: true,
  dateTime: true,
  customer: true,

  itemNames: true,
  quantity: true,
  unitPrice: false,

  discount: true,
  subtotal: true,
  serviceCharge: true,
  tax: true,
  rounding: true,
  grandTotal: true,

  paymentMethod: true,
  paidAmount: true,
  balance: true,

  footer: true,
  footerText: '',
}

/** Every toggle, in the order the settings screen shows them. */
export const RECEIPT_FIELD_KEYS = Object.keys(DEFAULT_RECEIPT_FIELDS).filter(
  (key) => key !== 'footerText',
) as Array<Exclude<keyof ReceiptFields, 'footerText'>>

/**
 * Read stored settings over the defaults.
 *
 * Spread over defaults rather than trusting the blob, so a field added to this
 * interface next year still has a value on every restaurant saved before it
 * existed — and one malformed row can never stop a till printing.
 */
export function readReceiptFields(value: unknown): ReceiptFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_RECEIPT_FIELDS
  const raw = value as Record<string, unknown>

  const fields = { ...DEFAULT_RECEIPT_FIELDS }
  for (const key of RECEIPT_FIELD_KEYS) {
    if (typeof raw[key] === 'boolean') fields[key] = raw[key] as boolean
  }
  if (typeof raw.footerText === 'string') fields.footerText = raw.footerText.slice(0, 160)
  return fields
}
