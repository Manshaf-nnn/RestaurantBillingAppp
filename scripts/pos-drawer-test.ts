/**
 * The POS_OPEN_DRAWER split and per-staff denials, over real HTTP
 * (staff.A.md §3, §6).
 *
 * ── Why this runs against the server ────────────────────────────────────────
 *
 * `staff-access-test` proves the arithmetic and reads the enforcement points
 * out of the source. That is not the same as proving the server refuses: a
 * guard can be present and unreachable, and the reported class of bug on this
 * codebase has twice been a screen that showed a form the action would reject.
 *
 * So this signs in as real users with real cookies and drives the real server
 * actions. The assertions are what comes back over the wire, not what any
 * function returns when called directly.
 *
 * The denial half also proves the thing the design depends on: permissions are
 * re-read from the database on every request, so a denial written between two
 * calls on the SAME cookie takes effect on the second one. If that were not
 * true, "effective immediately" would be a claim with nothing behind it.
 *
 * Usage:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/pos-drawer-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/lib/rbac'

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
  await prisma.cashMovement.deleteMany({ where: { session: { restaurantId: id } } })
  await prisma.cashDrawerSession.deleteMany({ where: { restaurantId: id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.session.deleteMany({ where: { user: { restaurantId: id } } })
  await prisma.userBranch.deleteMany({ where: { user: { restaurantId: id } } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.staffRole.deleteMany({ where: { restaurantId: id } })
  await prisma.cashRegister.deleteMany({ where: { branch: { restaurantId: id } } })
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
  const openId = ids.get('openDrawerAction')
  const permsId = ids.get('setStaffPermissions')
  if (!openId || !permsId) {
    console.error('openDrawerAction / setStaffPermissions are not in the client bundle — run `npx next build` first.')
    process.exit(1)
  }

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Drawer ${stamp}`, slug: `drawer-${stamp}`, email: `drawer-${stamp}@test.local`,
      status: 'ACTIVE', isActive: true, currency: 'LKR', timezone: 'Asia/Colombo',
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const register = await prisma.cashRegister.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, name: 'Till 1', isActive: true },
  })

  /*
   * The whole point of the split, as a role: somebody who works the till and
   * may not open one. Expressible only because opening is its own permission.
   */
  const tillOnly = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id,
      name: `Till only ${stamp}`,
      preset: 'POS',
      branchId: branch.id,
      isActive: true,
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.ORDER_VIEW,
        PERMISSIONS.ORDER_CREATE,
        PERMISSIONS.PAYMENT_VIEW,
        PERMISSIONS.PAYMENT_COLLECT,
        PERMISSIONS.CASH_DRAWER_OPERATE,
        // POS_OPEN_DRAWER deliberately absent.
      ],
    },
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

  const post = async (cookie: string, path: string, actionId: string, payload: unknown) => {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { cookie, 'Next-Action': actionId, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify([payload]),
      redirect: 'manual',
    })
    const body = await response.text()
    return { status: response.status, body, ok: response.status === 200 && body.includes('"ok":true') }
  }

  const owner = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `owner-${stamp}@test.local`, name: 'Ova',
      passwordHash: 'x', role: 'OWNER', emailVerifiedAt: new Date(),
    },
  })
  const noOpen = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `noopen-${stamp}@test.local`, name: 'Nila',
      passwordHash: 'x', role: 'POS', branchId: branch.id, staffRoleId: tillOnly.id,
      emailVerifiedAt: new Date(),
    },
  })
  const canOpen = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `canopen-${stamp}@test.local`, name: 'Ravi',
      passwordHash: 'x', role: 'POS', branchId: branch.id,
      emailVerifiedAt: new Date(),
    },
  })

  const ownerCookie = await sign({ ...owner, role: 'OWNER' })
  const noOpenCookie = await sign({ ...noOpen, role: 'POS' })
  const canOpenCookie = await sign({ ...canOpen, role: 'POS' })

  const openPayload = { openingFloat: 5000, openingPettyCash: 0, branchId: branch.id, registerId: register.id, note: '' }

  console.log('\n── 1. A POS role can work a till and not open one ──')
  {
    check(
      'the built-in POS role still opens drawers, so nobody lost anything',
      ROLE_PERMISSIONS.POS.includes(PERMISSIONS.POS_OPEN_DRAWER),
    )
    check(
      'and a custom role can withhold it while keeping the till',
      tillOnly.permissions.includes(PERMISSIONS.CASH_DRAWER_OPERATE) &&
        !tillOnly.permissions.includes(PERMISSIONS.POS_OPEN_DRAWER),
    )
  }

  console.log('\n── 2. Without it, the server refuses ──')
  {
    const result = await post(noOpenCookie, '/cashier/pos', openId, openPayload)
    check('opening a drawer is refused', !result.ok, result.body.slice(0, 200))
    const opened = await prisma.cashDrawerSession.count({ where: { openedById: noOpen.id } })
    check('and no session exists afterwards', opened === 0, `${opened} sessions`)

    // The opening-float screen is the form behind that action.
    const page = await fetch(`${BASE}/cashier/session`, {
      headers: { cookie: noOpenCookie },
      redirect: 'manual',
    })
    const went = page.headers.get('location') ?? ''
    check(
      'and the opening-float screen is not reachable by URL',
      page.status === 307 || page.status === 302 || page.status === 403,
      `status ${page.status} → ${went}`,
    )
    check('sent somewhere that says why', !went.includes('/cashier/session'), went)
  }

  console.log('\n── 3. With it, the same call works ──')
  {
    const result = await post(canOpenCookie, '/cashier/pos', openId, openPayload)
    check('the drawer opens', result.ok, result.body.slice(0, 200))
    const session = await prisma.cashDrawerSession.findFirst({ where: { openedById: canOpen.id } })
    check('the session is on the record', session !== null)
    // The form posts major units and the action converts — 5000 rupees is
    // 500000 cents on the row. Asserting the stored figure rather than the
    // posted one is the point: it is the conversion that has to be right.
    check('with the float that was counted', session?.openingFloat === 500_000, String(session?.openingFloat))
    check('at the branch it was opened for', session?.branchId === branch.id)
  }

  console.log('\n── 4. A denial lands on the very next request, same cookie ──')
  {
    // Ravi can take payments right now.
    const before = await prisma.user.findUniqueOrThrow({ where: { id: canOpen.id } })
    check('nothing is denied yet', before.deniedPermissions.length === 0)

    const denied = await post(ownerCookie, '/dashboard/staff', permsId, {
      userId: canOpen.id,
      allow: [],
      deny: [PERMISSIONS.POS_OPEN_DRAWER],
    })
    check('the owner may set it', denied.ok, denied.body.slice(0, 200))

    const after = await prisma.user.findUniqueOrThrow({ where: { id: canOpen.id } })
    check('and it is stored', after.deniedPermissions.includes(PERMISSIONS.POS_OPEN_DRAWER))

    // Close the open session so the refusal below is about the permission and
    // not about already having one.
    await prisma.cashDrawerSession.updateMany({
      where: { openedById: canOpen.id, status: 'OPEN' },
      data: { status: 'CLOSED', closedAt: new Date() },
    })

    const again = await post(canOpenCookie, '/cashier/pos', openId, openPayload)
    check(
      'the SAME cookie is now refused, with no re-login',
      !again.ok,
      again.body.slice(0, 200),
    )
  }

  console.log('\n── 5. Nobody may grant what they do not hold ──')
  {
    const manager = await prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `mgr-${stamp}@test.local`, name: 'Mina',
        passwordHash: 'x', role: 'MANAGER', branchId: branch.id, emailVerifiedAt: new Date(),
        // A manager without the refund permission.
        permissions: [],
      },
    })
    const managerCookie = await sign({ ...manager, role: 'MANAGER' })

    const escalate = await post(managerCookie, '/dashboard/staff', permsId, {
      userId: noOpen.id,
      allow: [PERMISSIONS.SETTINGS_MANAGE],
      deny: [],
    })
    check('granting beyond your own access is refused', !escalate.ok, escalate.body.slice(0, 200))

    const target = await prisma.user.findUniqueOrThrow({ where: { id: noOpen.id } })
    check('and nothing was written', !target.permissions.includes(PERMISSIONS.SETTINGS_MANAGE))

    // Taking away is NOT escalation-checked — a manager may stop their own
    // staff doing something they cannot do themselves.
    const takeAway = await post(managerCookie, '/dashboard/staff', permsId, {
      userId: noOpen.id,
      allow: [],
      deny: [PERMISSIONS.PAYMENT_COLLECT],
    })
    check('but taking one away is allowed', takeAway.ok, takeAway.body.slice(0, 200))

    await prisma.session.deleteMany({ where: { userId: manager.id } })
  }

  console.log('\n── 6. The owner cannot be restricted, and nobody edits themselves ──')
  {
    const self = await post(ownerCookie, '/dashboard/staff', permsId, {
      userId: owner.id, allow: [], deny: [PERMISSIONS.SETTINGS_MANAGE],
    })
    check('the owner cannot deny their own settings', !self.ok, self.body.slice(0, 200))

    const junk = await post(ownerCookie, '/dashboard/staff', permsId, {
      userId: noOpen.id, allow: ['not.a.permission'], deny: [],
    })
    check('an unknown key is refused rather than stored', !junk.ok, junk.body.slice(0, 200))

    const contradiction = await post(ownerCookie, '/dashboard/staff', permsId, {
      userId: noOpen.id,
      allow: [PERMISSIONS.INVENTORY_VIEW],
      deny: [PERMISSIONS.INVENTORY_VIEW],
    })
    check('allowing and denying the same key is refused', !contradiction.ok, contradiction.body.slice(0, 200))
  }

  console.log('\n── 7. The change is on the record ──')
  {
    const row = await prisma.auditLog.findFirst({
      where: { restaurantId: restaurant.id, action: 'staff.permissions_set', entityId: canOpen.id },
      orderBy: { createdAt: 'desc' },
    })
    check('an audit row names who changed what', row !== null && row.userId === owner.id)
    const after = (row?.after ?? {}) as { deny?: string[] }
    check(
      'with the denial in it',
      (after.deny ?? []).includes(PERMISSIONS.POS_OPEN_DRAWER),
      JSON.stringify(after).slice(0, 160),
    )
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
