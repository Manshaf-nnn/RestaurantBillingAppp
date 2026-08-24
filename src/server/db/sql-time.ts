import 'server-only'

import { Prisma } from '@prisma/client'

/**
 * Timestamps in raw SQL, without getting them wrong.
 *
 * ── What this database actually stores ──────────────────────────────────────
 *
 * Every `DateTime` column here is `timestamp WITHOUT time zone`, which is
 * Prisma's default mapping. Prisma writes the instant's **UTC wall clock** into
 * it and reads it back as UTC, so the column is UTC by convention — but nothing
 * in the column's type says so, and Postgres does not know it.
 *
 * That has two consequences, both of which were live bugs, and both of which
 * are invisible until somebody looks at a number closely.
 *
 * ── 1. A bound Date does not compare the way it looks like it does ──────────
 *
 *   WHERE "placedAt" >= ${from}          -- WRONG
 *
 * The driver binds `from` as `timestamptz`. Postgres then has to compare a
 * `timestamptz` with a `timestamp`, so it casts one to the other **using the
 * session timezone** — which on this connection is `Asia/Colombo`, not UTC. The
 * bound value silently becomes a Colombo wall clock while the column holds a
 * UTC one, and every comparison is off by the offset. Ask for one local day and
 * you get a window shifted five and a half hours off the day you asked for.
 *
 * `utc()` pins it: the parameter is converted to a UTC wall clock explicitly,
 * so the comparison is between two values in the same frame and no session
 * setting can move it.
 *
 * ── 2. `AT TIME ZONE <tz>` on this column runs backwards ────────────────────
 *
 *   date_trunc('day', "placedAt" AT TIME ZONE 'Asia/Kolkata')   -- WRONG
 *
 * That reads as "the day in Kolkata", and it is the opposite. `AT TIME ZONE`
 * applied to a naive `timestamp` *interprets* the value as being in that zone
 * and hands back a `timestamptz`. The column is UTC, so this claims a UTC
 * reading is Kolkata local and shifts it the wrong way.
 *
 * The correct form names both zones — the one the value is in, then the one you
 * want it in:
 *
 *   ("placedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata'
 *
 * The first turns the naive UTC value into a real instant; the second reads
 * that instant on a Kolkata clock. `localBucket()` builds exactly that.
 *
 * ── Why not just fix the columns ────────────────────────────────────────────
 *
 * Migrating every `DateTime` to `@db.Timestamptz` would make both problems
 * disappear at the type level, and is the right long-term answer. It is also a
 * migration over every table in a live database, which is not a thing to do in
 * passing. These two helpers make the current schema correct to query; the
 * migration can happen later without changing a single call site.
 */

/**
 * Bind a JS `Date` for comparison against a naive-UTC timestamp column.
 *
 * Use for EVERY date parameter in a `$queryRaw` against a `DateTime` column.
 *
 * Parenthesised, and that is not cosmetic: `BETWEEN a AND b` binds tighter than
 * `AT TIME ZONE`, so an unwrapped fragment turns `BETWEEN x AT TIME ZONE 'UTC'
 * AND y` into a syntax error — Postgres reads the `AND` as belonging to the
 * BETWEEN and then finds a dangling `AT`. Wrapping it here means no call site
 * has to know that.
 */
export function utc(date: Date): Prisma.Sql {
  return Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`
}

/**
 * `date_trunc(unit, column)` in a given timezone, for a naive-UTC column.
 *
 * Returns a `timestamp` holding the bucket's wall clock in `timeZone`. The
 * driver hands those back as Dates pretending to be UTC, so read the result
 * with the `getUTC*` getters — anything else re-applies the server's offset.
 *
 * `unit` and `column` are interpolated as raw SQL and must never come from user
 * input. Both are fixed strings at every call site; the timezone is bound as a
 * parameter because it comes from the restaurant record.
 */
export function localBucket(
  unit: 'hour' | 'day' | 'month',
  column: string,
  timeZone: string,
): Prisma.Sql {
  return Prisma.sql`(date_trunc(${unit}, (${Prisma.raw(column)} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}))`
}
