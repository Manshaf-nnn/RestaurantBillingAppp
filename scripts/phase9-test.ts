/** Phase 9: customers, loyalty, discounts. */
import { prisma } from '../src/server/db/prisma'
import { evaluate, evaluateCoupon, loyaltyFor, redeemPoints } from '../src/features/customers/discounts'
import { getCustomerProfile, getCustomerAnalytics } from '../src/features/customers/analytics'

let pass = 0, fail = 0
const shops: string[] = []
function ok(n: string, c: boolean, d = '') { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)) }
async function throws(n: string, fn: () => Promise<unknown>, code?: string) {
  try { await fn(); fail++; console.log(`  ✗ ${n} — expected rejection`) }
  catch (e) { const c = (e as { code?: string }).code
    if (code && c !== code) { fail++; console.log(`  ✗ ${n} — wanted ${code}, got ${c}`) }
    else { pass++; console.log(`  ✓ ${n} (${c ?? 'rejected'})`) } }
}

async function main() {
  const S = Date.now().toString(36)
  const shop = await prisma.restaurant.create({
    data: { name: `Cust ${S}`, slug: `cust-${S}`, currency: 'LKR', timezone: 'Asia/Colombo',
      loyaltyEnabled: true, loyaltyEarnRateX100: 100, loyaltyPointValue: 500 },
  })
  shops.push(shop.id)
  const colombo = await prisma.branch.create({ data: { restaurantId: shop.id, name: 'Colombo', code: 'C', isDefault: true } })
  const kandy = await prisma.branch.create({ data: { restaurantId: shop.id, name: 'Kandy', code: 'K' } })
  const mains = await prisma.category.create({ data: { restaurantId: shop.id, name: 'Mains', slug: `m-${S}` } })
  const desserts = await prisma.category.create({ data: { restaurantId: shop.id, name: 'Desserts', slug: `d-${S}` } })
  const burger = await prisma.food.create({ data: { restaurantId: shop.id, categoryId: mains.id, name: `B${S}`, slug: `b-${S}`, price: 1_000_00 } })
  const cake = await prisma.food.create({ data: { restaurantId: shop.id, categoryId: desserts.id, name: `C${S}`, slug: `c-${S}`, price: 400_00 } })

  const basket = [
    { foodId: burger.id, categoryId: mains.id, quantity: 2, lineTotal: 2_000_00 },
    { foodId: cake.id, categoryId: desserts.id, quantity: 1, lineTotal: 400_00 },
  ]
  const ctx = { restaurantId: shop.id, subtotal: 2_400_00, lines: basket, branchId: colombo.id }

  const mkCoupon = (data: Record<string, unknown>) =>
    prisma.coupon.create({ data: { restaurantId: shop.id, code: `X${Math.random().toString(36).slice(2, 8).toUpperCase()}`, type: 'PERCENT', value: 10, ...data } })

  console.log('\n── 1. Loyalty is configurable ───────────────────────────')
  const loyalty = await loyaltyFor(shop.id)
  ok('Rs 100 spent = 1 point', loyalty.pointsFor(100_00) === 1, `got ${loyalty.pointsFor(100_00)}`)
  ok('Rs 2500 spent = 25 points', loyalty.pointsFor(2_500_00) === 25, `got ${loyalty.pointsFor(2_500_00)}`)
  ok('100 points = Rs 500', loyalty.valueOf(100) === 500_00, `got ${loyalty.valueOf(100)}`)

  await prisma.restaurant.update({ where: { id: shop.id }, data: { loyaltyEarnRateX100: 200, loyaltyPointValue: 1_000 } })
  const custom = await loyaltyFor(shop.id)
  ok('the earn rate is not hardcoded', custom.pointsFor(100_00) === 2, `got ${custom.pointsFor(100_00)}`)
  ok('the point value is not hardcoded', custom.valueOf(100) === 100_000, `got ${custom.valueOf(100)}`)
  await prisma.restaurant.update({ where: { id: shop.id }, data: { loyaltyEarnRateX100: 100, loyaltyPointValue: 500 } })

  await prisma.restaurant.update({ where: { id: shop.id }, data: { loyaltyEnabled: false } })
  const off = await loyaltyFor(shop.id)
  ok('points stop accruing when loyalty is off', off.pointsFor(10_000_00) === 0)
  await prisma.restaurant.update({ where: { id: shop.id }, data: { loyaltyEnabled: true } })

  console.log('\n── 2. Discount types ────────────────────────────────────')
  const pct = await mkCoupon({ type: 'PERCENT', value: 10 })
  ok('10% off the bill = 240', (await evaluate(pct, ctx)).amount === 240_00)
  const fixed = await mkCoupon({ type: 'FIXED', value: 300_00 })
  ok('a fixed discount is exact', (await evaluate(fixed, ctx)).amount === 300_00)
  const capped = await mkCoupon({ type: 'PERCENT', value: 50, maxDiscount: 500_00 })
  ok('a cap limits the discount', (await evaluate(capped, ctx)).amount === 500_00)
  const huge = await mkCoupon({ type: 'FIXED', value: 9_999_00 })
  ok('a discount never exceeds the bill', (await evaluate(huge, ctx)).amount === 2_400_00)

  console.log('\n── 3. Scope ─────────────────────────────────────────────')
  const catOnly = await mkCoupon({ type: 'PERCENT', value: 50, scope: 'CATEGORY', categoryIds: [desserts.id] })
  const catResult = await evaluate(catOnly, ctx)
  ok('50% off desserts takes 200, not 1200', catResult.amount === 200_00, `got ${catResult.amount}`)
  ok('it reports what it applied to', catResult.eligibleLineTotal === 400_00)

  const itemOnly = await mkCoupon({ type: 'PERCENT', value: 10, scope: 'ITEM', itemIds: [burger.id] })
  ok('an item discount only touches that item', (await evaluate(itemOnly, ctx)).amount === 200_00)

  const missing = await mkCoupon({ type: 'PERCENT', value: 10, scope: 'ITEM', itemIds: ['nope'] })
  const missingResult = await evaluate(missing, ctx)
  ok('nothing qualifying is refused', !missingResult.ok)
  ok('and explains why', (missingResult.reason ?? '').includes('qualifies'))

  console.log('\n── 4. Conditions ────────────────────────────────────────')
  const minSpend = await mkCoupon({ minOrderAmount: 5_000_00 })
  const minResult = await evaluate(minSpend, ctx)
  ok('below the minimum is refused', !minResult.ok)
  ok('and says how much more to spend', (minResult.reason ?? '').includes('more'))

  const expired = await mkCoupon({ endsAt: new Date(Date.now() - 86_400_000) })
  ok('an expired offer is refused', !(await evaluate(expired, ctx)).ok)
  const future = await mkCoupon({ startsAt: new Date(Date.now() + 86_400_000) })
  ok('an offer that has not started is refused', !(await evaluate(future, ctx)).ok)
  const inactive = await mkCoupon({ isActive: false })
  ok('an inactive code is refused', !(await evaluate(inactive, ctx)).ok)
  const used = await mkCoupon({ usageLimit: 5, usedCount: 5 })
  ok('a fully claimed offer is refused', !(await evaluate(used, ctx)).ok)

  const otherBranch = await mkCoupon({ branchId: kandy.id })
  ok('a Kandy-only offer is refused in Colombo', !(await evaluate(otherBranch, ctx)).ok)
  ok('and works in Kandy', (await evaluate(otherBranch, { ...ctx, branchId: kandy.id })).ok)

  const happyHour = await mkCoupon({ startHour: 14, endHour: 17 })
  const at15 = new Date(2026, 7, 20, 15, 0)
  const at20 = new Date(2026, 7, 20, 20, 0)
  ok('happy hour applies inside the window', (await evaluate(happyHour, { ...ctx, now: at15 })).ok)
  ok('and not outside it', !(await evaluate(happyHour, { ...ctx, now: at20 })).ok)

  const lateNight = await mkCoupon({ startHour: 22, endHour: 2 })
  ok('a window that wraps midnight works at 23:00',
    (await evaluate(lateNight, { ...ctx, now: new Date(2026, 7, 20, 23, 0) })).ok)
  ok('and at 01:00', (await evaluate(lateNight, { ...ctx, now: new Date(2026, 7, 20, 1, 0) })).ok)
  ok('but not at 15:00', !(await evaluate(lateNight, { ...ctx, now: at15 })).ok)

  const weekend = await mkCoupon({ daysOfWeek: [0, 6] })
  ok('a weekend offer is refused on a Thursday',
    !(await evaluate(weekend, { ...ctx, now: new Date(2026, 7, 20) })).ok)
  ok('and allowed on a Saturday',
    (await evaluate(weekend, { ...ctx, now: new Date(2026, 7, 22) })).ok)

  console.log('\n── 5. Customer groups ───────────────────────────────────')
  const vip = await prisma.customer.create({
    data: { restaurantId: shop.id, name: 'VIP', phone: `07${S.slice(-7)}`, group: 'VIP', marketingConsent: true, marketingConsentAt: new Date() },
  })
  const normal = await prisma.customer.create({
    data: { restaurantId: shop.id, name: 'Normal', phone: `08${S.slice(-7)}` },
  })
  const vipOnly = await mkCoupon({ customerGroup: 'VIP' })
  ok('a VIP offer works for a VIP', (await evaluate(vipOnly, { ...ctx, customerId: vip.id })).ok)
  ok('and is refused for everyone else', !(await evaluate(vipOnly, { ...ctx, customerId: normal.id })).ok)
  ok('and needs a customer at all', !(await evaluate(vipOnly, ctx)).ok)
  ok('consent defaults to off', normal.marketingConsent === false)
  ok('consent records when it was given', vip.marketingConsentAt !== null)

  console.log('\n── 6. Redeeming points ──────────────────────────────────')
  await prisma.customer.update({ where: { id: vip.id }, data: { loyaltyPoints: 100 } })
  const redeem = await redeemPoints({ restaurantId: shop.id, customerId: vip.id, requestedPoints: 100, billTotal: 2_400_00 })
  ok('100 points is worth Rs 500', redeem.value === 500_00, `got ${redeem.value}`)
  // 100 points are worth Rs 500, so a Rs 1,000 bill absorbs them all.
  const uncapped = await redeemPoints({ restaurantId: shop.id, customerId: vip.id, requestedPoints: 100, billTotal: 1_000_00 })
  ok('a bill larger than the points takes them all', uncapped.points === 100 && uncapped.value === 500_00,
    `${uncapped.points}pts ${uncapped.value}`)
  // A Rs 300 bill can only absorb 60 points; the surplus stays on the account
  // rather than being burnt for change.
  const capped2 = await redeemPoints({ restaurantId: shop.id, customerId: vip.id, requestedPoints: 100, billTotal: 300_00 })
  ok('redemption is capped at the bill, surplus points kept',
    capped2.points === 60 && capped2.value === 300_00, `${capped2.points}pts ${capped2.value}`)
  await throws('spending points you do not have is refused',
    () => redeemPoints({ restaurantId: shop.id, customerId: vip.id, requestedPoints: 500, billTotal: 9_999_00 }),
    'LOYALTY_INSUFFICIENT')

  console.log('\n── 7. Customer analytics ────────────────────────────────')
  await prisma.customer.update({
    where: { id: vip.id },
    data: { totalSpent: 50_000_00, totalOrders: 12, lastOrderAt: new Date(Date.now() - 60 * 86_400_000) },
  })
  await prisma.customer.update({
    where: { id: normal.id }, data: { totalSpent: 1_200_00, totalOrders: 1, lastOrderAt: new Date() },
  })
  const analytics = await getCustomerAnalytics({ restaurantId: shop.id })
  ok('customers are counted', analytics.totalCustomers === 2)
  ok('consent is counted', analytics.withConsent === 1)
  ok('returning customers are counted', analytics.returning === 1)
  ok('one-time visitors are counted separately', analytics.oneTimers === 1)
  ok('top spender is the VIP', analytics.topSpenders[0].id === vip.id)
  ok('a lapsed regular is flagged', analytics.lapsing.some((l) => l.id === vip.id))
  ok('a one-time visitor is NOT called lapsing', !analytics.lapsing.some((l) => l.id === normal.id))
  ok('grouped by segment', analytics.byGroup.length === 2)

  const profile = await getCustomerProfile({ restaurantId: shop.id, customerId: vip.id })
  ok('the profile carries lifetime spend', profile.totalSpent === 50_000_00)
  ok('and average order value', profile.averageOrder === Math.round(50_000_00 / 12))
  ok('and days since last visit', profile.daysSinceLastVisit === 60, `got ${profile.daysSinceLastVisit}`)

  console.log('\n── 8. Tenant isolation ──────────────────────────────────')
  const other = await prisma.restaurant.create({
    data: { name: `O ${S}`, slug: `o-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  shops.push(other.id)
  const cross = await evaluateCoupon(pct.code, { ...ctx, restaurantId: other.id })
  ok('another tenant cannot use this code', !cross.ok)
  const otherAnalytics = await getCustomerAnalytics({ restaurantId: other.id })
  ok('another tenant sees no customers', otherAnalytics.totalCustomers === 0)
  await throws('another tenant cannot redeem these points',
    () => redeemPoints({ restaurantId: other.id, customerId: vip.id, requestedPoints: 1, billTotal: 100_00 }),
    'CUSTOMER_NOT_FOUND')

  // cleanup
  await prisma.couponRedemption.deleteMany({ where: { coupon: { restaurantId: { in: shops } } } })
  await prisma.coupon.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.customer.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.food.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.category.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.branch.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.restaurant.deleteMany({ where: { id: { in: shops } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error('\nCRASHED:', e); await prisma.$disconnect(); process.exit(1) })
