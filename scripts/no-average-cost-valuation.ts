/**
 * Stock is worth what its layers hold, not quantity × an average.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `InventoryItem.costPerUnit` is a blended rate for the whole restaurant. For
 * a long time it was the valuation: thirteen screens computed stock value as
 * `quantity × costPerUnit`, and not one of them agreed with the FIFO layers.
 * Two things were wrong with it, and the second is the one that keeps coming
 * back:
 *
 *   1. a blended rate times a quantity is not the sum of layers bought at
 *      different prices — it is only equal when every layer cost the same;
 *   2. `costPerUnit` is RESTAURANT-WIDE while `InventoryStock.available` is
 *      PER BRANCH, so multiplying one by the other values a branch's stock at
 *      every other branch's purchases too. A site that had bought cheaply was
 *      reported at the group blend, on every screen, in every report.
 *
 * FIFO.md settles it: "Inventory Value = SUM(remaining FIFO layer quantity ×
 * layer cost)". `StockBatch.remainingValue` already is that product, per
 * layer, exactly, so a valuation is an integer sum with no multiplication in
 * it at all.
 *
 * The pattern is easy to write by accident and looks perfectly reasonable, so
 * it gets a lint — the same reason `no-item-branch-filter` exists.
 *
 * ── What to write instead ───────────────────────────────────────────────────
 *
 *   value       → SUM(stockBatch.remainingValue) where remainingQty > 0
 *   unit cost   → currentUnitCost / currentUnitCostMany from features/inventory/fifo
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/no-average-cost-valuation.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', 'src')

/**
 * Files that may multiply by `costPerUnit`, each for a stated reason.
 *
 * Every entry here is a place where the figure is NOT a stock valuation, so
 * the rule does not apply. A new entry needs a reason that survives being read
 * out loud.
 */
const ALLOWED: Record<string, string> = {
  'features/inventory/ledger.ts':
    'the fallback value for an inbound movement whose caller quoted no price — ' +
    'a receipt keyed without a cost is a gap in the paperwork, not a free delivery',
  'features/inventory/recipe-resolver.ts':
    'the per-ingredient fallback when an item has no layer at the branch; a recipe ' +
    'priced at zero because the shelf is empty would read as a dish with no cost',
  'features/inventory/wastage.ts':
    'the fallback when the ledger reports no value moved, so a wastage record is ' +
    'never silently worth nothing',
  'features/inventory/variance-report.ts': 'fallback behind currentUnitCostMany',
  'features/inventory/count-queries.ts': 'fallback behind currentUnitCostMany',
  'features/inventory/stock-actions.ts': 'fallback behind currentUnitCost',
  'features/reports/reconciliation.ts': 'fallback behind currentUnitCostMany',
  'features/inventory/fifo.ts': 'the allocator itself — it derives unit cost FROM layer value',
  'features/inventory/fifo-walk.ts': 'the pure walk',
  'features/inventory/batches.ts': 'layer creation, where the rate is derived from the value',

  /*
   * These two multiply `ResolvedIngredient.costPerUnit`, which happens to share
   * a name with the item field but is not it: `priceTotals` sets it from
   * `currentUnitCostMany` — the next layer's rate at the branch — and only
   * falls back to the item's blend where that branch holds no layer. Both pass
   * a branch, so both are already FIFO.
   */
  'features/inventory/food-cost.ts': 'the resolver already priced the line; this scales it by quantity',
  'features/recipes/actions-fetch.ts': 'per-line figure from the same resolved ingredients',
}

/** Multiplying a quantity by the blended rate — the valuation mistake. */
const PATTERNS: Array<{ re: RegExp; what: string }> = [
  {
    re: /\*\s*(?:\w+\.)*\bcostPerUnit\b/,
    what: 'a quantity multiplied by costPerUnit',
  },
  {
    re: /\bcostPerUnit\s*\*/,
    what: 'costPerUnit multiplied by a quantity',
  },
  {
    re: /\bstockValue\s*\/\s*\w*\.?quantity\b/,
    what: 'stockValue ÷ quantity — the blended rate, computed by hand',
  },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(full)) out.push(full)
  }
  return out
}

/** Strip comments, so a note EXPLAINING the mistake is not read as one. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

let offences = 0
let checked = 0

for (const file of walk(ROOT)) {
  const rel = file.slice(ROOT.length + 1)
  if (ALLOWED[rel]) continue
  checked += 1

  const lines = code(readFileSync(file, 'utf8')).split('\n')
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (!pattern.re.test(line)) continue
      offences += 1
      console.log(`\n  ${rel}:${index + 1} — ${pattern.what}`)
      console.log(`      ${line.trim()}`)
      break
    }
  })
}

console.log(`\nchecked:  ${checked} files`)
console.log(`allowed:  ${Object.keys(ALLOWED).length} (each with a stated reason in this file)`)

if (offences > 0) {
  console.log(`\n✖ ${offences} average-cost valuation(s):`)
  console.log(`
Stock value is SUM(stockBatch.remainingValue) where remainingQty > 0 — an
integer sum, scoped to a branch if the figure is a branch's. For a per-unit
cost use currentUnitCost / currentUnitCostMany from features/inventory/fifo,
which is what the NEXT unit out costs (FIFO.md), not a blend of every delivery.
`)
  process.exitCode = 1
} else {
  console.log('\n✓ every stock value is the sum of its layers')
}
