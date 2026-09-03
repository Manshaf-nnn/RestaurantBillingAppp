/**
 * The calculator's math, proven (acCal.md §2).
 *
 * Pure functions, no database. The one identity that matters most: pulling
 * tax OUT of a tax-inclusive price must return exactly the net that putting
 * tax ON started from — for every rate, or the calculator would disagree
 * with the billing engine by a rupee here and there all day.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/calc-math-test.ts
 */
import {
  convertAtRate,
  discountOf,
  foodCostBps,
  marginBps,
  marginToMarkup,
  markupBps,
  markupToMargin,
  priceForMargin,
  priceForMarkup,
  shareBps,
  taxInGross,
  taxOnNet,
  toRateMicro,
} from '../src/lib/accounting-math'

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

console.log('\n── Tax: inclusive and exclusive are the same math, both ways ──')
{
  // Every net × rate combination must survive the round trip exactly.
  const nets = [1, 3, 7, 99, 1_000, 12_345, 99_999, 1_082_499, 999_999_999]
  const rates = [0, 100, 333, 825, 1_500, 1_800, 2_750]
  let holds = true
  let brokeAt = ''
  for (const net of nets) {
    for (const rate of rates) {
      const { gross } = taxOnNet(net, rate)
      const back = taxInGross(gross, rate)
      if (back.net !== net || back.tax !== gross - net) {
        holds = false
        brokeAt = `net ${net} rate ${rate}bps → gross ${gross} → back ${back.net}`
      }
    }
  }
  check('round trip net → gross → net is exact for every rate', holds, brokeAt)
  const known = taxInGross(11_500, 1_500)
  check('11,500 with 15% inside = 10,000 net + 1,500 tax', known.net === 10_000 && known.tax === 1_500)
  const zero = taxOnNet(10_000, 0)
  check('a 0% rate adds nothing', zero.tax === 0 && zero.gross === 10_000)
}

console.log('\n── Margin vs markup: different words, different numbers ──')
{
  check('1,000 sale costing 600: margin 40.00%', marginBps(1_000, 600) === 4_000)
  check('the same sale is a 66.67% markup', markupBps(1_000, 600) === 6_667)
  check('40% margin converts to 66.67% markup', marginToMarkup(4_000) === 6_667)
  check('66.67% markup converts back to 40% margin', markupToMargin(6_667) === 4_000)
  check('price for a 40% margin on cost 6,000 is 10,000', priceForMargin(6_000, 4_000) === 10_000)
  check('price for a 66.67% markup on cost 6,000 is 10,000', priceForMarkup(6_000, 6_667) === 10_000)
  // The suggested price must actually deliver the margin asked for.
  let delivers = true
  for (const cost of [1_000, 15_000, 123_456, 5_000_000]) {
    for (const target of [1_000, 2_500, 4_000, 6_500, 8_000]) {
      const price = priceForMargin(cost, target)
      const got = price === null ? null : marginBps(price, cost)
      if (got === null || Math.abs(got - target) > 5) delivers = false
    }
  }
  check('a suggested price delivers its target margin within 0.05%', delivers)
  check('a 100% margin has no finite price', priceForMargin(1_000, 10_000) === null)
  check('margin of a zero-price sale is refused, not NaN', marginBps(0, 500) === null)
  check('markup on a free ingredient is refused, not Infinity', markupBps(1_000, 0) === null)
}

console.log('\n── Food cost, shares, discounts ──')
{
  check('COGS 30,000 on revenue 100,000 = 30% food cost', foodCostBps(30_000, 100_000) === 3_000)
  check('food cost with no revenue is refused', foodCostBps(5_000, 0) === null)
  check('250 is 25% of 1,000', shareBps(250, 1_000) === 2_500)
  const d = discountOf(1_000, 2_500)
  check('25% off 1,000 = 250 off, 750 after', d.off === 250 && d.after === 750)
  const whole = discountOf(9_999, 10_000)
  check('100% off leaves zero', whole.after === 0 && whole.off === 9_999)
}

console.log('\n── Currency conversion at a typed rate ──')
{
  check('rate 291.735 stores exactly as micro-units', toRateMicro(291.735) === 291_735_000)
  check('100.00 at 291.735 = 29,173.50', convertAtRate(10_000, toRateMicro(291.735)) === 2_917_350)
  check('a rate of 1 changes nothing', convertAtRate(123_456, toRateMicro(1)) === 123_456)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
