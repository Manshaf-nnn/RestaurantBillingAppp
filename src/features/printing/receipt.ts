import { formatMoney } from '@/lib/money'

import type { PaperWidth } from './paper'

/**
 * Turning a bill into something printable.
 *
 * ── Why it is here and not inside a screen ──────────────────────────────────
 *
 * This mapping lived as a private function in `cashier-board.tsx`, and
 * `order-detail.tsx` had a second hand-rolled copy of it inline. Two copies of
 * "what a receipt looks like" is how one screen ends up printing a discount row
 * the other omits — and now that the POS prints too, there would have been
 * three. One copy, three callers.
 *
 * ── The rule about zero rows ────────────────────────────────────────────────
 *
 * Discount, service charge and tax appear only when they are not zero. A
 * thermal receipt is narrow and a queue is long: a line reading "Service 0.00"
 * costs a line of paper and a moment of a guest's attention to establish
 * nothing. TOTAL is always there, and always bold.
 *
 * ── Money is formatted here, deliberately ───────────────────────────────────
 *
 * `ReceiptInput` takes pre-formatted strings, so the printer never has to know
 * about currencies or locales. That keeps `print.ts` a layout concern and puts
 * every rounding decision in `formatMoney`, which is the only thing in the app
 * that should be making them.
 */

export interface ReceiptRestaurant {
  name: string
  currency: string
  locale: string
  taxLabel: string
  /** Thermal paper widths chosen in Settings. */
  paper: { receipt: PaperWidth; kitchen: PaperWidth }
  addressLine: string | null
  phone: string | null
}

/** Everything a receipt needs from the order itself. */
export interface PrintableBill {
  orderNumber: string
  /** ISO string. */
  placedAt: string
  tableNumber: string | null
  customerName: string
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
    lineTotal: number
  }>
  subtotal: number
  discountTotal: number
  serviceCharge: number
  taxTotal: number
  grandTotal: number
  /*
   * The rest of the money story, all optional so the three existing callers
   * keep working. A receipt that shows a total but not the loyalty discount
   * that shaped it, the tip riding on top, or what remains unpaid is a
   * receipt whose lines cannot produce its own bottom line (§92).
   */
  loyaltyDiscount?: number
  tipAmount?: number
  roundingAdj?: number
  paidTotal?: number
  payments?: Array<{ method: string; amount: number }>
}

export function buildReceipt(
  bill: PrintableBill,
  restaurant: ReceiptRestaurant,
  options: {
    /** Adds a "Paid via" line. Omitted on an unpaid bill. */
    paymentMethod?: string | null
    /** Replaces the default thank-you line. */
    footer?: string
  } = {},
) {
  const money = (minor: number) => formatMoney(minor, restaurant.currency, restaurant.locale)

  return {
    restaurantName: restaurant.name,
    addressLine: restaurant.addressLine,
    phone: restaurant.phone,
    orderNumber: bill.orderNumber,
    invoiceNumber: bill.invoiceNumber ?? null,
    tableNumber: bill.tableNumber,
    customerName: bill.customerName,
    placedAt: bill.placedAt,
    paymentMethod: options.paymentMethod,
    footer: options.footer,
    lines: bill.items.map((item) => ({
      name: item.name,
      optionsLabel: item.optionsLabel,
      quantity: item.quantity,
      lineTotal: money(item.lineTotal),
    })),
    totals: (() => {
      const tip = bill.tipAmount ?? 0
      const paid = bill.paidTotal ?? 0
      const owed = bill.grandTotal + tip
      const balance = owed - paid
      return [
        { label: 'Subtotal', value: money(bill.subtotal) },
        ...(bill.discountTotal ? [{ label: 'Discount', value: `-${money(bill.discountTotal)}` }] : []),
        ...(bill.loyaltyDiscount ? [{ label: 'Loyalty', value: `-${money(bill.loyaltyDiscount)}` }] : []),
        ...(bill.serviceCharge ? [{ label: 'Service', value: money(bill.serviceCharge) }] : []),
        ...(bill.taxTotal ? [{ label: restaurant.taxLabel, value: money(bill.taxTotal) }] : []),
        ...(bill.roundingAdj ? [{ label: 'Rounding', value: money(bill.roundingAdj) }] : []),
        { label: 'TOTAL', value: money(bill.grandTotal), strong: true },
        // The tip is the staff's, riding on top of the bill — shown after the
        // total precisely because it is not part of it.
        ...(tip ? [{ label: 'Tip', value: money(tip) }, { label: 'TO PAY', value: money(owed), strong: true }] : []),
        ...(bill.payments ?? []).map((payment) => ({
          label: `Paid · ${payment.method}`,
          value: money(payment.amount),
        })),
        ...(paid > 0 && balance > 0 ? [{ label: 'BALANCE DUE', value: money(balance), strong: true }] : []),
      ]
    })(),
  }
}
