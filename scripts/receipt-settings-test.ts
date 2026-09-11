/**
 * The bill settings, stored and read back (bill.md §1).
 *
 * The thing worth testing here is not that a boolean saves — it is that two
 * settings forms writing the same restaurant cannot erase each other. That bug
 * shipped once already: `updatePrinterSettings` wrote `printerConfig` as a
 * whole object, so anything else living in that column vanished the next time
 * somebody changed paper size. Receipt fields went in their own column
 * precisely so it cannot happen again, and these assertions hold both halves.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/receipt-settings-test.ts
 */
import { readReceiptFields, DEFAULT_RECEIPT_FIELDS } from '../src/features/printing/receipt-fields'
import { readPaperWidths } from '../src/features/printing/paper'
import { readPaymentConfig } from '../src/features/payments/service'
import { prisma } from '../src/server/db/prisma'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  const stamp = Date.now().toString(36)
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Bill ${stamp}`, slug: `bill-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      timezone: 'Asia/Colombo',
      printerConfig: { receipt: { width: 80 }, kitchen: { width: 80 } },
      paymentConfig: { cash: true, card: false, upiId: 'shop@bank' },
    },
  })

  console.log('\n── Each form owns its own column ──')
  {
    // Save bill settings, the way the action does.
    await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { receiptConfig: { ...DEFAULT_RECEIPT_FIELDS, unitPrice: true, serviceCharge: false, footerText: 'Come back soon' } },
    })
    const after = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurant.id } })

    const fields = readReceiptFields(after.receiptConfig)
    check('the toggles come back as saved', fields.unitPrice === true && fields.serviceCharge === false)
    check('and so does the footer', fields.footerText === 'Come back soon')

    check('saving the bill did not touch the paper size',
      readPaperWidths(after.printerConfig).receipt === 80)
    check('…nor the payment settings',
      readPaymentConfig(after.paymentConfig).upiId === 'shop@bank')
  }

  console.log('\n── A restaurant that never opened the setting ──')
  {
    const untouched = await prisma.restaurant.create({
      data: {
        name: `Plain ${stamp}`, slug: `plain-${stamp}`, status: 'ACTIVE', isActive: true,
        currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      },
    })
    check('gets exactly the defaults, so its paper does not change on deploy',
      JSON.stringify(readReceiptFields(untouched.receiptConfig)) === JSON.stringify(DEFAULT_RECEIPT_FIELDS))
    await prisma.restaurant.delete({ where: { id: untouched.id } })
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
