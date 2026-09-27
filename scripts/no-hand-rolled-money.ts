/**
 * What a bill comes to, and what is left on it, are each defined once.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `outstandingOn` in `features/orders/pricing` carries a comment calling
 * itself "the ONE definition — every till screen, intent and settlement check
 * reads this, so 'paid in full' cannot mean different things on different
 * screens". That was the intent and it was not true: nine screens wrote the
 * sum out by hand instead, and eight more wrote out `grandTotal + tipAmount`.
 *
 * Every copy happened to agree, so nothing was visibly wrong — which is
 * exactly what makes it worth a lint rather than a one-time cleanup. The cost
 * arrives later, on the day the definition changes: a credit note, a deposit
 * held against a booking, a service charge that stops being refundable. Then
 * the definition moves in one place and seventeen screens quietly keep the old
 * arithmetic, and the bug is not a wrong number on one page but two pages
 * disagreeing about what the guest owes.
 *
 * Three of the copies had already drifted: they subtracted `paidTotal`
 * without the `Math.max(0, …)`, so an overpaid bill rendered a negative amount
 * due. `accounting/integrity.ts` lists overpayment as a real historical class,
 * so those were reachable rows, not a hypothetical.
 *
 * ── What to write instead ───────────────────────────────────────────────────
 *
 *   what the guest owes in total   → billedOn(order)
 *   what is still to be handed over → outstandingOn(order)
 *   which status the money implies  → derivePaymentStatus(order)
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/no-hand-rolled-money.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', 'src')

/**
 * Files that may write this arithmetic out, each for a stated reason.
 *
 * A new entry needs a reason that survives being read out loud.
 */
const ALLOWED: Record<string, string> = {
  'features/orders/pricing.ts':
    'the definitions themselves — billedOn and outstandingOn are what everything else must call',
  'features/accounting/integrity.ts':
    'names the rule in a diagnostic message for the reader, and does no arithmetic with it',
}

const PATTERNS: Array<{ re: RegExp; what: string; instead: string }> = [
  {
    re: /\b[\w.]*grandTotal\s*\+\s*[\w.]*tipAmount\b/,
    what: 'the billed total, written out',
    instead: 'billedOn(order)',
  },
  {
    re: /\b[\w.]*tipAmount\s*\+\s*[\w.]*grandTotal\b/,
    what: 'the billed total, written out the other way round',
    instead: 'billedOn(order)',
  },
  {
    /*
     * The new way to get it wrong: reach for the shared helper for the first
     * half and then subtract by hand, losing the clamp that is the whole
     * difference between "outstanding" and "balance".
     */
    re: /billedOn\([^)]*\)\s*-\s*[\w.]*paidTotal\b/,
    what: 'billedOn minus what was paid, without the clamp',
    instead: 'outstandingOn(order)',
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
      console.log(`      write ${pattern.instead} instead`)
      break
    }
  })
}

console.log(`\nchecked:  ${checked} files`)
console.log(`allowed:  ${Object.keys(ALLOWED).length} (each with a stated reason in this file)`)

if (offences > 0) {
  console.log(`\n✖ ${offences} hand-rolled bill total(s):`)
  console.log(`
A bill's total and its outstanding balance are defined once, in
features/orders/pricing: billedOn() and outstandingOn(). Import them. The
clamp inside outstandingOn is part of the definition — without it an overpaid
bill reads as a negative amount due.
`)
  process.exitCode = 1
} else {
  console.log('\n✓ every bill total comes from the one definition')
}
