/**
 * An inventory item does not belong to a branch.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `InventoryItem.branchId` and `InventoryItem.locationId` are nullable columns
 * that NO screen in this application has ever written. They are null on every
 * row in every restaurant. Filtering a query on one therefore matches nothing,
 * and it does so silently: the types are perfect, the query is valid, Prisma is
 * happy, and the page simply comes back empty.
 *
 * That has now happened three separate times, each costing a live feature:
 *
 *   1. `purchasing/suggestions.ts` — reorder suggestions were empty at every
 *      branch, so the screen said there was nothing to buy. Fixed first, and
 *      its comment carries the original post-mortem.
 *   2. `inventory/count-queries.ts` — the stock count sheet offered zero items,
 *      so no count could be filled in, so none could be approved, so the Stock
 *      variance report had nothing to read either. Two dead screens from one
 *      `where` clause.
 *   3. `inventory/alerts.ts` — the whole inventory report went blank the moment
 *      anybody used the branch switcher.
 *
 * The rule, from the comment in `suggestions.ts` that keeps having to be
 * rediscovered:
 *
 *   > `branchId` scopes the QUANTITY, not the item list.
 *
 * An item is defined once for the whole restaurant. It is the STOCK that lives
 * somewhere, in `InventoryStock`, keyed by `(itemId, branchId,
 * storageLocationId)`. To narrow by location, join or filter on that.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/no-item-branch-filter.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/features', 'src/app', 'src/server']

/**
 * Places the filter is legitimate.
 *
 * Only two kinds of thing belong here: code that MAINTAINS the columns (a
 * migration helper, a repair script) and code that reads them to report on the
 * columns themselves. A page that wants a location's stock does not qualify.
 */
const ALLOWED: Record<string, string> = {}

function files(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...files(full))
    else if (/\.tsx?$/.test(entry)) found.push(full)
  }
  return found
}

/** The balanced `{…}` starting at `open`, exclusive of the outer braces. */
function block(src: string, open: number): { body: string; end: number } {
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return { body: src.slice(open + 1, i), end: i }
    }
  }
  return { body: src.slice(open + 1), end: src.length }
}

/**
 * Strip named relation filters, keep everything else.
 *
 * `locationStock: { some: { branchId } }` is the RIGHT way to narrow by
 * location, so any `identifier: { … }` is removed before the check. What
 * survives is the item's own columns — including the conditional-spread idiom
 *
 *     ...(branchId ? { branchId } : {})
 *
 * which is how all three real occurrences of this bug were written. An earlier
 * version of this check discarded anything inside braces and therefore missed
 * every one of them; the probe that caught that is in the commit message.
 */
function ownColumns(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '{') {
      out += body[i]
      continue
    }
    // Is this brace the value of `name:`? Then it is a relation filter.
    const before = out.replace(/\s+$/, '')
    const named = /[A-Za-z_$][\w$]*\s*:$/.test(before)
    const { body: inner, end } = block(body, i)
    if (named) {
      out = before.replace(/[A-Za-z_$][\w$]*\s*:$/, '')
    } else {
      // A spread or ternary branch — its keys are the item's own.
      out += ownColumns(inner)
    }
    i = end
  }
  return out
}

/** The `where` clause of an `inventoryItem.find*` / `count` / `aggregate` call. */
function itemWhereClauses(src: string): Array<{ line: number; body: string }> {
  const clauses: Array<{ line: number; body: string }> = []
  const call = /prisma\.inventoryItem\.(findMany|findFirst|findUnique|count|aggregate|updateMany)\s*\(/g

  for (let match = call.exec(src); match; match = call.exec(src)) {
    const whereAt = src.indexOf('where:', match.index)
    if (whereAt === -1) continue
    const open = src.indexOf('{', whereAt)
    if (open === -1) continue
    const { body } = block(src, open)
    clauses.push({ line: src.slice(0, open).split('\n').length, body: ownColumns(body) })
  }
  return clauses
}

function main() {
  const offenders: string[] = []
  let scanned = 0
  let calls = 0

  for (const root of ROOTS) {
    for (const file of files(root)) {
      const src = readFileSync(file, 'utf8')
      if (!src.includes('prisma.inventoryItem.')) continue
      scanned += 1

      for (const clause of itemWhereClauses(src)) {
        calls += 1
        const key = `${file}:${clause.line}`
        if (key in ALLOWED) continue
        // No trailing colon required — `{ branchId }` shorthand is how the
        // conditional-spread version is always written.
        if (/\bbranchId\b/.test(clause.body) || /\blocationId\b/.test(clause.body)) {
          offenders.push(`  ${file}:${clause.line}`)
        }
      }
    }
  }

  console.log(`files scanned:        ${scanned}`)
  console.log(`item queries checked: ${calls}`)
  console.log(`allowed:              ${Object.keys(ALLOWED).length}`)

  if (offenders.length > 0) {
    console.error(
      `\n✖ ${offenders.length} query filter(s) an inventory item on a branch:\n`,
    )
    console.error(offenders.join('\n'))
    console.error(
      '\n`InventoryItem.branchId` and `.locationId` are never written, so this\n' +
        'matches nothing and the screen goes quietly blank.\n\n' +
        'branchId scopes the QUANTITY, not the item list. Select every active\n' +
        'item and narrow the amount through `InventoryStock` instead:\n\n' +
        '  include: { locationStock: { where: { branchId }, select: { available: true } } }\n\n' +
        'See src/features/purchasing/suggestions.ts for the worked example.',
    )
    process.exit(1)
  }

  console.log('\n✓ no query narrows the item list by branch')
}

main()
