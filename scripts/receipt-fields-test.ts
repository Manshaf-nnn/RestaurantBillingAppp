/**
 * What a printed bill shows (bill.md §1).
 *
 * The requirement inverts what this code did before, so it is worth stating
 * plainly: a row the owner switched ON prints even when its value is zero.
 * "Service Charge: LKR 0.00" is the example in the brief, and it is the
 * assertion this file exists for — a bill that silently omits a charge is the
 * bill a guest argues about.
 *
 * Pure functions, no database: `buildReceipt` does no arithmetic beyond the
 * balance, and the whole point of these toggles is that they never touch a
 * number. The last test in the first section proves exactly that.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/receipt-fields-test.ts
 */
import {
  buildReceipt,
  receiptTotals,
  type PrintableBill,
  type ReceiptRestaurant,
} from '../src/features/printing/receipt'
import {
  DEFAULT_RECEIPT_FIELDS,
  readReceiptFields,
  RECEIPT_FIELD_KEYS,
  type ReceiptFields,
} from '../src/features/printing/receipt-fields'

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

const restaurant = (fields?: Partial<ReceiptFields>): ReceiptRestaurant => ({
  name: 'The Copper Spoon',
  currency: 'LKR',
  locale: 'en-GB',
  timeZone: 'Asia/Colombo',
  taxLabel: 'VAT',
  paper: { receipt: 58, kitchen: 80 },
  addressLine: '12 Galle Road, Colombo',
  phone: '0770000000',
  logoUrl: '/api/media/logo.png',
  fields: { ...DEFAULT_RECEIPT_FIELDS, ...(fields ?? {}) },
})

/** A bill with NO service charge, no discount and no rounding — all zero. */
const flatBill: PrintableBill = {
  orderNumber: '260911-001',
  placedAt: '2026-09-11T14:30:00.000Z',
  tableNumber: 'T4',
  customerName: 'Walk-in',
  customerPhone: '0771234567',
  cashierName: 'Nilaza',
  invoiceNumber: 'INV-2026-00042',
  items: [{ name: 'Pasta', quantity: 2, unitPrice: 75_000, lineTotal: 150_000 }],
  subtotal: 150_000,
  discountTotal: 0,
  serviceCharge: 0,
  taxTotal: 3_000,
  grandTotal: 153_000,
  roundingAdj: 0,
}

const labels = (rows: Array<{ label: string }>) => rows.map((row) => row.label)

console.log('\n── 1. Enabled means shown, at zero or not (the §1 rule) ──')
{
  const on = buildReceipt(flatBill, restaurant({ serviceCharge: true }))
  const service = on.totals.find((row) => row.label === 'Service')
  check('a ZERO service charge prints when the owner switched it on',
    service !== undefined && /0\.00$/.test(service.value),
    service ? service.value : 'no Service row at all')

  const off = buildReceipt(flatBill, restaurant({ serviceCharge: false }))
  check('…and vanishes entirely when switched off',
    !labels(off.totals).includes('Service'))

  const zeroRows = buildReceipt(flatBill, restaurant()).totals
  check('the other zero rows obey the same rule — discount and rounding print',
    labels(zeroRows).some((label) => label.startsWith('Discount')) &&
      labels(zeroRows).includes('Rounding'))

  /*
   * The guarantee that makes all of this safe: a toggle chooses which rows are
   * shown and never what a number is. Same bill, opposite settings, identical
   * total.
   */
  const everything = buildReceipt(flatBill, restaurant())
  const almostNothing = buildReceipt(
    flatBill,
    restaurant({ subtotal: false, discount: false, serviceCharge: false, tax: false, rounding: false }),
  )
  const totalOf = (rows: Array<{ label: string; value: string }>) =>
    rows.find((row) => row.label === 'TOTAL')?.value
  check('a toggle never changes a number — TOTAL is byte-identical either way',
    totalOf(everything.totals) === totalOf(almostNothing.totals) &&
      totalOf(everything.totals) !== undefined,
    `${totalOf(everything.totals)} vs ${totalOf(almostNothing.totals)}`)
}

console.log('\n── 2. Every field can be switched off ──')
{
  const allOff = Object.fromEntries(RECEIPT_FIELD_KEYS.map((key) => [key, false])) as Partial<ReceiptFields>
  const bare = buildReceipt(flatBill, restaurant(allOff))

  check('the header empties out', bare.restaurantName === null && bare.addressLine === null && bare.phone === null)
  check('the logo, cashier and customer go', bare.logoUrl === null && bare.cashierName === null && bare.customerName === null)
  check('the invoice number and date go', bare.invoiceNumber === null && bare.placedAt === null)
  check('the item list goes', bare.lines.length === 0)
  check('every money row goes', bare.totals.length === 0, labels(bare.totals).join(', '))
  check('the footer goes — null, so the template prints nothing at all', bare.footer === null)
  check('the order number stays: a receipt with no reference is not a receipt',
    bare.orderNumber === '260911-001')
}

console.log('\n── 3. Columns inside the item list ──')
{
  const withPrice = buildReceipt(flatBill, restaurant({ unitPrice: true, quantity: true }))
  check('unit price appears when switched on', withPrice.lines[0].unitPrice !== null)
  check('quantity is a number when switched on', withPrice.lines[0].quantity === 2)

  const without = buildReceipt(flatBill, restaurant({ unitPrice: false, quantity: false }))
  check('both go when switched off',
    without.lines[0].unitPrice === null && without.lines[0].quantity === null)
  check('the line total always stays — it is the money', without.lines[0].lineTotal.length > 0)
}

console.log('\n── 4. Paid, balance and change ──')
{
  const part: PrintableBill = { ...flatBill, paidTotal: 100_000, payments: [{ method: 'Cash', amount: 100_000 }] }
  const shown = buildReceipt(part, restaurant())
  check('a part payment shows what was paid and what is left',
    labels(shown.totals).some((l) => l.startsWith('Paid ·')) &&
      labels(shown.totals).includes('BALANCE DUE'))

  const hidden = buildReceipt(part, restaurant({ paidAmount: false, balance: false }))
  check('both switch off together with their fields',
    !labels(hidden.totals).some((l) => l.startsWith('Paid ·')) &&
      !labels(hidden.totals).includes('BALANCE DUE'))

  const change = buildReceipt({ ...flatBill, paidTotal: 153_000, changeAmount: 47_000 }, restaurant())
  check('change handed back prints as its own row', labels(change.totals).includes('CHANGE'))
}

console.log('\n── 5. The stored settings ──')
{
  check('nothing stored means exactly the defaults',
    JSON.stringify(readReceiptFields(null)) === JSON.stringify(DEFAULT_RECEIPT_FIELDS))
  check('garbage means the defaults, never a throw',
    JSON.stringify(readReceiptFields('not an object')) === JSON.stringify(DEFAULT_RECEIPT_FIELDS))
  check('a partial row keeps the defaults for keys it never heard of',
    readReceiptFields({ logo: true }).logo === true &&
      readReceiptFields({ logo: true }).grandTotal === DEFAULT_RECEIPT_FIELDS.grandTotal)
  check('a non-boolean is ignored rather than trusted',
    readReceiptFields({ tax: 'yes' }).tax === DEFAULT_RECEIPT_FIELDS.tax)
  check('the footer is capped so one paste cannot run off the roll',
    readReceiptFields({ footerText: 'x'.repeat(500) }).footerText.length === 160)
  check('defaults reproduce what receipts print today — logo, cashier and unit price stay off',
    !DEFAULT_RECEIPT_FIELDS.logo && !DEFAULT_RECEIPT_FIELDS.cashierName && !DEFAULT_RECEIPT_FIELDS.unitPrice)
}

console.log('\n── 6. One ladder, two surfaces ──')
{
  // The guest's on-screen bill renders its own markup but must not invent its
  // own rows — that divergence is what this shared function prevents.
  const viaBuild = buildReceipt(flatBill, restaurant()).totals
  const direct = receiptTotals(flatBill, restaurant(), DEFAULT_RECEIPT_FIELDS)
  check('receiptTotals called directly gives the same rows buildReceipt shows',
    JSON.stringify(viaBuild) === JSON.stringify(direct))

  const coupon = receiptTotals({ ...flatBill, couponCode: 'SAVE10' }, restaurant(), DEFAULT_RECEIPT_FIELDS)
  check('a coupon names itself on the discount row',
    labels(coupon).includes('Discount (SAVE10)'))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
