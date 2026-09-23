/**
 * Editing a stock item actually saves it (pro.A.md §19).
 *
 * ── Why this runs over HTTP ────────────────────────────────────────────────
 *
 * The reported bug was "I change the price, it says Item saved, and after a
 * refresh the old value is back". Every layer in isolation looked correct; the
 * defect lived in the seam between them — the action dropped a field from its
 * payload, returned before `revalidatePath`, and the dialog reported success
 * regardless. A service-level test would have passed throughout.
 *
 * So this drives the REAL server action through a real signed-in request, then
 * re-reads the row from the database. What the screen claims is irrelevant:
 * the assertion is what Postgres holds afterwards.
 *
 * Usage:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/inventory-edit-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

/** Server Action ids, read out of the built client bundle. */
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
  try { walk('.next/static/chunks') } catch { /* no build */ }
  return found
}

const stamp = Date.now().toString(36)
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryStock.deleteMany({ where: { item: { restaurantId: id } } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\`.`)
    process.exit(0)
  }
  const ids = actionIds()
  const actionId = ids.get('saveInventoryItem')
  if (!actionId) {
    console.error('saveInventoryItem is not in the client bundle — run `npx next build` first.')
    process.exit(1)
  }

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Stock ${stamp}`, slug: `stock-${stamp}`, email: `stock-${stamp}@test.local`,
      status: 'ACTIVE', isActive: true, currency: 'LKR', timezone: 'Asia/Colombo',
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const owner = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `stock-owner-${stamp}@test.local`, name: 'Ova',
      passwordHash: 'x', role: 'OWNER', emailVerifiedAt: new Date(),
    },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: `Supplier ${stamp}` },
  })

  const refresh = generateToken()
  const session = await prisma.session.create({
    data: { userId: owner.id, refreshTokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + 86_400_000) },
  })
  const access = await signAccessToken({
    sub: owner.id, rid: restaurant.id, role: owner.role, name: owner.name, email: owner.email, sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  const cookie = `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`

  const save = async (payload: Record<string, unknown>) => {
    const response = await fetch(`${BASE}/dashboard/inventory`, {
      method: 'POST',
      headers: { cookie, 'Next-Action': actionId, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify([payload]),
      redirect: 'manual',
    })
    const body = await response.text()
    return { status: response.status, body, ok: response.status === 200 && body.includes('"ok":true') }
  }

  const base = {
    name: `Rice ${stamp}`, sku: '', category: 'Dry goods', unit: 'KG', quantity: 0,
    branchId: branch.id, alertBelow: 5, maxStock: null, costPerUnit: 20_000,
    supplierId: '', storageArea: '', tracksExpiry: false, purchaseUnit: '', unitsPerPurchaseUnit: 0,
  }

  console.log('\n── 1. A new item is created with what was typed ──')
  const created = await save(base)
  check('created', created.ok, created.body.slice(0, 160))
  const item = await prisma.inventoryItem.findFirstOrThrow({
    where: { restaurantId: restaurant.id, name: base.name },
  })
  check('with its cost, because cost is settable at creation', item.costPerUnit === 20_000)

  console.log('\n── 2. Every editable field actually reaches the database ──')
  {
    const edited = {
      ...base,
      id: item.id,
      name: `Basmati ${stamp}`,
      sku: `SKU-${stamp}`,
      category: 'Grains',
      alertBelow: 12,
      maxStock: 90,
      supplierId: supplier.id,
      storageArea: 'Cold room',
      purchaseUnit: 'BOX',
      unitsPerPurchaseUnit: 25,
      tracksExpiry: true,
    }
    const result = await save(edited)
    check('the save is accepted', result.ok, result.body.slice(0, 160))

    /*
     * The point of the whole suite: re-read from Postgres. The action's own
     * reply, the toast and the rendered row are all downstream of this, and
     * all three used to say "saved" over a row that had not changed.
     */
    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })
    check('name', after.name === edited.name, after.name)
    check('sku', after.sku === edited.sku, String(after.sku))
    check('category', after.category === 'Grains', String(after.category))
    check('low-stock level', after.reorderLevel === 12 && after.minStock === 12, `${after.reorderLevel}/${after.minStock}`)
    check('par level', after.maxStock === 90, String(after.maxStock))
    check('supplier', after.supplierId === supplier.id, String(after.supplierId))
    check('storage area', after.storageArea === 'Cold room', String(after.storageArea))
    check('purchase unit', after.purchaseUnit === 'BOX', String(after.purchaseUnit))
    check('units per purchase unit', after.unitsPerPurchaseUnit === 25, String(after.unitsPerPurchaseUnit))
    check('expiry tracking', after.trackExpiry === true, String(after.trackExpiry))
    check('and the base unit is unchanged', after.unit === 'KG', after.unit)
  }

  console.log('\n── 3. The edit is on the record ──')
  {
    const row = await prisma.auditLog.findFirst({
      where: { restaurantId: restaurant.id, entity: 'InventoryItem', entityId: item.id },
      orderBy: { createdAt: 'desc' },
    })
    check('an audit row names the item and who changed it', row !== null && row.userId === owner.id)
    const before = (row?.before ?? {}) as { name?: string }
    const after = (row?.after ?? {}) as { name?: string }
    check('with before and after', before.name === `Rice ${stamp}` && after.name === `Basmati ${stamp}`,
      `${before.name} → ${after.name}`)
  }

  console.log('\n── 4. A cost change is refused, not silently dropped ──')
  {
    const result = await save({ ...base, id: item.id, name: `Basmati ${stamp}`, costPerUnit: 99_000 })
    check('the save is refused', !result.ok, result.body.slice(0, 160))
    check('with a reason a person can act on', result.body.includes('COST_LOCKED'), result.body.slice(0, 200))
    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })
    check('and the cost is untouched', after.costPerUnit === 20_000, String(after.costPerUnit))
  }

  console.log('\n── 5. The base unit locks once the ledger has used it ──')
  {
    await prisma.stockMovement.create({
      data: {
        restaurantId: restaurant.id, itemId: item.id, branchId: branch.id,
        type: 'ADJUSTMENT_IN', quantity: 1, unitCost: 20_000, balanceAfter: 1,
        reason: 'test', userId: owner.id,
      },
    })
    const result = await save({ ...base, id: item.id, name: `Basmati ${stamp}`, unit: 'GRAM' })
    check('changing KG to GRAM is refused', !result.ok && result.body.includes('UNIT_LOCKED'), result.body.slice(0, 160))
    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })
    check('and the unit stands', after.unit === 'KG', after.unit)
  }

  console.log('\n── 6. Another restaurant cannot edit this item by id ──')
  {
    const other = await prisma.restaurant.create({
      data: {
        name: `Other ${stamp}`, slug: `other-${stamp}`, email: `other-${stamp}@test.local`,
        status: 'ACTIVE', isActive: true, currency: 'LKR', timezone: 'Asia/Colombo',
      },
    })
    const intruder = await prisma.user.create({
      data: {
        restaurantId: other.id, email: `other-owner-${stamp}@test.local`, name: 'Other',
        passwordHash: 'x', role: 'OWNER', emailVerifiedAt: new Date(),
      },
    })
    const otherRefresh = generateToken()
    const otherSession = await prisma.session.create({
      data: { userId: intruder.id, refreshTokenHash: hashToken(otherRefresh), expiresAt: new Date(Date.now() + 86_400_000) },
    })
    const otherAccess = await signAccessToken({
      sub: intruder.id, rid: other.id, role: 'OWNER', name: intruder.name, email: intruder.email, sid: otherSession.id,
    } as Parameters<typeof signAccessToken>[0])

    const response = await fetch(`${BASE}/dashboard/inventory`, {
      method: 'POST',
      headers: {
        cookie: `${ACCESS_COOKIE}=${otherAccess}; ${REFRESH_COOKIE}=${otherRefresh}`,
        'Next-Action': actionId,
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: JSON.stringify([{ ...base, id: item.id, name: 'Hijacked' }]),
      redirect: 'manual',
    })
    const body = await response.text()
    check('refused', !(response.status === 200 && body.includes('"ok":true')), body.slice(0, 140))
    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })
    check('and the name is untouched', after.name === `Basmati ${stamp}`, after.name)

    await prisma.session.deleteMany({ where: { userId: intruder.id } })
    await prisma.user.deleteMany({ where: { restaurantId: other.id } })
    await prisma.restaurant.deleteMany({ where: { id: other.id } })
  }
}

main()
  .catch((error) => {
    failed += 1
    console.error('\n  ✗ crashed:', error)
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
