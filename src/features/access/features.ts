import { PERMISSIONS, type Permission } from '@/lib/rbac'

/**
 * Every feature in the app, and every action each one allows.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * An owner building a role has to be shown *all available system features* and
 * be able to switch each one, and each action within it, on or off. That list
 * has to come from somewhere, and the four places that need it must agree:
 *
 *   1. the role builder, which renders it as a grid of switches
 *   2. the sidebar, which hides what is switched off
 *   3. the page guards, which refuse the URL of what is switched off
 *   4. `scripts/no-unguarded-feature-pages.ts`, which proves 2 and 3 cover
 *      every page that exists
 *
 * Four hand-maintained copies of a 50-row list would disagree within a month,
 * and the way they disagree is a screen that is hidden but reachable — the
 * exact shape of the `/dashboard/purchases/receive` bug this replaces, where
 * the sidebar hid it behind `purchase.receive` and the page itself asked only
 * for `purchase.view`.
 *
 * ── It is a re-presentation, not a new taxonomy ─────────────────────────────
 *
 * `PERMISSIONS` is already `area.action` — `inventory.view`, `purchase.approve`,
 * `transfer.dispatch`. So a feature is the area, an action is the verb, and
 * nothing new has to be invented or kept in sync with the permission list. A
 * role's stored `permissions` array is exactly the set of switches left on.
 *
 * ── Adding a page ───────────────────────────────────────────────────────────
 *
 * Put its route on the feature that owns it and guard the page with that
 * feature's permission. The static test fails the build otherwise, which is
 * the point: a page nobody registered is a page no role can be denied.
 */

/**
 * The verbs, in the order Rolelogic lists them.
 *
 * Not every feature has every verb — a report cannot be approved — so each
 * feature names the ones it actually has, and the grid renders only those.
 * Inventing a "Delete" switch that controls nothing teaches an owner that the
 * switches are decorative.
 */
export type ActionKey =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'approve'
  | 'reject'
  | 'cancel'
  | 'submit'
  | 'transfer'
  | 'receive'
  | 'export'
  | 'operate'

export const ACTION_LABELS: Record<ActionKey, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  approve: 'Approve',
  reject: 'Reject',
  cancel: 'Cancel',
  submit: 'Submit',
  transfer: 'Transfer',
  receive: 'Receive',
  export: 'Export',
  operate: 'Operate',
}

export interface FeatureAction {
  key: ActionKey
  /** Overrides {@link ACTION_LABELS} when the plain verb would be unclear. */
  label?: string
  permission: Permission
  /** Shown under the switch when the power is easy to underestimate. */
  hint?: string
}

export interface Feature {
  key: string
  label: string
  /** Matches the sidebar section, so the grid reads in the same order. */
  group: string
  /** What the switch means, for an owner who has not used the screen. */
  description: string
  actions: FeatureAction[]
  /**
   * The pages this feature owns. Prefix-matched, so a route listed here also
   * claims everything beneath it. Used by the static test to prove no page is
   * left unregistered.
   */
  routes: string[]
}

export const FEATURE_GROUPS = [
  'Overview',
  'Operations',
  'Menu',
  'Inventory',
  'People',
  'Back office',
] as const

export const FEATURES: Feature[] = [
  // ── Overview ──────────────────────────────────────────────────────────────
  {
    key: 'dashboard',
    label: 'Dashboard',
    group: 'Overview',
    description: 'The home screen: takings, orders and alerts for the period.',
    actions: [{ key: 'view', permission: PERMISSIONS.DASHBOARD_VIEW }],
    routes: ['/dashboard'],
  },
  {
    key: 'tasks',
    label: 'Things to do',
    group: 'Overview',
    description: 'Instructions the owner has left for this location.',
    actions: [{ key: 'view', permission: PERMISSIONS.TASKS_VIEW }],
    routes: ['/dashboard/tasks'],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    group: 'Overview',
    description: 'Trends, peak hours and staff performance.',
    actions: [{ key: 'view', permission: PERMISSIONS.ANALYTICS_VIEW }],
    routes: ['/dashboard/analytics'],
  },
  {
    key: 'approvals',
    label: 'Approvals',
    group: 'Overview',
    description: 'Requests waiting on somebody senior — refunds, discounts, adjustments.',
    actions: [
      { key: 'view', permission: PERMISSIONS.APPROVALS_VIEW },
      {
        key: 'approve',
        label: 'Decide',
        permission: PERMISSIONS.PURCHASE_APPROVE,
        hint: 'Lets them settle a request rather than only raise one.',
      },
    ],
    routes: ['/dashboard/approvals'],
  },
  {
    key: 'cashDrawer',
    label: 'Cash drawer',
    group: 'Overview',
    description: 'Opening float, cash in and out, and the close-of-shift count.',
    actions: [
      { key: 'operate', label: 'Operate own drawer', permission: PERMISSIONS.CASH_DRAWER_OPERATE },
      {
        key: 'approve',
        label: "See everyone's",
        permission: PERMISSIONS.CASH_DRAWER_MANAGE,
        hint: "Every drawer's variance, signing off a large one, and managing tills.",
      },
    ],
    routes: ['/dashboard/cash-drawer'],
  },
  {
    key: 'pettyCash',
    label: 'Petty cash',
    group: 'Overview',
    description: 'The small-expenses fund: raising a request, approving it, paying it.',
    actions: [
      { key: 'view', permission: PERMISSIONS.PETTY_CASH_VIEW },
      {
        key: 'create',
        label: 'Raise a request',
        permission: PERMISSIONS.PETTY_CASH_REQUEST,
      },
      {
        key: 'approve',
        label: 'Approve and pay',
        permission: PERMISSIONS.PETTY_CASH_APPROVE,
        hint: 'The control. Giving it to whoever can raise a request removes it.',
      },
    ],
    routes: ['/dashboard/petty-cash'],
  },
  {
    key: 'locations',
    label: 'Locations',
    group: 'Overview',
    description: 'Branches, warehouses and production houses.',
    actions: [
      { key: 'view', permission: PERMISSIONS.BRANCH_VIEW },
      { key: 'edit', label: 'Manage', permission: PERMISSIONS.BRANCH_MANAGE },
    ],
    routes: ['/dashboard/locations'],
  },
  {
    key: 'transfers',
    label: 'Stock transfers',
    group: 'Overview',
    description: 'Moving stock between locations.',
    actions: [
      { key: 'view', permission: PERMISSIONS.TRANSFER_VIEW },
      { key: 'create', label: 'Request', permission: PERMISSIONS.TRANSFER_REQUEST },
      { key: 'approve', permission: PERMISSIONS.TRANSFER_APPROVE },
      { key: 'transfer', label: 'Dispatch', permission: PERMISSIONS.TRANSFER_DISPATCH },
      { key: 'receive', permission: PERMISSIONS.TRANSFER_RECEIVE },
    ],
    routes: ['/dashboard/transfers'],
  },
  {
    key: 'production',
    label: 'Production',
    group: 'Overview',
    description: 'Making finished goods from raw materials.',
    actions: [
      { key: 'view', permission: PERMISSIONS.PRODUCTION_VIEW },
      { key: 'create', label: 'Manage', permission: PERMISSIONS.PRODUCTION_MANAGE },
      { key: 'approve', permission: PERMISSIONS.PRODUCTION_APPROVE },
    ],
    routes: ['/dashboard/production'],
  },
  {
    key: 'handover',
    label: 'Shift handover',
    group: 'Overview',
    description: 'Notes passed from one shift to the next.',
    actions: [{ key: 'view', permission: PERMISSIONS.HANDOVER_VIEW }],
    routes: ['/dashboard/handover'],
  },

  // ── Operations ────────────────────────────────────────────────────────────
  {
    key: 'orders',
    label: 'Orders',
    group: 'Operations',
    description: 'Every order taken, at the table, counter or QR code.',
    actions: [
      { key: 'view', permission: PERMISSIONS.ORDER_VIEW },
      { key: 'create', permission: PERMISSIONS.ORDER_CREATE },
      { key: 'edit', label: 'Change status', permission: PERMISSIONS.ORDER_UPDATE_STATUS },
      { key: 'cancel', permission: PERMISSIONS.ORDER_CANCEL },
    ],
    routes: ['/dashboard/orders'],
  },
  {
    key: 'tables',
    label: 'Tables',
    group: 'Operations',
    description: 'The floor plan and each table’s status.',
    actions: [
      { key: 'view', permission: PERMISSIONS.TABLE_VIEW },
      { key: 'edit', label: 'Manage', permission: PERMISSIONS.TABLE_MANAGE },
    ],
    routes: ['/dashboard/tables'],
  },
  {
    key: 'reservations',
    label: 'Reservations',
    group: 'Operations',
    description: 'Bookings and the guests expected.',
    actions: [{ key: 'edit', label: 'Manage', permission: PERMISSIONS.RESERVATION_MANAGE }],
    routes: ['/dashboard/reservations'],
  },
  {
    key: 'kitchen',
    label: 'Kitchen display',
    group: 'Operations',
    description: 'The rail the kitchen cooks from.',
    actions: [
      { key: 'view', permission: PERMISSIONS.KITCHEN_VIEW },
      {
        key: 'approve',
        label: 'Accept orders',
        permission: PERMISSIONS.KITCHEN_ACCEPT,
        hint: 'Taking an order onto the kitchen\u2019s books, which is what sends its dishes to their sections.',
      },
      {
        key: 'transfer',
        label: 'Move items between sections',
        permission: PERMISSIONS.KITCHEN_REASSIGN,
        hint: 'Overrides the menu\u2019s own routing when a section goes down. Every use is logged.',
      },
    ],
    routes: ['/kitchen'],
  },
  {
    key: 'kitchenStations',
    label: 'Kitchen sections',
    group: 'Operations',
    description:
      'The sections a kitchen is divided into \u2014 rice range, pizza oven, juice bar \u2014 and which dishes each one cooks.',
    actions: [
      { key: 'view', permission: PERMISSIONS.KITCHEN_STATION_VIEW },
      {
        key: 'edit',
        label: 'Manage',
        permission: PERMISSIONS.KITCHEN_STATION_MANAGE,
        hint: 'Creating and retiring sections, and putting cooks on them.',
      },
    ],
    /*
     * A location's kitchen sections belong here, not to Locations \u2014 the same
     * argument the Staff screen makes below. `featureForRoute` matches the
     * longest prefix, so this beats `/dashboard/locations`.
     */
    routes: [
      '/dashboard/kitchen-stations',
      '/dashboard/locations/[branchId]/kitchen-stations',
    ],
  },
  {
    key: 'waiter',
    label: 'Waiter station',
    group: 'Operations',
    description: 'What is ready to run, and guest requests.',
    actions: [{ key: 'view', permission: PERMISSIONS.WAITER_VIEW }],
    routes: ['/waiter'],
  },
  {
    key: 'payments',
    label: 'Payments & till',
    group: 'Operations',
    description: 'Taking money, settling bills and refunds.',
    actions: [
      { key: 'view', permission: PERMISSIONS.PAYMENT_VIEW },
      { key: 'create', label: 'Collect', permission: PERMISSIONS.PAYMENT_COLLECT },
      {
        key: 'approve',
        label: 'Refund',
        permission: PERMISSIONS.PAYMENT_REFUND,
        hint: 'Giving money back. Deliberately not part of collecting it.',
      },
      { key: 'edit', label: 'Apply discount', permission: PERMISSIONS.DISCOUNT_APPLY },
      { key: 'export', label: 'See invoices', permission: PERMISSIONS.INVOICE_VIEW },
    ],
    routes: ['/cashier', '/dashboard/online-payments', '/dashboard/invoices'],
  },

  // ── Menu ──────────────────────────────────────────────────────────────────
  {
    key: 'menu',
    label: 'Menu',
    group: 'Menu',
    description: 'Dishes, prices and availability.',
    actions: [
      { key: 'view', permission: PERMISSIONS.MENU_VIEW },
      { key: 'edit', label: 'Manage', permission: PERMISSIONS.MENU_MANAGE },
      { key: 'create', label: 'Categories', permission: PERMISSIONS.CATEGORY_MANAGE },
    ],
    routes: ['/dashboard/menu', '/dashboard/categories'],
  },
  {
    key: 'recipes',
    label: 'Recipes',
    group: 'Menu',
    description: 'What each dish is made of — the link between sales and stock.',
    actions: [
      { key: 'view', permission: PERMISSIONS.RECIPE_VIEW },
      { key: 'edit', permission: PERMISSIONS.MENU_MANAGE },
    ],
    routes: ['/dashboard/recipes'],
  },
  {
    key: 'loyalty',
    label: 'Loyalty',
    group: 'Menu',
    description: 'Points guests earn and spend.',
    actions: [{ key: 'view', permission: PERMISSIONS.LOYALTY_VIEW }],
    routes: ['/dashboard/loyalty'],
  },
  {
    key: 'coupons',
    label: 'Coupons',
    group: 'Menu',
    description: 'Discount codes.',
    actions: [{ key: 'edit', label: 'Manage', permission: PERMISSIONS.COUPON_MANAGE }],
    routes: ['/dashboard/coupons'],
  },

  // ── Inventory ─────────────────────────────────────────────────────────────
  {
    key: 'inventory',
    label: 'Inventory',
    group: 'Inventory',
    description: 'Stock levels, items and the ledger behind them.',
    actions: [
      { key: 'view', permission: PERMISSIONS.INVENTORY_VIEW },
      { key: 'edit', label: 'Manage', permission: PERMISSIONS.INVENTORY_MANAGE },
      {
        key: 'approve',
        label: 'Adjust balance',
        permission: PERMISSIONS.INVENTORY_ADJUST,
        hint: 'Overriding a counted balance. One of the two ways a discrepancy gets hidden.',
      },
      {
        key: 'submit',
        label: 'Edit cost',
        permission: PERMISSIONS.INVENTORY_COST_EDIT,
        hint: 'Changing what stock is worth, which moves gross profit.',
      },
    ],
    routes: ['/dashboard/inventory', '/dashboard/inventory/ledger'],
  },
  {
    key: 'stockCounts',
    label: 'Stock counts',
    group: 'Inventory',
    description: 'Counting the shelf and reconciling it with the book.',
    actions: [
      { key: 'view', label: 'Count', permission: PERMISSIONS.INVENTORY_COUNT },
      { key: 'approve', permission: PERMISSIONS.INVENTORY_COUNT_APPROVE },
    ],
    routes: ['/dashboard/inventory/counts'],
  },
  {
    key: 'wastage',
    label: 'Wastage',
    group: 'Inventory',
    description: 'Stock thrown away, and why.',
    actions: [
      { key: 'view', label: 'Record', permission: PERMISSIONS.INVENTORY_WASTAGE },
      { key: 'approve', permission: PERMISSIONS.INVENTORY_WASTAGE_APPROVE },
    ],
    routes: ['/dashboard/inventory/wastage'],
  },
  {
    key: 'expiry',
    label: 'Expiry',
    group: 'Inventory',
    description: 'What is about to go out of date.',
    actions: [{ key: 'view', permission: PERMISSIONS.INVENTORY_EXPIRY_VIEW }],
    routes: ['/dashboard/inventory/expiry'],
  },
  {
    key: 'inventorySetup',
    label: 'Units & categories',
    group: 'Inventory',
    description: 'The measures and groupings stock is kept in.',
    actions: [{ key: 'view', permission: PERMISSIONS.INVENTORY_VIEW }],
    routes: ['/dashboard/inventory/setup'],
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    group: 'Inventory',
    description: 'Who the restaurant buys from.',
    actions: [
      { key: 'view', permission: PERMISSIONS.SUPPLIER_VIEW },
      { key: 'edit', label: 'Manage', permission: PERMISSIONS.SUPPLIER_MANAGE },
      {
        key: 'submit',
        label: 'Record payment',
        permission: PERMISSIONS.SUPPLIER_PAYMENT,
        hint: 'Saying the restaurant has paid someone. Separate from editing their details.',
      },
    ],
    routes: ['/dashboard/suppliers'],
  },
  {
    key: 'purchasing',
    label: 'Purchasing',
    group: 'Inventory',
    description: 'Ordering stock and receiving it.',
    actions: [
      { key: 'view', permission: PERMISSIONS.PURCHASE_VIEW },
      { key: 'create', label: 'Raise order', permission: PERMISSIONS.PURCHASE_CREATE },
      {
        key: 'approve',
        permission: PERMISSIONS.PURCHASE_APPROVE,
        hint: 'Committing the restaurant’s money. Deliberately separate from raising the order.',
      },
      { key: 'receive', label: 'Receive goods', permission: PERMISSIONS.PURCHASE_RECEIVE },
      { key: 'reject', label: 'Return', permission: PERMISSIONS.PURCHASE_RETURN },
    ],
    routes: ['/dashboard/purchases'],
  },

  // ── People ────────────────────────────────────────────────────────────────
  {
    key: 'customers',
    label: 'Customers',
    group: 'People',
    description: 'Guests, their history and loyalty points.',
    actions: [
      { key: 'view', permission: PERMISSIONS.CUSTOMER_VIEW },
      { key: 'edit', label: 'Manage', permission: PERMISSIONS.CUSTOMER_MANAGE },
    ],
    routes: ['/dashboard/customers'],
  },
  {
    key: 'customerInsights',
    label: 'Customer insights',
    group: 'People',
    description: 'Who returns, who spends and who has stopped coming.',
    actions: [{ key: 'view', permission: PERMISSIONS.CUSTOMER_ANALYTICS }],
    routes: ['/dashboard/customers/analytics'],
  },
  {
    key: 'live',
    label: 'Live floor',
    group: 'Overview',
    description: 'Tables, waiting times and who is sitting at them, as it happens.',
    actions: [{ key: 'view', permission: PERMISSIONS.DASHBOARD_LIVE }],
    routes: ['/dashboard/live'],
  },
  {
    key: 'staff',
    label: 'Staff',
    group: 'People',
    description: 'The team, their roles, their hours and their sign-in codes.',
    actions: [
      { key: 'view', permission: PERMISSIONS.STAFF_VIEW },
      {
        key: 'edit',
        label: 'Manage',
        permission: PERMISSIONS.STAFF_MANAGE,
        hint: 'Adding people, setting roles, correcting hours, issuing access links. A powerful switch.',
      },
    ],
    /*
     * A location's staff screen belongs to Staff, not to Locations.
     *
     * `featureForRoute` matches the longest prefix, so this beats
     * `/dashboard/locations` and the page may guard on STAFF_VIEW — which is
     * also what it should mean: switching **Staff** off ought to hide who
     * worked and for how long, while switching **Locations** off should not.
     */
    routes: [
      '/dashboard/staff',
      '/dashboard/roles',
      '/dashboard/links',
      '/dashboard/locations/[branchId]/staff',
    ],
  },
  {
    key: 'reviews',
    label: 'Reviews',
    group: 'People',
    description: 'What guests said publicly.',
    actions: [{ key: 'edit', label: 'Manage', permission: PERMISSIONS.REVIEW_MANAGE }],
    routes: ['/dashboard/reviews'],
  },
  {
    key: 'feedback',
    label: 'Feedback',
    group: 'People',
    description: 'What guests said privately.',
    actions: [{ key: 'view', permission: PERMISSIONS.FEEDBACK_VIEW }],
    routes: ['/dashboard/feedback'],
  },

  // ── Back office ───────────────────────────────────────────────────────────
  {
    key: 'reports',
    label: 'Reports',
    group: 'Back office',
    description: 'The reports hub and exporting any of them.',
    actions: [
      { key: 'view', permission: PERMISSIONS.REPORT_VIEW },
      { key: 'export', permission: PERMISSIONS.REPORT_EXPORT },
    ],
    routes: ['/dashboard/reports'],
  },
  {
    key: 'reportSales',
    label: 'Sales report',
    group: 'Back office',
    description: 'Takings by day, hour, item and payment method.',
    actions: [{ key: 'view', permission: PERMISSIONS.REPORT_SALES }],
    routes: ['/dashboard/reports/sales'],
  },
  {
    key: 'reportProfit',
    label: 'Gross profit',
    group: 'Back office',
    description: 'Revenue against what the food cost.',
    actions: [{ key: 'view', permission: PERMISSIONS.REPORT_PROFIT }],
    routes: ['/dashboard/reports/profit'],
  },
  {
    key: 'reportInventory',
    label: 'Inventory report',
    group: 'Back office',
    description: 'Stock value, movement and wastage.',
    actions: [{ key: 'view', permission: PERMISSIONS.REPORT_INVENTORY }],
    routes: ['/dashboard/reports/inventory'],
  },
  {
    key: 'reportPurchasing',
    label: 'Purchasing report',
    group: 'Back office',
    description: 'Spend, deliveries and what is owed.',
    actions: [{ key: 'view', permission: PERMISSIONS.REPORT_PURCHASING }],
    routes: ['/dashboard/reports/purchasing'],
  },
  {
    key: 'reportVariance',
    label: 'Stock variance',
    group: 'Back office',
    description: 'Where counted stock disagrees with the ledger.',
    actions: [{ key: 'view', permission: PERMISSIONS.REPORT_VARIANCE }],
    routes: ['/dashboard/reports/variance'],
  },
  {
    key: 'reportReconciliation',
    label: 'Reconciliation',
    group: 'Back office',
    description: 'Proving the stock ledger adds up.',
    actions: [{ key: 'view', permission: PERMISSIONS.REPORT_RECONCILIATION }],
    routes: ['/dashboard/reports/reconciliation'],
  },
  {
    key: 'accountingClose',
    label: 'Daily close & periods',
    group: 'Back office',
    description: 'Signing off business days and sealing accounting periods.',
    actions: [
      { key: 'view', permission: PERMISSIONS.REPORT_VIEW },
      { key: 'approve', permission: PERMISSIONS.ACCOUNTING_CLOSE },
    ],
    routes: ['/dashboard/reports/daily-close'],
  },
  {
    key: 'reportCash',
    label: 'Cash reports',
    group: 'Back office',
    description: 'Drawer sessions, variances and the petty cash ledger.',
    actions: [{ key: 'view', permission: PERMISSIONS.REPORT_CASH }],
    routes: ['/dashboard/reports/cash-drawer', '/dashboard/reports/petty-cash'],
  },
  {
    key: 'qr',
    label: 'QR codes',
    group: 'Back office',
    description: 'The codes guests scan at the table.',
    actions: [{ key: 'view', permission: PERMISSIONS.QR_VIEW }],
    routes: ['/dashboard/qr'],
  },
  {
    key: 'audit',
    label: 'Audit log',
    group: 'Back office',
    description: 'Who did what, and when.',
    actions: [{ key: 'view', permission: PERMISSIONS.AUDIT_VIEW }],
    routes: ['/dashboard/audit-logs'],
  },
  {
    key: 'settings',
    label: 'Settings',
    group: 'Back office',
    description: 'Restaurant details, tax, currency and printing.',
    actions: [
      { key: 'view', permission: PERMISSIONS.SETTINGS_VIEW },
      { key: 'edit', label: 'Change', permission: PERMISSIONS.SETTINGS_MANAGE },
    ],
    routes: ['/dashboard/settings'],
  },
]

/** Look-ups built once, since the registry is a module constant. */
const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]))

/** Every permission that appears anywhere in the registry. */
export const REGISTERED_PERMISSIONS: Set<string> = new Set(
  FEATURES.flatMap((f) => f.actions.map((a) => a.permission)),
)

export function featureByKey(key: string): Feature | undefined {
  return BY_KEY.get(key)
}

/**
 * The feature that owns a route.
 *
 * Longest prefix wins, so `/dashboard/reports/sales` resolves to the sales
 * report rather than to the reports hub that also matches it.
 */
export function featureForRoute(pathname: string): Feature | undefined {
  let best: Feature | undefined
  let bestLength = -1
  for (const feature of FEATURES) {
    for (const route of feature.routes) {
      const matches = pathname === route || pathname.startsWith(`${route}/`)
      if (matches && route.length > bestLength) {
        best = feature
        bestLength = route.length
      }
    }
  }
  return best
}

/**
 * The action that decides whether the feature is reachable at all.
 *
 * `view` where there is one; otherwise the first action listed, because some
 * features have no separate read — Reservations is `reservation.manage` and
 * nothing else, and Coupons is `coupon.manage`.
 */
export function primaryAction(feature: Feature): FeatureAction | undefined {
  return feature.actions.find((a) => a.key === 'view') ?? feature.actions[0]
}

/**
 * The permission set a role starts with when the owner enables whole features.
 *
 * Enabling a feature means its primary action at minimum — a feature switched
 * on with nothing readable is a menu entry leading to a refusal.
 */
export function permissionsForFeatures(featureKeys: string[]): string[] {
  const out = new Set<string>()
  for (const key of featureKeys) {
    const feature = BY_KEY.get(key)
    if (!feature) continue
    const view = primaryAction(feature)
    if (view) out.add(view.permission)
  }
  return [...out]
}

/**
 * Which features a permission set can reach, and which of their actions are on.
 *
 * What the role builder renders, and what an owner reads back when they reopen
 * a saved role.
 *
 * ── Why `enabled` is the primary action and not "any action" ────────────────
 *
 * "Any" was the first definition and it was wrong in a way the test caught: a
 * cashier with `payment.view` and `payment.collect` removed still holds
 * `discount.apply` and `invoice.view`, so Payments read back as ON while the
 * till was refusing them at the door. The switch has to say the same thing the
 * sidebar and the URL guard say, and both of those ask the primary permission.
 *
 * The leftover actions stay visible in `actions` — an owner should be able to
 * see that a discount right is dangling, and switch it off too.
 */
export function describePermissions(granted: Set<string>) {
  return FEATURES.map((feature) => {
    const primary = primaryAction(feature)
    return {
      feature,
      enabled: primary ? granted.has(primary.permission) : false,
      /** On, but unreachable because the feature itself is off. */
      orphaned: feature.actions.filter(
        (a) => granted.has(a.permission) && (!primary || !granted.has(primary.permission)),
      ),
      actions: feature.actions.map((action) => ({
        action,
        on: granted.has(action.permission),
      })),
    }
  })
}

/**
 * How much of a feature somebody has.
 *
 * ── Why three words and not a list of checkboxes ────────────────────────────
 *
 * The role builder is exact: every action is its own switch, because a role is
 * composed once and lived with. The Locations screen is not that — an owner
 * setting up Kandy is answering "can the manager touch the till, or only look
 * at it", and making them reason about `payment.view` versus `payment.collect`
 * versus `payment.refund` to say so is how a setup screen gets abandoned.
 *
 * So the same permission set is offered two ways. This is the coarse
 * vocabulary, and it is defined in terms of the fine one rather than beside it,
 * so the two can never mean different things:
 *
 *   off   nothing
 *   read  the primary action — exactly what makes the page open
 *   full  every action the feature has
 *
 * A role composed in the builder may sit between two of these. `levelOf` calls
 * that `custom`, and the Locations grid says so rather than rounding it to the
 * nearest word and silently rewriting somebody's careful work on save.
 */
export type FeatureLevel = 'off' | 'read' | 'full' | 'custom'

/** The permissions a level grants. `custom` is not expressible here by design. */
export function permissionsForLevel(feature: Feature, level: Exclude<FeatureLevel, 'custom'>): string[] {
  if (level === 'off') return []
  if (level === 'full') return feature.actions.map((a) => a.permission)
  const primary = primaryAction(feature)
  return primary ? [primary.permission] : []
}

/** Which level a permission set corresponds to, or `custom` if it is between. */
export function levelOf(feature: Feature, granted: Set<string>): FeatureLevel {
  const on = feature.actions.filter((a) => granted.has(a.permission))
  if (on.length === 0) return 'off'
  if (on.length === feature.actions.length) return 'full'

  const primary = primaryAction(feature)
  // Read is exactly the primary action and nothing else. Anything else that
  // happens to be one permission — a stray `discount.apply` with Payments off —
  // is not "read", it is a role somebody built deliberately.
  if (on.length === 1 && primary && on[0].permission === primary.permission) return 'read'
  return 'custom'
}

/**
 * Apply a level to an existing permission set, leaving every other feature be.
 *
 * Returns a new set — the grid holds one `Set<string>` for the whole role, the
 * same shape the role builder posts, so a location grid and the roles screen
 * write interchangeable data.
 */
export function withLevel(
  granted: Set<string>,
  feature: Feature,
  level: Exclude<FeatureLevel, 'custom'>,
): Set<string> {
  const next = new Set(granted)
  for (const action of feature.actions) next.delete(action.permission)
  for (const permission of permissionsForLevel(feature, level)) next.add(permission)
  return next
}
