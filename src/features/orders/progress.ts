/**
 * Item-level kitchen progress, by quantity (abc.md §6).
 *
 * Pure: no database, no server-only import, so the guest tracker, the boards
 * and the tests all read the same arithmetic the service writes with.
 *
 * ── The model ───────────────────────────────────────────────────────────────
 *
 * A line keeps ONE `status` — void, split, merge, depletion and the guest edit
 * all read it — and gains two counters: `preparedQty` (how many of `quantity`
 * the kitchen has finished) and `servedQty` (how many of those the floor has
 * carried out). The status is a readout of the counters:
 *
 *   served  === quantity → SERVED
 *   prepared === quantity → READY
 *   prepared > 0          → PREPARING
 *   otherwise             → whatever it was (QUEUED, or PREPARING once a cook
 *                           pressed Start without finishing anything yet)
 *
 * Counters only go up, and `served ≤ prepared ≤ quantity` always holds — the
 * database enforces the same with `order_items_progress_check`.
 *
 * ── What the floor shows ────────────────────────────────────────────────────
 *
 *   Ordered   = Σ quantity
 *   Prepared  = Σ (preparedQty − servedQty)   — ready, not yet carried out
 *   Served    = Σ servedQty
 *   Remaining = Σ (quantity − preparedQty)    = Ordered − Prepared − Served
 *
 * Served is never counted as Prepared: the spec's "3 ordered, 2 prepared,
 * 1 served → Remaining 0" is three plates made, one of them already at the
 * table. Cancelled lines are outside all four.
 */

export type ProgressStatus = 'QUEUED' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED'

export interface ItemProgress {
  quantity: number
  preparedQty: number
  servedQty: number
}

export interface ProgressUpdate {
  preparedQty?: number
  servedQty?: number
}

export type ProgressRefusal =
  | { code: 'PROGRESS_BACKWARDS'; message: string }
  | { code: 'PROGRESS_OVER_QUANTITY'; message: string }
  | { code: 'PROGRESS_UNPREPARED'; message: string }

export type ProgressOutcome =
  | { ok: true; changed: boolean; preparedQty: number; servedQty: number; status: ProgressStatus }
  | { ok: false; refusal: ProgressRefusal }

/** The status a line reads at, from its counters. */
export function rowStatusFromCounters(row: ItemProgress & { status: ProgressStatus }): ProgressStatus {
  if (row.status === 'CANCELLED') return 'CANCELLED'
  if (row.quantity > 0 && row.servedQty >= row.quantity) return 'SERVED'
  if (row.quantity > 0 && row.preparedQty >= row.quantity) return 'READY'
  if (row.preparedQty > 0) return 'PREPARING'
  return row.status
}

/**
 * Apply an update to a line, or say why not.
 *
 * Serving implies preparing: asking for `servedQty: 3` on a line with one
 * prepared is refused rather than silently preparing the other two — a waiter
 * cannot carry out food the kitchen has not made. Marking prepared what is
 * already served is a no-op, not a refusal (the checkbox is simply checked).
 */
export function applyProgress(
  current: ItemProgress & { status: ProgressStatus; name?: string },
  update: ProgressUpdate,
): ProgressOutcome {
  const name = current.name ?? 'This item'
  const preparedQty = update.preparedQty ?? current.preparedQty
  const servedQty = update.servedQty ?? current.servedQty

  if (preparedQty < current.preparedQty || servedQty < current.servedQty) {
    return {
      ok: false,
      refusal: {
        code: 'PROGRESS_BACKWARDS',
        message: `${name} is already further along — progress only moves forward`,
      },
    }
  }
  if (preparedQty > current.quantity || servedQty > current.quantity) {
    return {
      ok: false,
      refusal: {
        code: 'PROGRESS_OVER_QUANTITY',
        message: `Only ${current.quantity} × ${name} was ordered`,
      },
    }
  }
  if (servedQty > preparedQty) {
    return {
      ok: false,
      refusal: {
        code: 'PROGRESS_UNPREPARED',
        message: `Only ${preparedQty} of ${current.quantity} × ${name} ${preparedQty === 1 ? 'is' : 'are'} prepared`,
      },
    }
  }

  const status = rowStatusFromCounters({ ...current, preparedQty, servedQty })
  return {
    ok: true,
    changed:
      preparedQty !== current.preparedQty || servedQty !== current.servedQty || status !== current.status,
    preparedQty,
    servedQty,
    status,
  }
}

export interface ProgressSummary {
  ordered: number
  prepared: number
  served: number
  remaining: number
}

/** The four floor figures for a set of lines. Cancelled lines are outside. */
export function summariseProgress(
  items: ReadonlyArray<ItemProgress & { status: ProgressStatus }>,
): ProgressSummary {
  let ordered = 0
  let prepared = 0
  let served = 0
  for (const item of items) {
    if (item.status === 'CANCELLED') continue
    ordered += item.quantity
    prepared += item.preparedQty - item.servedQty
    served += item.servedQty
  }
  return { ordered, prepared, served, remaining: ordered - prepared - served }
}

/** "2 of 3 ready" / "1 of 3 served" for a line, or null when nothing has moved. */
export function progressLabel(item: ItemProgress & { status: ProgressStatus }): string | null {
  if (item.status === 'CANCELLED') return null
  if (item.servedQty >= item.quantity) return null
  if (item.servedQty > 0) return `${item.servedQty} of ${item.quantity} served`
  if (item.preparedQty >= item.quantity) return null
  if (item.preparedQty > 0) return `${item.preparedQty} of ${item.quantity} ready`
  return null
}
