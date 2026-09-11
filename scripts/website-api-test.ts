/**
 * The website API over real HTTP (websiteconnect.md).
 *
 * `website-connection-test` proves the service. This proves the door: that a
 * key in an Authorization header is what gets a website in, that the middleware
 * refuses a browser-side call with a message naming the actual mistake, that
 * the menu comes back priced for the branch that was asked for, and that an
 * order POSTed from outside lands in the database as an ONLINE order the
 * kitchen and the till will see.
 *
 * Requires a build and a running server:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/website-api-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { issueWebsiteKey } from '../src/features/website/service'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const API = `${BASE}/api/website/v1`

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** One call, the way a website's server would make it. */
async function api(
  path: string,
  key: string | null,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'manual',
  })
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  return { status: response.status, body }
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\`.`)
    process.exit(0)
  }

  const stamp = Date.now().toString(36)

  async function mkRestaurant(label: string, second = false) {
    const restaurant = await prisma.restaurant.create({
      data: {
        name: `Site ${label} ${stamp}`, slug: `site-${label}-${stamp}`, status: 'ACTIVE', isActive: true,
        currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false, timezone: 'Asia/Colombo',
      },
    })
    const main = await prisma.branch.create({
      data: { restaurantId: restaurant.id, name: 'Main', code: `S${label}M`, isDefault: true },
    })
    const kandy = second
      ? await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Kandy', code: `S${label}K` } })
      : null
    const category = await prisma.category.create({
      data: { restaurantId: restaurant.id, name: 'Mains', slug: `site-${label}-mains-${stamp}` },
    })
    const dish = await prisma.food.create({
      data: {
        restaurantId: restaurant.id, categoryId: category.id, name: 'Kottu',
        slug: `site-${label}-kottu-${stamp}`, price: 150_000, isAvailable: true,
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
  const keyA = (await issueWebsiteKey({ restaurantId: A.restaurant.id })).key
  const keyB = (await issueWebsiteKey({ restaurantId: B.restaurant.id })).key

  console.log('\n── 1. The door ──')
  {
    const none = await api('/connection', null)
    check('no key → 401 with a code the developer can search for',
      none.status === 401 && none.body?.code === 'INVALID_KEY', `${none.status} ${JSON.stringify(none.body)}`)
    const bad = await api('/connection', 'tfk_nonsense')
    check('a made-up key → 401', bad.status === 401 && bad.body?.code === 'INVALID_KEY')
    const b = await api('/connection', keyB)
    const bRestaurant = b.body?.restaurant as { id: string } | undefined
    check('B’s key answers with B — and could not answer with anything else',
      b.status === 200 && bRestaurant?.id === B.restaurant.id)
  }

  console.log('\n── 2. Test Connection, as the website does it ──')
  {
    const before = await prisma.websiteConnection.findUniqueOrThrow({ where: { restaurantId: A.restaurant.id } })
    const res = await api('/connection', keyA)
    const restaurant = res.body?.restaurant as { id: string; name: string } | undefined
    const branch = res.body?.branch as { id: string } | undefined
    const branches = (res.body?.branches ?? []) as Array<{ code: string }>
    check('200 with the key’s own restaurant', res.status === 200 && restaurant?.id === A.restaurant.id)
    check('the default branch is named, and every branch is listed',
      branch?.id === A.main.id && branches.some((entry) => entry.code === 'SAK'))
    const after = await prisma.websiteConnection.findUniqueOrThrow({ where: { restaurantId: A.restaurant.id } })
    check('that one call is what turns the console green',
      before.connectedAt === null && after.connectedAt !== null)
  }

  console.log('\n── 3. Branding, with nothing internal on it ──')
  {
    const res = await api('/restaurant', keyA)
    const text = JSON.stringify(res.body)
    const restaurant = res.body?.restaurant as { name: string; currency: string } | undefined
    check('name and currency come back', res.status === 200 && restaurant?.name === A.restaurant.name && restaurant?.currency === 'LKR')
    check('payment accounts, printer setup and receipt layout are not on it',
      !text.includes('paymentConfig') && !text.includes('printerConfig') && !text.includes('receiptConfig'))
  }

  console.log('\n── 4. The menu, priced for the branch that was asked for ──')
  {
    const kandy = await api('/menu?branch=SAK', keyA)
    const kItems = (kandy.body?.items ?? []) as Array<{ id: string; price: number }>
    check('Kandy’s price, not the base price', kItems.find((item) => item.id === A.dish.id)?.price === 120_000,
      JSON.stringify(kItems.map((item) => item.price)))
    const main = await api('/menu', keyA)
    const mItems = (main.body?.items ?? []) as Array<{ id: string; price: number }>
    check('no branch named means the default branch', mItems.find((item) => item.id === A.dish.id)?.price === 150_000)
    const nope = await api('/menu?branch=NOPE', keyA)
    check('an unknown branch is a 404, not a silent default', nope.status === 404)
    check('B’s menu does not contain A’s dish',
      !((await api('/menu', keyB)).body?.items as Array<{ id: string }>).some((item) => item.id === A.dish.id))
  }

  console.log('\n── 5. An order from outside lands inside ──')
  const placed = await api('/orders', keyA, {
    method: 'POST',
    body: {
      branch: 'SAK', type: 'TAKEAWAY', customerName: 'Nimal', customerPhone: '+94 77 123 4567',
      items: [{ foodId: A.dish.id, quantity: 2, optionIds: [] }],
      idempotencyKey: `web-${stamp}-1`,
    },
  })
  const order = placed.body?.order as { id: string; status: string; grandTotal: number } | undefined
  {
    check('201 with the priced order', placed.status === 201 && order?.status === 'PENDING' && order?.grandTotal === 240_000,
      `${placed.status} ${JSON.stringify(placed.body)}`)
    const row = order ? await prisma.order.findUnique({ where: { id: order.id } }) : null
    check('the row the kitchen and till will see is ONLINE, at Kandy',
      row?.channel === 'ONLINE' && row?.branchId === A.kandy!.id && row?.restaurantId === A.restaurant.id)

    const replay = await api('/orders', keyA, {
      method: 'POST',
      body: {
        branch: 'SAK', type: 'TAKEAWAY', customerName: 'Nimal',
        items: [{ foodId: A.dish.id, quantity: 2, optionIds: [] }],
        idempotencyKey: `web-${stamp}-1`,
      },
    })
    check('the same checkout sent twice is one order', (replay.body?.order as { id: string } | undefined)?.id === order?.id)

    const invalid = await api('/orders', keyA, { method: 'POST', body: { customerName: 'X', items: [] } })
    check('a bad body is 422 with the field named',
      invalid.status === 422 && Boolean((invalid.body?.fieldErrors as Record<string, unknown> | undefined)?.items))
  }

  console.log('\n── 6. Reading it back ──')
  {
    const mine = await api(`/orders/${order?.id}`, keyA)
    check('A reads its order', mine.status === 200 && (mine.body?.order as { id: string } | undefined)?.id === order?.id)
    const theirs = await api(`/orders/${order?.id}`, keyB)
    check('B gets a 404 for A’s order — it does not exist as far as B’s key is concerned', theirs.status === 404)
  }

  console.log('\n── 7. A browser-side call is refused, and told why ──')
  {
    const browser = await api('/orders', keyA, {
      method: 'POST',
      headers: { origin: 'https://mrchai.lk' },
      body: { customerName: 'X', items: [{ foodId: A.dish.id, quantity: 1 }] },
    })
    check('403 BROWSER_CALL, before the key goes any further',
      browser.status === 403 && browser.body?.code === 'BROWSER_CALL', `${browser.status} ${JSON.stringify(browser.body)}`)
    check('…with a message about where the key belongs',
      /server/.test(String(browser.body?.error)) && /browser/.test(String(browser.body?.error)))
  }

  await prisma.restaurant.deleteMany({ where: { id: { in: [A.restaurant.id, B.restaurant.id] } } })
  console.log(`\n${passed} passed, ${failed} failed`)
  await prisma.$disconnect()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1) })
