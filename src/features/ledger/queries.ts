import 'server-only'

import type { DateRange } from '@/features/reports/range'
import { ACCOUNTS, accountName, accountType, isContra, normalSide, type AccountType } from './accounts'
import { buildJournal, type JournalEntry } from './journal'

/**
 * Trial balance, cash book and financial position — all folded from the same
 * derived journal (acCal.md §9, §15), so the four screens can never tell
 * four different stories.
 *
 * Folding the journal rather than running separate aggregates costs a little
 * more work per page and buys the guarantee that matters: the trial balance
 * IS the journal, summed. If a screen disagrees with the journal it is
 * because the journal changed, never because two queries drifted.
 */

export interface TrialBalanceRow {
  code: string
  name: string
  type: AccountType
  debits: number
  credits: number
  /** Signed by the account's normal side: what a reader would call "the balance". */
  balance: number
}

export interface TrialBalance {
  rows: TrialBalanceRow[]
  totalDebits: number
  totalCredits: number
  /** True when debits equal credits — it always should. */
  balanced: boolean
  entryCount: number
}

export function foldTrialBalance(entries: JournalEntry[]): TrialBalance {
  const totals = new Map<string, { debits: number; credits: number }>()
  for (const entry of entries) {
    for (const line of entry.lines) {
      const row = totals.get(line.account) ?? { debits: 0, credits: 0 }
      row.debits += line.debit
      row.credits += line.credit
      totals.set(line.account, row)
    }
  }

  const rows: TrialBalanceRow[] = ACCOUNTS.filter((account) => totals.has(account.code)).map((account) => {
    const row = totals.get(account.code)!
    const debitNormal = normalSide(account.code) === 'DEBIT'
    return {
      code: account.code,
      name: account.name,
      type: account.type,
      debits: row.debits,
      credits: row.credits,
      balance: debitNormal ? row.debits - row.credits : row.credits - row.debits,
    }
  })

  const totalDebits = rows.reduce((sum, row) => sum + row.debits, 0)
  const totalCredits = rows.reduce((sum, row) => sum + row.credits, 0)
  return { rows, totalDebits, totalCredits, balanced: totalDebits === totalCredits, entryCount: entries.length }
}

export interface CashBookRow {
  date: Date
  narrative: string
  sourceType: string
  href: string
  /** Money into the cash account. */
  inflow: number
  outflow: number
  runningBalance: number
}

/** Every movement of physical cash, oldest first, with a running balance. */
export function foldCashBook(entries: JournalEntry[]): { rows: CashBookRow[]; closing: number } {
  const rows: CashBookRow[] = []
  let running = 0
  const chronological = [...entries].sort((a, b) => a.date.getTime() - b.date.getTime())
  for (const entry of chronological) {
    const cash = entry.lines.filter((line) => line.account === '1000')
    if (cash.length === 0) continue
    const inflow = cash.reduce((sum, line) => sum + line.debit, 0)
    const outflow = cash.reduce((sum, line) => sum + line.credit, 0)
    running += inflow - outflow
    rows.push({
      date: entry.date,
      narrative: entry.narrative,
      sourceType: entry.sourceType,
      href: entry.href,
      inflow,
      outflow,
      runningBalance: running,
    })
  }
  return { rows: rows.reverse(), closing: running }
}

export interface ProfitAndLoss {
  revenue: { grossSales: number; discounts: number; refunds: number; serviceCharge: number; netSales: number }
  cogs: number
  grossProfit: number
  expenses: Array<{ label: string; amount: number }>
  totalExpenses: number
  operatingProfit: number
  marginPercent: number | null
}

/**
 * The P&L, folded from the journal (acCal.md §15). "Operating profit" here
 * is honest about its scope: it counts the costs the system actually
 * records — cash-recorded expenses, petty cash, wastage, stock adjustments
 * and drawer differences. It knows nothing about loans, depreciation or
 * anything never entered.
 */
export function foldProfitAndLoss(entries: JournalEntry[]): ProfitAndLoss {
  const balance = (code: string) => {
    let debits = 0
    let credits = 0
    for (const entry of entries) {
      for (const line of entry.lines) {
        if (line.account !== code) continue
        debits += line.debit
        credits += line.credit
      }
    }
    return { debits, credits }
  }

  const sales = balance('4000')
  const discounts = balance('4100')
  const refunds = balance('4110')
  const service = balance('4900')
  const rounding = balance('4910')

  const grossSales = sales.credits - sales.debits
  const discountTotal = discounts.debits - discounts.credits
  const refundTotal = refunds.debits - refunds.credits
  const serviceCharge = service.credits - service.debits
  const netSales = grossSales - discountTotal - refundTotal

  const cogsRow = balance('5000')
  const cogs = cogsRow.debits - cogsRow.credits
  const grossProfit = netSales - cogs

  const expenseCodes: Array<[string, string]> = [
    ['6000', 'Operating expenses'],
    ['6100', 'Petty cash'],
    ['6200', 'Wastage'],
    ['6210', 'Stock adjustments'],
    ['6900', 'Other cash payouts'],
    ['6910', 'Cash over/short'],
  ]
  const expenses = expenseCodes
    .map(([code, label]) => {
      const row = balance(code)
      return { label, amount: row.debits - row.credits }
    })
    .filter((row) => row.amount !== 0)

  const totalExpenses = expenses.reduce((sum, row) => sum + row.amount, 0)
  const roundingIncome = rounding.credits - rounding.debits
  const operatingProfit = grossProfit + serviceCharge + roundingIncome - totalExpenses

  return {
    revenue: { grossSales, discounts: discountTotal, refunds: refundTotal, serviceCharge, netSales },
    cogs,
    grossProfit,
    expenses,
    totalExpenses,
    operatingProfit,
    marginPercent: netSales > 0 ? Math.round((operatingProfit / netSales) * 1000) / 10 : null,
  }
}

export interface PositionSection {
  title: string
  rows: Array<{ label: string; amount: number }>
  total: number
}

export interface FinancialPosition {
  assets: PositionSection
  liabilities: PositionSection
  equity: PositionSection
  /** Assets = liabilities + equity, once retained earnings closes the gap. */
  balanced: boolean
}

/**
 * "Financial position" — deliberately NOT called a balance sheet.
 *
 * It is built only from operating records: there is no asset register, no
 * depreciation, no loans and no capital accounts in this system. Income and
 * expenses are closed into a single clearly-labelled derived line so the
 * statement adds up honestly, and the page says so in as many words.
 */
export function foldPosition(entries: JournalEntry[]): FinancialPosition {
  const trial = foldTrialBalance(entries)
  const pick = (type: AccountType) => trial.rows.filter((row) => row.type === type)

  const assetRows = pick('ASSET').map((row) => ({ label: row.name, amount: row.balance }))
  const liabilityRows = pick('LIABILITY').map((row) => ({ label: row.name, amount: row.balance }))
  const equityRows = pick('EQUITY').map((row) => ({ label: row.name, amount: row.balance }))

  // Contra income (discounts, refunds) REDUCES income — adding it would
  // count every discount as revenue and throw the statement out by twice it.
  const income = pick('INCOME').reduce(
    (sum, row) => sum + (isContra(row.code) ? -row.balance : row.balance),
    0,
  )
  const expense = pick('EXPENSE').reduce((sum, row) => sum + row.balance, 0)
  const retained = income - expense
  if (retained !== 0) {
    equityRows.push({ label: 'Retained earnings (derived)', amount: retained })
  }

  const assets = assetRows.reduce((sum, row) => sum + row.amount, 0)
  const liabilities = liabilityRows.reduce((sum, row) => sum + row.amount, 0)
  const equity = equityRows.reduce((sum, row) => sum + row.amount, 0)

  return {
    assets: { title: 'What the business holds', rows: assetRows, total: assets },
    liabilities: { title: 'What it owes', rows: liabilityRows, total: liabilities },
    equity: { title: 'What is left over', rows: equityRows, total: equity },
    balanced: assets === liabilities + equity,
  }
}

/** One fetch, four views — the page picks which folds it needs. */
export async function getLedger(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}) {
  const entries = await buildJournal(params)
  return {
    entries,
    trialBalance: foldTrialBalance(entries),
    cashBook: foldCashBook(entries),
    profitAndLoss: foldProfitAndLoss(entries),
    position: foldPosition(entries),
  }
}

export { accountName, accountType }
