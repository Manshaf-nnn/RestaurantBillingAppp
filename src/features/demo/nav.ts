import {
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Bike,
  Building2,
  Calculator,
  CalendarClock,
  ChefHat,
  ClipboardCheck,
  ClipboardList,
  Coins,
  Factory,
  FileText,
  Gauge,
  HandPlatter,
  KeyRound,
  Landmark,
  LayoutDashboard,
  ListOrdered,
  ListTodo,
  MonitorDot,
  Package,
  PackageCheck,
  PiggyBank,
  QrCode,
  ScanLine,
  Scale,
  ScrollText,
  Settings,
  ShieldCheck,
  Smartphone,
  Smile,
  Sparkles,
  Star,
  Ticket,
  Trash2,
  TrendingUp,
  Truck,
  UserSearch,
  UsersRound,
  Utensils,
  Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/*
 * The demo's sidebar. It is the real dashboard's sidebar — same sections, same
 * labels, same order, same icons (see features/dashboard/nav.ts) — so a visitor
 * sees the actual size of the product. The one addition is "Guest QR menu",
 * which is not a staff screen: it is what a guest sees on their own phone.
 */

export interface DemoScreen {
  id: string
  label: string
  icon: LucideIcon
  blurb: string
}

export const NAV: { title: string; items: DemoScreen[] }[] = [
  {
    title: 'Overview',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, blurb: 'Today at a glance for the location you pick.' },
      { id: 'command', label: 'Command Center', icon: Gauge, blurb: 'Every branch, every order, on one live screen.' },
      { id: 'tasks', label: 'Things to do', icon: ListTodo, blurb: 'Everything that is waiting on a person, in one list.' },
      { id: 'analytics', label: 'Analytics', icon: BarChart3, blurb: 'How sales move by day, hour and order type.' },
      { id: 'cash-drawer', label: 'Cash drawer', icon: Wallet, blurb: 'Open with a float, log cash in and out, and close against a physical count.' },
      { id: 'locations', label: 'Locations', icon: Building2, blurb: 'Branches, production houses and warehouses, each with its own stock.' },
      { id: 'transfers', label: 'Transfers', icon: ArrowLeftRight, blurb: 'Move stock between locations with a full trail.' },
      { id: 'production', label: 'Kitchen Production', icon: Factory, blurb: 'Make sauces, pastes and dough out of stock, costed exactly.' },
      { id: 'floor', label: 'Live floor', icon: MonitorDot, blurb: 'Tables, waiting times and who is sitting at them. Tap a table to move it along.' },
      { id: 'approvals', label: 'Approvals', icon: ShieldCheck, blurb: 'Discounts, voids and refunds wait for your yes.' },
      { id: 'delivery', label: 'Delivery Desk', icon: Bike, blurb: 'Delivery orders from the kitchen to the customer’s door.' },
      { id: 'shift', label: 'Shift', icon: ClipboardList, blurb: 'Your shift, your handover and the notes for whoever is next.' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { id: 'qr', label: 'Guest QR menu', icon: Smartphone, blurb: 'Every page your guest sees: welcome, menu, dish, cart, food tracker and bill.' },
      { id: 'orders', label: 'Orders', icon: ListOrdered, blurb: 'Every order from every channel, with its status.' },
      { id: 'invoices', label: 'Invoices', icon: ListOrdered, blurb: 'Numbered invoices for every bill, paid or not.' },
      { id: 'tables', label: 'Tables', icon: ClipboardList, blurb: 'Your tables, areas and seats, each with its own QR.' },
      { id: 'reservations', label: 'Reservations', icon: FileText, blurb: 'Bookings, party sizes and the tables held for them.' },
      { id: 'kitchen', label: 'Kitchen display', icon: ChefHat, blurb: 'Every dish moves from waiting to preparing to ready, and the guest sees it live.' },
      { id: 'kitchen-sections', label: 'Kitchen sections', icon: Utensils, blurb: 'How a kitchen is divided up, and which dishes each part cooks.' },
      { id: 'waiter', label: 'Waiter station', icon: HandPlatter, blurb: 'What is ready to serve and which tables are asking for something.' },
      { id: 'pos', label: 'POS', icon: HandPlatter, blurb: 'The full till: orders, customer offers, bills, payment, delivery desk, drawer and shift.' },
      { id: 'payment-details', label: 'Payment details', icon: Landmark, blurb: 'Every account your money is filed under, and transfers waiting to be confirmed.' },
    ],
  },
  {
    title: 'Menu',
    items: [
      { id: 'menu', label: 'Menu items', icon: Utensils, blurb: 'Dishes, categories, prices, sizes, add-ons and availability.' },
      { id: 'recipes', label: 'Recipes', icon: ChefHat, blurb: 'What each dish costs to make. Highest food cost first.' },
      { id: 'menu-import', label: 'Add your menu', icon: Sparkles, blurb: 'Photograph your printed menu and the dishes are read in for you.' },
      { id: 'loyalty', label: 'Loyalty', icon: Sparkles, blurb: 'Reward your regulars with points and watch the programme grow.' },
      { id: 'coupons', label: 'Coupons', icon: Ticket, blurb: 'Offers by customer group, time, branch and minimum spend.' },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { id: 'stock', label: 'Stock', icon: Package, blurb: 'Know what is on the shelf in every location.' },
      { id: 'stock-ledger', label: 'Stock ledger', icon: Package, blurb: 'Every movement, newest first, valued at the cost when it happened.' },
      { id: 'stock-counts', label: 'Stock counts', icon: ClipboardCheck, blurb: 'Count the shelf, then have the difference approved.' },
      { id: 'adjustments', label: 'Adjustments', icon: Scale, blurb: 'Corrections to stock, each with a reason and an approval.' },
      { id: 'wastage', label: 'Wastage', icon: Trash2, blurb: 'What went in the bin, why, and what it cost.' },
      { id: 'expiry', label: 'Expiry', icon: CalendarClock, blurb: 'Batches close to their date, before they become waste.' },
      { id: 'variance', label: 'Stock variance', icon: Scale, blurb: 'The gap between the system and the shelf.' },
      { id: 'reconciliation', label: 'Reconciliation', icon: Scale, blurb: 'Opening, in, out and what should be left, item by item.' },
      { id: 'daily-close', label: 'Daily close', icon: Scale, blurb: 'Sign off each day’s figures and seal them.' },
      { id: 'units', label: 'Units & categories', icon: Scale, blurb: 'The two lists every stock item picks from.' },
      { id: 'suppliers', label: 'Suppliers', icon: Truck, blurb: 'Who you buy from, what they supply and what you owe.' },
      { id: 'purchasing', label: 'Purchasing', icon: Truck, blurb: 'Request and get approval before buying.' },
      { id: 'goods-received', label: 'Goods received', icon: PackageCheck, blurb: 'Receive goods against an approved order. Stock moves then.' },
    ],
  },
  {
    title: 'People',
    items: [
      { id: 'customers', label: 'Customers', icon: UsersRound, blurb: 'Remember every guest and bring them back.' },
      { id: 'customer-insights', label: 'Customer insights', icon: UserSearch, blurb: 'Who your guests are, how often they come and what they spend.' },
      { id: 'staff', label: 'Staff', icon: ShieldCheck, blurb: 'Your team, their roles and where they work.' },
      { id: 'shifts', label: 'Shifts', icon: CalendarClock, blurb: 'The shifts you run, who is on them and how each handover went.' },
      { id: 'roles', label: 'Roles & access', icon: KeyRound, blurb: 'Give a job title only the features it needs.' },
      { id: 'staff-codes', label: 'Staff codes', icon: BadgeCheck, blurb: 'A short code and a sign-in link for every person.' },
      { id: 'reviews', label: 'Reviews', icon: Star, blurb: 'Dish ratings and comments from guests.' },
      { id: 'feedback', label: 'Feedback', icon: Smile, blurb: 'Quick, anonymous feedback after the bill is paid.' },
    ],
  },
  {
    title: 'Accounting',
    items: [
      { id: 'acc-overview', label: 'Overview', icon: LayoutDashboard, blurb: 'Income, costs and profit for the month so far.' },
      { id: 'money-out', label: 'Money out', icon: Wallet, blurb: 'Draft a payment, get it signed off, then pay it.' },
      { id: 'acc-approvals', label: 'Approvals', icon: ClipboardCheck, blurb: 'Money leaves the business only past this desk.' },
      { id: 'expenses', label: 'Expenses', icon: ScrollText, blurb: 'Formal business costs, approved and on the record.' },
      { id: 'payables', label: 'Payables', icon: Landmark, blurb: 'What you owe each supplier and how old it is.' },
      { id: 'checks', label: 'Checks', icon: Scale, blurb: 'Compare what was recorded with what actually happened.' },
      { id: 'ledger', label: 'Ledger', icon: ScrollText, blurb: 'Every entry behind the figures.' },
      { id: 'acc-reports', label: 'Reports', icon: BarChart3, blurb: 'Profit and loss and the reports an accountant asks for.' },
      { id: 'close-month', label: 'Close month', icon: CalendarClock, blurb: 'Lock a month once its figures are right.' },
      { id: 'tools', label: 'Tools', icon: Calculator, blurb: 'Quick sums and a safe way to test a price change.' },
    ],
  },
  {
    title: 'Back office',
    items: [
      { id: 'reports', label: 'Reports', icon: BarChart3, blurb: 'Sales, profit and best sellers without a spreadsheet.' },
      { id: 'sales-report', label: 'Sales report', icon: TrendingUp, blurb: 'Sales by day with discounts and refunds.' },
      { id: 'delivery-report', label: 'Delivery report', icon: Bike, blurb: 'Deliveries, time to the door and cash collected.' },
      { id: 'gross-profit', label: 'Gross profit', icon: PiggyBank, blurb: 'What each dish earns after its ingredients.' },
      { id: 'inventory-report', label: 'Inventory report', icon: Package, blurb: 'Stock usage, movement and value across locations.' },
      { id: 'purchasing-report', label: 'Purchasing report', icon: Truck, blurb: 'What you bought, from whom and at what cost.' },
      { id: 'cash-drawer-report', label: 'Cash drawer report', icon: Wallet, blurb: 'Every drawer: expected, counted and the difference.' },
      { id: 'petty-cash-report', label: 'Petty cash report', icon: Coins, blurb: 'Small cash paid out, by whom and for what.' },
      { id: 'payment-details-report', label: 'Payment details report', icon: Landmark, blurb: 'What you collected, by method and by account.' },
      { id: 'reservations-report', label: 'Reservations report', icon: FileText, blurb: 'Bookings taken and how many were kept.' },
      { id: 'qr-code', label: 'QR code', icon: QrCode, blurb: 'A printable code for every table.' },
      { id: 'qr-menus', label: 'QR menus', icon: ScanLine, blurb: 'What a guest sees when they scan, and what it asks them.' },
      { id: 'audit-log', label: 'Audit log', icon: ScrollText, blurb: 'Every administrative action, recorded.' },
      { id: 'settings', label: 'Settings', icon: Settings, blurb: 'Tax, charges, payments, printing and the guest experience.' },
      { id: 'share-links', label: 'Share links', icon: UsersRound, blurb: 'One sign-in link per person or screen.' },
    ],
  },
]

export const ALL_SCREENS: DemoScreen[] = NAV.flatMap((section) => section.items)

/** The quick row on phones: the screens a restaurant owner asks about first. */
export const HIGHLIGHTS = ['command', 'floor', 'qr', 'pos', 'kitchen', 'delivery', 'approvals', 'transfers', 'stock', 'reports', 'customers'].map(
  (id) => ALL_SCREENS.find((s) => s.id === id)!,
)
