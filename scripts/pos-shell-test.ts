/**
 * The POS is one screen with the cashier inside it (abc.md §8).
 *
 *   - /cashier is a redirect into the shell's Cashier tab, carrying the
 *     branch and the takeaway mode it was given;
 *   - /cashier/pos shows the tabs a person may open — Orders, Cashier,
 *     Drawer — and renders each tab's own screen;
 *   - a tab somebody may not open sends them to the first they may, not to
 *     a refusal and not to a blank page;
 *   - which tabs are whose is one pure function the page, the strip and this
 *     file all ask;
 *   - the sidebar has one POS entry, the old till URL has no entry of its
 *     own, a cashier lands in the shell, the app shortcut points into it.
 *
 * Runtime tier: needs a built server.
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/pos-shell-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { PERMISSIONS, ROLE_HOME, can, type PermissionSubject } from '../src/lib/rbac'
import { posTabsFor, resolvePosTab } from '../src/features/cashier/pos-tabs'
import { RECEIVER_ROLES } from '../src/features/handover/shift-service'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

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

async function signIn(user: { id: string; restaurantId: string | null; role: string; name: string | null; email: string }) {
  const refresh = generateToken()
  const session = await prisma.session.create({
    data: { userId: user.id, refreshTokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + 86_400_000) },
  })
  const access = await signAccessToken({
    sub: user.id, rid: user.restaurantId, role: user.role,
    name: user.name, email: user.email, sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
}

async function hit(path: string, cookie: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' })
  const body = res.status >= 300 && res.status < 400 ? '' : await res.text()
  return { status: res.status, location: res.headers.get('location'), body }
}

async function main() {
  console.log('\n── 0. Whose tabs ──')
  {
    const subject = (role: PermissionSubject['role'], permissions: string[] = []): PermissionSubject =>
      ({ role, permissions } as PermissionSubject)
    // DELIBERATE behaviour change 2026-09 (recorrection.md §2): Shift
    // Handover is the fourth tab, where the person finishing a shift stands.
    check('a cashier has all four', posTabsFor(subject('CASHIER')).join(',') === 'orders,cashier,drawer,handover')
    check('an owner has all four', posTabsFor(subject('OWNER')).join(',') === 'orders,cashier,drawer,handover')
    check('a waiter takes orders and hands their shift on', posTabsFor(subject('WAITER')).join(',') === 'orders,handover')
    check('the kitchen still has none — it hands over from its own screen', posTabsFor(subject('KITCHEN')).length === 0)
    check('and neither do the stores', posTabsFor(subject('WAREHOUSE_STAFF')).length === 0)
    check('an asked-for tab is honoured when allowed', resolvePosTab(subject('CASHIER'), 'drawer') === 'drawer')
    check('a tab they may not open falls to the first they may', resolvePosTab(subject('WAITER'), 'cashier') === 'orders')
    check('nonsense falls to the first', resolvePosTab(subject('OWNER'), 'nope') === 'orders')
    check('the handover tab is honoured', resolvePosTab(subject('WAITER'), 'handover') === 'handover')
    check('and nothing allowed is null', resolvePosTab(subject('KITCHEN'), 'orders') === null)

    /*
     * The tab and the page gate must agree. The POS asks for a till
     * permission before it will open at all, so a tab offered to somebody
     * that gate turns away would be a tab nobody could reach.
     */
    const posGate = [PERMISSIONS.ORDER_CREATE, PERMISSIONS.PAYMENT_COLLECT, PERMISSIONS.CASH_DRAWER_OPERATE, PERMISSIONS.CASH_DRAWER_MANAGE]
    const roles = ['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'ACCOUNTANT', 'INVENTORY_MANAGER', 'PURCHASING_MANAGER', 'WAREHOUSE_STAFF'] as const
    check('nobody is offered a tab on a screen they cannot open',
      roles.every((role) => posTabsFor(subject(role)).length === 0 || posGate.some((p) => can(subject(role), p))))
    check('everybody who may hand over can reach the screen that accepts it',
      roles.every((role) => !RECEIVER_ROLES[role]?.length || can(subject(role), PERMISSIONS.HANDOVER_VIEW)))
  }

  console.log('\n── 1. The registry ──')
  {
    const stub = readFileSync('src/app/cashier/page.tsx', 'utf8')
    check('/cashier is a redirect stub', stub.includes('redirect(') && !stub.includes('prisma.') && !stub.includes('requirePagePermission'))
    check('into the Cashier tab', stub.includes("tab=cashier"))
    const nav = readFileSync('src/features/dashboard/nav.ts', 'utf8')
    check('the sidebar has one POS entry', (nav.match(/href: '\/cashier\/pos'/g) ?? []).length === 1 && !nav.includes("href: '/cashier',"))
    check('a cashier lands in the shell', ROLE_HOME.CASHIER.startsWith('/cashier/pos'))
    const manifest = readFileSync('src/app/manifest.webmanifest/route.ts', 'utf8')
    check('the app shortcut points into the shell', manifest.includes("url: '/cashier/pos?tab=cashier'"))
    const features = readFileSync('src/features/access/features.ts', 'utf8')
    check('the payments feature owns the shell route', /routes: \[[^\]]*'\/cashier\/pos'/.test(features))
  }

  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`\nNo server at ${BASE} — the HTTP half is skipped. Start one with \`npx next start\`.`)
    console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
    process.exit(failed === 0 ? 0 : 1)
  }

  const stamp = Date.now().toString(36)
  const restaurant = await prisma.restaurant.create({
    data: { name: `Shell ${stamp}`, slug: `shell-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const owner = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `shell-owner-${stamp}@test.local`, name: 'Owner', passwordHash: 'x', role: 'OWNER' },
  })
  // A manager who may only take orders: no PAYMENT_COLLECT, no drawer.
  const ordersOnly = await prisma.staffRole.create({
    data: {
      restaurantId: restaurant.id, name: 'Order taker', preset: 'MANAGER', branchId: branch.id,
      permissions: [PERMISSIONS.ORDER_CREATE, PERMISSIONS.ORDER_VIEW, PERMISSIONS.MENU_VIEW, PERMISSIONS.DASHBOARD_VIEW],
    },
  })
  const taker = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `shell-taker-${stamp}@test.local`, name: 'Taker', passwordHash: 'x',
      role: 'MANAGER', branchId: branch.id, staffRoleId: ordersOnly.id,
    },
  })
  const asOwner = await signIn(owner)
  const asTaker = await signIn(taker)
  const q = `branch=${branch.id}`

  try {
    console.log('\n── 2. The old till URL redirects into the shell ──')
    {
      const plain = await hit('/cashier', asOwner)
      check('/cashier redirects', plain.status >= 300 && plain.status < 400, `status ${plain.status}`)
      check('to the Cashier tab of the POS', (plain.location ?? '').includes('/cashier/pos') && (plain.location ?? '').includes('tab=cashier'), String(plain.location))
      const withBranch = await hit(`/cashier?${q}&mode=takeaway`, asOwner)
      check('carrying the branch and the takeaway mode', (withBranch.location ?? '').includes(`branch=${branch.id}`) && (withBranch.location ?? '').includes('mode=takeaway'), String(withBranch.location))
    }

    console.log('\n── 3. The shell, tab by tab ──')
    {
      const orders = await hit(`/cashier/pos?${q}`, asOwner)
      check('the POS renders for an owner', orders.status === 200, `status ${orders.status}`)
      check('with the tab strip', orders.body.includes('data-testid="pos-tabs"'))
      check('showing every tab', orders.body.includes('>Orders<') && orders.body.includes('>Cashier<') && orders.body.includes('>Drawer<') && orders.body.includes('>Shift Handover<'))
      check('and the order-taking screen', /Tap a dish to add it/.test(orders.body))

      const cashier = await hit(`/cashier/pos?${q}&tab=cashier`, asOwner)
      check('the Cashier tab renders the till', cashier.status === 200 && /Open bills/.test(cashier.body), `status ${cashier.status}`)
      check('inside the shell, not a second screen', cashier.body.includes('data-testid="pos-tabs"'))

      const drawer = await hit(`/cashier/pos?${q}&tab=drawer`, asOwner)
      check('the Drawer tab renders the drawer console', drawer.status === 200 && /float/i.test(drawer.body), `status ${drawer.status}`)

      // recorrection.md §2 — the same handover screen the dashboard mounts,
      // on the till where the person finishing a shift is standing.
      const handover = await hit(`/cashier/pos?${q}&tab=handover`, asOwner)
      check('the Shift Handover tab renders', handover.status === 200, `status ${handover.status}`)
      check('with the flow on it', /Start handover/.test(handover.body))
      check('and the history section', /Handover history/.test(handover.body))
      /*
       * The columns are pinned at their source rather than in the rendered
       * page: this fixture's owner has never handed a shift over, so the
       * table is an empty state here, and asserting on the markup would pass
       * or fail on whether the test data happened to include a handover.
       */
      const panel = readFileSync('src/features/handover/components/shift-handover.tsx', 'utf8')
      check('which lists date, who, where, shift and status',
        ['>Date<', '>Outgoing<', '>Receiving<', '>Location<', '>Shift<', '>Status<'].every((column) => panel.includes(column)))
      check('inside the shell, not a second screen', handover.body.includes('data-testid="pos-tabs"'))

      const page = readFileSync('src/app/cashier/pos/page.tsx', 'utf8')
      check('it mounts the existing panel, not a copy of it', page.includes('<ShiftHandoverPanel') && page.includes("from '@/features/handover/shift-service'"))
    }

    console.log('\n── 4. A tab they may not open ──')
    {
      const refused = await hit(`/cashier/pos?${q}&tab=cashier`, asTaker)
      check('an order-taker asking for the Cashier tab is sent to Orders', refused.status >= 300 && refused.status < 400 && (refused.location ?? '').includes('tab=orders'), `status ${refused.status} → ${refused.location}`)
      const theirs = await hit(`/cashier/pos?${q}&tab=orders`, asTaker)
      check('and Orders renders for them', theirs.status === 200, `status ${theirs.status}`)
      check('with only the tabs they hold', theirs.body.includes('>Orders<') && !theirs.body.includes('>Cashier<') && !theirs.body.includes('>Drawer<'))
    }
  } finally {
    await prisma.session.deleteMany({ where: { user: { restaurantId: restaurant.id } } })
    await prisma.auditLog.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.notification.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.staffRole.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
    await prisma.restaurant.delete({ where: { id: restaurant.id } })
    await prisma.$disconnect()
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
