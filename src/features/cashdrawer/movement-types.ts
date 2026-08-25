import type { CashMovementType } from '@prisma/client'

/**
 * What each kind of cash movement means, and which way it moves the money.
 *
 * ── Why the direction is derived and not stored ─────────────────────────────
 *
 * There used to be two types, CASH_IN and CASH_OUT, and the direction *was* the
 * type. That made "how much went to the bank today" unanswerable — a bank
 * deposit, a cash drop, a supplier paid at the door and a petty cash expense
 * were one indistinguishable pile of CASH_OUT rows separated only by whatever
 * the cashier happened to type in the reason box.
 *
 * Splitting them could have meant carrying a direction column alongside the
 * type. It does not, because then a row could say PETTY_CASH_PAID and +1, and
 * nothing would stop it. The direction belongs to the *kind* of event, so it
 * lives here, in one table, and `computeDrawerTotals` reads it. Adding a type
 * without a direction is a TypeScript error rather than a rounding surprise.
 *
 * ── Why there is no CASH_SALE ───────────────────────────────────────────────
 *
 * A cash sale is already attributed by stamping `Payment.cashDrawerSessionId`
 * when the money is taken. Mirroring it as a movement would give one physical
 * event two rows that can disagree — and they would, the first time a payment
 * was voided and only one of the two was reversed.
 */

/** How a movement type reads on screen and in a report. */
export interface MovementMeta {
  label: string
  /** One line of help, shown under the picker. */
  hint: string
  direction: 1 | -1
  /** Offered in the cashier's cash in/out form. Some types are system-only. */
  manual: boolean
}

export const MOVEMENT_TYPES: Record<CashMovementType, MovementMeta> = {
  CASH_IN: {
    label: 'Cash in',
    hint: 'Money added to the drawer for a reason not covered below',
    direction: 1,
    manual: true,
  },
  ADDITIONAL_CASH: {
    label: 'Additional float',
    hint: 'More change brought to the till mid-shift',
    direction: 1,
    manual: true,
  },
  ADJUSTMENT_IN: {
    label: 'Adjustment in',
    hint: 'A correction that adds cash, signed off by a manager',
    direction: 1,
    manual: true,
  },
  CASH_OUT: {
    label: 'Cash out',
    hint: 'Money removed for a reason not covered below',
    direction: -1,
    manual: true,
  },
  CASH_PAID_OUT: {
    label: 'Paid out',
    hint: 'Paid to somebody in cash — a supplier at the door, a courier',
    direction: -1,
    manual: true,
  },
  CASH_DROP: {
    label: 'Cash drop',
    hint: 'Skimmed to the safe so the till is not holding the day’s takings',
    direction: -1,
    manual: true,
  },
  BANK_DEPOSIT: {
    label: 'Bank deposit',
    hint: 'Taken to the bank',
    direction: -1,
    manual: true,
  },
  ADJUSTMENT_OUT: {
    label: 'Adjustment out',
    hint: 'A correction that removes cash, signed off by a manager',
    direction: -1,
    manual: true,
  },
  PETTY_FUND_TOPUP: {
    label: 'Top up petty cash',
    hint: 'Moves money from the drawer into the petty cash tin',
    direction: -1,
    manual: true,
  },
  /*
   * The two below are written by the system, never chosen from a form. A refund
   * is recorded when the refund is given; a petty cash expense when the request
   * is paid. Letting a cashier post either by hand would put the same rupees in
   * the ledger twice.
   */
  CASH_REFUND: {
    label: 'Cash refund',
    hint: 'Handed back to a customer',
    direction: -1,
    manual: false,
  },
  PETTY_CASH_PAID: {
    label: 'Petty cash paid',
    hint: 'An approved petty cash expense paid out of the drawer',
    direction: -1,
    manual: false,
  },
}

/** The types a person may pick, in the order they should be offered. */
export const MANUAL_MOVEMENT_TYPES = (
  [
    'CASH_IN',
    'ADDITIONAL_CASH',
    'CASH_PAID_OUT',
    'CASH_DROP',
    'BANK_DEPOSIT',
    'PETTY_FUND_TOPUP',
    'ADJUSTMENT_IN',
    'ADJUSTMENT_OUT',
    'CASH_OUT',
  ] as const
).filter((type) => MOVEMENT_TYPES[type].manual)

export function directionOf(type: CashMovementType): 1 | -1 {
  return MOVEMENT_TYPES[type].direction
}

export function labelOf(type: CashMovementType): string {
  return MOVEMENT_TYPES[type].label
}

/** Signed amount: what this movement does to the drawer. */
export function signedAmount(type: CashMovementType, amount: number): number {
  return directionOf(type) * amount
}
