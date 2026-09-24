import 'server-only'

import type { StockUnit } from '@prisma/client'

import { roundQty } from '@/lib/quantity'
import { allocateFifo, type FifoAllocation } from '@/features/inventory/batches'
import { toBaseUnits } from '@/features/inventory/units'
import { prisma, type TxClient } from '@/server/db/prisma'

/**
 * What an ingredient would cost to draw right now, FIFO (pro.b.md §1, §2, §4).
 *
 * ── One reader, so the number shown is the number taken ─────────────────────
 *
 * The recipe screen shows a cost per ingredient, the stock check shows a cost
 * per item, the issue screen shows a cost per line, and the issue itself
 * consumes at a cost. Four screens with four ways of arriving at a figure is
 * how "it said 150.00 and charged 152.30" happens. All four call this, and
 * this calls the same allocator the consumption runs through, so a preview is
 * a dry run of the draw and nothing else.
 *
 * The quantity is asked for in whatever unit the recipe line uses and converted
 * against the item once here, so a line in grams on an item stocked in kilos
 * prices correctly.
 */
export interface FifoCost {
  /** Base units the caller asked about, after conversion. */
  quantity: number
  /** The blended per-base-unit cost of exactly that draw, minor units. */
  unitCost: number
  /** The exact total, minor units, unrounded. */
  totalCost: number
  /** The oldest lot's own price — what the NEXT unit costs (the stock check). */
  nextUnitCost: number
  allocation: FifoAllocation
}

export async function fifoCostFor(
  db: TxClient | typeof prisma,
  params: {
    restaurantId: string
    itemId: string
    branchId: string
    quantity: number
    unit?: StockUnit | null
  },
): Promise<FifoCost | null> {
  const item = await db.inventoryItem.findFirst({
    where: { id: params.itemId, restaurantId: params.restaurantId },
    select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true, costPerUnit: true },
  })
  if (!item) return null

  const base = roundQty(toBaseUnits(params.quantity, params.unit ?? item.unit, item))
  if (!(base > 0)) {
    return {
      quantity: 0,
      unitCost: item.costPerUnit,
      totalCost: 0,
      nextUnitCost: item.costPerUnit,
      allocation: { lots: [], shortfall: 0, totalValue: 0 },
    }
  }

  const allocation = await allocateFifo(db, {
    restaurantId: params.restaurantId,
    itemId: item.id,
    branchId: params.branchId,
    quantity: base,
  })

  /*
   * What the layers hold, and nothing for what they do not (FIFO.md: "do not
   * invent a fake FIFO cost"). A shortfall used to be priced at the running
   * average so the screen showed a rounder number; that number was a guess
   * about stock which is not there. "Not enough" is said by the stock check.
   */
  const covered = roundQty(base - allocation.shortfall)
  const nextUnitCost = allocation.lots[0]?.unitCost ?? 0

  return {
    quantity: base,
    // Per unit of what was actually covered, so a partly-covered draw reports
    // the real rate of the stock it found rather than a diluted one.
    unitCost: covered > 0 ? Math.round(allocation.totalValue / covered) : 0,
    totalCost: allocation.totalValue,
    nextUnitCost,
    allocation,
  }
}
