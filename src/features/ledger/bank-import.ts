import 'server-only'

import { createHash } from 'node:crypto'

import { ValidationError } from '@/lib/errors'

/**
 * Reading a bank statement (acCal.md §6).
 *
 * Sri Lankan banks give small businesses a CSV or Excel download, never a
 * live feed, so this is a file parser — deliberately forgiving about column
 * order and naming, and deliberately strict about the money: an amount it
 * cannot read is a refused row, never a guessed one.
 */

export interface ParsedLine {
  lineDate: Date
  description: string
  reference: string | null
  /** Signed minor units: positive = money in, negative = money out. */
  amount: number
  lineHash: string
}

/** A tiny CSV reader that understands quoted fields and embedded commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''))
}

const DATE_KEYS = ['date', 'transaction date', 'value date', 'posting date', 'txn date']
const DESC_KEYS = ['description', 'narration', 'particulars', 'details', 'transaction details', 'remarks']
const REF_KEYS = ['reference', 'ref', 'cheque', 'cheque no', 'transaction id', 'ref no']
const AMOUNT_KEYS = ['amount', 'transaction amount', 'value']
const DEBIT_KEYS = ['debit', 'withdrawal', 'withdrawals', 'paid out', 'dr']
const CREDIT_KEYS = ['credit', 'deposit', 'deposits', 'paid in', 'cr']

function indexOfHeader(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.includes(header.trim().toLowerCase()))
}

/** Read a money cell in any of the shapes a bank export uses. */
function readAmount(cell: string, currencyFactor: number): number | null {
  const cleaned = cell.replace(/[^0-9.,()-]/g, '').trim()
  if (cleaned === '') return null
  // (1,234.50) is how some exports write a negative.
  const negative = /^\(.*\)$/.test(cleaned) || cleaned.startsWith('-')
  const digits = cleaned.replace(/[(),-]/g, '')
  if (digits === '') return null
  const value = Number.parseFloat(digits)
  if (!Number.isFinite(value)) return null
  const minor = Math.round(value * currencyFactor)
  return negative ? -minor : minor
}

/** Dates come as YYYY-MM-DD, DD/MM/YYYY or DD-MMM-YYYY. */
function readDate(cell: string): Date | null {
  const text = cell.trim()
  if (text === '') return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text)
  if (dmy) {
    const year = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3])
    return new Date(Date.UTC(year, Number(dmy[2]) - 1, Number(dmy[1])))
  }
  const named = /^(\d{1,2})[- ]([A-Za-z]{3,})[- ](\d{2,4})$/.exec(text)
  if (named) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const monthIndex = months.indexOf(named[2].slice(0, 3).toLowerCase())
    if (monthIndex >= 0) {
      const year = Number(named[3].length === 2 ? `20${named[3]}` : named[3])
      return new Date(Date.UTC(year, monthIndex, Number(named[1])))
    }
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function hashLine(restaurantId: string, line: { lineDate: Date; amount: number; description: string }): string {
  const normalised = line.description.trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256')
    .update(`${restaurantId}|${line.lineDate.toISOString().slice(0, 10)}|${line.amount}|${normalised}`)
    .digest('hex')
}

export function hashFile(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex')
}

/**
 * Turn a statement's rows into lines we can match. Rows we cannot read are
 * skipped and counted — never guessed at, because a guessed amount in a
 * bank reconciliation is worse than a missing one.
 */
export function readStatementRows(params: {
  restaurantId: string
  rows: string[][]
  currencyFactor: number
}): { lines: ParsedLine[]; skipped: number } {
  const { restaurantId, rows, currencyFactor } = params
  if (rows.length < 2) {
    throw new ValidationError('That file has no rows under its headings.')
  }

  const headers = rows[0].map((header) => header.trim().toLowerCase())
  const dateAt = indexOfHeader(headers, DATE_KEYS)
  const descAt = indexOfHeader(headers, DESC_KEYS)
  const refAt = indexOfHeader(headers, REF_KEYS)
  const amountAt = indexOfHeader(headers, AMOUNT_KEYS)
  const debitAt = indexOfHeader(headers, DEBIT_KEYS)
  const creditAt = indexOfHeader(headers, CREDIT_KEYS)

  if (dateAt < 0) {
    throw new ValidationError('No date column found. The first row must name the columns (Date, Description, Amount).')
  }
  if (amountAt < 0 && debitAt < 0 && creditAt < 0) {
    throw new ValidationError('No amount column found — expected Amount, or Debit and Credit columns.')
  }

  const lines: ParsedLine[] = []
  let skipped = 0

  for (const row of rows.slice(1)) {
    const lineDate = readDate(row[dateAt] ?? '')
    if (!lineDate) {
      skipped += 1
      continue
    }

    let amount: number | null = null
    if (amountAt >= 0) {
      amount = readAmount(row[amountAt] ?? '', currencyFactor)
    }
    if (amount === null && (debitAt >= 0 || creditAt >= 0)) {
      const debit = debitAt >= 0 ? readAmount(row[debitAt] ?? '', currencyFactor) : null
      const credit = creditAt >= 0 ? readAmount(row[creditAt] ?? '', currencyFactor) : null
      if (credit !== null && credit !== 0) amount = Math.abs(credit)
      else if (debit !== null && debit !== 0) amount = -Math.abs(debit)
    }
    if (amount === null || amount === 0) {
      skipped += 1
      continue
    }

    const description = (row[descAt] ?? '').trim() || 'Bank transaction'
    const reference = refAt >= 0 ? (row[refAt] ?? '').trim() || null : null
    lines.push({
      lineDate,
      description,
      reference,
      amount,
      lineHash: hashLine(restaurantId, { lineDate, amount, description }),
    })
  }

  if (lines.length === 0) {
    throw new ValidationError('No usable rows in that file — check the date and amount columns.')
  }
  return { lines, skipped }
}
