import {
  BarChart3,
  ChefHat,
  ClipboardList,
  CreditCard,
  FileText,
  HandPlatter,
  Landmark,
  LayoutDashboard,
  ListOrdered,
  Package,
  QrCode,
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
} from 'lucide-react'

import { PERMISSIONS, type Permission } from '@/lib/rbac'

export interface NavItem {
  href: string
  label: string
  icon: typeof LayoutDashboard
  permission: Permission
  exact?: boolean
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
        label: 'Production',
        icon: Factory,
        permission: PERMISSIONS.PRODUCTION_VIEW,
      },
      {
        href: '/dashboard/approvals',
        label: 'Approvals',
        icon: ShieldCheck,
        permission: PERMISSIONS.DASHBOARD_VIEW,
      },
      {
        href: '/dashboard/handover',
        label: 'Shift handover',
        icon: ClipboardList,
        permission: PERMISSIONS.ORDER_VIEW,
      },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/dashboard/orders', label: 'Orders', icon: ListOrdered, permission: PERMISSIONS.ORDER_VIEW },
      { href: '/dashboard/tables', label: 'Tables', icon: ClipboardList, permission: PERMISSIONS.TABLE_VIEW },
      {
        href: '/dashboard/reservations',
        label: 'Reservations',
        icon: FileText,
        permission: PERMISSIONS.RESERVATION_MANAGE,
      },
      { href: '/kitchen', label: 'Kitchen display', icon: ChefHat, permission: PERMISSIONS.KITCHEN_VIEW },
      { href: '/waiter', label: 'Waiter station', icon: HandPlatter, permission: PERMISSIONS.WAITER_VIEW },
      { href: '/cashier/pos', label: 'New order', icon: HandPlatter, permission: PERMISSIONS.ORDER_CREATE },
      { href: '/cashier/pos?type=TAKEAWAY', label: 'Takeaway', icon: HandPlatter, permission: PERMISSIONS.ORDER_CREATE },
      { href: '/cashier/pos?type=DELIVERY', label: 'Delivery', icon: HandPlatter, permission: PERMISSIONS.ORDER_CREATE },
      { href: '/cashier', label: 'Cashier', icon: CreditCard, permission: PERMISSIONS.PAYMENT_COLLECT },
      {
        href: '/dashboard/online-payments',
        label: 'Online payments',
        icon: Landmark,
        permission: PERMISSIONS.PAYMENT_COLLECT,
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
        permission: PERMISSIONS.MENU_VIEW,
      },
      {
        href: '/dashboard/menu/import',
        label: 'Add your menu',
        icon: Sparkles,
        permission: PERMISSIONS.MENU_MANAGE,
      },
      { href: '/dashboard/loyalty', label: 'Loyalty', icon: Sparkles, permission: PERMISSIONS.SETTINGS_VIEW },
      { href: '/dashboard/coupons', label: 'Coupons', icon: Ticket, permission: PERMISSIONS.COUPON_MANAGE },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { href: '/dashboard/inventory', label: 'Stock', icon: Package, permission: PERMISSIONS.INVENTORY_VIEW },
      {
        href: '/dashboard/inventory/counts',
        label: 'Stock counts',
        icon: ClipboardCheck,
        permission: PERMISSIONS.INVENTORY_COUNT,
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
        permission: PERMISSIONS.REPORT_VIEW,
      },
      { href: '/dashboard/suppliers', label: 'Suppliers', icon: Truck, permission: PERMISSIONS.SUPPLIER_MANAGE },
      { href: '/dashboard/purchases', label: 'Purchasing', icon: Truck, permission: PERMISSIONS.PURCHASE_VIEW },
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
      { href: '/dashboard/staff', label: 'Staff', icon: ShieldCheck, permission: PERMISSIONS.STAFF_VIEW },
      { href: '/dashboard/reviews', label: 'Reviews', icon: Star, permission: PERMISSIONS.REVIEW_MANAGE },
      { href: '/dashboard/feedback', label: 'Feedback', icon: Smile, permission: PERMISSIONS.REVIEW_MANAGE },
    ],
  },
  {
    title: 'Back office',
    items: [
      { href: '/dashboard/reports', label: 'Reports', icon: BarChart3, permission: PERMISSIONS.REPORT_VIEW },
      { href: '/dashboard/reports/sales', label: 'Sales report', icon: TrendingUp, permission: PERMISSIONS.REPORT_VIEW },
      { href: '/dashboard/reports/profit', label: 'Gross profit', icon: PiggyBank, permission: PERMISSIONS.REPORT_VIEW },
      { href: '/dashboard/qr', label: 'QR code', icon: QrCode, permission: PERMISSIONS.SETTINGS_VIEW },
      {
        href: '/dashboard/audit-logs',
        label: 'Audit log',
        icon: ScrollText,
        permission: PERMISSIONS.AUDIT_VIEW,
      },
      { href: '/dashboard/settings', label: 'Settings', icon: Settings, permission: PERMISSIONS.SETTINGS_VIEW },
      { href: '/dashboard/links', label: 'Share links', icon: UsersRound, permission: PERMISSIONS.STAFF_MANAGE },
    ],
  },
]
