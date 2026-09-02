/**
 * A guest edits their order from the phone — and the bill, the kitchen and the
 * stock ledger all agree about what happened.
 *
 * ── The defect this pins (AUDIT.md C1) ──────────────────────────────────────
 *
 * The tracker used to send only the lines the guest kept, and the server
 * looped over the payload: a line missing from it was never touched. Remove a
 * dish on the phone and it stayed QUEUED on the kitchen board, kept its
 * ingredients deducted, but left the bill. Free food, reachable by anyone with
 * a QR code and no account.
 *
 * The fix makes the payload authoritative — every line is in it, absence
 * means zero — so it can only be proven over the real Server Action, where the
 * real payload arrives. Service-level calls cannot see a client that filters.
 *
 * Also pinned here:
 *   • H11 — a guest can only remove QUEUED lines; a PREPARING line is refused,
 *     and a removed line is CANCELLED, never deleted (the row is the record).
 *   • H10 — editing an order the kitchen has NOT accepted must not deplete
 *     stock (reconcile runs only if depletion rows already exist).
 *   • The audit's invariant: after every guest edit,
 *     sum(lineTotal where status ≠ CANCELLED) === order.subtotal.
 *
 * Requires a build and a running server:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/guest-edit-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { prisma } from '../src/server/db/prisma'
import { generateToken } from '../src/server/auth/password'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const GUEST_COOKIE = 'ros_gs'
const TENANT_COOKIE = 'ros_r'

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

/** name → action id, harvested from the built client chunks. */
function actionIds(): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.js')) {
        const src = readFileSync(full, 'utf8')
        const re = /createServerReference\)\("([0-9a-f]{40,42})"[^)]*?,"([A-Za-z0-9_$]+)"\)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(src))) if (!found.has(m[2])) found.set(m[2], m[1])
      }
    }
  }
  try {
    walk('.next/static/chunks')
  } catch {
    // no build
  }
  return found
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\`.`)
    process.exit(0)
  }

  const editId = actionIds().get('updateGuestOrderItems')
  if (!editId) {
    console.error('updateGuestOrderItems not found in the client bundle — run `npx next build`.')
    process.exit(1)
  }

  const restaurant = await prisma.restaurant.findFirst({
    where: { isActive: true, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, slug: true },
  })
  if (!restaurant) {
    console.error('No active restaurant — seed the database first.')
    process.exit(1)
  }
  const branch = await prisma.branch.findFirst({
    where: { restaurantId: restaurant.id, deletedAt: null, isActive: true },
    orderBy: { isDefault: 'desc' },
  })
  if (!branch) {
    console.error('Restaurant has no branch.')
    process.exit(1)
  }

  const stamp = Date.now().toString(36).toUpperCase().slice(-5)
  const guestSession = generateToken(18)
  const cookie = `${GUEST_COOKIE}=${guestSession}; ${TENANT_COOKIE}=${restaurant.slug}`

  /*
   * The order is created directly, not through placeOrder, so the fixture can
   * hold the exact shape the defect needs: one line still QUEUED (the guest
   * may remove it), one already PREPARING (the kitchen owns it), on an order
   * the kitchen has looked at but no depletion has run for.
   */
  const mkOrder = async (suffix: string) =>
    prisma.order.create({
      data: {
        restaurantId: restaurant.id,
        branchId: branch.id,
        orderNumber: `GED-${stamp}-${suffix}`,
        channel: 'QR',
        status: 'ACCEPTED',
        customerName: 'Guest',
        customerPhone: '',
        guestSessionId: guestSession,
        subtotal: 3000,
        grandTotal: 3000,
        items: {
          create: [
            { name: 'Queued dish', unitPrice: 1000, quantity: 2, lineTotal: 2000, status: 'QUEUED', isVeg: false, prepTimeMinutes: 10 },
            { name: 'Cooking dish', unitPrice: 1000, quantity: 1, lineTotal: 1000, status: 'PREPARING', isVeg: false, prepTimeMinutes: 10 },
          ],
        },
      },
      include: { items: true },
    })

  const edit = async (orderId: string, items: Array<{ itemId: string; quantity: number }>) => {
    const response = await fetch(`${BASE}/order/track/${orderId}`, {
      method: 'POST',
      headers: { cookie, 'Next-Action': editId, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify([{ orderId, items }]),
      redirect: 'manual',
    })
    return { status: response.status, body: await response.text() }
  }

  const lines = (orderId: string) =>
    prisma.orderItem.findMany({ where: { orderId }, orderBy: { name: 'asc' } })

  const billAgrees = async (orderId: string) => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } })
    const active = order.items.filter((item) => item.status !== 'CANCELLED')
    const sum = active.reduce((total, item) => total + item.lineTotal, 0)
    return { order, sum, agrees: sum === order.subtotal }
  }

  console.log('A line left out of the payload is removed from the KITCHEN, not just the bill')
  {
    const order = await mkOrder('A')
    const queued = order.items.find((item) => item.status === 'QUEUED')!
    const cooking = order.items.find((item) => item.status === 'PREPARING')!

    // The old client sent exactly this: only the lines the guest kept.
    const result = await edit(order.id, [{ itemId: cooking.id, quantity: 1 }])
    check('the edit is accepted', result.body.includes('"ok":true'), result.body.slice(0, 200))

    const after = await lines(order.id)
    const gone = after.find((item) => item.id === queued.id)
    check('the omitted line still exists as a row', Boolean(gone), 'it was hard-deleted — the bill cannot explain itself')
    check('…and is CANCELLED, off the kitchen board', gone?.status === 'CANCELLED', `status ${gone?.status}`)

    const { order: refreshed, sum, agrees } = await billAgrees(order.id)
    check('sum(active lineTotal) === subtotal', agrees, `lines ${sum}, subtotal ${refreshed.subtotal}`)
    check('the removed food is off the bill', refreshed.subtotal === 1000, `subtotal ${refreshed.subtotal}`)
  }

  console.log('\nA dish the kitchen is already cooking cannot be taken back by a guest')
  {
    const order = await mkOrder('B')
    const queued = order.items.find((item) => item.status === 'QUEUED')!
    const cooking = order.items.find((item) => item.status === 'PREPARING')!

    const result = await edit(order.id, [
      { itemId: queued.id, quantity: 2 },
      { itemId: cooking.id, quantity: 0 },
    ])
    check('the edit is refused', result.body.includes('"ok":false'), result.body.slice(0, 200))

    const { order: refreshed } = await billAgrees(order.id)
    const untouched = await lines(order.id)
    check('nothing changed', refreshed.subtotal === 3000 && untouched.every((item) => item.status !== 'CANCELLED'))
  }

  console.log('\nEditing an order that has not consumed stock does not start consuming it')
  {
    const order = await mkOrder('C')
    const queued = order.items.find((item) => item.status === 'QUEUED')!
    const cooking = order.items.find((item) => item.status === 'PREPARING')!

    await edit(order.id, [
      { itemId: queued.id, quantity: 1 },
      { itemId: cooking.id, quantity: 1 },
    ])
    const depletions = await prisma.orderStockDepletion.count({ where: { orderId: order.id } })
    check('no depletion rows appeared', depletions === 0, `${depletions} rows — the edit depleted an unaccepted order`)

    const { agrees, sum, order: refreshed } = await billAgrees(order.id)
    check('a plain reduction keeps the invariant', agrees && refreshed.subtotal === 2000, `lines ${sum}, subtotal ${refreshed.subtotal}`)
  }

  console.log('\nMore of a cooking dish becomes a fresh QUEUED line, not fiction on a done card')
  {
    const order = await mkOrder('D')
    const queued = order.items.find((item) => item.status === 'QUEUED')!
    const cooking = order.items.find((item) => item.status === 'PREPARING')!

    await edit(order.id, [
      { itemId: queued.id, quantity: 2 },
      { itemId: cooking.id, quantity: 3 },
    ])
    const after = await lines(order.id)
    const original = after.find((item) => item.id === cooking.id)
    const extra = after.find((item) => item.id !== cooking.id && item.id !== queued.id)
    check('the original card is untouched', original?.quantity === 1 && original.status === 'PREPARING')
    check('the extra is its own QUEUED line', extra?.quantity === 2 && extra.status === 'QUEUED', extra ? `${extra.quantity} ${extra.status}` : 'no new line')

    const { agrees, sum, order: refreshed } = await billAgrees(order.id)
    check('the bill counts all five dishes', agrees && refreshed.subtotal === 5000, `lines ${sum}, subtotal ${refreshed.subtotal}`)
  }

  console.log('\nAnother guest’s cookie cannot edit this order')
  {
    const order = await mkOrder('E')
    const queued = order.items.find((item) => item.status === 'QUEUED')!
    const strangerCookie = `${GUEST_COOKIE}=${generateToken(18)}; ${TENANT_COOKIE}=${restaurant.slug}`
    const response = await fetch(`${BASE}/order/track/${order.id}`, {
      method: 'POST',
      headers: { cookie: strangerCookie, 'Next-Action': editId, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify([{ orderId: order.id, items: [{ itemId: queued.id, quantity: 0 }] }]),
      redirect: 'manual',
    })
    const body = await response.text()
    check('refused', body.includes('"ok":false'), body.slice(0, 200))
    const untouched = await lines(order.id)
    check('nothing changed', untouched.every((item) => item.status !== 'CANCELLED'))
  }

  await prisma.orderEvent.deleteMany({ where: { order: { orderNumber: { startsWith: `GED-${stamp}` } } } })
  await prisma.orderItem.deleteMany({ where: { order: { orderNumber: { startsWith: `GED-${stamp}` } } } })
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: `GED-${stamp}` } } })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
