import { roundQty } from '@/lib/quantity'

/**
 * The FIFO walk, as a pure function (pro.b.md §5).
 *
 * ── Why this is separate from the allocator ─────────────────────────────────
 *
 * The server draws lots when ingredients are issued. The recipe screen and the
 * order page show what a draw WOULD cost before anybody presses anything.
 * Those are the same arithmetic, and if they were written twice they would
 * one day disagree — "it said 150.00 and took 152.30" is exactly the kind of
 * bug this module has been rebuilt over. So the walk lives here, with no
 * database and no `server-only`, and both the allocator and the screens call
 * it on the same lot list.
 */
export interface FifoLot {
  batchId: string | null
  batchNo: string | null
  /** Base units still in this lot. */
  remaining: number
  /** This lot's own cost per base unit, minor units. */
  unitCost: number
}

export interface FifoDraw {
  /** Real lots drawn, oldest first. */
  lots: Array<FifoLot & { quantity: number; lineCost: number }>
  /**
   * Stock on hand that no lot accounts for, drawn last at the running
   * average. Received before every receipt created a lot.
   */
  remainder: { quantity: number; unitCost: number; lineCost: number } | null
  /** What even that could not cover. */
  shortfall: number
  /** The exact value of everything drawn, minor units, unrounded. */
  totalValue: number
  /** totalValue ÷ what was drawn, rounded. The average cost of THIS draw. */
  unitCost: number
}

export function walkFifo(params: {
  /** Oldest receipt first — the caller orders them. */
  lots: FifoLot[]
  quantity: number
  /** Base units on hand that no lot explains. */
  unlotted: number
  /** The item's running average, minor units per base unit — the remainder's price. */
  averageCost: number
}): FifoDraw {
  const lots: FifoDraw['lots'] = []
  let left = roundQty(Math.max(0, params.quantity))
  let totalValue = 0

  for (const lot of params.lots) {
    if (left <= 1e-9) break
    if (!(lot.remaining > 0)) continue
    const take = roundQty(Math.min(lot.remaining, left))
    const lineCost = take * lot.unitCost
    lots.push({ ...lot, quantity: take, lineCost: Math.round(lineCost) })
    totalValue += lineCost
    left = roundQty(left - take)
  }

  let remainder: FifoDraw['remainder'] = null
  if (left > 1e-9 && params.unlotted > 1e-9) {
    const take = roundQty(Math.min(params.unlotted, left))
    const lineCost = take * params.averageCost
    remainder = { quantity: take, unitCost: Math.round(params.averageCost), lineCost: Math.round(lineCost) }
    totalValue += lineCost
    left = roundQty(left - take)
  }

  const drawn = roundQty(params.quantity - left)
  return {
    lots,
    remainder,
    shortfall: Math.max(0, left),
    totalValue,
    unitCost: drawn > 0 ? Math.round(totalValue / drawn) : Math.round(params.averageCost),
  }
}
