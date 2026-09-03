/**
 * The chart of accounts (acCal.md §9).
 *
 * A fixed list, not a table: this ledger is DERIVED from the operating
 * records, so there is nothing for an owner to configure and nothing to keep
 * in sync. Every journal line names one of these codes, and the trial
 * balance is these codes with their totals.
 *
 * Client-safe: constants only.
 */

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE'

export interface Account {
  code: string
  name: string
  type: AccountType
  /** A contra account sits under its parent and reduces it. */
  contra?: boolean
}

export const ACCOUNTS = [
  { code: '1000', name: 'Cash on hand', type: 'ASSET' },
  { code: '1050', name: 'Bank & card clearing', type: 'ASSET' },
  { code: '1100', name: 'Customer receivables', type: 'ASSET' },
  { code: '1200', name: 'Inventory', type: 'ASSET' },
  { code: '2000', name: 'Supplier payables', type: 'LIABILITY' },
  { code: '2100', name: 'Tax payable', type: 'LIABILITY' },
  { code: '2120', name: 'Tips payable', type: 'LIABILITY' },
  { code: '3000', name: 'Opening balances & owner funds', type: 'EQUITY' },
  { code: '4000', name: 'Sales revenue', type: 'INCOME' },
  { code: '4100', name: 'Discounts given', type: 'INCOME', contra: true },
  { code: '4110', name: 'Refunds', type: 'INCOME', contra: true },
  { code: '4900', name: 'Service charge income', type: 'INCOME' },
  { code: '4910', name: 'Rounding differences', type: 'INCOME' },
  { code: '5000', name: 'Cost of goods sold', type: 'EXPENSE' },
  { code: '6000', name: 'Operating expenses', type: 'EXPENSE' },
  { code: '6100', name: 'Petty cash expenses', type: 'EXPENSE' },
  { code: '6200', name: 'Wastage', type: 'EXPENSE' },
  { code: '6210', name: 'Stock adjustments', type: 'EXPENSE' },
  { code: '6900', name: 'Other cash payouts', type: 'EXPENSE' },
  { code: '6910', name: 'Cash over/short', type: 'EXPENSE' },
] as const satisfies readonly Account[]

export type AccountCode = (typeof ACCOUNTS)[number]['code']

const BY_CODE = new Map<string, Account>(ACCOUNTS.map((account) => [account.code, account]))

export function accountName(code: string): string {
  return BY_CODE.get(code)?.name ?? code
}

export function accountType(code: string): AccountType {
  return BY_CODE.get(code)?.type ?? 'EXPENSE'
}

/**
 * Which side increases this account. Assets and expenses grow on the debit
 * side; liabilities, equity and income grow on the credit side. Contra
 * income accounts (discounts, refunds) grow on the debit side, which is
 * exactly why they reduce revenue.
 */
export function normalSide(code: string): 'DEBIT' | 'CREDIT' {
  const account = BY_CODE.get(code)
  if (!account) return 'DEBIT'
  if (account.contra) return 'DEBIT'
  return account.type === 'ASSET' || account.type === 'EXPENSE' ? 'DEBIT' : 'CREDIT'
}

/**
 * A contra account carries a balance on the opposite side to its family and
 * REDUCES it: discounts and refunds are income accounts whose balances come
 * off revenue. Anything summing a family must ask this, or it double-counts
 * the very figures meant to be deductions.
 */
export function isContra(code: string): boolean {
  return BY_CODE.get(code)?.contra === true
}

/** Cash goes to 1000; every other method lands in the bank/card clearing. */
export function accountForMethod(method: string): '1000' | '1050' {
  return method === 'CASH' ? '1000' : '1050'
}
