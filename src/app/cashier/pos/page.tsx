import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { AutoRefresh } from '@/components/auto-refresh'
import { CashierBoard } from '@/features/cashier/components/cashier-board'
import { PosTabs } from '@/features/cashier/components/pos-tabs'
import { PosTerminal } from '@/features/cashier/components/pos-terminal'
import { posTabsFor, resolvePosTab } from '@/features/cashier/pos-tabs'
import { DrawerConsole } from '@/features/cashdrawer/components/drawer-console'
import { requireCashierSession } from '@/features/cashdrawer/gate'
import { getDrawerPageData } from '@/features/cashdrawer/queries'
import { flagForgottenDrawers } from '@/features/cashdrawer/service'
import { StationBranchPicker } from '@/features/dashboard/components/station-branch-picker'
import { StationExit } from '@/features/dashboard/components/station-exit'
import {
  branchNameFor,
  listStationBranches,
  scopeToOne,
  selectedBranch,
} from '@/features/dashboard/selected-branch'
import { ShiftPanel } from '@/features/shifts/components/shift-panel'
import { loadShiftPanel } from '@/features/shifts/panel-data'
import { listCustomerCategories } from '@/features/customers/service'
import { getPublicMenu } from '@/features/menu/queries'
import { getCashierQueue, readOptions } from '@/features/orders/queries'
import { readPaperWidths } from '@/features/printing/paper'
import { readReceiptFields } from '@/features/printing/receipt-fields'
import { localeForCurrency } from '@/lib/money'
import { PERMISSIONS, ROLE_LABELS, can } from '@/lib/rbac'
import { requirePageAnyPermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'POS' }

const TYPES = new Set(['COUNTER', 'TAKEAWAY', 'DELIVERY', 'DINE_IN'])

/** Rebuild the query string with a patch, so a redirect keeps the branch and the rest. */
function withParams(params: Record<string, string | string[] | undefined>, patch: Record<string, string>) {
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && !(key in patch)) next.set(key, value)
  }
  for (const [key, value] of Object.entries(patch)) next.set(key, value)
  return `/cashier/pos?${next.toString()}`
}

/**
 * The POS: one screen, three tabs (abc.md §8).
 *
 * ── Orders · Cashier · Drawer · Shift Handover ─────────────────────────────
 *
 * Taking an order, settling its bill and counting the drawer used to be three
 * URLs — `/cashier/pos`, `/cashier` and `/dashboard/cash-drawer` — with two
 * sidebar entries and no way to move between them without the sidebar. The
 * till is one counter; this is its one screen. Each tab is the screen it
 * always was, mounted inside a shared header; nothing about how an order is
 * priced, a payment taken or a drawer closed changes.
 *
 * ── Only the active tab's data loads ────────────────────────────────────────
 *
 * The cashier queue, the menu and the drawer history are three sets of
 * queries; one request runs one of them. Switching tabs is a navigation
 * (`?tab=`), so a bookmark, a refresh and the sidebar all land on the same
 * view, and the branch the till chose travels with it.
 *
 * ── Who sees which tab ──────────────────────────────────────────────────────
 *
 * `posTabsFor`: Orders for ORDER_CREATE, Cashier for PAYMENT_COLLECT, Drawer
 * for either drawer permission. A tab somebody may not open sends them to the
 * first they may — not a refusal, not a blank page — and the tab strip only
 * ever lists what they hold.
 */
export default async function PosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePageAnyPermission(
    [
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.PAYMENT_COLLECT,
      PERMISSIONS.CASH_DRAWER_OPERATE,
      PERMISSIONS.CASH_DRAWER_MANAGE,
    ],
    '/cashier/pos',
  )
  const params = await searchParams
  const tabs = posTabsFor(user)
  const tab = resolvePosTab(user, params.tab)
  if (!tab) redirect('/forbidden')
  // Asked for a tab they may not open: the URL says where they landed instead.
  if (typeof params.tab === 'string' && params.tab !== tab) redirect(withParams(params, { tab }))

  // Same gate as before: this screen takes payment, so the drawer that money
  // belongs to has to exist before the screen does. Managers are not gated.
  await requireCashierSession(user, withParams(params, { tab }))

  const restaurant = await requireRestaurant(user.restaurantId)

  /*
   * The till works at one location — see `StationBranchPicker`. This screen
   * RINGS UP orders and settles bills, so an ambiguous branch here does not
   * merely show the wrong tickets, it files new ones against whatever the
   * switcher happened to be on. A confined cashier gets their own site and
   * cannot widen it; an owner picks, and the pick keeps the tab.
   */
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)
  if (!branchId) {
    const choices = await listStationBranches(user)
    if (choices.length > 1) {
      return (
        <StationBranchPicker
          title="POS"
          description="Which counter is this screen for? Its menu, its prices, its tables and its bills."
          branches={choices}
          basePath="/cashier/pos"
          query={{ tab }}
        />
      )
    }
    if (choices.length === 1) redirect(withParams(params, { tab, branch: choices[0].id }))
  }

  const branchName = await branchNameFor(user.restaurantId, branchId)
  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const receipt = {
    name: restaurant.name,
    currency: restaurant.currency,
    locale,
    timeZone: restaurant.timezone,
    taxLabel: restaurant.taxLabel,
    logoUrl: restaurant.logoUrl,
    fields: readReceiptFields(restaurant.receiptConfig),
    // Paper size the owner chose in Settings — receipts printed at the wrong
    // width waste a third of an 80 mm roll, or overflow a 58 mm one.
    paper: readPaperWidths(restaurant.printerConfig),
    addressLine: [restaurant.addressLine, restaurant.city].filter(Boolean).join(', ') || null,
    phone: restaurant.phone,
  }

  const header = (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">POS</h1>
        <p className="text-sm text-muted-foreground">
          {restaurant.name}
          {branchName ? ` · ${branchName}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <PosTabs tabs={tabs} active={tab} />
        <StationExit user={user} current="/cashier/pos" />
      </div>
    </header>
  )

  // ── Orders ────────────────────────────────────────────────────────────────
  if (tab === 'orders') {
    const [menu, tables, servers, customerCategories] = await Promise.all([
      getPublicMenu(user.restaurantId, restaurant.timezone, branchId),
      prisma.restaurantTable.findMany({
        where: { restaurantId: user.restaurantId, isActive: true, ...(branchId ? { branchId } : {}) },
        select: { id: true, number: true, area: true, status: true },
        orderBy: { number: 'asc' },
      }),
      // Anyone who works the floor or the till can be credited with a sale.
      prisma.user.findMany({
        where: {
          restaurantId: user.restaurantId, isActive: true, deletedAt: null,
          // Both spellings — the migration moved every row to POS, and a
          // restaurant that has not deployed it yet still has CASHIER rows
          // whose owner is standing at the till (staff.A.md §10).
          role: { in: ['WAITER', 'POS', 'CASHIER', 'MANAGER', 'OWNER', 'ADMIN'] },
        },
        select: { id: true, name: true, role: true },
        orderBy: { name: 'asc' },
      }),
      // The owner's customer categories, so Add customer at the till offers the
      // same choices as the customer screen (pro.A.md §1, §6).
      listCustomerCategories({ restaurantId: user.restaurantId }),
    ])

    // Lets the sidebar link straight into takeaway or delivery; an old
    // bookmark with ?type= keeps working.
    const raw = typeof params.type === 'string' ? params.type.toUpperCase() : ''
    const initialType = TYPES.has(raw) ? (raw as 'COUNTER' | 'TAKEAWAY' | 'DELIVERY' | 'DINE_IN') : 'COUNTER'

    return (
      <div className="mx-auto w-full max-w-7xl p-4 pb-24 lg:pb-4">
        {/*
          The menu on this screen is rendered on the server, so a dish added by
          the owner did not appear here until the cashier reloaded the browser.
          `catalog` and not `ops`: a till should notice a new dish, and should
          not be re-rendered every time the kitchen touches a ticket.
        */}
        <AutoRefresh scope="catalog" intervalMs={10000} />
        {header}
        <p className="mb-4 text-sm text-muted-foreground">
          Tap a dish to add it. Adjust quantity with − and +, then send it to the kitchen and
          print the bill.
        </p>
        <PosTerminal
          menu={menu}
          currency={restaurant.currency}
          initialType={initialType}
          // Where this till is standing. Without it the order took the branch
          // from the top-bar switcher, not from the counter being rung up at.
          branchId={branchId}
          restaurant={receipt}
          tables={tables.map((t) => ({ ...t, status: t.status as string }))}
          servers={servers.map((s) => ({ ...s, role: s.role as string }))}
          currentUserId={user.id}
          customerCategories={customerCategories.map((category) => ({
            id: category.id,
            name: category.name,
          }))}
        />
      </div>
    )
  }

  // ── Cashier ───────────────────────────────────────────────────────────────
  if (tab === 'cashier') {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const branchIds = branchId ? [branchId] : selection.branchIds

    const [menu, bills, tables, rewards, today, cashierCategories] = await Promise.all([
      // The till sells its own branch's menu at its own branch's prices.
      getPublicMenu(user.restaurantId, restaurant.timezone, branchId),
      getCashierQueue(user.restaurantId, branchIds),
      // The order dialog can take a dine-in now, and a dine-in needs a table.
      prisma.restaurantTable.findMany({
        where: { restaurantId: user.restaurantId, isActive: true, ...(branchId ? { branchId } : {}) },
        select: { id: true, number: true, area: true },
        orderBy: { number: 'asc' },
      }),
      // Loaded once for the screen rather than per bill (loyalty spec).
      restaurant.loyaltyEnabled
        ? prisma.loyaltyReward.findMany({
            where: {
              restaurantId: user.restaurantId,
              isActive: true,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            orderBy: [{ pointsCost: 'asc' }, { name: 'asc' }],
          })
        : Promise.resolve([]),
      prisma.payment.aggregate({
        where: {
          restaurantId: user.restaurantId,
          status: 'PAID',
          paidAt: { gte: startOfDay },
          // A payment reaches its branch through its order; without this the
          // till's "taken today" was the whole chain's takings.
          ...(branchIds ? { order: { branchId: { in: branchIds } } } : {}),
        },
        _sum: { amount: true },
        _count: true,
      }),
      // The owner's customer categories, so Add customer at the till offers
      // the same choices as the customer screen (pro.A.md §1, §6).
      listCustomerCategories({ restaurantId: user.restaurantId }),
    ])

    /*
     * One query for every account on the screen, rather than one per bill.
     * A till with thirty open tabs would otherwise make thirty round trips to
     * show a number beside each name.
     */
    const customerIds = [...new Set(bills.map((order) => order.customerId).filter((id): id is string => Boolean(id)))]
    const points = new Map(
      (customerIds.length
        ? await prisma.customer.findMany({
            where: { id: { in: customerIds }, restaurantId: user.restaurantId },
            // The category comes along so the till's customer block can show
            // it (pro.A.md §5) without a second round trip.
            select: { id: true, name: true, loyaltyPoints: true, category: { select: { name: true } } },
          })
        : []
      ).map((customer) => [customer.id, customer]),
    )


    return (
      <div className="mx-auto w-full max-w-7xl p-4 pb-24 lg:pb-4">
        {header}
        <CashierBoard
          embedded
          branchIds={branchIds}
          customerCategories={cashierCategories.map((category) => ({ id: category.id, name: category.name }))}
          branchName={branchName}
          menu={menu}
          startInTakeaway={params.mode === 'takeaway'}
          user={{ name: user.name, role: ROLE_LABELS[user.role] }}
          todayTotal={today._sum.amount ?? 0}
          todayCount={today._count}
          restaurant={receipt}
          tables={tables}
          // QR / online orders wait here for a yes or a no (abc.md §5).
          canAccept={can(user, PERMISSIONS.ORDER_ACCEPT)}
          initialBills={bills.map((order) => ({
            id: order.id,
            orderNumber: order.orderNumber,
            type: order.type as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY',
            channel: order.channel,
            status: order.status as 'PENDING',
            paymentStatus: order.paymentStatus,
            tableId: order.tableId,
            tableNumber: order.tableNumber ?? order.table?.number ?? null,
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            placedAt: order.placedAt.toISOString(),
            heldAt: order.heldAt ? order.heldAt.toISOString() : null,
            holdReason: order.holdReason,
            subtotal: order.subtotal,
            discountTotal: order.discountTotal + order.loyaltyDiscount,
            serviceCharge: order.serviceCharge,
            taxTotal: order.taxTotal,
            grandTotal: order.grandTotal,
            tipAmount: order.tipAmount,
            paidTotal: order.paidTotal,
            items: order.items.map((item) => ({
              id: item.id,
              name: item.name,
              optionsLabel: readOptions(item.options)
                .map((option) => option.name)
                .join(', '),
              quantity: item.quantity,
              lineTotal: item.lineTotal,
              discountAmount: item.discountAmount,
              discountReason: item.discountReason,
            })),
            // Every tender taken on this bill (pro.A.md §11).
            payments: order.payments
              .filter((payment) => payment.status === 'PAID' || payment.status === 'REFUNDED')
              .map((payment) => ({
                id: payment.id,
                method: payment.method,
                amount: payment.amount,
                paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
              })),
            customerId: order.customerId,
            customerCategory: points.get(order.customerId ?? '')?.category?.name ?? null,
            // Who the bill belongs to, so the till can show their points.
            loyalty: order.customerId
              ? {
                  customerId: order.customerId,
                  customerName: points.get(order.customerId)?.name ?? order.customerName,
                  points: points.get(order.customerId)?.loyaltyPoints ?? 0,
                }
              : null,
          }))}
          rewards={rewards.map((reward) => ({
            id: reward.id,
            name: reward.name,
            description: reward.description,
            pointsCost: reward.pointsCost,
            value: reward.value,
            minOrderAmount: reward.minOrderAmount,
            expiresAt: reward.expiresAt?.toISOString() ?? null,
          }))}
        />
      </div>
    )
  }

  // ── Shift ─────────────────────────────────────────────────────────────────
  /*
   * The same screen the dashboard mounts, on the till where the person
   * finishing a shift is actually standing (recorrection.md §2,
   * shifthandover.md "UI").
   *
   * It is the SAME component over the SAME loader — `ShiftPanel` over
   * `loadShiftPanel` — so there is one shift system with two doors onto it,
   * and a shift started or handed over here is the one the dashboard shows.
   * Nothing about the flow, its guards, its notifications or its audit trail
   * is re-implemented here.
   */
  if (tab === 'handover') {
    const panel = await loadShiftPanel({
      user,
      timeZone: restaurant.timezone,
      selection: branchId ? { ...selection, branchId, branchIds: [branchId] } : selection,
      searchParams: params,
    })

    return (
      <div className="mx-auto w-full max-w-7xl p-4 pb-24 lg:pb-4">
        <AutoRefresh intervalMs={15000} />
        {header}
        <p className="mb-4 text-sm text-muted-foreground">
          Your shift, and the handover when it ends — with your till, if you have one. Whoever takes
          over sees the same summary and accepts or declines it on their own screen.
        </p>
        <ShiftPanel
          data={panel}
          viewerId={user.id}
          viewerName={user.name}
          currency={restaurant.currency}
          locale={locale}
        />
      </div>
    )
  }

  // ── Drawer ────────────────────────────────────────────────────────────────
  /*
   * The forgotten-drawer check runs on read because this deployment has no
   * scheduler; failure is swallowed because a broken notification must never
   * cost anybody the drawer screen. Same as `/dashboard/cash-drawer`, which
   * stays for managers reconciling the day across locations.
   */
  if (can(user, PERMISSIONS.CASH_DRAWER_MANAGE)) {
    await flagForgottenDrawers({ restaurantId: user.restaurantId, timezone: restaurant.timezone }).catch(() => {})
  }
  const drawer = await getDrawerPageData({
    restaurantId: user.restaurantId,
    branchId,
    branchIds: selection.branchIds,
    userId: user.id,
    currency: restaurant.currency,
    canReview: can(user, PERMISSIONS.CASH_VARIANCE_REVIEW),
    canSeeAll: can(user, PERMISSIONS.CASH_DRAWER_MANAGE),
    canApprovePetty: can(user, PERMISSIONS.PETTY_CASH_APPROVE),
    // Opening a till is its own permission now (staff.A.md §6).
    canOpen: can(user, PERMISSIONS.POS_OPEN_DRAWER),
  })

  return (
    <div className="mx-auto w-full max-w-7xl p-4 pb-24 lg:pb-4">
      {header}
      <p className="mb-4 text-sm text-muted-foreground">
        Open with a float, log cash in and out, and close against a physical count.
      </p>
      <DrawerConsole data={drawer} />
    </div>
  )
}
