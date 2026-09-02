/**
 * The billing engine, exercised directly across its whole matrix.
 *
 * `computeTotals` is the one function every bill in the product goes
 * through, and until now nothing tested IT — only the flows around it. The
 * matrix: tax inclusive × exclusive, service charge on and off, coupon and
 * manual discounts separately and together, loyalty on top, clamping when
 * discounts exceed the bill, rounding, and the §110 rule that the tip never
 * enters the total.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/billing-math-test.ts
 */
import { computeTotals, outstandingOn } from '../src/features/orders/pricing'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function main() {
  const lines = [{ lineTotal: 100_000 }, { lineTotal: 50_000 }] // 1500.00

  console.log('\n── Exclusive tax, service charge ──')
  {
    // 1500 − 100 coupon − 50 manual = 1350 base; 10% service 135; 5% tax on 1485 = 74.25 → 7425
    const t = computeTotals({
      lines, taxRateBps: 500, serviceChargeBps: 1000, taxInclusive: false,
      couponDiscount: 10_000, manualDiscount: 5_000, currency: 'LKR', roundTotal: false,
    })
    check('subtotal is the line sum', t.subtotal === 150_000)
    check('the split is preserved', t.couponDiscount === 10_000 && t.manualDiscount === 5_000)
    check('discountTotal is their sum', t.discountTotal === 15_000)
    check('service is levied on the discounted base', t.serviceCharge === 13_500, `${t.serviceCharge}`)
    check('tax applies to base + service', t.taxTotal === 7_425, `${t.taxTotal}`)
    check('grand total adds up', t.grandTotal === 135_000 + 13_500 + 7_425, `${t.grandTotal}`)
  }

  console.log('\n── Inclusive tax backs the tax out, never adds it ──')
  {
    const t = computeTotals({
      lines, taxRateBps: 1000, serviceChargeBps: 0, taxInclusive: true,
      currency: 'LKR', roundTotal: false,
    })
    check('the total IS the price on the menu', t.grandTotal === 150_000, `${t.grandTotal}`)
    check('the tax reported is the backed-out tenth', t.taxTotal === 150_000 - Math.round(150_000 * 10_000 / 11_000), `${t.taxTotal}`)
  }

  console.log('\n── Clamping: a discount can empty a bill, never invert it ──')
  {
    const t = computeTotals({
      lines: [{ lineTotal: 10_000 }], taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      couponDiscount: 8_000, manualDiscount: 8_000, currency: 'LKR', roundTotal: false,
    })
    check('the coupon is honoured first, the manual takes the clamp',
      t.couponDiscount === 8_000 && t.manualDiscount === 2_000,
      `${t.couponDiscount}/${t.manualDiscount}`)
    check('the bill lands on zero, not below', t.grandTotal === 0, `${t.grandTotal}`)
  }
  {
    const t = computeTotals({
      lines: [{ lineTotal: 10_000 }], taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      couponDiscount: 5_000, loyaltyDiscount: 50_000, currency: 'LKR', roundTotal: false,
    })
    check('loyalty is clamped to what remains after discounts',
      t.loyaltyDiscount === 5_000 && t.grandTotal === 0, `${t.loyaltyDiscount}/${t.grandTotal}`)
  }

  console.log('\n── The tip is never in the total (§110) ──')
  {
    const withTip = computeTotals({
      lines, taxRateBps: 500, serviceChargeBps: 1000, taxInclusive: false,
      tipAmount: 20_000, currency: 'LKR', roundTotal: false,
    })
    const withoutTip = computeTotals({
      lines, taxRateBps: 500, serviceChargeBps: 1000, taxInclusive: false,
      currency: 'LKR', roundTotal: false,
    })
    check('grandTotal is identical with and without a tip',
      withTip.grandTotal === withoutTip.grandTotal,
      `${withTip.grandTotal} vs ${withoutTip.grandTotal}`)
    check('the tip is carried separately', withTip.tipAmount === 20_000)
    check('what the guest owes is the one place they meet',
      outstandingOn({ grandTotal: withTip.grandTotal, tipAmount: withTip.tipAmount, paidTotal: 0 }) ===
        withTip.grandTotal + 20_000)
  }

  console.log('\n── Rounding is a recorded adjustment, not a silent change ──')
  {
    const t = computeTotals({
      lines: [{ lineTotal: 10_049 }], taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      currency: 'LKR', roundTotal: true,
    })
    check('the total is rounded to the major unit', t.grandTotal % 100 === 0, `${t.grandTotal}`)
    check('and the adjustment is exactly the difference',
      t.grandTotal === 10_049 + t.roundingAdj, `${t.grandTotal} vs 10049 + ${t.roundingAdj}`)
  }

  console.log('\n── Money identities hold across the whole matrix ──')
  {
    let cases = 0
    let holds = true
    for (const taxInclusive of [true, false]) {
      for (const taxRateBps of [0, 500, 1800]) {
        for (const serviceChargeBps of [0, 1000]) {
          for (const couponDiscount of [0, 7_777]) {
            for (const manualDiscount of [0, 3_333]) {
              for (const loyaltyDiscount of [0, 2_500]) {
                const t = computeTotals({
                  lines, taxRateBps, serviceChargeBps, taxInclusive,
                  couponDiscount, manualDiscount, loyaltyDiscount,
                  currency: 'LKR', roundTotal: true,
                })
                cases += 1
                const identity =
                  t.discountTotal === t.couponDiscount + t.manualDiscount &&
                  t.taxableBase === t.subtotal - t.discountTotal - t.loyaltyDiscount &&
                  t.grandTotal >= 0 &&
                  t.grandTotal ===
                    t.taxableBase + t.serviceCharge + (taxInclusive ? 0 : t.taxTotal) + t.roundingAdj
                if (!identity) {
                  holds = false
                  console.log('    broke at', { taxInclusive, taxRateBps, serviceChargeBps, couponDiscount, manualDiscount, loyaltyDiscount }, t)
                }
              }
            }
          }
        }
      }
    }
    check(`every identity holds across ${cases} combinations`, holds && cases === 96)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
