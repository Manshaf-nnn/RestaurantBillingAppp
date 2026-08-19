import type { StockUnit } from '@prisma/client'

/**
 * Stock unit conversion.
 *
 * Every ledger row is stored in the item's own base unit, so a balance is
 * never a mix of kilograms and grams. Conversion happens once, at the edge,
 * when a movement is posted — which is why this module has no database access
 * and is trivially testable.
 *
 * Two kinds of conversion exist:
 *
 *  1. Standard ones that are true everywhere — 1 kg is 1000 g, 1 litre is
 *     1000 ml, 1 dozen is 12 pieces. These are hardcoded because they are
 *     facts, not settings.
 *
 *  2. Packaging, which is whatever a particular supplier says it is. A box of
 *     chicken might be 10 kg at one supplier and 12 kg at another, so BOX,
 *     PACK and BOTTLE carry no built-in ratio. The item's own
 *     `unitsPerPurchaseUnit` supplies it, and a conversion without one is
 *     refused rather than guessed.
 */

export class UnitConversionError extends Error {
  readonly code = 'UNIT_CONVERSION'
  constructor(message: string) {
    super(message)
    this.name = 'UnitConversionError'
  }
}

/** Units that measure the same physical thing, expressed in a common base. */
const FAMILIES: Array<Partial<Record<StockUnit, number>>> = [
  // mass, in grams
  { KG: 1000, GRAM: 1 },
  // volume, in millilitres
  { LITRE: 1000, ML: 1 },
  // count, in pieces
  { DOZEN: 12, PIECE: 1 },
]

/** Units whose size is defined per item rather than universally. */
const PACKAGING: StockUnit[] = ['BOX', 'PACK', 'BOTTLE']

export function isPackagingUnit(unit: StockUnit): boolean {
  return PACKAGING.includes(unit)
}

export const UNIT_LABELS: Record<StockUnit, string> = {
  KG: 'kg',
  GRAM: 'g',
  LITRE: 'L',
  ML: 'ml',
  PIECE: 'pc',
  DOZEN: 'dozen',
  BOX: 'box',
  PACK: 'packet',
  BOTTLE: 'bottle',
}

export function formatQuantity(quantity: number, unit: StockUnit): string {
  // Trim float noise without forcing decimals onto whole numbers.
  const rounded = Math.round(quantity * 1e6) / 1e6
  return `${rounded} ${UNIT_LABELS[unit]}`
}

function familyFactor(unit: StockUnit): number | null {
  for (const family of FAMILIES) {
    const factor = family[unit]
    if (factor !== undefined) return factor
  }
  return null
}

function sameFamily(a: StockUnit, b: StockUnit): boolean {
  return FAMILIES.some((family) => family[a] !== undefined && family[b] !== undefined)
}

export interface ConvertibleItem {
  name: string
  unit: StockUnit
  purchaseUnit?: StockUnit | null
  consumptionUnit?: StockUnit | null
  unitsPerPurchaseUnit?: number | null
}

/**
 * Convert a quantity into the item's base unit.
 *
 * Throws rather than falling back to 1:1. Silently treating 500 g as 500 kg
 * would corrupt the ledger in a way nobody notices until a stock take, so an
 * unconvertible unit is an error the caller must handle.
 */
export function toBaseUnits(
  quantity: number,
  from: StockUnit,
  item: ConvertibleItem,
): number {
  const base = item.unit
  if (from === base) return round(quantity)

  if (sameFamily(from, base)) {
    const fromFactor = familyFactor(from)!
    const baseFactor = familyFactor(base)!
    return round((quantity * fromFactor) / baseFactor)
  }

  // Packaging: only the item's own declared pack size can resolve it.
  if (isPackagingUnit(from)) {
    const perPack = item.unitsPerPurchaseUnit
    if (from !== item.purchaseUnit || !perPack || perPack <= 0) {
      throw new UnitConversionError(
        `${item.name}: cannot convert ${UNIT_LABELS[from]} to ${UNIT_LABELS[base]}. ` +
          `Set the purchase unit to ${UNIT_LABELS[from]} and how many ${UNIT_LABELS[base]} are in one.`,
      )
    }
    return round(quantity * perPack)
  }

  throw new UnitConversionError(
    `${item.name}: ${UNIT_LABELS[from]} and ${UNIT_LABELS[base]} measure different things.`,
  )
}

/** Convert out of the base unit for display, e.g. show a purchase in boxes. */
export function fromBaseUnits(
  quantityInBase: number,
  to: StockUnit,
  item: ConvertibleItem,
): number {
  const base = item.unit
  if (to === base) return round(quantityInBase)

  if (sameFamily(to, base)) {
    const toFactor = familyFactor(to)!
    const baseFactor = familyFactor(base)!
    return round((quantityInBase * baseFactor) / toFactor)
  }

  if (isPackagingUnit(to)) {
    const perPack = item.unitsPerPurchaseUnit
    if (to !== item.purchaseUnit || !perPack || perPack <= 0) {
      throw new UnitConversionError(
        `${item.name}: no pack size set for ${UNIT_LABELS[to]}.`,
      )
    }
    return round(quantityInBase / perPack)
  }

  throw new UnitConversionError(
    `${item.name}: ${UNIT_LABELS[base]} cannot be shown as ${UNIT_LABELS[to]}.`,
  )
}

/** Which units a given item can accept, for populating a dropdown. */
export function acceptableUnits(item: ConvertibleItem): StockUnit[] {
  const units = new Set<StockUnit>([item.unit])
  for (const family of FAMILIES) {
    if (family[item.unit] !== undefined) {
      for (const key of Object.keys(family) as StockUnit[]) units.add(key)
    }
  }
  if (item.purchaseUnit && item.unitsPerPurchaseUnit) units.add(item.purchaseUnit)
  if (item.consumptionUnit) {
    try {
      toBaseUnits(1, item.consumptionUnit, item)
      units.add(item.consumptionUnit)
    } catch {
      // A consumption unit that cannot be converted is a misconfiguration; it
      // simply does not appear as an option rather than breaking the form.
    }
  }
  return [...units]
}

/** Float quantities drift; six places is far finer than any kitchen scale. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
