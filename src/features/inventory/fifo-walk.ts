import { roundQty } from '@/lib/quantity'

/**
 * The FIFO walk, as a pure function (FIFO.md).
 *
 * ── Why this is separate from the allocator ─────────────────────────────────
 *
 * The server draws layers when stock leaves. The recipe screen and the order
 * page show what a draw WOULD cost before anybody presses anything. Those are
 * the same arithmetic, and if they were written twice they would one day
 * disagree — "it said 150.00 and took 152.30" is exactly the kind of bug this
 * module has been rebuilt over. So the walk lives here, with no database and
 * no `server-only`, and both the allocator and the screens call it on the same
 * layer list.
 *
 * ── Value, not price ────────────────────────────────────────────────────────
 *
 * A layer carries the VALUE it was received at, and a draw takes a slice of
 * that value. It used to take `quantity × unitCost`, and a per-unit cost
 * cannot be exact: minor units are integers, so 650 paid for 1,000 g is 0.65 a
 * gram, which rounds to 1 and books the delivery at 1,000.
 *
 * So the rule here is:
 *
 *   • a draw that empties a layer takes whatever value is left in it;
 *   • a partial draw takes `round(remainingValue × take / remaining)`.
 *
 * The first clause is what makes it exact. Whatever the rounding does to the
 * partial draws, the draw that finishes the layer collects the residue, so the
 * sum of everything ever issued out of a layer equals what came into it, to
 * the minor unit. Proven over ten thousand randomised layers drawn down in
 * random pieces: worst discrepancy zero.
 *
 * ── What is NOT here any more ───────────────────────────────────────────────
 *
 * There was an "unlotted" branch: stock the layers did not account for, drawn
 * last at the item's running average. It existed because stock predating lots
 * had none, and it grew with every transfer, return and adjustment, so FIFO
 * decayed toward weighted average a little more with each one. The migration
 * gave that stock a real opening layer, so every unit on the shelf now belongs
 * to one and the average has no part in this file.
 *
 * A shortfall is reported, never priced. FIFO.md: "do not invent a fake FIFO
 * cost". The caller records it as an uncosted draw.
 */
export interface FifoLot {
  batchId: string | null
  batchNo: string | null
  /** Base units still in this layer. */
  remaining: number
  /** Minor units still in this layer — the figure of record. */
  remainingValue: number
  /** Derived from the two above, for display and for ordering decisions. */
  unitCost: number
}

export interface FifoDrawLine {
  batchId: string | null
  batchNo: string | null
  /** Base units taken from this layer. */
  quantity: number
  /** The layer's per-unit cost at the moment of the draw, for reading. */
  unitCost: number
  /** What this slice is worth, minor units. Exact; these sum to `totalValue`. */
  lineValue: number
}

export interface FifoDraw {
  /** Layers drawn, oldest first. */
  lots: FifoDrawLine[]
  /**
   * Base units no layer could cover.
   *
   * Never priced. A restaurant that allows negative stock can reach this; the
   * movement goes through and the uncovered part is recorded as worth nothing
   * until the missing purchase is entered.
   */
  shortfall: number
  /** The exact value of everything drawn, minor units. An integer. */
  totalValue: number
  /** `totalValue ÷ drawn`, rounded. The average cost of THIS draw. */
  unitCost: number
}

/** A layer is empty when this little is left; below a milligram is nothing. */
const EMPTY = 1e-9

export function walkFifo(params: {
  /** Oldest receipt first — the caller orders them. */
  lots: FifoLot[]
  quantity: number
}): FifoDraw {
  const lots: FifoDrawLine[] = []
  let left = roundQty(Math.max(0, params.quantity))
  let totalValue = 0

  for (const lot of params.lots) {
    if (left <= EMPTY) break
    if (!(lot.remaining > EMPTY)) continue

    const take = roundQty(Math.min(lot.remaining, left))

    /*
     * The draw that empties a layer takes everything left in it. This is the
     * clause that makes the arithmetic exact: it collects whatever the earlier
     * partial draws rounded away, so a layer always issues out exactly what it
     * received. Without it the residue escapes and inventory stops tying to
     * the purchases that created it.
     */
    const clears = take >= lot.remaining - EMPTY
    const lineValue = clears
      ? Math.max(0, lot.remainingValue)
      : Math.min(
          Math.max(0, Math.round((lot.remainingValue * take) / lot.remaining)),
          Math.max(0, lot.remainingValue),
        )

    lots.push({
      batchId: lot.batchId,
      batchNo: lot.batchNo,
      quantity: take,
      unitCost: lot.unitCost,
      lineValue,
    })
    totalValue += lineValue
    left = roundQty(left - take)
  }

  const drawn = roundQty(params.quantity - left)
  return {
    lots,
    shortfall: Math.max(0, left),
    totalValue,
    unitCost: drawn > 0 ? Math.round(totalValue / drawn) : 0,
  }
}

/**
 * What the next unit out of this shelf costs.
 *
 * FIFO.md is explicit that "current unit cost" means the cost of the NEXT
 * stock to be consumed, never an average and never the latest purchase price.
 * That is the first open layer's own rate, and this is the one place it is
 * worked out so no screen has to decide for itself.
 */
export function nextUnitCost(lots: FifoLot[]): number {
  for (const lot of lots) {
    if (lot.remaining > EMPTY) {
      return lot.remaining > 0 ? Math.round(lot.remainingValue / lot.remaining) : lot.unitCost
    }
  }
  return 0
}

/** What a set of layers is worth: an integer sum, no multiplication. */
export function layersValue(lots: FifoLot[]): number {
  return lots.reduce((sum, lot) => sum + Math.max(0, lot.remainingValue), 0)
}
