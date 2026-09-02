import 'server-only'

import type { TxClient } from './prisma'

/**
 * Atomically advance a named per-restaurant counter and return the new value.
 *
 * The invoice number used to be `count(invoices this year) + 1`, which two
 * simultaneous settlements compute identically — one settles, the other dies
 * on the (restaurantId, number) unique constraint. An upsert-increment is a
 * single row-locked statement: it cannot collide, and it never reuses a
 * number, even after an invoice is deleted (a count would).
 */
export async function nextCounterValue(
  tx: TxClient,
  restaurantId: string,
  key: string,
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "restaurant_counters" ("restaurantId", "key", "value")
    VALUES (${restaurantId}, ${key}, 1)
    ON CONFLICT ("restaurantId", "key")
    DO UPDATE SET "value" = "restaurant_counters"."value" + 1
    RETURNING "value"
  `
  return rows[0].value
}

/** The year where the restaurant is, not where the server is. */
export function yearIn(timeZone: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(at)
  } catch {
    return String(at.getFullYear())
  }
}
