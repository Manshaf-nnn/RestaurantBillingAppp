import type { StockUnit } from '@prisma/client'

/**
 * Shapes shared between the production queries (server) and the Kitchen
 * Production screen (client). Everything here is plain data — dates are ISO
 * strings, money is integer minor units — so a server page can hand it to a
 * client component whole.
 */

/** One stock item as the Make Item form sees it: what it costs and what is here. */
export interface WorkspaceItem {
  id: string
  name: string
  /** The ledger's base unit. */
  unit: StockUnit
  purchaseUnit: StockUnit | null
  consumptionUnit: StockUnit | null
  unitsPerPurchaseUnit: number | null
  /** Units this item can be entered in, base first. */
  units: StockUnit[]
  /**
   * Exact cost per base unit, minor units, unrounded: stockValue ÷ quantity
   * while there is stock, the rounded cache otherwise. The preview multiplies
   * this; the transaction re-reads the ledger and is the figure of record.
   */
  unitCost: number
  /** On hand at the chosen branch, base units. */
  available: number
  isPrepared: boolean
  /** The item's category — the recipe's "Category" (pro.b.md §1). */
  category: string | null
  /**
   * The layers still on this branch's shelf, oldest receipt first, each with
   * the value it holds (FIFO.md). The screens walk these with `walkFifo` — the
   * same walk the issue runs — so a preview is a dry run of the draw.
   *
   * `unlotted` used to sit beside this: stock no layer accounted for, drawn
   * last at the item's running average. The opening-layer migration gave that
   * stock a real layer, so every unit on the shelf belongs to one and the
   * average has no part in a preview any more.
   */
  lots: Array<{
    batchId: string
    batchNo: string
    remaining: number
    remainingValue: number
    unitCost: number
  }>
  /** The oldest layer's own rate — what the next unit costs (FIFO.md). */
  nextUnitCost: number
}

export interface PreparedItemRow {
  id: string
  name: string
  unit: StockUnit
  /** At the chosen branch, base units. */
  available: number
  /** Rounded average per base unit, minor units. */
  costPerUnit: number
  /** available × costPerUnit — this branch's share, minor units. */
  stockValue: number
  lastProducedAt: string | null
  runs: number
}

/**
 * One run in Production History (aO.md §5): the complete story of a run —
 * item, when, how much, what it consumed, what it cost, who, where, its
 * reference and its status. Batches in progress and cancelled batches are
 * rows too; nothing that happened in the kitchen is filtered out of history.
 */
export interface ProductionHistoryRow {
  id: string
  number: string
  itemId: string | null
  itemName: string
  quantity: number
  unit: string | null
  totalCost: number
  unitCost: number
  /** IN_PROGRESS · COMPLETED · PARTIALLY_COMPLETED · CANCELLED. */
  status: string
  /** When the run was started — a batch not yet done has no `completedAt`. */
  createdAt: string
  completedAt: string | null
  madeBy: string | null
  branchName: string
  wasteCount: number
  /** What was aimed for, what came out, and what was lost (pro.b.md §13). */
  plannedQty: number
  actualQty: number | null
  wastageQty: number | null
  batchNumber: string | null
  /**
   * What left stock, in the ingredient's own unit. For a batch still in
   * progress, what its plan will take; empty for a cancelled batch — nothing
   * moved.
   */
  consumed: Array<{ itemId: string; name: string; quantity: number; unit: string }>
}

/** One line of how a prepared item is made. */
export interface PrepRecipeLine {
  itemId: string
  quantity: number
  unit: StockUnit
  /** The ingredient's name when the reader has it; a retired item has none. */
  name?: string
}

/**
 * How a prepared item was last made (recorrection.md §3): the active
 * `Recipe.producesItemId` recipe, flattened. "Make more" pre-fills from it and
 * the detail costs it against today's averages.
 */
export interface PrepRecipe {
  recipeId: string
  version: number
  yieldQty: number
  yieldUnit: StockUnit | null
  ingredients: PrepRecipeLine[]
  /** Step 1's instructions (pro.b.md §1). */
  instructions: string | null
}

/** A batch created and not yet marked done. Nothing in it has moved. */
export interface OpenBatch {
  id: string
  number: string
  /** The prepared item it will stock — set from Create (recorrection.md §3). */
  itemId: string | null
  name: string
  plannedQty: number
  unit: StockUnit | null
  branchName: string | null
  startedAt: string
  notes: string | null
  /** What completion will consume — or what was issued already (pro.b.md §4). */
  ingredients: PrepRecipeLine[]
  /** Stock has already left for this order. */
  issued: boolean
}

export interface ProductionWorkspaceData {
  items: WorkspaceItem[]
  prepared: PreparedItemRow[]
  history: ProductionHistoryRow[]
  openBatches: OpenBatch[]
  /** Keyed by the prepared item's id. */
  recipes: Record<string, PrepRecipe>
  stats: {
    runsToday: number
    /** Value moved from raw stock into prepared stock today, minor units. */
    valueToday: number
    preparedCount: number
  }
}

/**
 * One prepared item's page (aO.md §5): the item, what is on the shelf here,
 * how it is made and what that costs today, the batches waiting for "How
 * much did you make?", and its full history at this location.
 */
export interface PreparedItemPageData {
  item: {
    id: string
    name: string
    unit: StockUnit
    /** Units the yield can be entered in, base first. */
    units: StockUnit[]
  }
  branch: { id: string; name: string } | null
  stock: {
    /** Base units on hand at this location. */
    here: number
    /** Everywhere, base units. */
    total: number
    /** Rounded average per base unit, minor units. */
    costPerUnit: number
    /** here × costPerUnit, minor units. */
    value: number
    lastProducedAt: string | null
    runs: number
  }
  recipe: {
    recipeId: string
    version: number
    yieldQty: number
    yieldUnit: StockUnit | null
    lines: Array<{
      itemId: string
      name: string
      quantity: number
      unit: StockUnit
      /** The ingredient's base unit — what its cost is per. Null for a retired item. */
      itemUnit: StockUnit | null
      /** Exact average per base unit today, minor units. */
      unitCost: number
      /** quantity (base) × unitCost, minor units. */
      lineCost: number
      /** On hand here, base units. */
      available: number
    }>
    /** What one recipe yield costs at today's averages, minor units. */
    productionCost: number
    /** productionCost ÷ the yield in the item's base unit, minor units. */
    costPerUnit: number
  } | null
  openBatches: OpenBatch[]
  history: ProductionHistoryRow[]
}

/** What `produceItem` hands back — flat, so it can cross the action boundary. */
export interface ProduceItemResult {
  /** True when this request key had already been recorded; nothing moved this time. */
  replayed: boolean
  orderId: string
  number: string
  item: {
    id: string
    name: string
    unit: StockUnit
    /** Created by this run rather than found. */
    isNew: boolean
    /** After the run: rounded average per base unit, and the balance. */
    costPerUnit: number
    quantity: number
  }
  /** Base units of the item. */
  producedQty: number
  consumed: Array<{
    itemId: string
    name: string
    quantity: number
    unit: StockUnit
    value: number
    /** Which lots it came from, oldest first (pro.b.md §9). Null batchNo = the unlotted remainder. */
    lots?: Array<{ batchNo: string | null; quantity: number; unitCost: number; lineCost: number }>
  }>
  wasted: Array<{ itemId: string; name: string; quantity: number; unit: StockUnit; value: number }>
  /** Exactly what left the ingredients, minor units — and exactly what the item gained. */
  totalValue: number
  /** Per base unit of the item, minor units, rounded. */
  unitCost: number
  completedAt: string
}

/** What Create hands back (recorrection.md §3). Flat, so it can cross the action boundary. */
export interface StartBatchResult {
  /** True when this request key had already started a batch; nothing new was created. */
  replayed: boolean
  id: string
  number: string
  plannedQty: number
  unit: StockUnit
  item: {
    id: string
    name: string
    unit: StockUnit
    /** Created by this Create rather than found. */
    isNew: boolean
  }
}

/** What issuing hands back (pro.b.md §4). Flat, so it can cross the action boundary. */
export interface IssueIngredientsResult {
  orderId: string
  number: string
  issuedAt: string
  consumed: ProduceItemResult['consumed']
  /** Exactly what left the ingredients, minor units, rounded. */
  totalValue: number
}
