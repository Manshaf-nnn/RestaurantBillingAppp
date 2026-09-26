import {
  MonitorDot,
  BarChart3,
  ChefHat,
  ClipboardList,
  Coins,
  FileText,
  HandPlatter,
  Landmark,
  LayoutDashboard,
  ListOrdered,
  Package,
  QrCode,
  ScanLine,
  ScrollText,
  Settings,
  ShieldCheck,
  Smile,
  Sparkles,
  Star,
  Ticket,
  Truck,
  UsersRound,
  Utensils,
  Wallet,
  ClipboardCheck,
  Trash2,
  CalendarClock,
  Scale,
  Building2,
  ArrowLeftRight,
  Factory,
  TrendingUp,
  PiggyBank,
  UserSearch,
  BadgeCheck,
  ListTodo,
  PackageCheck,
  KeyRound,
  Calculator,
  Gauge,
} from 'lucide-react'

import {
  PERMISSIONS,
  landingFor,
  permissionsFor,
  type Permission,
  type PermissionSubject,
} from '@/lib/rbac'

export interface NavItem {
  href: string
  label: string
  icon: typeof LayoutDashboard
  permission: Permission
  /**
   * Further permissions any ONE of which also shows the entry (abc.md §8):
   * the POS is a shell whose tabs are gated separately, so somebody who may
   * collect payment but not take orders still needs the door.
   */
  anyOf?: Permission[]
  /**
   * Roles the EDGE lets through to this href, when it is not open to everyone.
   *
   * Permissions decide what a page shows; `middleware.ts` decides who reaches
   * the shell at all, and the two are different lists. A waiter holds
   * `ORDER_CREATE`, so the permission filter below showed them the POS — and
   * `ROLE_ALLOWED['/cashier']` in `middleware.ts` does not include WAITER, so
   * clicking it bounced them to /forbidden. A sidebar entry that leads
   * somewhere the edge refuses is worse than a missing one.
   *
   * Set this ONLY as a literal mirror of the matching `ROLE_ALLOWED` entry in
   * `src/middleware.ts`, which stays the source of truth. It narrows and never
   * widens: it cannot grant anything the permission filter has not already
   * granted. `role-assignment-test.ts` checks the two agree.
   */
  roles?: string[]
  exact?: boolean
  /**
   * Other sidebar entries this one cannot work without, by href.
   *
   * The role builder ticks them for you and will not let them be unticked
   * while this entry is on; the server closes a saved permission list over
   * the same declarations (`withRequiredPermissions`), so a role that shows
   * POS and hides Payment details cannot be stored however the request was
   * made. Declared here, on the entry, because the sidebar is the one list
   * of modules an owner is choosing from — a second list of "what needs
   * what" kept anywhere else would drift from it.
   *
   * Only for a dependency the CODE has: a screen this one sends people to,
   * or an action it calls, that is guarded by the other entry's permission.
   * "These usually go together" is a template's job, not this field's.
   */
  requires?: string[]
  /**
   * What ticking this entry in the role builder switches on, when opening
   * the screen is not the same as being able to use it. Defaults to
   * `[permission]`, which is right for every plain page. The POS is the
   * exception: it is a shell whose tabs are gated one by one, so a role that
   * holds only `order.create` gets a till that can take an order and not the
   * money for it.
   */
  grants?: Permission[]
}

export interface NavSection {
  title: string
  items: NavItem[]
}

/** The dashboard sidebar. Items are filtered by the viewer's permissions. */
export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [
      {
        href: '/dashboard',
        label: 'Dashboard',
        icon: LayoutDashboard,
        permission: PERMISSIONS.DASHBOARD_VIEW,
        exact: true,
      },
      {
        /*
         * The owner's view (smart.md): health score, what needs review, the
         * nine numbers with "Why is this number?", and the money trace. Guarded
         * by the accounting permission on purpose — it shows profit.
         */
        href: '/dashboard/insights',
        label: 'Command Center',
        icon: Gauge,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        /*
         * High in the list on purpose. A branch manager signing in should see
         * what the owner has asked of them before they see anything else — an
         * instruction buried under Reports is an instruction nobody reads.
         */
        href: '/dashboard/tasks',
        label: 'Things to do',
        icon: ListTodo,
        permission: PERMISSIONS.TASKS_VIEW,
      },
      {
        href: '/dashboard/analytics',
        label: 'Analytics',
        icon: BarChart3,
        permission: PERMISSIONS.ANALYTICS_VIEW,
      },
      {
        href: '/dashboard/cash-drawer',
        label: 'Cash drawer',
        icon: Wallet,
        permission: PERMISSIONS.CASH_DRAWER_OPERATE,
      },
      /*
       * Petty cash has no entry of its own any more. The tin is a field on the
       * drawer row, so it is managed on the Cash drawer screen; the old page
       * survives as a deep link from there for history and filters.
       */
      {
        href: '/dashboard/locations',
        label: 'Locations',
        icon: Building2,
        permission: PERMISSIONS.BRANCH_VIEW,
      },
      {
        href: '/dashboard/transfers',
        label: 'Transfers',
        icon: ArrowLeftRight,
        permission: PERMISSIONS.TRANSFER_VIEW,
      },
      {
        href: '/dashboard/production',
        label: 'Kitchen Production',
        icon: Factory,
        permission: PERMISSIONS.PRODUCTION_VIEW,
      },
      {
        href: '/dashboard/live',
        label: 'Live floor',
        icon: MonitorDot,
        permission: PERMISSIONS.DASHBOARD_LIVE,
      },
      {
        href: '/dashboard/approvals',
        label: 'Approvals',
        icon: ShieldCheck,
        permission: PERMISSIONS.APPROVALS_VIEW,
      },
      {
        href: '/dashboard/handover',
        label: 'Shift',
        icon: ClipboardList,
        permission: PERMISSIONS.HANDOVER_VIEW,
      },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/dashboard/orders', label: 'Orders', icon: ListOrdered, permission: PERMISSIONS.ORDER_VIEW },
      { href: '/dashboard/invoices', label: 'Invoices', icon: ListOrdered, permission: PERMISSIONS.INVOICE_VIEW },
      { href: '/dashboard/tables', label: 'Tables', icon: ClipboardList, permission: PERMISSIONS.TABLE_VIEW },
      {
        href: '/dashboard/reservations',
        label: 'Reservations',
        icon: FileText,
        permission: PERMISSIONS.RESERVATION_MANAGE,
      },
      {
        href: '/kitchen',
        label: 'Kitchen display',
        icon: ChefHat,
        permission: PERMISSIONS.KITCHEN_VIEW,
        // A literal mirror of ROLE_ALLOWED['/kitchen'] in `src/middleware.ts`.
        // POS carried its mirror and this did not, so a role built on POS and
        // handed `kitchen.view` saw a Kitchen display entry that bounced to
        // /forbidden — the exact shape `NavItem.roles` exists to prevent.
        roles: ['OWNER', 'MANAGER', 'ADMIN', 'KITCHEN'],
      },
      /*
       * Beside the kitchen display, because that is what it configures.
       *
       * It had no entry at all — the only way in was a link on a location's
       * page — and with no sections created the menu has nothing to route to
       * and the kitchen has nothing to route with. Everything else in this
       * feature depends on it, so it belongs where it can be found.
       */
      {
        href: '/dashboard/kitchen-stations',
        label: 'Kitchen sections',
        icon: Utensils,
        permission: PERMISSIONS.KITCHEN_STATION_VIEW,
      },
      {
        href: '/waiter',
        label: 'Waiter station',
        icon: HandPlatter,
        permission: PERMISSIONS.WAITER_VIEW,
        // A literal mirror of ROLE_ALLOWED['/waiter'] in `src/middleware.ts`.
        roles: ['OWNER', 'MANAGER', 'ADMIN', 'WAITER'],
      },
      /*
       * One entry, because there was only ever one screen.
       *
       * "New order", "Takeaway" and "Delivery" all pointed at /cashier/pos and
       * differed by a `?type=` the page reads once to seed a useState — while
       * the screen itself carries Dine in / Counter / Takeaway / Delivery chips
       * across the top. Three menu entries for a control already on the page.
       *
       * Two live bugs went with the duplication, and both disappear here rather
       * than needing a fix:
       *
       *   Takeaway and Delivery could never highlight. The active check below
       *   compares `usePathname()`, which excludes the query string, so on
       *   /cashier/pos?type=TAKEAWAY it was always "New order" that lit up.
       *
       *   `?type=` was dropped whenever the till had not chosen a branch yet —
       *   the branch redirect and the station picker both rebuild the URL as
       *   /cashier/pos?branch=…, so "Takeaway" landed you on Counter.
       *
       * The page still reads `?type=`, so an old bookmark keeps working.
       */
      /*
       * One POS entry (abc.md §8). The till is a tab inside it, so the old
       * separate "Cashier" entry is gone — and so is the case where both lit
       * up at once. Whoever may take orders OR collect payment OR run a
       * drawer has somewhere to click; the shell shows them their tabs.
       */
      {
        href: '/cashier/pos',
        label: 'POS',
        icon: HandPlatter,
        permission: PERMISSIONS.ORDER_CREATE,
        anyOf: [PERMISSIONS.PAYMENT_COLLECT, PERMISSIONS.CASH_DRAWER_OPERATE, PERMISSIONS.CASH_DRAWER_MANAGE],
        /*
         * A literal mirror of ROLE_ALLOWED['/cashier'] in `src/middleware.ts`.
         *
         * WAITER holds ORDER_CREATE and so passed the permission filter, but
         * the edge refuses them — so waiters saw a POS link that bounced them
         * to /forbidden. They take orders at /waiter now, which is the right
         * door and the only one they need.
         */
        roles: ['OWNER', 'MANAGER', 'ADMIN', 'POS', 'CASHIER'],
        /*
         * A till needs Payment details (bank.md). Guests declare bank
         * transfers and somebody at the till confirms them on that screen —
         * it "answers to PAYMENT_COLLECT, which a cashier holds, because
         * confirming transfers is a till job", and `account.view` was split
         * from `payment.collect` for exactly that reason. A POS role without
         * it can take a transfer and never mark it received.
         */
        requires: ['/dashboard/payment-details'],
        /*
         * The till as a working till: orders in, money taken, online orders
         * answered. Not the drawer — that is its own entry below, because an
         * owner may want a person who serves without ever holding a float —
         * and not discounts or refunds, which stay a deliberate grant.
         */
        grants: [
          PERMISSIONS.ORDER_CREATE,
          PERMISSIONS.ORDER_UPDATE_STATUS,
          PERMISSIONS.PAYMENT_VIEW,
          PERMISSIONS.PAYMENT_COLLECT,
          PERMISSIONS.ORDER_ACCEPT,
        ],
      },
      {
        href: '/dashboard/payment-details',
        label: 'Payment details',
        icon: Landmark,
        permission: PERMISSIONS.ACCOUNT_VIEW,
      },
    ],
  },
  {
    title: 'Menu',
    items: [
      // Categories are a fixed set (see default-categories.ts) — no management
      // screen; owners just pick one when adding a dish.
      { href: '/dashboard/menu', label: 'Menu items', icon: Utensils, permission: PERMISSIONS.MENU_VIEW },
      {
        href: '/dashboard/recipes',
        label: 'Recipes',
        icon: ChefHat,
        permission: PERMISSIONS.RECIPE_VIEW,
      },
      {
        href: '/dashboard/menu/import',
        label: 'Add your menu',
        icon: Sparkles,
        permission: PERMISSIONS.MENU_MANAGE,
        // It writes into the menu list and returns you to it, and that list
        // opens on `menu.view`.
        requires: ['/dashboard/menu'],
      },
      { href: '/dashboard/loyalty', label: 'Loyalty', icon: Sparkles, permission: PERMISSIONS.LOYALTY_VIEW },
      { href: '/dashboard/coupons', label: 'Coupons', icon: Ticket, permission: PERMISSIONS.COUPON_MANAGE },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { href: '/dashboard/inventory', label: 'Stock', icon: Package, permission: PERMISSIONS.INVENTORY_VIEW },
      { href: '/dashboard/inventory/ledger', label: 'Stock ledger', icon: Package, permission: PERMISSIONS.INVENTORY_VIEW },
      {
        href: '/dashboard/inventory/counts',
        label: 'Stock counts',
        icon: ClipboardCheck,
        permission: PERMISSIONS.INVENTORY_COUNT,
      },
      {
        href: '/dashboard/inventory/adjustments',
        label: 'Adjustments',
        icon: Scale,
        permission: PERMISSIONS.INVENTORY_ADJUST_REQUEST,
      },
      {
        href: '/dashboard/inventory/wastage',
        label: 'Wastage',
        icon: Trash2,
        permission: PERMISSIONS.INVENTORY_WASTAGE,
      },
      {
        href: '/dashboard/inventory/expiry',
        label: 'Expiry',
        icon: CalendarClock,
        permission: PERMISSIONS.INVENTORY_EXPIRY_VIEW,
      },
      {
        href: '/dashboard/reports/variance',
        label: 'Stock variance',
        icon: Scale,
        permission: PERMISSIONS.REPORT_VARIANCE,
      },
      {
        href: '/dashboard/reports/reconciliation',
        label: 'Reconciliation',
        icon: Scale,
        permission: PERMISSIONS.REPORT_RECONCILIATION,
      },
      {
        href: '/dashboard/reports/daily-close',
        label: 'Daily close',
        icon: Scale,
        permission: PERMISSIONS.REPORT_VIEW,
      },
      {
        // Under Inventory, because it answers a question asked while adding an
        // item: "why isn't my category in this list".
        href: '/dashboard/inventory/setup',
        label: 'Units & categories',
        icon: Scale,
        permission: PERMISSIONS.INVENTORY_VIEW,
      },
      { href: '/dashboard/suppliers', label: 'Suppliers', icon: Truck, permission: PERMISSIONS.SUPPLIER_VIEW },
      { href: '/dashboard/purchases', label: 'Purchasing', icon: Truck, permission: PERMISSIONS.PURCHASE_VIEW },
      {
        // The storekeeper's screen. Receiving always worked and lived at the
        // bottom of an individual order, so the only way in was to already know
        // the order number.
        href: '/dashboard/purchases/receive',
        label: 'Goods received',
        icon: PackageCheck,
        permission: PERMISSIONS.PURCHASE_RECEIVE,
        // Every delivery on it opens its purchase order, and the order page
        // is guarded by `purchase.view`.
        requires: ['/dashboard/purchases'],
      },
    ],
  },
  {
    title: 'People',
    items: [
      {
        href: '/dashboard/customers',
        label: 'Customers',
        icon: UsersRound,
        permission: PERMISSIONS.CUSTOMER_VIEW,
      },
      {
        href: '/dashboard/customers/analytics',
        label: 'Customer insights',
        icon: UserSearch,
        permission: PERMISSIONS.CUSTOMER_ANALYTICS,
        // Each row opens the guest's own page, which is `customer.view`.
        requires: ['/dashboard/customers'],
      },
      { href: '/dashboard/staff', label: 'Staff', icon: ShieldCheck, permission: PERMISSIONS.STAFF_VIEW },
      {
        // The rota: who works which shift, where (shifthandover.md §1–2).
        href: '/dashboard/shifts',
        label: 'Shifts',
        icon: CalendarClock,
        permission: PERMISSIONS.SHIFT_ASSIGN,
        anyOf: [PERMISSIONS.SHIFT_ASSIGN, PERMISSIONS.SHIFT_TEMPLATE_MANAGE],
      },
      {
        // Next to Staff, because "who works here" and "what may they do" are
        // the same question asked twice.
        href: '/dashboard/roles',
        label: 'Roles & access',
        icon: KeyRound,
        permission: PERMISSIONS.STAFF_MANAGE,
        // Its second tab IS the Staff screen, and assigning a role means
        // choosing from the staff list — both `staff.view`.
        requires: ['/dashboard/staff'],
      },
      {
        href: '/dashboard/staff/codes',
        label: 'Staff codes',
        icon: BadgeCheck,
        /*
         * `staff.manage`, because that is what the page asks for: "reading a
         * credential is the same power as issuing it". This entry said
         * `staff.view`, so a role with Staff on and Manage off was offered a
         * link that ended at /forbidden — and, in the role builder, a tab that
         * could be ticked and never opened.
         */
        permission: PERMISSIONS.STAFF_MANAGE,
        requires: ['/dashboard/staff'],
      },
      { href: '/dashboard/reviews', label: 'Reviews', icon: Star, permission: PERMISSIONS.REVIEW_MANAGE },
      { href: '/dashboard/feedback', label: 'Feedback', icon: Smile, permission: PERMISSIONS.FEEDBACK_VIEW },
    ],
  },
  {
    title: 'Accounting',
    items: [
      {
        href: '/dashboard/accounting',
        label: 'Overview',
        icon: LayoutDashboard,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
        exact: true,
      },
      {
        href: '/dashboard/accounting/payments',
        label: 'Money out',
        icon: Wallet,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        href: '/dashboard/accounting/approvals',
        label: 'Approvals',
        icon: ClipboardCheck,
        permission: PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE,
      },
      {
        href: '/dashboard/accounting/expenses',
        label: 'Expenses',
        icon: ScrollText,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        href: '/dashboard/accounting/payables',
        label: 'Payables',
        icon: Landmark,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        href: '/dashboard/accounting/reconciliation',
        label: 'Checks',
        icon: Scale,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        href: '/dashboard/accounting/ledger',
        label: 'Ledger',
        icon: ScrollText,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        href: '/dashboard/accounting/reports',
        label: 'Reports',
        icon: BarChart3,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
        exact: true,
      },
      {
        href: '/dashboard/accounting/close',
        label: 'Close month',
        icon: CalendarClock,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
      {
        href: '/dashboard/accounting/tools',
        label: 'Tools',
        icon: Calculator,
        permission: PERMISSIONS.ACCOUNTING_VIEW,
      },
    ],
  },
  {
    title: 'Back office',
    items: [
      { href: '/dashboard/reports', label: 'Reports', icon: BarChart3, permission: PERMISSIONS.REPORT_VIEW },
      { href: '/dashboard/reports/sales', label: 'Sales report', icon: TrendingUp, permission: PERMISSIONS.REPORT_SALES },
      { href: '/dashboard/reports/profit', label: 'Gross profit', icon: PiggyBank, permission: PERMISSIONS.REPORT_PROFIT },
      { href: '/dashboard/reports/inventory', label: 'Inventory report', icon: Package, permission: PERMISSIONS.REPORT_INVENTORY },
      { href: '/dashboard/reports/purchasing', label: 'Purchasing report', icon: Truck, permission: PERMISSIONS.REPORT_PURCHASING },
      { href: '/dashboard/reports/cash-drawer', label: 'Cash drawer report', icon: Wallet, permission: PERMISSIONS.REPORT_CASH },
      { href: '/dashboard/reports/petty-cash', label: 'Petty cash report', icon: Coins, permission: PERMISSIONS.REPORT_CASH },
      { href: '/dashboard/qr', label: 'QR code', icon: QrCode, permission: PERMISSIONS.QR_VIEW },
    /*
     * ar.md §1 — what guests meet when they scan, as opposed to the printed
     * codes above. Its own row because an owner looking for "what does the
     * menu ask my customers" is not looking for a print sheet.
     */
    { href: '/dashboard/qr/experiences', label: 'QR menus', icon: ScanLine, permission: PERMISSIONS.QR_VIEW },
      {
        href: '/dashboard/audit-logs',
        label: 'Audit log',
        icon: ScrollText,
        permission: PERMISSIONS.AUDIT_VIEW,
      },
      { href: '/dashboard/settings', label: 'Settings', icon: Settings, permission: PERMISSIONS.SETTINGS_VIEW },

      {
        href: '/dashboard/links',
        label: 'Share links',
        icon: UsersRound,
        permission: PERMISSIONS.STAFF_MANAGE,
        // A personal link is made for a member of staff picked from the list.
        requires: ['/dashboard/staff'],
      },
    ],
  },
]

/**
 * The sidebar this person actually gets.
 *
 * One implementation, because there are now three readers: the shell that
 * renders it, the station screens that decide whether a "Dashboard" control is
 * worth showing at all, and `/forbidden`, which needs somewhere real to send
 * people. A refused page that offers a way back to another refused page is a
 * loop, and that is exactly what it offered before.
 *
 * `permissionsFor` is the same function the server guards use, so what the
 * sidebar shows and what the page allows cannot disagree.
 */
export function visibleSections(user: PermissionSubject): NavSection[] {
  const granted = permissionsFor(user)
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) =>
        (granted.has(item.permission) || (item.anyOf ?? []).some((p) => granted.has(p))) &&
        // And the edge has to let them in. See `NavItem.roles`.
        (!item.roles || item.roles.includes(user.role)),
    ),
  })).filter((section) => section.items.length > 0)
}

/** Every item they may open, flattened, in sidebar order. */
export function reachableNavItems(user: PermissionSubject): NavItem[] {
  return visibleSections(user).flatMap((section) => section.items)
}

/**
 * Somewhere this person can actually go.
 *
 * Their landing page first, but only if they hold the permission that guards
 * it — a custom role built on Waiter without `waiter.view` lands on `/waiter`,
 * is refused, and used to be handed a button back to `/waiter`. Otherwise the
 * first thing in their sidebar. `null` when there is genuinely nothing, which
 * is a real state worth naming rather than papering over with `/dashboard`.
 */
export function firstReachablePath(user: PermissionSubject): string | null {
  const items = reachableNavItems(user)
  const home = landingFor(user.role)
  // A landing page may name a tab (`?tab=`); the entry that owns it is the path.
  const homePath = home.split('?')[0]
  if (items.some((item) => item.href === homePath)) return home
  return items[0]?.href ?? null
}

/*
 * ── Favorites, Recent and page search ───────────────────────────────────────
 *
 * All of it lives here, beside `visibleSections`, because every one of these
 * answers is "which of the sidebar's own entries applies", and there is exactly
 * one list of those. sidebar.md §7 asks for no second permission system; the
 * way to honour that is for none of what follows to look at a permission
 * directly. Each helper composes `reachableNavItems`, so whatever the server
 * guards would refuse is already absent before these functions see it.
 */

/**
 * How many shortcuts one person may pin.
 *
 * Twelve, because a favorites list longer than the screen is a second sidebar,
 * and the whole point of §10 is opening TableFlow and seeing today's work
 * without scrolling. The cap is enforced on write, so a longer list cannot be
 * saved rather than being saved and then truncated on the way out.
 */
export const MAX_FAVORITES = 12

/** How many recently-visited pages are kept. §3: "keep only a small number." */
export const MAX_RECENT = 5

/** Every href the sidebar declares, for rejecting anything invented. */
const KNOWN_HREFS = new Set(NAV_SECTIONS.flatMap((section) => section.items.map((i) => i.href)))

/** Is this a real sidebar destination at all? */
export function isNavHref(href: string): boolean {
  return KNOWN_HREFS.has(href)
}

/** href → item, for the ones this person may open. Built once per caller. */
function reachableByHref(user: PermissionSubject): Map<string, NavItem> {
  return new Map(reachableNavItems(user).map((item) => [item.href, item]))
}

/**
 * Turn a saved list of hrefs into the sidebar entries this person may open.
 *
 * The one function behind both Favorites and Recent, because both are the same
 * problem: a list of strings somebody's browser or database is holding, which
 * has to be re-checked against what they are allowed to see *now*.
 *
 * Anything they may not open is dropped silently, and that is the whole of
 * sidebar.md §7 — take `inventory.view` away and Stock leaves their Favorites
 * on their next page load, with no migration, no cleanup job and no second
 * place where permissions are decided. A dropped href stays in the column: it
 * is inert there, and it comes back if the permission does, which is kinder
 * than deleting a list somebody arranged because their role changed for an
 * afternoon.
 */
export function resolveNavHrefs(
  user: PermissionSubject,
  hrefs: string[],
  limit: number,
): NavItem[] {
  const reachable = reachableByHref(user)
  const seen = new Set<string>()
  const items: NavItem[] = []

  for (const href of hrefs) {
    if (items.length >= limit) break
    if (seen.has(href)) continue
    const item = reachable.get(href)
    if (!item) continue
    seen.add(href)
    items.push(item)
  }

  return items
}

/** The shortcuts this person gets, in the order they arranged them. */
export function favoriteItems(user: PermissionSubject, hrefs: string[]): NavItem[] {
  return resolveNavHrefs(user, hrefs, MAX_FAVORITES)
}

/** The pages they opened last, most recent first. */
export function recentItems(user: PermissionSubject, hrefs: string[]): NavItem[] {
  return resolveNavHrefs(user, hrefs, MAX_RECENT)
}

/**
 * The same filter, applied on the way in.
 *
 * Deduped, capped and permission-checked before anything is written, so the
 * column cannot hold a shortcut to a page this person may not open even if the
 * request was hand-made. On the server the subject carries
 * `availablePermissions` as well, so this also refuses a page the restaurant's
 * plan does not include.
 */
export function sanitiseFavorites(user: PermissionSubject, hrefs: string[]): string[] {
  return favoriteItems(user, hrefs).map((item) => item.href)
}

/**
 * Which sidebar entry owns this pathname — the question "Recent" has to answer.
 *
 * Longest match wins, and that is the entire subtlety. Several entries are
 * prefixes of others: `/dashboard/inventory` is a prefix of
 * `/dashboard/inventory/counts`, `/dashboard/purchases` of
 * `/dashboard/purchases/receive`, `/dashboard/reports` of six report screens.
 * Take the first entry that matches and Recent fills with "Stock" and "Reports"
 * however many different screens somebody actually opened. Sorting by href
 * length first gives the most specific entry, which is the one whose name the
 * person would use for where they are.
 *
 * `exact` entries still match only themselves, the same rule the sidebar
 * highlight uses — that is what keeps `/dashboard` from claiming the whole
 * product and `/cashier` from claiming `/cashier/pos`.
 */
export function navItemForPath(user: PermissionSubject, pathname: string): NavItem | null {
  const candidates = reachableNavItems(user)
    .filter((item) => {
      // A nav href may carry a query string of its own; compare paths only.
      const path = item.href.split('?')[0]
      if (item.exact) return pathname === path
      return pathname === path || pathname.startsWith(`${path}/`)
    })
    .sort((a, b) => b.href.length - a.href.length)

  return candidates[0] ?? null
}

/**
 * Pages matching what somebody typed (sidebar.md §4).
 *
 * Searches the section title as well as the label, so "inventory" finds Stock
 * and Wastage — entries filed under Inventory whose own names never say the
 * word. Case-insensitive, and substring rather than prefix, because people
 * search for "waste" and mean "Wastage".
 *
 * There is no permission check in here and there must not be: the list it walks
 * is already `visibleSections`, so "search must respect RBAC" is true by
 * construction rather than by a second filter somebody has to remember.
 */
export function searchNavItems(
  user: PermissionSubject,
  term: string,
): Array<{ item: NavItem; section: string }> {
  const needle = term.trim().toLowerCase()
  if (!needle) return []

  const matches: Array<{ item: NavItem; section: string }> = []
  for (const section of visibleSections(user)) {
    const sectionMatches = section.title.toLowerCase().includes(needle)
    for (const item of section.items) {
      if (sectionMatches || item.label.toLowerCase().includes(needle)) {
        matches.push({ item, section: section.title })
      }
    }
  }

  /*
   * A label that starts with the term first. Typing "stock" should offer Stock
   * before Stock ledger, and both before "Kitchen sections" — which matches only
   * because its section is called Inventory, and is the least likely thing meant.
   */
  return matches.sort((a, b) => rank(a.item.label, needle) - rank(b.item.label, needle))
}

function rank(label: string, needle: string): number {
  const lower = label.toLowerCase()
  if (lower === needle) return 0
  if (lower.startsWith(needle)) return 1
  if (lower.includes(needle)) return 2
  return 3
}
