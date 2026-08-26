import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { PosTerminal } from '@/features/cashier/components/pos-terminal'
import { readPaperWidths } from '@/features/printing/paper'
import { getPublicMenu } from '@/features/menu/queries'
import {
  listStationBranches,
  scopeToOne,
  selectedBranch,
} from '@/features/dashboard/selected-branch'
import { StationBranchPicker } from '@/features/dashboard/components/station-branch-picker'
import { requireCashierSession } from '@/features/cashdrawer/gate'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { AutoRefresh } from '@/components/auto-refresh'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'POS' }

const TYPES = new Set(['COUNTER', 'TAKEAWAY', 'DELIVERY', 'DINE_IN'])

export default async function PosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ORDER_CREATE, '/cashier/pos')

  // Same gate as /cashier: this screen takes payment, so the drawer that money
  // belongs to has to exist before the screen does.
  await requireCashierSession(user, '/cashier/pos')

  const restaurant = await requireRestaurant(user.restaurantId)

  /*
   * The till works at one location.
   *
   * The MENU was already scoped by `user.branchId` and the TABLE LIST was not,
   * so the same screen sold Kandy's menu against a list containing Colombo's
   * tables — and picking one filed the order at Colombo, because the table
   * decides the branch. For an owner, whose `branchId` is null, the menu was
   * the restaurant's base prices and the list was every table in the business.
   *
   * `selectedBranch` answers for both: a confined cashier gets their own site
   * and cannot widen it; an owner gets whatever the top bar is showing.
   */
  const selection = await selectedBranch(user, await searchParams)
  const branchId = scopeToOne(selection)

  /*
   * This screen RINGS UP orders, so it cannot be ambiguous about where.
   *
   * With no branch chosen, the table list showed every branch's tables and the
   * menu fell back to the restaurant's base prices — and the order that came
   * out landed on whatever `actingBranchId` resolved from the cookie. One
   * screen, three different answers about which location it was working at.
   */
  if (!branchId) {
    const choices = await listStationBranches(user)
    if (choices.length > 1) {
      return (
        <StationBranchPicker
          title="POS"
          description="Which counter are you ringing up at? Its menu, its prices and its tables."
          branches={choices}
          basePath="/cashier/pos"
        />
      )
    }
    if (choices.length === 1) redirect(`/cashier/pos?branch=${choices[0].id}`)
  }

  const [menu, tables, servers] = await Promise.all([
    getPublicMenu(user.restaurantId, restaurant.timezone, branchId),
    prisma.restaurantTable.findMany({
      where: {
        restaurantId: user.restaurantId,
        isActive: true,
        ...(branchId ? { branchId } : {}),
      },
      select: { id: true, number: true, area: true, status: true },
      orderBy: { number: 'asc' },
    }),
    // Anyone who works the floor or the till can be credited with a sale.
    prisma.user.findMany({
      where: {
        restaurantId: user.restaurantId, isActive: true, deletedAt: null,
        role: { in: ['WAITER', 'CASHIER', 'MANAGER', 'OWNER', 'ADMIN'] },
      },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
  ])

  // Lets the sidebar link straight into takeaway or delivery.
  const params = await searchParams
  const raw = typeof params.type === 'string' ? params.type.toUpperCase() : ''
  const initialType = TYPES.has(raw)
    ? (raw as 'COUNTER' | 'TAKEAWAY' | 'DELIVERY' | 'DINE_IN')
    : 'COUNTER'

  return (
    <div className="mx-auto w-full max-w-7xl p-4 pb-24 lg:pb-4">
      {/*
        The menu on this screen is rendered on the server, so a dish added by
        the owner did not appear here until the cashier reloaded the browser —
        the exact complaint this was built for. `catalog` and not `ops`: a till
        should notice a new dish, and should not be re-rendered every time the
        kitchen touches a ticket.
      */}
      <AutoRefresh scope="catalog" intervalMs={10000} />
      <header className="mb-4">
        <h1 className="text-xl font-semibold">POS</h1>
        <p className="text-sm text-muted-foreground">
          Tap a dish to add it. Adjust quantity with − and +, then send it to the kitchen and
          print the bill.
        </p>
      </header>
      <PosTerminal
        menu={menu}
        currency={restaurant.currency}
        initialType={initialType}
        /*
         * What a printed bill needs in its header. The same wiring the cashier
         * board has always used — see `app/cashier/page.tsx` — including the
         * 'en' → 'en-IN' locale coercion the other receipt call sites make, and
         * the owner's 58mm/80mm choice from Settings.
         */
        restaurant={{
          name: restaurant.name,
          currency: restaurant.currency,
          locale: restaurant.locale === 'en' ? 'en-IN' : restaurant.locale,
          taxLabel: restaurant.taxLabel,
          paper: readPaperWidths(restaurant.printerConfig),
          addressLine: [restaurant.addressLine, restaurant.city].filter(Boolean).join(', ') || null,
          phone: restaurant.phone,
        }}
        tables={tables.map((t) => ({ ...t, status: t.status as string }))}
        servers={servers.map((s) => ({ ...s, role: s.role as string }))}
        currentUserId={user.id}
      />
    </div>
  )
}
