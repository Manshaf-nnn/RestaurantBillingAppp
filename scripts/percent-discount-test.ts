/**
 * A bill discount as a percentage (cashier → Discount → Percentage).
 *
 * Pinned: the percentage is taken of exactly what a manual discount comes
 * off in `computeTotals` — the live lines after their item discounts and the
 * coupon — so the base helper and the totals engine can never disagree; a
 * fixed amount is capped at that same room; the schema takes exactly one of
 * the two, refuses more than 100% or more than two decimals, and still
 * accepts the plain amount the till has always sent.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/percent-discount-test.ts
 */
import { computeTotals, manualDiscountBase } from '../src/features/orders/pricing'
import { applyDiscountSchema } from '../src/features/orders/schema'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const lines = [
  { lineTotal: 70_000, discount: 10_000 }, // pizza 700, 100 off the line
  { lineTotal: 30_000, discount: 0 },
]
const base = manualDiscountBase({ lines, couponDiscount: 5_000 })

console.log('\n── The base ──')
check('subtotal less item discounts less coupon', base === 100_000 - 10_000 - 5_000, String(base))
check('never negative', manualDiscountBase({ lines: [{ lineTotal: 1_000, discount: 5_000 }], couponDiscount: 9_000 }) === 0)

console.log('\n── The totals engine agrees ──')
const tenPercent = Math.round((base * 10) / 100)
const totals = computeTotals({
  lines, taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false, couponDiscount: 5_000,
  manualDiscount: tenPercent, loyaltyDiscount: 0, currency: 'LKR', roundTotal: false,
})
check('10% is applied in full, not clamped', totals.manualDiscount === tenPercent, `${totals.manualDiscount} vs ${tenPercent}`)
check('100% takes exactly what is left, and the bill reaches zero before tax', computeTotals({
  lines, taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false, couponDiscount: 5_000,
  manualDiscount: base, loyaltyDiscount: 0, currency: 'LKR', roundTotal: false,
}).grandTotal === 0)

console.log('\n── The schema ──')
const id = 'cln0000000000000000000000'
check('a plain amount still parses (the old shape)', applyDiscountSchema.safeParse({ orderId: id, amount: 500 }).success)
check('a percentage parses', applyDiscountSchema.safeParse({ orderId: id, mode: 'percent', percent: 12.5 }).success)
check('more than 100% is refused', !applyDiscountSchema.safeParse({ orderId: id, mode: 'percent', percent: 101 }).success)
check('a negative percentage is refused', !applyDiscountSchema.safeParse({ orderId: id, mode: 'percent', percent: -1 }).success)
check('three decimals are refused', !applyDiscountSchema.safeParse({ orderId: id, mode: 'percent', percent: 10.125 }).success)
check('percent mode with no percentage is refused', !applyDiscountSchema.safeParse({ orderId: id, mode: 'percent', amount: 500 }).success)
check('amount mode with no amount is refused', !applyDiscountSchema.safeParse({ orderId: id, mode: 'amount' }).success)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
