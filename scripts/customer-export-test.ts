/**
 * The customers' phone numbers, exported (Customers → Export numbers).
 *
 * Pinned: the category filter including "no category"; blocked customers
 * and undialable numbers left out and counted; landlines left out only when
 * asked; the same number written two ways is one entry; numbers are digits
 * with the country code and no plus; the branch narrows; another
 * restaurant's customers never appear; the TXT shape is one number per
 * line and nothing else; and the permission is the owner's, not the
 * manager's, by default.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/customer-export-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { listCustomerNumbers, numbersAsText, categoryFilterFrom } from '../src/features/customers/export'
import { phoneKey } from '../src/features/customers/phone'
import { LK, isMobile } from '../src/features/sms/msisdn'
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/lib/rbac'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const stamp = Date.now().toString(36)
const restaurantIds: string[] = []

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: `Export ${stamp}`, slug: `export-${stamp}`, status: 'ACTIVE', isActive: true, timezone: 'Asia/Colombo', currency: 'LKR' },
  })
  restaurantIds.push(restaurant.id)
  const other = await prisma.restaurant.create({
    data: { name: `Other ${stamp}`, slug: `oexport-${stamp}`, status: 'ACTIVE', isActive: true, timezone: 'Asia/Colombo', currency: 'LKR' },
  })
  restaurantIds.push(other.id)
  const vip = await prisma.customerCategory.create({ data: { restaurantId: restaurant.id, name: 'VIP' } })
  const regular = await prisma.customerCategory.create({ data: { restaurantId: restaurant.id, name: 'Regular' } })

  const add = (restaurantId: string, name: string, phone: string, extra: Record<string, unknown> = {}) =>
    prisma.customer.create({ data: { restaurantId, name, phone, phoneKey: phoneKey(phone), ...extra } })

  await add(restaurant.id, 'Amal', '0771234567', { categoryId: vip.id })
  await add(restaurant.id, 'Amal again', '+94771234567', { categoryId: vip.id }) // same number, other spelling
  await add(restaurant.id, 'Bimal', '0712223334', { categoryId: regular.id })
  await add(restaurant.id, 'Chamari', '0765556667') // no category
  await add(restaurant.id, 'Office', '0112345678', { categoryId: vip.id }) // Colombo landline
  await add(restaurant.id, 'Blocked', '0779998887', { categoryId: vip.id, isBlocked: true })
  await add(restaurant.id, 'Short', '12345', { categoryId: vip.id }) // undialable
  await add(other.id, 'Stranger', '0770000001', {})

  const base = { restaurantId: restaurant.id, branchIds: null, segment: {} }

  console.log('\n── 1. All categories, mobiles only ──')
  const all = await listCustomerNumbers({ ...base, category: { kind: 'all' }, mobileOnly: true })
  check('three dialable mobiles, one entry each', all.rows.map((r) => r.number).sort().join() === ['94712223334', '94765556667', '94771234567'].join(), all.rows.map((r) => r.number).join())
  check('digits only, country code first, no plus', all.rows.every((r) => /^94\d{9}$/.test(r.number)))
  check('the duplicate spelling was folded', all.skipped.duplicate === 1)
  check('the landline was left out and counted', all.skipped.landline === 1)
  check('the undialable number was left out and counted', all.skipped.invalid === 1)
  check('the blocked customer was left out and counted', all.skipped.blocked === 1 && !all.rows.some((r) => r.name === 'Blocked'))
  check('nobody from another restaurant', !all.rows.some((r) => r.name === 'Stranger'))
  check('not truncated', all.truncated === false)

  console.log('\n── 2. Category filter ──')
  const vips = await listCustomerNumbers({ ...base, category: { kind: 'one', id: vip.id }, mobileOnly: true })
  check('VIP only: one mobile', vips.rows.length === 1 && vips.rows[0]?.number === '94771234567', vips.rows.map((r) => r.number).join())
  check('…with its category named', vips.rows[0]?.category === 'VIP')
  const none = await listCustomerNumbers({ ...base, category: { kind: 'none' }, mobileOnly: true })
  check('"no category" finds the uncategorised customer', none.rows.length === 1 && none.rows[0]?.name === 'Chamari')
  check('the URL forms parse', categoryFilterFrom('').kind === 'all' && categoryFilterFrom('none').kind === 'none' && categoryFilterFrom(vip.id).kind === 'one')

  console.log('\n── 3. Landlines when asked ──')
  const withLandlines = await listCustomerNumbers({ ...base, category: { kind: 'one', id: vip.id }, mobileOnly: false })
  check('the Colombo landline is included when landlines are wanted', withLandlines.rows.some((r) => r.number === '94112345678'))
  check('isMobile: 077 is, 011 is not, a foreign number is not judged', isMobile('+94771234567', LK) && !isMobile('+94112345678', LK) && isMobile('+447700900000', LK))

  console.log('\n── 4. The page filters still apply ──')
  const searched = await listCustomerNumbers({ ...base, segment: { q: 'bimal' }, category: { kind: 'all' }, mobileOnly: true })
  check('a search narrows the list the same way it narrows the screen', searched.rows.length === 1 && searched.rows[0]?.name === 'Bimal')
  const otherOnly = await listCustomerNumbers({ restaurantId: other.id, branchIds: null, segment: {}, category: { kind: 'all' }, mobileOnly: true })
  check('the other restaurant sees only its own', otherOnly.rows.length === 1 && otherOnly.rows[0]?.name === 'Stranger')

  console.log('\n── 5. The text file ──')
  const text = numbersAsText(all.rows)
  check('one number per line, CRLF, nothing else', text === all.rows.map((r) => r.number).join('\r\n') + '\r\n' && !/[^\d\r\n]/.test(text))
  check('an empty list is an empty file', numbersAsText([]) === '')

  console.log('\n── 6. Who may ──')
  check('the owner may export', ROLE_PERMISSIONS.OWNER.includes(PERMISSIONS.CUSTOMER_EXPORT))
  check('an administrator may', ROLE_PERMISSIONS.ADMIN.includes(PERMISSIONS.CUSTOMER_EXPORT))
  check('a manager may not, by default', !ROLE_PERMISSIONS.MANAGER.includes(PERMISSIONS.CUSTOMER_EXPORT))
  check('nor a cashier, waiter or accountant',
    !ROLE_PERMISSIONS.CASHIER.includes(PERMISSIONS.CUSTOMER_EXPORT) &&
      !ROLE_PERMISSIONS.WAITER.includes(PERMISSIONS.CUSTOMER_EXPORT) &&
      !ROLE_PERMISSIONS.ACCOUNTANT.includes(PERMISSIONS.CUSTOMER_EXPORT))
}

main()
  .catch((error) => { console.error(error); failed += 1 })
  .finally(async () => {
    for (const id of restaurantIds) await prisma.restaurant.delete({ where: { id } }).catch((error) => console.error('cleanup', error.message))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
