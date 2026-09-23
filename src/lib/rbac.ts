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
  /*
   * The live floor board.
   *
   * Deliberately NOT in `SPLIT_FROM`. That list exists so splitting an existing
   * screen does not silently downgrade the roles that could already reach it —
   * but this screen never existed, so nothing is being split. Deriving it from
   * `dashboard.view` would hand the floor, with guests' names on it, to every
   * role holding that: the accountant, the cashier, warehouse staff. It lands
   * on owners, admins and managers through ALL, and is granted deliberately to
   * anybody else.
   */
  DASHBOARD_LIVE: 'dashboard.live',
  ANALYTICS_VIEW: 'analytics.view',

  // menu
  MENU_VIEW: 'menu.view',
  MENU_MANAGE: 'menu.manage',
  CATEGORY_MANAGE: 'category.manage',

  // floor
  TABLE_VIEW: 'table.view',
  TABLE_MANAGE: 'table.manage',
  /** Move an occupied table's sitting to an empty one (abc.md §3). */
  TABLE_SWAP: 'table.swap',
  RESERVATION_MANAGE: 'reservation.manage',

  // orders
  ORDER_VIEW: 'order.view',
  ORDER_CREATE: 'order.create',
  ORDER_UPDATE_STATUS: 'order.updateStatus',
  ORDER_CANCEL: 'order.cancel',
  KITCHEN_VIEW: 'kitchen.view',
  /// Taking an order onto the kitchen's books, which is what routes its items
  /// to their stations. Split from KITCHEN_VIEW — the old board let anyone who
  /// could see the rail press Accept, and taking that away on deploy day would
  /// strand every existing kitchen account.
  KITCHEN_ACCEPT: 'kitchen.accept',
  /// Moving a pending item to a different station when one goes down. New
  /// authority, deliberately NOT split: it overrides the menu's own routing and
  /// every use is written to the audit log.
  KITCHEN_REASSIGN: 'kitchen.reassign',
  /// Seeing which stations a branch has. Split from KITCHEN_VIEW: a cook who
  /// can see the rail can see which section they are cooking on.
  KITCHEN_STATION_VIEW: 'kitchen.stationView',
  /// Creating and retiring stations, and assigning cooks to them. Setup work,
  /// not service work — not split.
  KITCHEN_STATION_MANAGE: 'kitchen.stationManage',
  WAITER_VIEW: 'waiter.view',

  // money
  PAYMENT_VIEW: 'payment.view',
  PAYMENT_COLLECT: 'payment.collect',
  /** Accept or turn away a QR / online order at the till (abc.md §5). */
  ORDER_ACCEPT: 'order.accept',
  PAYMENT_REFUND: 'payment.refund',
  INVOICE_VIEW: 'invoice.view',
  DISCOUNT_APPLY: 'discount.apply',
  COUPON_MANAGE: 'coupon.manage',

  /**
   * Open a till and count its opening float (staff.A.md §6).
   *
   * Carved out of CASH_DRAWER_OPERATE, which had grown to mean six different
   * powers: seeing the Drawer tab, raising petty cash, recording a cash
   * movement, closing and counting down, handing a till on, AND starting one.
   * An owner who wants a POS user to take payments without ever opening a
   * drawer had no way to say so — the one switch gave all six.
   *
   * Split (see SPLIT_FROM) so every existing account keeps exactly what it
   * holds today; from now on it can be switched off on its own.
   */
  POS_OPEN_DRAWER: 'pos.openDrawer',

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
  /**
   * Break the two-person rule, on the record (correctionA.md §9).
   *
   * Lets somebody sign a request they raised themselves, or one for a location
   * whose approver list does not name them. Deliberately its own switch rather
   * than something OWNER simply has: the whole point of an override is that it
   * is a decision to grant, visible in the role builder beside everything else
   * an owner can hand out — and revocable without taking the queue away.
   */
  APPROVALS_FORCE: 'approvals.force',
  /** Choose which staff may sign off requests at each location (§9). */
  APPROVALS_MANAGE: 'approvals.manage',
  HANDOVER_VIEW: 'handover.view',
  /** See your own shift, start the one you were rostered on, read your own history (shifthandover.md §3). */
  SHIFT_VIEW: 'shift.view',
  /** Put staff on the rota at a location you may manage (shifthandover.md §2). */
  SHIFT_ASSIGN: 'shift.assign',
  /** Define the kinds of shift — Day, Night, custom (shifthandover.md §1). Owner/admin. */
  SHIFT_TEMPLATE_MANAGE: 'shift.templates',
  RECIPE_VIEW: 'recipe.view',
  LOYALTY_VIEW: 'loyalty.view',
  QR_VIEW: 'qr.view',
  /*
   * Changing what a QR menu shows and asks (ar.md §1).
   *
   * Split from QR_VIEW rather than derived from it: reading the print sheet is
   * something a manager does, while rewriting the guest experience — which
   * menu is shown, what a customer is made to hand over before they can eat —
   * is not the same power. Deliberately absent from SPLIT_FROM for that
   * reason; OWNER, ADMIN and MANAGER pick it up through ALL.
   */
  QR_MANAGE: 'qr.manage',
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
  /**
   * Ask for an adjustment rather than make one (stockMa.md).
   *
   * A storeman finds forty bottles where the system says forty-two and must be
   * able to say so. Letting them correct it themselves would be the one thing
   * the separation exists to prevent, so this raises an approval request and
   * the stock moves only when somebody who may adjust signs it off.
   *
   * Granted explicitly rather than split from `inventory.adjust`, even though
   * everyone who may adjust may obviously also ask. `no-parent-permission-
   * actions.ts` walks every split pair, finds the feature selling the child
   * and refuses any actions file its pages import that names the PARENT —
   * and `stock-actions.ts` names `inventory.adjust` by right.
   */
  INVENTORY_ADJUST_REQUEST: 'inventory.adjustRequest',
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
  /// Signing off a cash difference that crossed the review threshold.
  /// Split OUT of `cashDrawer.manage` at the owner's request: a manager still
  /// sees every drawer and can force-close one, but confirming a large gap has
  /// been looked at is the owner's or admin's act. Grantable from the roles
  /// screen if a restaurant wants a manager to hold it after all.
  CASH_VARIANCE_REVIEW: 'cashDrawer.varianceReview',
  /// Close business days and accounting periods, and reopen sealed ones.
  /// Deliberately NOT held by the accountant role: an auditor who can seal
  /// and unseal the periods they audit is not an audit.
  ACCOUNTING_CLOSE: 'accounting.close',
  /// Open the Accounting section — the hub, payables, reconciliation.
  ACCOUNTING_VIEW: 'accounting.view',
  /// Draft, edit drafts, submit and cancel outgoing payments — supplier
  /// settlements and formal expenses. Recording is the accountant's job;
  /// APPROVING is deliberately somebody else's.
  ACCOUNTING_PAYMENT_CREATE: 'accounting.paymentCreate',
  /// Execute an APPROVED payment — make the transfer, hand over the cash,
  /// mark it paid. Split from approval on purpose: the two-person control
  /// lives entirely at approve, and paying is the accountant's desk again.
  ACCOUNTING_PAYMENT_PAY: 'accounting.paymentPay',
  /// Approve, reject, send back or reverse an accountant's payment. The
  /// owner's pen: excluded from MANAGER below, never held by ACCOUNTANT,
  /// and the submitter is refused even when they hold it.
  ACCOUNTING_PAYMENT_APPROVE: 'accounting.paymentApprove',
  /// Manage the expense category book.
  ACCOUNTING_EXPENSE_MANAGE: 'accounting.expenseManage',
  /// Bank-statement reconciliation: upload statements, accept/reject/undo
  /// matches. Reconciling is reading plus a match flag — it moves no money.
  ACCOUNTING_RECONCILE: 'accounting.reconcile',
  /// Pin a signed, append-only note to a financial record, and acknowledge
  /// a standing warning on the Issues screen.
  ACCOUNTING_NOTE: 'accounting.note',

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
  (p) =>
    p !== PERMISSIONS.SETTINGS_MANAGE &&
    p !== PERMISSIONS.PAYMENT_REFUND &&
    // Sign-off on a large cash gap stays with the owner/admin — the manager may
    // BE the person whose shift produced it.
    p !== PERMISSIONS.CASH_VARIANCE_REVIEW &&
    // Money leaving the business is signed off by the owner/admin — the
    // manager may be the person who raised it.
    p !== PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE &&
    // The kinds of shift are the owner's to define (shifthandover.md §1); a
    // manager rosters people onto them at their own site.
    p !== PERMISSIONS.SHIFT_TEMPLATE_MANAGE,
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

/**
 * The till and the order screen, which are one workspace (staff.A.md §6).
 *
 * Called POS rather than CASHIER because the product has only ever had one
 * screen here — `/cashier` has been a redirect stub for some time and the
 * sidebar has said POS since. Two names for one thing is how a permission
 * gets granted twice and revoked once.
 */
const POS: Permission[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.ORDER_VIEW,
  PERMISSIONS.ORDER_CREATE,
  PERMISSIONS.ORDER_UPDATE_STATUS,
  PERMISSIONS.PAYMENT_VIEW,
  PERMISSIONS.PAYMENT_COLLECT,
  // QR and online orders wait at the till for a yes or a no (abc.md §5).
  PERMISSIONS.ORDER_ACCEPT,
  PERMISSIONS.INVOICE_VIEW,
  PERMISSIONS.DISCOUNT_APPLY,
  PERMISSIONS.CUSTOMER_VIEW,
  PERMISSIONS.MENU_VIEW,
  PERMISSIONS.TABLE_VIEW,
  // A customer needs to move: the cashier at the till is who they ask (abc.md §3).
  PERMISSIONS.TABLE_SWAP,
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
  // They work shifts and `RECEIVER_ROLES` already offers them as receivers;
  // without this a handover to one of them could never be accepted.
  PERMISSIONS.HANDOVER_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_MANAGE,
  PERMISSIONS.INVENTORY_ADJUST,
  PERMISSIONS.INVENTORY_ADJUST_REQUEST,
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
  PERMISSIONS.HANDOVER_VIEW,
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

/**
 * Keeps one location's store (stockMa.md).
 *
 * Everything a storeman does with their hands — receive a delivery, send a
 * transfer, take one in, count a shelf, write off a spoiled crate, make a
 * prepared item — and nothing that rewrites what any of it was worth. No
 * balance adjustment, no cost edit, no signature on their own paperwork.
 *
 * ── Why no DASHBOARD_VIEW ──────────────────────────────────────────────────
 *
 * `/dashboard` is the sales screen: takings, collected, average order value,
 * outstanding bills. A storeman has no reason to read the day's money, and
 * the permission also splits into `APPROVALS_VIEW` and `TASKS_VIEW`. Their
 * landing page is the stock they are responsible for, and the inventory
 * report is their overview.
 *
 * ── Why the report permissions are named one by one ───────────────────────
 *
 * `REPORT_VIEW` splits into seven, two of which are cash and profit. The two
 * that are about stock are granted directly instead.
 */
const STOCK_KEEPER: Permission[] = [
  // Not derived: HANDOVER_VIEW splits from ORDER_VIEW, which they do not hold.
  PERMISSIONS.HANDOVER_VIEW,
  PERMISSIONS.BRANCH_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_EXPIRY_VIEW,
  // Count and record; approving a count is what posts the variance, and that
  // is somebody else's signature.
  PERMISSIONS.INVENTORY_COUNT,
  PERMISSIONS.INVENTORY_WASTAGE,
  PERMISSIONS.INVENTORY_ADJUST_REQUEST,
  PERMISSIONS.TRANSFER_VIEW,
  PERMISSIONS.TRANSFER_REQUEST,
  // Dispatch and receive, never approve — TRANSFER_APPROVE also closes and
  // rejects, and reserves stock at the source.
  PERMISSIONS.TRANSFER_DISPATCH,
  PERMISSIONS.TRANSFER_RECEIVE,
  PERMISSIONS.PURCHASE_VIEW,
  PERMISSIONS.PURCHASE_RECEIVE,
  PERMISSIONS.SUPPLIER_VIEW,
  PERMISSIONS.PRODUCTION_VIEW,
  PERMISSIONS.PRODUCTION_MANAGE,
  PERMISSIONS.REPORT_INVENTORY,
  PERMISSIONS.REPORT_VARIANCE,
]

/** Moves boxes. Receives and dispatches, counts, but never adjusts a balance
 *  or edits a cost — those are the two ways stock discrepancies get hidden. */
const WAREHOUSE_STAFF: Permission[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.HANDOVER_VIEW,
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
  // The accountant's own module: record and execute payments, keep the
  // category book. Approval is deliberately absent — see the permission's
  // own comment.
  PERMISSIONS.ACCOUNTING_VIEW,
  PERMISSIONS.ACCOUNTING_PAYMENT_CREATE,
  PERMISSIONS.ACCOUNTING_PAYMENT_PAY,
  PERMISSIONS.ACCOUNTING_EXPENSE_MANAGE,
  PERMISSIONS.ACCOUNTING_RECONCILE,
  PERMISSIONS.ACCOUNTING_NOTE,
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
  // abc.md §3 — whoever manages tables may swap them; cashiers get it explicitly.
  [PERMISSIONS.TABLE_SWAP, PERMISSIONS.TABLE_MANAGE],
  // abc.md §5 — whoever collects payment accepts online orders at the till.
  // Split from PAYMENT_COLLECT and NOT from ORDER_UPDATE_STATUS: the kitchen
  // and the waiters hold that one, and the point is that they do not accept.
  [PERMISSIONS.ORDER_ACCEPT, PERMISSIONS.PAYMENT_COLLECT],
  [PERMISSIONS.TASKS_VIEW, PERMISSIONS.DASHBOARD_VIEW],
  [PERMISSIONS.APPROVALS_VIEW, PERMISSIONS.DASHBOARD_VIEW],
  [PERMISSIONS.HANDOVER_VIEW, PERMISSIONS.ORDER_VIEW],
  // shifthandover.md §3 — whoever hands a shift on has a shift to see.
  [PERMISSIONS.SHIFT_VIEW, PERMISSIONS.HANDOVER_VIEW],
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
  // staff.A.md §6 — whoever works a till today already opens one, so nobody
  // loses the power on the day it becomes its own switch.
  [PERMISSIONS.POS_OPEN_DRAWER, PERMISSIONS.CASH_DRAWER_OPERATE],
  [PERMISSIONS.PETTY_CASH_APPROVE, PERMISSIONS.CASH_DRAWER_MANAGE],
  // Accepting an order and seeing the station list are both things anyone who
  // could already work the kitchen rail could already do. Reassigning items and
  // managing stations are not, so they are absent on purpose.
  [PERMISSIONS.KITCHEN_ACCEPT, PERMISSIONS.KITCHEN_VIEW],
  [PERMISSIONS.KITCHEN_STATION_VIEW, PERMISSIONS.KITCHEN_VIEW],
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
  STOCK_KEEPER: withSplits(STOCK_KEEPER),
  ACCOUNTANT: withSplits(ACCOUNTANT),
  SUPER_ADMIN: ALL,
  OWNER: ALL,
  MANAGER: withSplits(MANAGER),
  KITCHEN: withSplits(KITCHEN),
  POS: withSplits(POS),
  /*
   * Retired (staff.A.md §10). The migration moves every row to POS, so nothing
   * should resolve through here — but a Postgres enum value cannot be dropped
   * without recreating the type and rewriting five columns that reference it,
   * which is not a risk worth taking on a live database for a value with no
   * rows. It resolves to the same list so a row that somehow survived behaves
   * identically rather than losing its screens.
   */
  CASHIER: withSplits(POS),
  WAITER: withSplits(WAITER),
}

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Administrator',
  INVENTORY_MANAGER: 'Inventory manager',
  PURCHASING_MANAGER: 'Purchasing manager',
  WAREHOUSE_STAFF: 'Warehouse staff',
  STOCK_KEEPER: 'Stock keeper',
  ACCOUNTANT: 'Accountant',
  SUPER_ADMIN: 'Super Admin',
  OWNER: 'Owner',
  MANAGER: 'Manager',
  KITCHEN: 'Kitchen',
  POS: 'POS',
  /** Retired — kept so a historical row still renders a name (staff.A.md §10). */
  CASHIER: 'POS (old name)',
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
  // The stock they are responsible for, not the day's takings.
  STOCK_KEEPER: '/dashboard/inventory',
  ACCOUNTANT: '/dashboard/accounting',
  OWNER: '/dashboard',
  MANAGER: '/dashboard',
  KITCHEN: '/kitchen',
  // The till is a tab inside the POS (abc.md §8).
  POS: '/cashier/pos?tab=cashier',
  CASHIER: '/cashier/pos?tab=cashier',
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
  /**
   * Keys taken away from this one person, whatever granted them (staff.A.md §3).
   *
   * Subtracted last in `permissionsFor`, so it beats the role defaults, a saved
   * role and the per-user grant alike. Owners and the platform operator are
   * exempt — see the short-circuit there.
   */
  deniedPermissions?: string[] | null
  /**
   * Every permission the platform operator has sold this restaurant.
   *
   * Undefined or empty means unrestricted. Anything here is intersected with
   * whatever the role grants, which is the chain `superadmin.md` describes:
   * platform availability, then role permission, then user access.
   *
   * Permissions rather than feature keys, because the feature registry imports
   * from this module and resolving keys here would close the loop. The session
   * layer expands the restaurant's feature list once, with
   * `permissionsForFeatures`, and hands the result down.
   */
  availablePermissions?: string[] | null
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
 * Per-user `permissions` still adds on top, so "this one POS user may also
 * approve wastage" needs no bespoke role.
 *
 * ── Why there is now a deny list, having said there would not be ────────────
 *
 * DELIBERATE behaviour change 2026-09 (staff.A.md §3). This comment used to
 * say a deny list was rejected because it "makes every one of the 152
 * permission checks depend on getting a precedence rule right, and a deny list
 * consulted in one place and forgotten in another fails open".
 *
 * That argument assumed deny would be consulted at the call sites. It is not.
 * `can`, `canAny`, `canAll` and `visibleSections` are one-liners over THIS
 * function, so there is exactly one place a subtraction can live and no caller
 * that can bypass it. Nor can it fail open: a subtraction that never runs
 * grants nothing new, it only leaves the union as it already was.
 *
 * The need is real. A saved role answers "what does a POS user get"; it cannot
 * answer "everyone on this role except Nila, who must not give discounts"
 * without cloning the role, and a cloned role drifts from its original the
 * first time somebody edits one and not the other.
 *
 * Deny beats everything: role default, saved role, and the per-user grant
 * above it. "Take this away from this person" has to mean it regardless of how
 * they came to hold it, or it is not a revocation, it is a suggestion.
 *
 * ── The owner is not lockable ───────────────────────────────────────────────
 *
 * An owner who saves a role for themselves with Settings switched off could
 * not switch it back on — the screen they need is the screen they just
 * removed. That is unrecoverable without database access, so it is refused at
 * the only level that matters. The same applies to the platform operator.
 */
export function permissionsFor(subject: PermissionSubject): Set<string> {
  /*
   * The platform operator's list first, then the role's.
   *
   * A restaurant can only use what it has been sold. This wraps the OWNER
   * short-circuit below rather than living inside it, because an owner must be
   * denied a feature their restaurant does not have just as firmly as a waiter
   * is — otherwise every tenant's owner holds every feature and the whole plan
   * is decorative.
   *
   * `undefined` means unrestricted, which is what keeps every existing caller
   * and every test that builds a bare `{ role }` working unchanged.
   */
  const available = availableSet(subject.availablePermissions)

  if (subject.role === 'OWNER' || subject.role === 'SUPER_ADMIN') {
    return available ? new Set([...ALL].filter((p) => available.has(p))) : new Set<string>(ALL)
  }
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
  const granted = new Set<string>([...base, ...(subject.permissions ?? [])])

  /*
   * Deny last, so it beats every source above it (staff.A.md §3).
   *
   * Above the owner short-circuit this would be a way to lock an owner out of
   * their own restaurant; below it, an owner's denials are simply never
   * consulted, which is the same protection the saved-role path already has.
   */
  for (const permission of subject.deniedPermissions ?? []) granted.delete(permission)

  if (!available) return granted
  return new Set([...granted].filter((permission) => available.has(permission)))
}

/**
 * `null` means no restriction. An empty list means the same thing — "we have
 * not scoped this tenant" is the ordinary case, and it must not require writing
 * out every permission for every restaurant that already exists.
 */
function availableSet(permissions: string[] | null | undefined): Set<string> | null {
  if (!permissions || permissions.length === 0) return null
  return new Set(permissions)
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

/**
 * Roles that work the floor — every restaurant has them.
 *
 * CASHIER is absent on purpose (staff.A.md §10): it is the retired name for
 * POS, and this list is what `assignableRoles` offers, so leaving it out is
 * what stops the old name being handed to anybody new.
 */
const FLOOR_ROLES: UserRole[] = ['KITCHEN', 'POS', 'WAITER']

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
  'STOCK_KEEPER',
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
 * May this admin act on somebody who already holds that role?
 *
 * ── Why this is not just `assignableRoles(...).includes(...)` ───────────────
 *
 * Those are two different questions and retiring a role separated them.
 * `assignableRoles` answers "what may I CREATE", and CASHIER is deliberately
 * absent from it so nobody is given the old name again (staff.A.md §10). But
 * seven call sites were asking a stored role the same way — "may I reset this
 * person's password", "may I read their sign-in code", "may I change what they
 * can do" — and for those, a row that still says CASHIER is a person standing
 * at a till, not a role to be withheld. Reusing the create ladder there meant
 * an owner could not touch their own leftover accounts, with no error that
 * explained why.
 *
 * So the retired name resolves to the one that replaced it, and only here.
 */
export function canActOnRole(adminRole: UserRole, targetRole: UserRole): boolean {
  const effective = targetRole === 'CASHIER' ? 'POS' : targetRole
  return assignableRoles(adminRole).includes(effective)
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

/**
 * Somebody's reach across the business.
 *
 * `branchId` is their HOME site — where their shift opens, where their drawer
 * defaults, the one `requiresOwnBranch` insists on. `branchIds` (staff.A.md
 * §4) are extra sites they may also work, which is the ordinary case for a
 * supervisor covering two of three shops. They are separate fields because
 * "where do you work" and "what may you see" are different questions, and
 * answering both with one column is why a person could only ever have one.
 */
export interface BranchSubject {
  role: UserRole
  branchId?: string | null
  /** Extra sites beyond the home one. Order is not significant. */
  branchIds?: string[] | null
}

/**
 * Turn a database row into a subject these functions understand.
 *
 * A user row loaded with `branchAccess: { select: { branchId: true } }` has its
 * extra sites as rows, not as a list of ids. Every place that checks somebody
 * ELSE's reach — who may receive a handover, who may take this till — would
 * otherwise have to flatten it by hand, and the one that forgot would quietly
 * narrow that person back to a single branch with no error anywhere.
 */
export function reachOf<T extends BranchSubject>(
  subject: T & { branchAccess?: Array<{ branchId: string }> | null },
): BranchSubject {
  return {
    role: subject.role,
    branchId: subject.branchId ?? null,
    branchIds: subject.branchAccess
      ? subject.branchAccess.map((row) => row.branchId)
      : (subject.branchIds ?? []),
  }
}

export function visibleBranchIds(subject: BranchSubject): string[] | null {
  if (seesAllLocations(subject.role, subject.branchId)) return null
  /*
   * Someone tied to a location with none assigned yet sees nothing rather than
   * everything — failing closed is the only safe default here. An extra site
   * on its own still counts, so a person given Kandy and Ampara but no home
   * branch is not blinded.
   */
  const ids = new Set<string>()
  if (subject.branchId) ids.add(subject.branchId)
  for (const id of subject.branchIds ?? []) if (id) ids.add(id)
  return [...ids]
}

/** Spread into a Prisma `where` to confine a query to what the user may see. */
export function branchScope(subject: BranchSubject): { branchId?: { in: string[] } } {
  const ids = visibleBranchIds(subject)
  return ids === null ? {} : { branchId: { in: ids } }
}

/** True when this user may act on that specific location. */
export function canAccessBranch(subject: BranchSubject, branchId: string): boolean {
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
