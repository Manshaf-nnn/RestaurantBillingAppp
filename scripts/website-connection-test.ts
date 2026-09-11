/**
 * A restaurant's own website, connected by a key (websiteconnect.md).
 *
 * The rule this file exists for: Restaurant A's website reaches Restaurant A's
 * data and nothing else. There is no restaurant parameter to get wrong — the
 * key IS the restaurant — so the tests are about the key: that only its hash
 * is stored, that a wrong one is refused, that another tenant's is refused,
 * that rotating and disconnecting actually kill it, and that an order placed
 * through it lands in the ordinary pipeline stamped ONLINE.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/website-connection-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { hashToken } from '../src/server/auth/password'
import { placeOrder } from '../src/features/orders/service'
import { websiteOrderSchema } from '../src/features/website/schema'
import {
  WEBSITE_KEY_PREFIX,
  authenticateWebsiteKey,
  disconnectWebsite,
  getOrderForWebsite,
  getWebsiteConnection,
  issueWebsiteKey,
  placeWebsiteOrder,
  resolveWebsiteBranch,
  touchWebsiteConnection,
} from '../src/features/website/service'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

async function main() {
  const stamp = Date.now().toString(36)

  /** A restaurant with a default branch, optionally a second one that sells cheaper. */
  async function mkRestaurant(label: string, second = false) {
    const restaurant = await prisma.restaurant.create({
      data: {
        name: `Web ${label} ${stamp}`, slug: `web-${label}-${stamp}`, status: 'ACTIVE', isActive: true,
        currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false, timezone: 'Asia/Colombo',
      },
    })
    const main = await prisma.branch.create({
      data: { restaurantId: restaurant.id, name: 'Main', code: `W${label}M`, isDefault: true },
    })
    const kandy = second
      ? await prisma.branch.create({
          data: { restaurantId: restaurant.id, name: 'Kandy', code: `W${label}K` },
        })
      : null
    const category = await prisma.category.create({
      data: { restaurantId: restaurant.id, name: 'Mains', slug: `web-${label}-mains-${stamp}` },
    })
    const dish = await prisma.food.create({
      data: {
        restaurantId: restaurant.id, categoryId: category.id, name: 'Kottu',
        slug: `web-${label}-kottu-${stamp}`, price: 150_000, isAvailable: true,
        branches: {
          create: [
            { restaurantId: restaurant.id, branchId: main.id },
            ...(kandy ? [{ restaurantId: restaurant.id, branchId: kandy.id, price: 120_000 }] : []),
          ],
        },
      },
    })
    return { restaurant, main, kandy, dish }
  }

  const A = await mkRestaurant('A', true)
  const B = await mkRestaurant('B')

  console.log('\n── 1. A key is issued, and only its hash is kept ──')
  const issuedA = await issueWebsiteKey({ restaurantId: A.restaurant.id, websiteUrl: 'https://a.example' })
  const issuedB = await issueWebsiteKey({ restaurantId: B.restaurant.id })
  const keyA = issuedA.key
  const keyB = issuedB.key
  {
    check('the key carries the prefix, so a pasted password is never mistaken for one',
      keyA.startsWith(WEBSITE_KEY_PREFIX) && keyA.length > 40)
    check('the hint is the last four characters', issuedA.connection.keyHint === keyA.slice(-4))
    const row = await prisma.websiteConnection.findUniqueOrThrow({ where: { restaurantId: A.restaurant.id } })
    check('the row holds the SHA-256, not the key', row.keyHash === hashToken(keyA))
    check('…and the key appears nowhere in the row', !JSON.stringify(row).includes(keyA))
    check('a first issue is not a regeneration', issuedA.regenerated === false)
  }

  console.log('\n── 2. The key decides the restaurant — nothing else can ──')
  {
    const callerA = await authenticateWebsiteKey(keyA)
    const callerB = await authenticateWebsiteKey(keyB)
    check('A’s key reaches A', callerA.restaurant.id === A.restaurant.id)
    check('B’s key reaches B, and not A', callerB.restaurant.id === B.restaurant.id)
    await refuses('no key is refused', () => authenticateWebsiteKey(null), /not valid/)
    await refuses('a made-up key is refused', () => authenticateWebsiteKey(`${WEBSITE_KEY_PREFIX}nonsense`), /not valid/)
    await refuses('a key missing its prefix is refused before any lookup',
      () => authenticateWebsiteKey(keyA.slice(WEBSITE_KEY_PREFIX.length)), /not valid/)
    await refuses('the hash itself is not a key', () => authenticateWebsiteKey(hashToken(keyA)), /not valid/)
  }

  console.log('\n── 3. Issued is a claim; used is a fact ──')
  {
    const before = await getWebsiteConnection(A.restaurant.id)
    check('a fresh key has not connected anything', before?.connectedAt === null && before?.lastSeenAt === null)

    await touchWebsiteConnection(before!)
    const after = await getWebsiteConnection(A.restaurant.id)
    check('the first use marks it connected', after?.connectedAt !== null && after?.lastSeenAt !== null)

    await touchWebsiteConnection(after!)
    const again = await getWebsiteConnection(A.restaurant.id)
    check('a second use within the minute costs no write',
      again?.lastSeenAt?.getTime() === after?.lastSeenAt?.getTime())
  }

  console.log('\n── 4. Which branch — said explicitly, or the default; never a cookie ──')
  {
    check('nothing named means the default branch',
      (await resolveWebsiteBranch(A.restaurant.id)).id === A.main.id)
    check('a code is matched case-insensitively',
      (await resolveWebsiteBranch(A.restaurant.id, 'wak')).id === A.kandy!.id)
    check('an id works too',
      (await resolveWebsiteBranch(A.restaurant.id, A.kandy!.id)).id === A.kandy!.id)
    await refuses('an unknown branch is refused, not silently defaulted',
      () => resolveWebsiteBranch(A.restaurant.id, 'NOPE'), /Branch "NOPE"/)
    await refuses('another restaurant’s branch code is unknown here',
      () => resolveWebsiteBranch(A.restaurant.id, B.main.code), /Branch/)
  }

  console.log('\n── 5. An order lands in the ordinary pipeline, stamped ONLINE ──')
  const callerA = await authenticateWebsiteKey(keyA)
  const first = await placeWebsiteOrder(callerA, {
    branch: 'WAK', type: 'TAKEAWAY', customerName: 'Nimal',
    items: [{ foodId: A.dish.id, quantity: 2, optionIds: [] }],
  })
  {
    check('the order is ONLINE, TAKEAWAY, at the branch that was named',
      first.channel === 'ONLINE' && first.type === 'TAKEAWAY' && first.branchId === A.kandy!.id,
      `${first.channel} ${first.type}`)
    check('it was priced by TableFlow at the branch’s own price, not the base price',
      first.subtotal === 240_000, `${first.subtotal}`)
    check('it arrives PENDING and UNPAID, for the kitchen and the till',
      first.status === 'PENDING' && first.paymentStatus === 'UNPAID')
    check('the connection counts it',
      (await getWebsiteConnection(A.restaurant.id))?.orderCount === 1)

    const delivery = await placeWebsiteOrder(callerA, {
      type: 'DELIVERY', customerName: 'Rani', deliveryAddress: '12 Galle Road', notes: 'ring twice',
      items: [{ foodId: A.dish.id, quantity: 1, optionIds: [] }],
    })
    check('a delivery carries its address where the kitchen ticket prints it',
      delivery.type === 'DELIVERY' && (delivery.notes ?? '').includes('Deliver to: 12 Galle Road') &&
        (delivery.notes ?? '').includes('ring twice'),
      delivery.notes ?? '')

    const noAddress = websiteOrderSchema.safeParse({
      type: 'DELIVERY', customerName: 'Rani', items: [{ foodId: A.dish.id, quantity: 1 }],
    })
    check('a delivery with no address is refused before it reaches the kitchen',
      !noAddress.success && JSON.stringify(noAddress.success ? '' : noAddress.error.issues).includes('deliveryAddress'))
    check('an empty order is refused',
      !websiteOrderSchema.safeParse({ customerName: 'X', items: [] }).success)
    check('the schema has no way to spend loyalty points',
      !('redeemPoints' in websiteOrderSchema._def.schema.shape))
  }

  console.log('\n── 6. A retry is not a second order ──')
  {
    const key = `checkout-${stamp}-1`
    const countBefore = (await getWebsiteConnection(A.restaurant.id))!.orderCount
    const one = await placeWebsiteOrder(callerA, {
      type: 'TAKEAWAY', customerName: 'Retry', idempotencyKey: key,
      items: [{ foodId: A.dish.id, quantity: 1, optionIds: [] }],
    })
    const two = await placeWebsiteOrder(callerA, {
      type: 'TAKEAWAY', customerName: 'Retry', idempotencyKey: key,
      items: [{ foodId: A.dish.id, quantity: 1, optionIds: [] }],
    })
    check('the same idempotency key returns the same order', one.id === two.id)
    check('…and it is counted once',
      (await getWebsiteConnection(A.restaurant.id))!.orderCount === countBefore + 1)
  }

  console.log('\n── 7. A website reads back its own orders, and only those ──')
  {
    check('A can read the order it placed', (await getOrderForWebsite(A.restaurant.id, first.id))?.id === first.id)
    check('B cannot read A’s order, even knowing its id', (await getOrderForWebsite(B.restaurant.id, first.id)) === null)

    const staff = await placeOrder({
      restaurantId: A.restaurant.id, branchId: A.main.id, tableId: null, type: 'COUNTER', channel: 'COUNTER',
      customerName: 'Walk-in', customerPhone: '', items: [{ foodId: A.dish.id, quantity: 1, optionIds: [] }],
    })
    check('the dining room’s orders are not the website’s to read',
      (await getOrderForWebsite(A.restaurant.id, staff.id)) === null)
  }

  console.log('\n── 8. Regenerating kills the old key the moment the new one exists ──')
  const rotated = await issueWebsiteKey({ restaurantId: A.restaurant.id })
  {
    check('it is reported as a regeneration, naming what it replaced',
      rotated.regenerated && rotated.previousHint === keyA.slice(-4))
    await refuses('the old key is dead', () => authenticateWebsiteKey(keyA), /not valid/)
    check('the new key works', (await authenticateWebsiteKey(rotated.key)).restaurant.id === A.restaurant.id)
    const row = await getWebsiteConnection(A.restaurant.id)
    check('a new key has proved nothing yet', row?.connectedAt === null)
    check('…but the orders that happened still happened', (row?.orderCount ?? 0) >= 3)
    check('…and the address recorded beside it survived the rotation', row?.websiteUrl === 'https://a.example')
  }

  console.log('\n── 9. A suspended restaurant’s website is told so ──')
  {
    await prisma.restaurant.update({ where: { id: A.restaurant.id }, data: { isActive: false } })
    await refuses('an inactive restaurant refuses its own key, by name',
      () => authenticateWebsiteKey(rotated.key), /not active/)
    await prisma.restaurant.update({ where: { id: A.restaurant.id }, data: { isActive: true } })
  }

  console.log('\n── 10. Disconnecting ──')
  {
    const removed = await disconnectWebsite(A.restaurant.id)
    check('the connection is gone', removed !== null && (await getWebsiteConnection(A.restaurant.id)) === null)
    await refuses('and the key with it', () => authenticateWebsiteKey(rotated.key), /not valid/)
    check('disconnecting twice is a no-op, not an error', (await disconnectWebsite(A.restaurant.id)) === null)
    check('B was never touched', (await authenticateWebsiteKey(keyB)).restaurant.id === B.restaurant.id)
  }

  await prisma.restaurant.deleteMany({ where: { id: { in: [A.restaurant.id, B.restaurant.id] } } })
  console.log(`\n${passed} passed, ${failed} failed`)
  await prisma.$disconnect()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1) })
