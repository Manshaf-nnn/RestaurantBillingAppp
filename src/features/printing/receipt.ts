import { formatMoney } from '@/lib/money'
import { formatDateTime } from '@/lib/datetime'

import type { PaperWidth } from './paper'
import { DEFAULT_RECEIPT_FIELDS, type ReceiptFields } from './receipt-fields'

/**
 * Turning a bill into something printable.
 *
 * ── Why it is here and not inside a screen ──────────────────────────────────
 *
 * This mapping lived as a private function in `cashier-board.tsx`, and
 * `order-detail.tsx` had a second hand-rolled copy of it inline. Two copies of
 * "what a receipt looks like" is how one screen ends up printing a discount row
 * the other omits — and now that the POS prints too, there would have been
 * three. One copy, four callers.
 *
 * ── The rule about zero rows ────────────────────────────────────────────────
 *
 * It used to be: drop any row whose value is zero. It is now: print the rows
 * the owner switched on, at zero or not, and drop the ones they switched off
 * (bill.md §1). An owner who turns Service Charge ON wants the guest to see
 * that none was added, because a bill that silently omits it is the bill you
 * end up arguing about. `DEFAULT_RECEIPT_FIELDS` keeps the previous shape for
 * anyone who never opens the setting.
 *
 * ── Money is formatted here, deliberately ───────────────────────────────────
 *
 * `ReceiptInput` takes pre-formatted strings, so the printer never has to know
 * about currencies or locales. That keeps `print.ts` a layout concern and puts
 * every rounding decision in `formatMoney`, which is the only thing in the app
 * that should be making them.
 *
 * Nothing here computes money. Every figure arrives already decided by the
 * billing engine; the only arithmetic is `owed = grandTotal + tip` and the
 * balance that follows from it, which are presentation of numbers the engine
 * produced.
 */

export interface ReceiptRestaurant {
  name: string
  currency: string
  locale: string
  /** The restaurant's IANA zone. A bill is stamped in business time, not in
   *  the server's timezone nor the reader's — see lib/datetime. */
  timeZone?: string | null
  taxLabel: string
  /** Thermal paper widths chosen in Settings. */
  paper: { receipt: PaperWidth; kitchen: PaperWidth }
  addressLine: string | null
  phone: string | null
  /** Shown at the top of the bill when the logo field is switched on. */
  logoUrl: string | null
  /*
   * Which rows this restaurant prints.
   *
   * REQUIRED, deliberately. It was optional, with `buildReceipt` falling back
   * to the defaults — which compiled everywhere and meant the settings screen
   * saved toggles that no receipt ever read. An owner switched a row off, the
   * bill printed it anyway, and nothing anywhere said why. Required, the
   * compiler names every screen that has to pass it.
   */
  fields: ReceiptFields
}

/** Everything a receipt needs from the order itself. */
export interface PrintableBill {
  orderNumber: string
  /** ISO string. */
  placedAt: string
  tableNumber: string | null
  customerName: string
  customerPhone?: string | null
  /** Who rang it up — credited on the paper when the field is on. */
  cashierName?: string | null
  /**
   * Only set once the bill has been settled in full — invoices are issued by
   * the payment, not by placing the order. A bill printed at the counter the
   * moment food is sent to the kitchen has none, and the printed copy omits the
   * row rather than showing a blank one.
   */
  invoiceNumber?: string | null
  items: Array<{
    name: string
    optionsLabel?: string
    quantity: number
    unitPrice?: number
    lineTotal: number
  }>
  subtotal: number
  discountTotal: number
  serviceCharge: number
  taxTotal: number
  grandTotal: number
  /*
   * The rest of the money story, all optional so the existing callers keep
   * working. A receipt that shows a total but not the loyalty discount that
   * shaped it, the tip riding on top, or what remains unpaid is a receipt whose
   * lines cannot produce its own bottom line (§92).
   */
  loyaltyDiscount?: number
  tipAmount?: number
  roundingAdj?: number
  paidTotal?: number
  /** Cash handed back, when the guest tendered more than the bill. */
  changeAmount?: number
  /** Names the discount on the paper, e.g. "Discount (SAVE10)". */
  couponCode?: string | null
  payments?: Array<{ method: string; amount: number }>
}

export interface ReceiptTotalRow {
  label: string
  value: string
  strong?: boolean
}

/**
 * The money rows, in order.
 *
 * Exported because the guest's on-screen bill renders the same ladder in its
 * own markup. It shares this list rather than the HTML: forcing a responsive
 * web page with pay buttons through the thermal template would wreck it, and
 * keeping a second copy of the gates is exactly the drift this module's header
 * comment exists to prevent.
 */
export function receiptTotals(
  bill: PrintableBill,
  restaurant: Pick<ReceiptRestaurant, 'currency' | 'locale' | 'taxLabel'>,
  fields: ReceiptFields = DEFAULT_RECEIPT_FIELDS,
): ReceiptTotalRow[] {
  const money = (minor: number) => formatMoney(minor, restaurant.currency, restaurant.locale)

  const tip = bill.tipAmount ?? 0
  const paid = bill.paidTotal ?? 0
  const change = bill.changeAmount ?? 0
  const owed = bill.grandTotal + tip
  const balance = owed - paid

  const discountLabel = bill.couponCode ? `Discount (${bill.couponCode})` : 'Discount'

  return [
    ...(fields.subtotal ? [{ label: 'Subtotal', value: money(bill.subtotal) }] : []),
    ...(fields.discount ? [{ label: discountLabel, value: `-${money(bill.discountTotal)}` }] : []),
    // Loyalty rides with the discount switch: it is a discount, and an owner
    // toggling "Discount" off is not asking to keep a second discount row.
    ...(fields.discount && bill.loyaltyDiscount ? [{ label: 'Loyalty', value: `-${money(bill.loyaltyDiscount)}` }] : []),
    ...(fields.serviceCharge ? [{ label: 'Service', value: money(bill.serviceCharge) }] : []),
    ...(fields.tax ? [{ label: restaurant.taxLabel, value: money(bill.taxTotal) }] : []),
    ...(fields.rounding ? [{ label: 'Rounding', value: money(bill.roundingAdj ?? 0) }] : []),
    ...(fields.grandTotal ? [{ label: 'TOTAL', value: money(bill.grandTotal), strong: true }] : []),
    // The tip is the staff's, riding on top of the bill — shown after the
    // total precisely because it is not part of it. No toggle of its own:
    // suppressing a tip the guest agreed to pay would make the paper lie.
    ...(tip ? [{ label: 'Tip', value: money(tip) }, { label: 'TO PAY', value: money(owed), strong: true }] : []),
    ...(fields.paidAmount ? (bill.payments ?? []).map((payment) => ({
      label: `Paid · ${payment.method}`,
      value: money(payment.amount),
    })) : []),
    ...(fields.balance && paid > 0 && balance > 0
      ? [{ label: 'BALANCE DUE', value: money(balance), strong: true }]
      : []),
    ...(fields.balance && change > 0 ? [{ label: 'CHANGE', value: money(change), strong: true }] : []),
  ]
}

export function buildReceipt(
  bill: PrintableBill,
  restaurant: ReceiptRestaurant,
  options: {
    /** Adds a "Paid via" line. Omitted on an unpaid bill. */
    paymentMethod?: string | null
    /** Replaces the restaurant's own footer for this one print. */
    footer?: string
  } = {},
) {
  const money = (minor: number) => formatMoney(minor, restaurant.currency, restaurant.locale)
  const fields = restaurant.fields

  /*
   * Switched-off fields are nulled here rather than gated in the template, so
   * `print.ts` stays a layout concern that knows nothing about settings — its
   * existing `${x ? … : ''}` conditionals already do the right thing with a
   * null, and there is one place to look for why a row is missing.
   */
  return {
    restaurantName: fields.restaurantName ? restaurant.name : null,
    logoUrl: fields.logo ? (restaurant.logoUrl ?? null) : null,
    logoMono: fields.logoMono,
    addressLine: fields.address ? restaurant.addressLine : null,
    phone: fields.phone ? restaurant.phone : null,
    orderNumber: bill.orderNumber,
    invoiceNumber: fields.invoiceNumber ? (bill.invoiceNumber ?? null) : null,
    tableNumber: bill.tableNumber,
    customerName: fields.customer ? bill.customerName : null,
    customerPhone: fields.customer ? (bill.customerPhone ?? null) : null,
    cashierName: fields.cashierName ? (bill.cashierName ?? null) : null,
    placedAt: fields.dateTime ? bill.placedAt : null,
    timeZone: restaurant.timeZone ?? null,
    locale: restaurant.locale,
    paymentMethod: fields.paymentMethod ? options.paymentMethod : null,
    /*
     * null means "print no footer at all". The template used to read
     * `footer ?? 'Thank you…'`, so an empty string printed an empty centred
     * line while undefined printed the default — a distinction nobody could
     * see and everybody tripped over.
     */
    footer: fields.footer
      ? options.footer || fields.footerText || 'Thank you — please come again!'
      : null,
    lines: fields.itemNames
      ? bill.items.map((item) => ({
          name: item.name,
          optionsLabel: item.optionsLabel,
          quantity: fields.quantity ? item.quantity : null,
          unitPrice: fields.unitPrice && item.unitPrice !== undefined ? money(item.unitPrice) : null,
          lineTotal: money(item.lineTotal),
        }))
      : [],
    totals: receiptTotals(bill, restaurant, fields),
  }
}

/** What a printed receipt needs — the shape `buildReceipt` returns. */
export type ReceiptView = ReturnType<typeof buildReceipt>

/** Date and time in the restaurant's own clock, for the printed copy. */
export function receiptTimestamp(receipt: {
  placedAt: string | null
  timeZone?: string | null
  locale?: string
}): string | null {
  if (!receipt.placedAt) return null
  return formatDateTime(receipt.placedAt, { locale: receipt.locale, timeZone: receipt.timeZone })
}
