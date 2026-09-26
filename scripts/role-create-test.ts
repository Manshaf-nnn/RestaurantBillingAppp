/**
 * Create Role, end to end: the real Server Action over HTTP, then the people
 * it put on the role asking the server for pages.
 *
 * ── Why over HTTP ───────────────────────────────────────────────────────────
 *
 * `sidebar-access-test.ts` proves the arithmetic. This proves the seam: that
 * `createRole` closes the list it was SENT (not the one the dialog would have
 * built), connects the staff it was given, refuses what it should refuse
 * without leaving a half-made role behind, and that a person it connected is
 * then served the tabs and refused the rest — which only a real request with
 * a real cookie can show, for the reasons `role-url-refusal-test.ts` gives.
 *
 * Run: BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json \
 *        scripts/role-create-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { PERMISSIONS } from '../src/lib/rbac'

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
const restaurantIds: string[] = []

async function cleanup(id: string) {
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.session.deleteMany({ where: { user: { restaurantId: id } } })
  await prisma.invite.deleteMany({ where: { restaurantId: id } })
  await prisma.userBranch.deleteMany({ where: { user: { restaurantId: id } } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.staffRole.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\`.`)
    process.exit(0)
  }
  const ids = actionIds()
  const createId = ids.get('createRole')
  const updateId = ids.get('updateRole')
  const assignId = ids.get('assignRole')
  if (!createId || !updateId || !assignId) {
    console.error('createRole / updateRole / assignRole are not in the client bundle — run `npx next build` first.')
    process.exit(1)
  }

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Create Role ${stamp}`, slug: `create-role-${stamp}`, email: `cr-${stamp}@test.local`,
      status: 'ACTIVE', isActive: true, currency: 'LKR', timezone: 'Asia/Colombo',
    },
  })
  restaurantIds.push(restaurant.id)
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' },
  })

  const person = (name: string, role: 'OWNER' | 'MANAGER' | 'WAITER', branchId: string | null, isActive = true) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `${name.toLowerCase()}-${stamp}@test.local`, name,
        passwordHash: 'x', role, branchId, isActive, emailVerifiedAt: new Date(),
      },
    })

  const owner = await person('Ova', 'OWNER', null)
  const kandyManager = await person('Kavi', 'MANAGER', kandy.id)
  const nila = await person('Nila', 'WAITER', main.id)
  const ravi = await person('Ravi', 'WAITER', main.id)
  const sam = await person('Sam', 'WAITER', main.id)
  const tara = await person('Tara', 'WAITER', main.id)
  const dev = await person('Dev', 'WAITER', main.id, false)

  // Somebody else's restaurant, for the tenant check.
  const other = await prisma.restaurant.create({
    data: { name: `Other ${stamp}`, slug: `other-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  restaurantIds.push(other.id)
  const stranger = await prisma.user.create({
    data: { restaurantId: other.id, email: `stranger-${stamp}@test.local`, name: 'Stranger', passwordHash: 'x', role: 'WAITER' },
  })

  const sign = async (user: { id: string; role: string; name: string; email: string }) => {
    const refresh = generateToken()
    const session = await prisma.session.create({
      data: { userId: user.id, refreshTokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + 86_400_000) },
    })
    const access = await signAccessToken({
      sub: user.id, rid: restaurant.id, role: user.role, name: user.name, email: user.email, sid: session.id,
    } as Parameters<typeof signAccessToken>[0])
    return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
  }

  const post = async (cookie: string, actionId: string, payload: unknown) => {
    const response = await fetch(`${BASE}/dashboard/roles`, {
      method: 'POST',
      headers: { cookie, 'Next-Action': actionId, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify([payload]),
      redirect: 'manual',
    })
    const body = await response.text()
    return { status: response.status, body, ok: response.status === 200 && body.includes('"ok":true') }
  }

  const visit = async (path: string, cookie: string) => {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' })
    const body = res.status === 200 ? await res.text() : ''
    const location = res.headers.get('location') ?? ''
    return {
      served: res.status === 200 && !body.includes('/forbidden'),
      refused: body.includes('/forbidden') || location.includes('/forbidden'),
      where: `${res.status} ${location}`,
    }
  }

  const roleNamed = (name: string) =>
    prisma.staffRole.findFirst({ where: { restaurantId: restaurant.id, name, deletedAt: null } })
  const userRow = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } })

  const ownerCookie = await sign(owner)
  const kaviCookie = await sign(kandyManager)

  /*
   * What a browser sends when the owner ticks POS and Cash drawer from
   * scratch — MINUS Payment details, which the dialog would have added. The
   * server has to add it itself, or the dependency is decoration.
   */
  const tillWithoutDependency = [
    PERMISSIONS.ORDER_CREATE,
    PERMISSIONS.ORDER_UPDATE_STATUS,
    PERMISSIONS.PAYMENT_VIEW,
    PERMISSIONS.PAYMENT_COLLECT,
    PERMISSIONS.ORDER_ACCEPT,
    PERMISSIONS.CASH_DRAWER_OPERATE,
  ]

  console.log('\n── 1. A till role, from scratch, with two people on it ──')
  {
    const result = await post(ownerCookie, createId, {
      name: `Till ${stamp}`,
      description: '',
      preset: '',
      branchId: main.id,
      permissions: tillWithoutDependency,
      assignments: [
        { userId: nila.id, branchId: null },
        // Asks for Kandy; the role pins Main, and the role wins.
        { userId: ravi.id, branchId: kandy.id },
      ],
    })
    check('the role is created', result.ok, result.body.slice(0, 200))

    const role = await roleNamed(`Till ${stamp}`)
    check('based on POS — inferred from the tabs, not "the smallest built-in"', role?.preset === 'POS', String(role?.preset))
    check('Payment details was added by the server', role?.permissions.includes(PERMISSIONS.ACCOUNT_VIEW) === true, role?.permissions.join(', '))
    check('and what was sent is all there', tillWithoutDependency.every((p) => role?.permissions.includes(p)))
    check('pinned to Main', role?.branchId === main.id)

    const [n, r] = await Promise.all([userRow(nila.id), userRow(ravi.id)])
    check('Nila is on the role', n.staffRoleId === role?.id)
    check('and her account role follows the preset, so the edge lets her into the till', n.role === 'POS', n.role)
    check('Ravi shares the same role', r.staffRoleId === role?.id)
    check('at the role’s location, not the one the form asked for', r.branchId === main.id, String(r.branchId))

    const members = await prisma.user.count({ where: { staffRoleId: role?.id ?? '-' } })
    check('two people, one role', members === 2, `${members}`)

    const audits = await prisma.auditLog.count({
      where: { restaurantId: restaurant.id, action: 'role.assigned', entityId: { in: [nila.id, ravi.id] } },
    })
    check('each assignment is on the record', audits === 2, `${audits}`)
    check('the role has its sign-in link', (await prisma.invite.count({ where: { staffRoleId: role?.id ?? '-', mode: 'ROLE' } })) === 1)
  }

  console.log('\n── 2. The person the role was given to, at the door ──')
  {
    const fresh = await userRow(nila.id)
    const cookie = await sign(fresh)
    const details = await visit('/dashboard/payment-details', cookie)
    check('Payment details opens for her — the dependency is real access', details.served, details.where)
    const pos = await visit('/cashier/pos', cookie)
    check('so does the POS', pos.served, pos.where)
    const stock = await visit('/dashboard/inventory', cookie)
    check('Stock, which the role does not have, is refused by URL', stock.refused, stock.where)
    const settings = await visit('/dashboard/settings', cookie)
    check('and so is Settings', settings.refused, settings.where)
  }

  console.log('\n── 3. An unpinned role: each person’s own location ──')
  {
    const result = await post(ownerCookie, createId, {
      name: `Reader ${stamp}`,
      description: '',
      preset: '',
      branchId: null,
      permissions: [PERMISSIONS.DASHBOARD_VIEW],
      assignments: [{ userId: sam.id, branchId: kandy.id }],
    })
    check('created for all locations', result.ok, result.body.slice(0, 200))
    const role = await roleNamed(`Reader ${stamp}`)
    check('the role pins nothing', role !== null && role.branchId === null)
    const s = await userRow(sam.id)
    check('Sam moved to Kandy, as the form asked', s.branchId === kandy.id, String(s.branchId))
    check('and is on the role', s.staffRoleId === role?.id)

    const cookie = await sign(s)
    const dashboard = await visit('/dashboard', cookie)
    check('the one tab he was given opens', dashboard.served, dashboard.where)
    const orders = await visit('/dashboard/orders', cookie)
    check('and Orders, which he was not, is refused', orders.refused, orders.where)

    // assignRole with a location, the same path the staff screen uses.
    const assigned = await post(ownerCookie, assignId, { userId: tara.id, staffRoleId: role?.id, branchId: kandy.id })
    check('assigning later with a location works too', assigned.ok, assigned.body.slice(0, 200))
    const t = await userRow(tara.id)
    check('Tara is on the role at Kandy', t.staffRoleId === role?.id && t.branchId === kandy.id)
  }

  console.log('\n── 4. Refusals leave nothing behind ──')
  {
    const inactive = await post(ownerCookie, createId, {
      name: `Ghost ${stamp}`, description: '', preset: '', branchId: main.id,
      permissions: tillWithoutDependency, assignments: [{ userId: nila.id, branchId: null }, { userId: dev.id, branchId: null }],
    })
    check('a switched-off person is refused', !inactive.ok, inactive.body.slice(0, 160))
    check('and no role was created for the others', (await roleNamed(`Ghost ${stamp}`)) === null)

    const foreign = await post(ownerCookie, createId, {
      name: `Foreign ${stamp}`, description: '', preset: '', branchId: main.id,
      permissions: tillWithoutDependency, assignments: [{ userId: stranger.id, branchId: null }],
    })
    check('somebody from another restaurant is refused', !foreign.ok, foreign.body.slice(0, 160))
    check('with no role behind it', (await roleNamed(`Foreign ${stamp}`)) === null)
    check('and the stranger untouched', (await userRow(stranger.id)).staffRoleId === null)

    const acrossSites = await post(kaviCookie, createId, {
      name: `Kandy till ${stamp}`, description: '', preset: '', branchId: kandy.id,
      permissions: tillWithoutDependency, assignments: [{ userId: nila.id, branchId: null }],
    })
    check('a Kandy manager cannot put Main’s staff on a role', !acrossSites.ok, acrossSites.body.slice(0, 160))
    check('and no role was created', (await roleNamed(`Kandy till ${stamp}`)) === null)

    const elsewhere = await post(kaviCookie, createId, {
      name: `Main till ${stamp}`, description: '', preset: '', branchId: main.id,
      permissions: tillWithoutDependency, assignments: [],
    })
    check('nor pin a role to a location they do not run', !elsewhere.ok, elsewhere.body.slice(0, 160))

    const impossible = await post(kaviCookie, createId, {
      name: `Both ${stamp}`, description: '', preset: '', branchId: kandy.id,
      permissions: [...tillWithoutDependency, PERMISSIONS.KITCHEN_VIEW], assignments: [],
    })
    check('POS and Kitchen display together, from a manager, is refused', !impossible.ok)
    check('naming the two tabs', /Kitchen display and POS|POS and Kitchen display/.test(impossible.body), impossible.body.slice(0, 200))

    const still = await userRow(nila.id)
    check('Nila is exactly where §1 left her', still.staffRoleId !== null && still.branchId === main.id)
  }

  console.log('\n── 5. Editing cannot take a dependency away ──')
  {
    const role = (await roleNamed(`Till ${stamp}`))!
    const result = await post(ownerCookie, updateId, {
      id: role.id,
      name: role.name,
      description: '',
      preset: role.preset,
      branchId: role.branchId,
      permissions: role.permissions.filter((p) => p !== PERMISSIONS.ACCOUNT_VIEW),
      isActive: true,
    })
    check('the edit is accepted', result.ok, result.body.slice(0, 160))
    const after = await roleNamed(`Till ${stamp}`)
    check('and Payment details is still there, because POS still is', after?.permissions.includes(PERMISSIONS.ACCOUNT_VIEW) === true)

    /*
     * Down to the drawer alone. The drawer tab lives inside the POS shell
     * (abc.md §8), so the sidebar still offers the POS door — and a door that
     * shows still carries what it requires.
     */
    const drawerOnly = await post(ownerCookie, updateId, {
      id: role.id,
      name: role.name,
      description: '',
      preset: role.preset,
      branchId: role.branchId,
      permissions: [PERMISSIONS.CASH_DRAWER_OPERATE],
      isActive: true,
    })
    check('cutting the role down to the drawer is fine', drawerOnly.ok)
    const stillDoor = await roleNamed(`Till ${stamp}`)
    check(
      'the POS door still shows for the drawer, so Payment details is kept',
      stillDoor?.permissions.includes(PERMISSIONS.ACCOUNT_VIEW) === true,
      stillDoor?.permissions.join(', '),
    )

    const withoutPos = await post(ownerCookie, updateId, {
      id: role.id,
      name: role.name,
      description: '',
      preset: role.preset,
      branchId: role.branchId,
      permissions: [PERMISSIONS.ORDER_VIEW],
      isActive: true,
    })
    check('taking the whole till off is fine', withoutPos.ok)
    const freed = await roleNamed(`Till ${stamp}`)
    check(
      'and then Payment details can go too — the lock was POS’s, not permanent',
      freed?.permissions.includes(PERMISSIONS.ACCOUNT_VIEW) === false && freed?.permissions.includes(PERMISSIONS.ORDER_VIEW) === true,
      freed?.permissions.join(', '),
    )
  }
}

main()
  .catch((error) => {
    failed += 1
    console.error('\n  ✗ crashed:', error)
  })
  .finally(async () => {
    for (const id of restaurantIds) await cleanup(id).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
