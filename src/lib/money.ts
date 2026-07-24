/**
 * Money handling.
 *
 * All monetary amounts in RestaurantOS are integers in the currency's minor
 * unit (cents, paise, …). Floating point never touches a price.
 * Rates are basis points: 10000 bps = 100%.
 */

export const BPS_DENOMINATOR = 10_000

export type CurrencyCode = string

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XOF', 'XAF'])

export function minorUnitFactor(currency: CurrencyCode): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100
}

/** Format minor units for display, e.g. formatMoney(125050, 'INR') → "₹1,250.50". */
export function formatMoney(
  minor: number,
  currency: CurrencyCode = 'INR',
  locale = 'en-IN',
): string {
  const factor = minorUnitFactor(currency)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: factor === 1 ? 0 : 2,
      maximumFractionDigits: factor === 1 ? 0 : 2,
    }).format(minor / factor)
  } catch {
    return `${currency} ${(minor / factor).toFixed(factor === 1 ? 0 : 2)}`
  }
}

/** Compact display for dashboards: 1.2K, 3.4M. */
export function formatMoneyCompact(
  minor: number,
  currency: CurrencyCode = 'INR',
  locale = 'en-IN',
): string {
  const factor = minorUnitFactor(currency)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(minor / factor)
  } catch {
    return formatMoney(minor, currency, locale)
  }
}

export function currencySymbol(currency: CurrencyCode = 'INR', locale = 'en-IN'): string {
  try {
    return (
      new Intl.NumberFormat(locale, { style: 'currency', currency })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? currency
    )
  } catch {
    return currency
  }
}

/** Parse a user-entered major-unit string ("12.50") into minor units (1250). */
export function parseMoney(input: string | number, currency: CurrencyCode = 'INR'): number {
  const factor = minorUnitFactor(currency)
  const value = typeof input === 'number' ? input : Number(String(input).replace(/[^0-9.-]/g, ''))
  if (!Number.isFinite(value)) return 0
  return Math.round(value * factor)
}

/** Convert minor units to a major-unit number for form inputs. */
export function toMajor(minor: number, currency: CurrencyCode = 'INR'): number {
  const factor = minorUnitFactor(currency)
  return Math.round(minor) / factor
}

/** Apply a basis-point rate to an amount, rounding half-up. */
export function applyBps(amountMinor: number, bps: number): number {
  return Math.round((amountMinor * bps) / BPS_DENOMINATOR)
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`
}

export function bpsFromPercent(percent: number): number {
  return Math.round(percent * 100)
}

/** Round a total to the nearest whole major unit; returns the adjustment. */
export function roundToNearestMajor(
  amountMinor: number,
  currency: CurrencyCode = 'INR',
): { total: number; adjustment: number } {
  const factor = minorUnitFactor(currency)
  if (factor === 1) return { total: amountMinor, adjustment: 0 }
  const rounded = Math.round(amountMinor / factor) * factor
  return { total: rounded, adjustment: rounded - amountMinor }
}
