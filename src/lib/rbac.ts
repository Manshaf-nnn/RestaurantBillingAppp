import type { UserRole } from '@prisma/client'

/**
 * Permission model.
 *
 * A user's effective permission set = role defaults ∪ per-user grants.
 * Checks are performed both server-side (every action / route) and client-side
 * (to hide affordances). The server check is the one that matters.
 */
export const PERMISSIONS = {
  // dashboards
  DASHBOARD_VIEW: 'dashboard.view',
  ANALYTICS_VIEW: 'analytics.view',

  // menu
  MENU_VIEW: 'menu.view',
  MENU_MANAGE: 'menu.manage',
  CATEGORY_MANAGE: 'category.manage',

  // floor
  TABLE_VIEW: 'table.view',
  TABLE_MANAGE: 'table.manage',
  RESERVATION_MANAGE: 'reservation.manage',

  // orders
  ORDER_VIEW: 'order.view',
  ORDER_CREATE: 'order.create',
  ORDER_UPDATE_STATUS: 'order.updateStatus',
  ORDER_CANCEL: 'order.cancel',
  KITCHEN_VIEW: 'kitchen.view',
  WAITER_VIEW: 'waiter.view',

  // money
  PAYMENT_VIEW: 'payment.view',
  PAYMENT_COLLECT: 'payment.collect',
  PAYMENT_REFUND: 'payment.refund',
  INVOICE_VIEW: 'invoice.view',
  DISCOUNT_APPLY: 'discount.apply',
  COUPON_MANAGE: 'coupon.manage',

  // people
  CUSTOMER_VIEW: 'customer.view',
  CUSTOMER_MANAGE: 'customer.manage',
  STAFF_VIEW: 'staff.view',
  STAFF_MANAGE: 'staff.manage',

  // supply chain
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_MANAGE: 'inventory.manage',
  SUPPLIER_VIEW: 'supplier.view',
  /*
   * Recording money paid to a supplier. Separate from SUPPLIER_MANAGE, because
   * editing a phone number and settling an invoice are different powers — a
   * purchasing manager should be able to keep the supplier list tidy without
   * being able to say the restaurant has paid someone.
   */
  SUPPLIER_PAYMENT: 'supplier.payment',
  SUPPLIER_MANAGE: 'supplier.manage',
  PURCHASE_MANAGE: 'purchase.manage',

  // back office
  REPORT_VIEW: 'report.view',
  REPORT_EXPORT: 'report.export',
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_VIEW: 'audit.view',
  REVIEW_MANAGE: 'review.manage',

  /*
   * ── Screens that used to borrow somebody else's permission ────────────────
   *
   * An owner is meant to see every feature while building a role and switch
   * each one on or off. That was impossible for a dozen screens, because they
   * did not have a permission of their own — all six reports answered to
   * `report.view`, Approvals and Things-to-do to `dashboard.view`, Recipes to
   * `menu.view`. Turning one off turned the whole group off, and turning
   * Approvals off would have taken the dashboard with it.
   *
   * Each of these is granted below to exactly the roles that hold its old
   * parent, so no existing account gains or loses anything the day this ships.
   * They exist to be switched OFF individually from now on.
   */
  TASKS_VIEW: 'tasks.view',
  APPROVALS_VIEW: 'approvals.view',
  HANDOVER_VIEW: 'handover.view',
  RECIPE_VIEW: 'recipe.view',
  LOYALTY_VIEW: 'loyalty.view',
  QR_VIEW: 'qr.view',
  FEEDBACK_VIEW: 'feedback.view',
  CUSTOMER_ANALYTICS: 'customer.analytics',
  REPORT_SALES: 'report.sales',
  REPORT_PROFIT: 'report.profit',
  REPORT_INVENTORY: 'report.inventory',
  REPORT_PURCHASING: 'report.purchasing',
  REPORT_VARIANCE: 'report.variance',
  REPORT_RECONCILIATION: 'report.reconciliation',

  // inventory — moving stock and changing what it cost are separate powers
  // from ordinary stock-keeping, so they are separate permissions.
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_WASTAGE: 'inventory.wastage',
  INVENTORY_TRANSFER: 'inventory.transfer',
  INVENTORY_COUNT: 'inventory.count',
  INVENTORY_COUNT_APPROVE: 'inventory.countApprove',
  INVENTORY_COST_EDIT: 'inventory.costEdit',
  INVENTORY_WASTAGE_APPROVE: 'inventory.wastageApprove',
  INVENTORY_EXPIRY_VIEW: 'inventory.expiryView',

  // purchasing — creating an order and committing the restaurant's money to it
  // are separate acts, so they are separate permissions.
  PURCHASE_VIEW: 'purchase.view',
  PURCHASE_CREATE: 'purchase.create',
  PURCHASE_APPROVE: 'purchase.approve',
  PURCHASE_RECEIVE: 'purchase.receive',
  PURCHASE_RETURN: 'purchase.return',

  // branches
  BRANCH_VIEW: 'branch.view',
  BRANCH_MANAGE: 'branch.manage',

  // transfers and production — requesting stock and releasing it are different
  // acts, so dispatch is not implied by request.
  TRANSFER_VIEW: 'transfer.view',
  TRANSFER_REQUEST: 'transfer.request',
  TRANSFER_APPROVE: 'transfer.approve',
  TRANSFER_DISPATCH: 'transfer.dispatch',
  TRANSFER_RECEIVE: 'transfer.receive',
  PRODUCTION_VIEW: 'production.view',
  PRODUCTION_MANAGE: 'production.manage',
  PRODUCTION_APPROVE: 'production.approve',

  // cash drawer — operating your own drawer is a cashier's job; seeing everyone's
  // variance and force-closing a drawer someone left open is a manager's.
  CASH_DRAWER_OPERATE: 'cashDrawer.operate',
  CASH_DRAWER_MANAGE: 'cashDrawer.manage',

  // petty cash — three permissions because there are three different jobs.
  // Anybody at the till may need to see what the tin has left; raising a
  // request is a step further; approving one and handing the notes over is the
  // control, and giving it to whoever can raise a request removes the control.
  PETTY_CASH_VIEW: 'pettyCash.view',
  PETTY_CASH_REQUEST: 'pettyCash.request',
  PETTY_CASH_APPROVE: 'pettyCash.approve',

  // the cash reports, split from REPORT_VIEW like every other report.
  REPORT_CASH: 'report.cash',
} as const

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

const ALL: Permission[] = Object.values(PERMISSIONS)

const MANAGER: Permission[] = ALL.filter(
  (p) => p !== PERMISSIONS.SETTINGS_MANAGE && p !== PERMISSIONS.PAYMENT_REFUND,
)

// A cashier handles money at the till, not the restaurant's buying. They are
// deliberately given none of the purchasing permissions.

const KITCHEN: Permission[] = [
  PERMISSIONS.KITCHEN_VIEW,
  PERMISSIONS.ORDER_VIEW,
  PERMISSIONS.ORDER_UPDATE_STATUS,
  PERMISSIONS.MENU_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_WASTAGE,
  PERMISSIONS.INVENTORY_COUNT,
  PERMISSIONS.INVENTORY_EXPIRY_VIEW,
]

const CASHIER: Permission[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.ORDER_VIEW,
  PERMISSIONS.ORDER_CREATE,
  PERMISSIONS.ORDER_UPDATE_STATUS,
  PERMISSIONS.PAYMENT_VIEW,
  PERMISSIONS.PAYMENT_COLLECT,
  PERMISSIONS.INVOICE_VIEW,
  PERMISSIONS.DISCOUNT_APPLY,
  PERMISSIONS.CUSTOMER_VIEW,
  PERMISSIONS.MENU_VIEW,
  PERMISSIONS.TABLE_VIEW,
  PERMISSIONS.BRANCH_VIEW,
  PERMISSIONS.CASH_DRAWER_OPERATE,
]

const WAITER: Permission[] = [
  PERMISSIONS.WAITER_VIEW,
  PERMISSIONS.ORDER_VIEW,
  PERMISSIONS.ORDER_CREATE,
  PERMISSIONS.ORDER_UPDATE_STATUS,
  PERMISSIONS.TABLE_VIEW,
  PERMISSIONS.TABLE_MANAGE,
  PERMISSIONS.MENU_VIEW,
  PERMISSIONS.CUSTOMER_VIEW,
]

/**
 * A restaurant administrator: everything an owner can do except platform
 * concerns. Distinct from OWNER so a trusted employee can run the business
 * without inheriting whatever the owner's account is used for outside it.
 */
const ADMIN: Permission[] = ALL

/** Runs stock: counts, adjustments, wastage, transfers, recipes. Not money. */
const INVENTORY_MANAGER: Permission[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_MANAGE,
  PERMISSIONS.INVENTORY_ADJUST,
  PERMISSIONS.INVENTORY_WASTAGE,
  PERMISSIONS.INVENTORY_WASTAGE_APPROVE,
  PERMISSIONS.INVENTORY_TRANSFER,
  PERMISSIONS.INVENTORY_COUNT,
  PERMISSIONS.INVENTORY_COUNT_APPROVE,
  PERMISSIONS.INVENTORY_EXPIRY_VIEW,
  PERMISSIONS.INVENTORY_COST_EDIT,
  PERMISSIONS.TRANSFER_VIEW,
  PERMISSIONS.TRANSFER_REQUEST,
  PERMISSIONS.TRANSFER_APPROVE,
  PERMISSIONS.TRANSFER_DISPATCH,
  PERMISSIONS.TRANSFER_RECEIVE,
  PERMISSIONS.PRODUCTION_VIEW,
  PERMISSIONS.PRODUCTION_MANAGE,
  PERMISSIONS.MENU_VIEW,
  PERMISSIONS.SUPPLIER_VIEW,
  PERMISSIONS.SUPPLIER_MANAGE,
  PERMISSIONS.PURCHASE_VIEW,
  PERMISSIONS.REPORT_VIEW,
  PERMISSIONS.BRANCH_VIEW,
]

/** Buys. Can raise and receive orders; approving their own is the one thing
 *  they cannot do, since that is the control the approval step exists for. */
const PURCHASING_MANAGER: Permission[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.PURCHASE_VIEW,
  PERMISSIONS.PURCHASE_CREATE,
  PERMISSIONS.PURCHASE_RECEIVE,
  PERMISSIONS.PURCHASE_RETURN,
  PERMISSIONS.SUPPLIER_VIEW,
  PERMISSIONS.SUPPLIER_MANAGE,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_EXPIRY_VIEW,
  PERMISSIONS.TRANSFER_VIEW,
  PERMISSIONS.REPORT_VIEW,
  PERMISSIONS.BRANCH_VIEW,
]

/** Moves boxes. Receives and dispatches, counts, but never adjusts a balance
 *  or edits a cost — those are the two ways stock discrepancies get hidden. */
const WAREHOUSE_STAFF: Permission[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_COUNT,
  PERMISSIONS.INVENTORY_WASTAGE,
  PERMISSIONS.INVENTORY_EXPIRY_VIEW,
  PERMISSIONS.TRANSFER_VIEW,
  PERMISSIONS.TRANSFER_REQUEST,
  PERMISSIONS.TRANSFER_DISPATCH,
  PERMISSIONS.TRANSFER_RECEIVE,
  PERMISSIONS.PURCHASE_VIEW,
  PERMISSIONS.PURCHASE_RECEIVE,
  PERMISSIONS.BRANCH_VIEW,
]

/** Reads the money. Deliberately read-only: an accountant who can edit the
 *  figures they audit is not an audit. */
const ACCOUNTANT: Permission[] = [
  // Read-only on the supplier RECORD — an accountant reconciles what is owed
  // and never edits a phone number — but settling the account is their job.
  PERMISSIONS.SUPPLIER_VIEW,
  PERMISSIONS.SUPPLIER_PAYMENT,
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.ANALYTICS_VIEW,
  PERMISSIONS.REPORT_VIEW,
  PERMISSIONS.REPORT_EXPORT,
  PERMISSIONS.PAYMENT_VIEW,
  PERMISSIONS.INVOICE_VIEW,
  PERMISSIONS.ORDER_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.PURCHASE_VIEW,
  PERMISSIONS.TRANSFER_VIEW,
  PERMISSIONS.PRODUCTION_VIEW,
  PERMISSIONS.AUDIT_VIEW,
  PERMISSIONS.BRANCH_VIEW,
  PERMISSIONS.CUSTOMER_VIEW,
]

/**
 * Which permission each newly-split screen used to answer to.
 *
 * Splitting them is what makes "Approvals OFF, Dashboard ON" expressible. But
 * a split is a silent downgrade if the roles are not brought with it: the day
 * `report.sales` appears, an accountant holding `report.view` would lose the
 * sales report unless something grants it.
 *
 * So the defaults are DERIVED rather than retyped into eight arrays. Anyone
 * holding the parent gets the child, which by construction means no account
 * gains or loses a thing on the day of the migration. Hand-editing the arrays
 * would have been fourteen chances to miss one, in a file where missing one is
 * invisible until somebody's screen is empty.
 */
const SPLIT_FROM: Array<[child: Permission, parent: Permission]> = [
  [PERMISSIONS.TASKS_VIEW, PERMISSIONS.DASHBOARD_VIEW],
  [PERMISSIONS.APPROVALS_VIEW, PERMISSIONS.DASHBOARD_VIEW],
  [PERMISSIONS.HANDOVER_VIEW, PERMISSIONS.ORDER_VIEW],
  [PERMISSIONS.RECIPE_VIEW, PERMISSIONS.MENU_VIEW],
  [PERMISSIONS.LOYALTY_VIEW, PERMISSIONS.SETTINGS_VIEW],
  [PERMISSIONS.QR_VIEW, PERMISSIONS.SETTINGS_VIEW],
  [PERMISSIONS.FEEDBACK_VIEW, PERMISSIONS.REVIEW_MANAGE],
  [PERMISSIONS.CUSTOMER_ANALYTICS, PERMISSIONS.CUSTOMER_VIEW],
  [PERMISSIONS.REPORT_SALES, PERMISSIONS.REPORT_VIEW],
  [PERMISSIONS.REPORT_PROFIT, PERMISSIONS.REPORT_VIEW],
  [PERMISSIONS.REPORT_INVENTORY, PERMISSIONS.REPORT_VIEW],
  [PERMISSIONS.REPORT_PURCHASING, PERMISSIONS.REPORT_VIEW],
  [PERMISSIONS.REPORT_VARIANCE, PERMISSIONS.REPORT_VIEW],
  [PERMISSIONS.REPORT_RECONCILIATION, PERMISSIONS.REPORT_VIEW],
  [PERMISSIONS.REPORT_CASH, PERMISSIONS.REPORT_VIEW],
  // Somebody already trusted to run a till may see and raise petty cash;
  // approving it stays with whoever already reconciles the floor.
  [PERMISSIONS.PETTY_CASH_VIEW, PERMISSIONS.CASH_DRAWER_OPERATE],
  [PERMISSIONS.PETTY_CASH_REQUEST, PERMISSIONS.CASH_DRAWER_OPERATE],
  [PERMISSIONS.PETTY_CASH_APPROVE, PERMISSIONS.CASH_DRAWER_MANAGE],
]

/** Grant every split child to whoever already holds its parent. */
function withSplits(list: Permission[]): Permission[] {
  const set = new Set<Permission>(list)
  for (const [child, parent] of SPLIT_FROM) {
    if (set.has(parent)) set.add(child)
  }
  return [...set]
}

/**
 * The built-in roles.
 *
 * From here on these are TEMPLATES as much as they are roles: a restaurant
 * that customises one gets a `StaffRole` row holding an explicit permission
 * list, seeded from the array here. This stays the answer for everyone who has
 * not customised anything, which is every account today.
 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  ADMIN: withSplits(ADMIN),
  INVENTORY_MANAGER: withSplits(INVENTORY_MANAGER),
  PURCHASING_MANAGER: withSplits(PURCHASING_MANAGER),
  WAREHOUSE_STAFF: withSplits(WAREHOUSE_STAFF),
  ACCOUNTANT: withSplits(ACCOUNTANT),
  SUPER_ADMIN: ALL,
  OWNER: ALL,
  MANAGER: withSplits(MANAGER),
  KITCHEN: withSplits(KITCHEN),
  CASHIER: withSplits(CASHIER),
  WAITER: withSplits(WAITER),
}

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Administrator',
  INVENTORY_MANAGER: 'Inventory manager',
  PURCHASING_MANAGER: 'Purchasing manager',
  WAREHOUSE_STAFF: 'Warehouse staff',
  ACCOUNTANT: 'Accountant',
  SUPER_ADMIN: 'Super Admin',
  OWNER: 'Owner',
  MANAGER: 'Manager',
  KITCHEN: 'Kitchen',
  CASHIER: 'Cashier',
  WAITER: 'Waiter',
}

/** Where each role lands after signing in. */
export const ROLE_HOME: Record<UserRole, string> = {
  SUPER_ADMIN: '/admin',
  ADMIN: '/dashboard',
  // Back-office roles land on the dashboard rather than a service screen —
  // none of them work the floor.
  INVENTORY_MANAGER: '/dashboard/inventory',
  PURCHASING_MANAGER: '/dashboard/purchases',
  WAREHOUSE_STAFF: '/dashboard/locations',
  ACCOUNTANT: '/dashboard/reports',
  OWNER: '/dashboard',
  MANAGER: '/dashboard',
  KITCHEN: '/kitchen',
  CASHIER: '/cashier',
  WAITER: '/waiter',
}

/**
 * Where somebody lands after signing in.
 *
 * One function, because there were four. `auth/actions.ts` read the table,
 * `access/links.ts` read it again, `app/page.tsx` a third time, and
 * `staff/codes/page.tsx` had reimplemented it as a ternary chain that had
 * already drifted — it knew about three roles and defaulted the other eight to
 * `/dashboard`, which is wrong for every back-office role.
 *
 * A destination is only useful if the person is allowed to be there, and the
 * edge middleware decides that from `role` alone. So this takes the role and
 * nothing else: anything that changes where somebody lands has to change their
 * role, which is exactly the rule Part A exists to enforce.
 */
export function landingFor(role: UserRole): string {
  return ROLE_HOME[role] ?? '/dashboard'
}

export interface PermissionSubject {
  role: UserRole
  /** Extra keys granted to this one person, on top of whatever the role gives. */
  permissions?: string[]
  /**
   * The complete permission list from a saved `StaffRole`, when the person has
   * one. Present means it REPLACES the role defaults; absent or null means
   * fall back to them.
   */
  rolePermissions?: string[] | null
}

/**
 * Everything this person may do.
 *
 * ── Why a saved role REPLACES the defaults rather than adding to them ───────
 *
 * This used to be `ROLE_PERMISSIONS[role] ∪ user.permissions` and nothing
 * else, which can only ever grant. An owner could give a cashier the inventory
 * screen; there was no way to take the payment screen away, because the union
 * always put it back. Every ON/OFF switch in the role builder needs the OFF
 * half to mean something.
 *
 * The alternative — keeping the union and adding a deny list — was rejected.
 * It makes every one of the 152 permission checks in this codebase depend on
 * getting a precedence rule right, and a deny list that is consulted in one
 * place and forgotten in another fails open. Storing the answer instead of
 * computing it means there is nothing to get wrong: what the row says is what
 * the person has.
 *
 * Per-user `permissions` still adds on top, so "this one cashier may also
 * approve wastage" needs no bespoke role.
 *
 * ── The owner is not lockable ───────────────────────────────────────────────
 *
 * An owner who saves a role for themselves with Settings switched off could
 * not switch it back on — the screen they need is the screen they just
 * removed. That is unrecoverable without database access, so it is refused at
 * the only level that matters. The same applies to the platform operator.
 */
export function permissionsFor(subject: PermissionSubject): Set<string> {
  if (subject.role === 'OWNER' || subject.role === 'SUPER_ADMIN') return new Set<string>(ALL)
  /*
   * `withSplits` applies to the PRESET list and deliberately not to a saved one.
   *
   * It is tempting to run it on both — a custom role holding `report.view` gets
   * the reports hub and none of the reports behind it, which looks like an
   * oversight. It is not. The splits exist so that when a permission was carved
   * into smaller ones, nobody lost access they already had; they are a
   * compatibility rule for the built-in presets, not a general "parent implies
   * child".
   *
   * Applying them here would make a switch impossible to turn off: an owner who
   * unticks Gross profit while leaving Reports on would watch it come back,
   * because `report.view` would re-derive `report.profit` on every request. A
   * saved role is an explicit list — the builder shows every one of these as its
   * own switch — and the whole point of a list somebody composed by hand is that
   * what is not in it is not granted.
   *
   * `role-url-refusal-test` is the check that holds this: it strips three
   * permissions from a MANAGER and asserts the pages go on refusing.
   */
  const base = subject.rolePermissions ?? ROLE_PERMISSIONS[subject.role]
  return new Set<string>([...base, ...(subject.permissions ?? [])])
}

export function can(subject: PermissionSubject | null | undefined, permission: Permission): boolean {
  if (!subject) return false
  return permissionsFor(subject).has(permission)
}

export function canAny(
  subject: PermissionSubject | null | undefined,
  permissions: Permission[],
): boolean {
  if (!subject) return false
  const set = permissionsFor(subject)
  return permissions.some((p) => set.has(p))
}

export function canAll(
  subject: PermissionSubject | null | undefined,
  permissions: Permission[],
): boolean {
  if (!subject) return false
  const set = permissionsFor(subject)
  return permissions.every((p) => set.has(p))
}

/**
 * Who may be put in charge of a location.
 *
 * Derived from BRANCH_MANAGE rather than written out as a list of roles, so a
 * role that gains the permission later cannot be quietly left out of the
 * manager picker while being perfectly able to run the site.
 */
export function canManageLocation(subject: PermissionSubject): boolean {
  return can(subject, PERMISSIONS.BRANCH_MANAGE)
}

/** Roles that work the floor — every restaurant has them. */
const FLOOR_ROLES: UserRole[] = ['KITCHEN', 'CASHIER', 'WAITER']

/**
 * The back-office roles. Fully defined above and, until now, impossible to
 * assign: `assignableRoles` listed only the five original roles, so nobody
 * could ever be made an inventory manager or an accountant from any screen.
 * The permission sets existed and no user could hold them.
 */
const BACK_OFFICE_ROLES: UserRole[] = [
  'INVENTORY_MANAGER',
  'PURCHASING_MANAGER',
  'WAREHOUSE_STAFF',
  'ACCOUNTANT',
]

/**
 * Roles a given role is allowed to create or edit — prevents privilege
 * escalation.
 *
 * Nobody may create their own rank or above: an owner cannot mint another
 * owner, a manager cannot mint a manager. That rule is what stops a stolen
 * manager account from becoming a permanent one.
 *
 * ADMIN previously fell through to `default: []`, so an admin — who holds every
 * permission including STAFF_MANAGE — could add nobody at all.
 */
export function assignableRoles(role: UserRole): UserRole[] {
  switch (role) {
    case 'SUPER_ADMIN':
      return ['OWNER', 'ADMIN', 'MANAGER', ...BACK_OFFICE_ROLES, ...FLOOR_ROLES]
    case 'OWNER':
      return ['ADMIN', 'MANAGER', ...BACK_OFFICE_ROLES, ...FLOOR_ROLES]
    case 'ADMIN':
      return ['MANAGER', ...BACK_OFFICE_ROLES, ...FLOOR_ROLES]
    case 'MANAGER':
      return [...BACK_OFFICE_ROLES, ...FLOOR_ROLES]
    default:
      return []
  }
}


/**
 * Which locations a user may see.
 *
 * Roles that run the whole business see everything; anyone with a home branch
 * is confined to it. This is the server-side half of the permission model —
 * hiding a branch in the UI while the query still returns it is not access
 * control, it is decoration.
 *
 * Returning `null` means "no restriction", which callers spread into a `where`
 * clause. That is deliberately different from an empty array, which would mean
 * "no locations at all" and silently return nothing.
 */
/*
 * Roles whose remit is the whole restaurant rather than one site.
 *
 * MANAGER is deliberately NOT here. A restaurant with several sites has a
 * manager per site, and "the Colombo manager must not see Kandy's figures" is
 * the ordinary expectation — it was listed, so every branch manager saw every
 * branch. It is now decided per user instead: a manager with no branch assigned
 * is a group manager and sees everything; a manager assigned to Colombo sees
 * Colombo. That reads the existing data rather than needing a new flag, and it
 * leaves single-site restaurants (where nobody has a branch) unchanged.
 */
const CROSS_LOCATION_ROLES: UserRole[] = [
  'SUPER_ADMIN',
  'OWNER',
  'ADMIN',
  'INVENTORY_MANAGER',
  'PURCHASING_MANAGER',
  'ACCOUNTANT',
]

/** Roles that see everything only while they are not tied to one site. */
const SITE_SCOPED_WHEN_ASSIGNED: UserRole[] = ['MANAGER']

export function seesAllLocations(role: UserRole, branchId?: string | null): boolean {
  if (CROSS_LOCATION_ROLES.includes(role)) return true
  return SITE_SCOPED_WHEN_ASSIGNED.includes(role) && !branchId
}

/**
 * True when leaving this role's location blank would blind them.
 *
 * "All locations" means two opposite things depending on the role, and the
 * Staff screen offered it to both. For an accountant or a group manager a blank
 * branch genuinely means the whole business. For a chef, a cashier or a waiter
 * `visibleBranchIds` returns `[]` — they see NOTHING — and the form's own hint
 * said "they see every site". So an owner could add a kitchen account, leave
 * the default, and create an account whose screen would be empty for ever, with
 * no error at the time and the symptom appearing hours later in another room.
 *
 * Derived from the same two lists `seesAllLocations` reads rather than written
 * out again, so a role that changes category later cannot be left behind in a
 * third copy.
 */
export function requiresOwnBranch(role: UserRole): boolean {
  return !CROSS_LOCATION_ROLES.includes(role) && !SITE_SCOPED_WHEN_ASSIGNED.includes(role)
}

export function visibleBranchIds(subject: {
  role: UserRole
  branchId?: string | null
}): string[] | null {
  if (seesAllLocations(subject.role, subject.branchId)) return null
  // Someone tied to a location with none assigned yet sees nothing rather than
  // everything — failing closed is the only safe default here.
  return subject.branchId ? [subject.branchId] : []
}

/** Spread into a Prisma `where` to confine a query to what the user may see. */
export function branchScope(subject: {
  role: UserRole
  branchId?: string | null
}): { branchId?: { in: string[] } } {
  const ids = visibleBranchIds(subject)
  return ids === null ? {} : { branchId: { in: ids } }
}

/** True when this user may act on that specific location. */
export function canAccessBranch(
  subject: { role: UserRole; branchId?: string | null },
  branchId: string,
): boolean {
  const ids = visibleBranchIds(subject)
  return ids === null || ids.includes(branchId)
}

/**
 * Which customers a branch may see.
 *
 * A guest belongs to the business, not to a site — `Customer` is keyed
 * `(restaurantId, phone)` and their loyalty points are a single counter on that
 * row, with no ledger behind it. Forking the record per branch would split a
 * regular in two and halve their points with no way to rebuild them.
 *
 * So the record stays whole and the VISIBILITY narrows: a branch sees the
 * people who have ordered there. Reached through the orders, which is the only
 * thing that knows where someone has actually been.
 *
 * A customer with no orders at all — added by hand on the Customers screen —
 * belongs to no branch yet, so they stay visible to everyone rather than
 * disappearing the moment they are created.
 */
export function customersAtBranch(branchIds: string[] | null) {
  if (!branchIds) return {}
  return {
    OR: [
      { orders: { some: { branchId: { in: branchIds } } } },
      { orders: { none: {} } },
    ],
  }
}
