'use client'

import { Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'

import { MENU, SALES_BY_HOUR, compact, rs } from './data'
import { codeOf } from './pos-data'
import { AreaChart, Card, CardTitle, Pill, QrCode, useNotify, type QrShape, type Tone } from './ui'

/*
 * Every sidebar entry of the real dashboard that does not have a hand-built
 * demo screen gets one of these: four figures, an optional chart, and a table
 * of sample rows. The wording follows each real page's own description so the
 * demo says what the product does and no more.
 */

interface Screen {
  stats: [label: string, value: string, tone?: Tone][]
  chart?: { title: string; data: { label: string; value: number }[] }
  table?: { title: string; columns: string[]; rows: string[][] }
  action?: string
  note?: string
}

/** Words that read better as a coloured badge than as plain text. */
const BADGES: Record<string, Tone> = {
  Paid: 'ok', Open: 'ok', Active: 'ok', Approved: 'ok', Received: 'ok', Balanced: 'ok', Signed: 'ok', Sealed: 'ok', Closed: 'ok', Kept: 'ok', Done: 'ok', Free: 'ok', Match: 'ok', Published: 'ok', Completed: 'ok', Served: 'ok', On: 'ok', Confirmed: 'ok',
  Pending: 'warn', Draft: 'warn', Low: 'warn', 'Part paid': 'warn', Submitted: 'warn', Waiting: 'warn', Soon: 'warn', Preparing: 'warn', Ordered: 'warn', 'Due soon': 'warn', Medium: 'warn',
  Overdue: 'bad', Short: 'bad', Expired: 'bad', Rejected: 'bad', Cancelled: 'bad', 'No-show': 'bad', High: 'bad', Unpaid: 'bad', Off: 'bad', 'Look here': 'bad',
  Reserved: 'violet', Seated: 'info', Occupied: 'info', 'In transit': 'violet', Ready: 'violet', Scheduled: 'info', Accepted: 'info', Branch: 'info', Warehouse: 'violet', 'Production house': 'brand', Ordering: 'brand', 'Menu only': 'neutral', Personal: 'info', 'Shared screen': 'violet',
}

const week = (values: number[]) => ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'].map((label, i) => ({ label, value: values[i] }))

const SCREENS: Record<string, Screen> = {
  dashboard: {
    stats: [['Revenue today', rs(486250), 'brand'], ['Orders', '142', 'violet'], ['Average order', rs(3424), 'ok'], ['Tables in use', '31 / 46', 'info']],
    chart: { title: 'Sales today, by hour', data: SALES_BY_HOUR },
    table: {
      title: 'Recent orders',
      columns: ['Order', 'Type', 'Customer', 'Total', 'Status'],
      rows: [
        ['#1047', 'Dine in · T13', 'Kavindu Silva', rs(4500), 'Preparing'],
        ['#1046', 'Online pickup', 'Walk-in', rs(3140), 'Accepted'],
        ['#1045', 'QR · T7', 'QR guest', rs(3608), 'Preparing'],
        ['#1044', 'Dine in · T9', 'Tharushi Fernando', rs(7073), 'Served'],
        ['#1043', 'Takeaway', 'Ruwan', rs(4780), 'Ready'],
      ],
    },
  },
  tasks: {
    stats: [['Waiting on you', '9', 'warn'], ['Overdue', '2', 'bad'], ['Done today', '14', 'ok'], ['Assigned to others', '5', 'info']],
    table: {
      title: 'Things to do',
      columns: ['What', 'Where', 'Waiting since', 'Priority'],
      rows: [
        ['Approve 15% discount on Table 4', 'Approvals', '2 min', 'High'],
        ['Count the drawer for Till 1 handover', 'Shift', '10 min', 'High'],
        ['Reorder Garlic and Prawns', 'Stock · Galle Fort', '1 hr', 'Medium'],
        ['Receive PO-0311 from Lanka Seafood', 'Goods received', '2 hr', 'Medium'],
        ['Sign off yesterday’s figures', 'Daily close', 'Since morning', 'Medium'],
        ['Reply to a 2-star review', 'Reviews', 'Yesterday', 'Low'],
      ],
    },
    note: 'One list of everything that needs a person: approvals, low stock, handovers, deliveries to receive and days to sign off.',
  },
  analytics: {
    stats: [['Revenue, 7 days', compact(3184900), 'brand'], ['Orders', '936', 'violet'], ['Busiest hour', '1 pm', 'info'], ['Repeat guests', '64%', 'ok']],
    chart: { title: 'Revenue by day', data: week([398200, 512600, 604800, 571300, 301900, 309850, 486250]) },
    table: {
      title: 'By order type',
      columns: ['Type', 'Orders', 'Revenue', 'Average bill', 'Share'],
      rows: [
        ['Dine in', '412', compact(1401000), rs(3400), '44%'],
        ['QR order', '253', compact(860000), rs(3399), '27%'],
        ['Delivery', '168', compact(573000), rs(3411), '18%'],
        ['Takeaway', '103', compact(350900), rs(3407), '11%'],
      ],
    },
  },
  locations: {
    stats: [['Locations', '5', 'info'], ['Branches', '3', 'brand'], ['Stock value', compact(1740000), 'ok'], ['Staff', '46', 'violet']],
    table: {
      title: 'Locations',
      columns: ['Name', 'Type', 'Stock value', 'Staff', 'Status'],
      rows: [
        ['Colombo 03', 'Branch', compact(482000), '18', 'Open'],
        ['Kandy City', 'Branch', compact(311000), '12', 'Open'],
        ['Galle Fort', 'Branch', compact(227000), '9', 'Open'],
        ['Central Kitchen', 'Production house', compact(356000), '5', 'Active'],
        ['Peliyagoda Store', 'Warehouse', compact(364000), '2', 'Active'],
      ],
    },
    action: 'Add location',
    note: 'Branches, production houses and warehouses. Every one holds its own stock and shares one ledger.',
  },
  production: {
    stats: [['Batches today', '7', 'brand'], ['Made', '84 kg', 'ok'], ['Ingredient cost', rs(61400), 'warn'], ['Waiting to start', '2', 'info']],
    table: {
      title: 'Production batches',
      columns: ['Batch', 'Makes', 'Uses', 'Cost', 'Status'],
      rows: [
        ['PB-0231', 'Kottu curry gravy · 20 L', 'Chicken, coconut milk, spices', rs(14200), 'Completed'],
        ['PB-0232', 'Biryani masala · 8 kg', 'Onions, spices, oil', rs(9600), 'Completed'],
        ['PB-0233', 'Pizza dough · 25 kg', 'Flour, oil, yeast', rs(7100), 'Preparing'],
        ['PB-0234', 'Sambol · 6 kg', 'Coconut, chillies, lime', rs(3900), 'Scheduled'],
      ],
    },
    action: 'New batch',
    note: 'Make prepared items out of stock. What goes in leaves the ledger; what comes out is stock, worth exactly what it took.',
  },
  orders: {
    stats: [['Orders today', '142', 'brand'], ['In progress', '11', 'warn'], ['Completed', '129', 'ok'], ['Cancelled', '2', 'bad']],
    table: {
      title: 'Orders',
      columns: ['Order', 'Type', 'Customer', 'Items', 'Total', 'Status'],
      rows: [
        ['#1047', 'Dine in · T13', 'Kavindu Silva', '6', rs(4500), 'Preparing'],
        ['#1046', 'Online pickup', 'Walk-in', '2', rs(3140), 'Accepted'],
        ['#1045', 'QR · T7', 'QR guest', '4', rs(3608), 'Preparing'],
        ['#1044', 'Dine in · T9', 'Tharushi Fernando', '5', rs(7073), 'Served'],
        ['#1043', 'Takeaway', 'Ruwan', '4', rs(4780), 'Ready'],
        ['#1040', 'Delivery', 'Fathima Rizwan', '5', rs(6050), 'Completed'],
        ['#1037', 'Dine in · T2', 'Walk-in', '3', rs(2890), 'Cancelled'],
      ],
    },
  },
  invoices: {
    stats: [['Invoices today', '129', 'brand'], ['Value', rs(441900), 'ok'], ['Part paid', '3', 'warn'], ['Unpaid', '4', 'bad']],
    table: {
      title: 'Invoices',
      columns: ['Invoice', 'Order', 'Customer', 'Total', 'Payment'],
      rows: [
        ['INV-004812', '#1040', 'Fathima Rizwan', rs(6050), 'Paid'],
        ['INV-004811', '#1036', 'Nimal Perera', rs(12595), 'Paid'],
        ['INV-004810', '#1042', 'Kavindu Silva', rs(15499), 'Part paid'],
        ['INV-004809', '#1035', 'Walk-in', rs(2140), 'Paid'],
        ['INV-004808', '#1044', 'Tharushi Fernando', rs(7073), 'Unpaid'],
      ],
    },
    note: 'Invoice numbers are issued in order when a bill is first printed, so there are no gaps to explain later.',
  },
  tables: {
    stats: [['Tables', '16', 'info'], ['Seats', '62', 'violet'], ['Areas', '2', 'brand'], ['QR codes printed', '16', 'ok']],
    table: {
      title: 'Tables',
      columns: ['Table', 'Area', 'Seats', 'QR', 'Status'],
      rows: [
        ['T1', 'Indoor', '2', 'Printed', 'Occupied'],
        ['T2', 'Indoor', '2', 'Printed', 'Free'],
        ['T4', 'Indoor', '4', 'Printed', 'Occupied'],
        ['T8', 'Indoor', '8', 'Printed', 'Reserved'],
        ['T10', 'Terrace', '2', 'Printed', 'Free'],
        ['T13', 'Terrace', '6', 'Printed', 'Occupied'],
      ],
    },
    action: 'Add table',
  },
  reservations: {
    stats: [['Today', '9', 'brand'], ['Guests expected', '38', 'violet'], ['Seated', '4', 'ok'], ['No-shows this week', '2', 'bad']],
    table: {
      title: 'Reservations',
      columns: ['Guest', 'Party', 'When', 'Table', 'Status'],
      rows: [
        ['Fernando', '8', 'Today, 8:00 pm', 'T8', 'Confirmed'],
        ['Hiruni Wickramasinghe', '2', 'Today, 8:30 pm', 'T10', 'Confirmed'],
        ['Mohamed Ashraf', '6', 'Today, 9:00 pm', 'T13', 'Pending'],
        ['Arjun Selvam', '4', 'Tomorrow, 1:00 pm', 'T3', 'Confirmed'],
        ['Dilani Jayawardena', '2', 'Yesterday, 7:30 pm', 'T1', 'Kept'],
        ['Pradeep Kumar', '4', 'Yesterday, 8:00 pm', 'T6', 'No-show'],
      ],
    },
    action: 'New reservation',
    note: 'A reserved table is held on the live floor and cannot be taken by a QR guest at that time.',
  },
  'kitchen-sections': {
    stats: [['Sections', '4', 'brand'], ['Dishes routed', '31', 'ok'], ['Not assigned', '0', 'info'], ['Cooks assigned', '9', 'violet']],
    table: {
      title: 'Kitchen sections',
      columns: ['Section', 'Dishes', 'Staff', 'Printer', 'Status'],
      rows: [
        ['Hot kitchen', '14', '4', 'Kitchen-1', 'Active'],
        ['Grill', '6', '2', 'Kitchen-2', 'Active'],
        ['Bar', '7', '2', 'Bar-1', 'Active'],
        ['Pastry', '4', '1', 'Kitchen-1', 'Active'],
      ],
    },
    action: 'Add section',
    note: 'How a kitchen is divided up, and which dishes each part cooks. Each section gets its own screen showing only its dishes.',
  },
  waiter: {
    stats: [['Ready to serve', '3', 'ok'], ['In the kitchen', '8', 'warn'], ['Open requests', '2', 'bad'], ['Tables occupied', '11', 'info']],
    table: {
      title: 'Waiter station',
      columns: ['Table', 'What', 'Since', 'Status'],
      rows: [
        ['T11', 'Butter Chicken, King Coconut ×4 ready', '1 min', 'Ready'],
        ['T3', 'Margherita Pizza ready', 'now', 'Ready'],
        ['T7', 'Guest asked for water', '2 min', 'Waiting'],
        ['T4', 'Guest asked for the bill', '4 min', 'Waiting'],
        ['T13', 'Watalappan ×4 cooking', '3 min', 'Preparing'],
      ],
    },
    action: 'New order',
    note: 'When the kitchen marks a dish ready it appears here with a chime. Waiters serve dish by dish and take orders from their phone.',
  },
  'payment-details': {
    stats: [['Accounts', '5', 'info'], ['Collected today', rs(486250), 'ok'], ['Transfers to confirm', '2', 'warn'], ['In the bank', compact(2140000), 'brand']],
    table: {
      title: 'Accounts',
      columns: ['Account', 'Type', 'Collected today', 'Waiting', 'Status'],
      rows: [
        ['Cash drawer · Till 1', 'Cash', rs(68450), '—', 'Open'],
        ['Card terminal', 'Card', rs(186200), '—', 'Active'],
        ['QR pay', 'QR', rs(74300), '—', 'Active'],
        ['Current account', 'Bank transfer', rs(38800), '2 transfers', 'Pending'],
        ['Online payments', 'Online', rs(118500), '—', 'Active'],
      ],
    },
    note: 'Every account your money is filed under, and the bank transfers waiting to be confirmed.',
  },
  menu: {
    stats: [['Dishes', String(MENU.length), 'brand'], ['Categories', '4', 'info'], ['Sold out now', '1', 'bad'], ['With sizes or add-ons', '7', 'violet']],
    table: {
      title: 'Menu items',
      columns: ['Code', 'Dish', 'Category', 'Price', 'Available'],
      rows: MENU.slice(0, 12).map((m) => [codeOf(m.id), `${m.emoji} ${m.name}`, m.category, rs(m.price), m.id === 'm20' ? 'Off' : 'On']),
    },
    action: 'Add dish',
    note: 'Prices and availability can differ per branch. Switching a dish off hides it from the till and the guest menu at once.',
  },
  recipes: {
    stats: [['Dishes costed', '31', 'ok'], ['Average food cost', '31.8%', 'brand'], ['Over 40%', '3', 'bad'], ['No recipe yet', '0', 'info']],
    table: {
      title: 'Recipes, highest food cost first',
      columns: ['Dish', 'Sells for', 'Costs', 'Food cost', 'Margin'],
      rows: [
        ['Jaffna Crab Curry', rs(2900), rs(1305), '45%', rs(1595)],
        ['Grilled Seer Fish', rs(2250), rs(945), '42%', rs(1305)],
        ['Mutton Biryani', rs(2100), rs(860), '41%', rs(1240)],
        ['Chicken Biryani', rs(1650), rs(510), '31%', rs(1140)],
        ['Chicken Kottu', rs(1250), rs(350), '28%', rs(900)],
        ['Mango Smoothie', rs(590), rs(130), '22%', rs(460)],
      ],
    },
    note: 'What each dish costs to make. Every sale deducts its recipe from stock, so usage and profit are worked out for you.',
  },
  'menu-import': {
    stats: [['Dishes found', '31', 'ok'], ['Need a look', '2', 'warn'], ['Photos matched', '24', 'brand'], ['Time taken', '3 min', 'info']],
    table: {
      title: 'Scanned from your menu',
      columns: ['Dish', 'Category', 'Price', 'Photo', 'Status'],
      rows: [
        ['Chicken Kottu', 'Mains', rs(1250), 'Matched', 'Confirmed'],
        ['Cheese Kottu', 'Mains', rs(1450), 'Matched', 'Confirmed'],
        ['Hot Butter Cuttlefish', 'Mains', rs(1850), 'Matched', 'Confirmed'],
        ['Watalappan', 'Desserts', rs(550), 'Matched', 'Confirmed'],
        ['Faluda', 'Drinks', rs(590), 'None yet', 'Pending'],
      ],
    },
    action: 'Scan a menu',
    note: 'Take a photo of your printed menu and the dishes, categories and prices are read for you to check. Upload photos in bulk and they are matched to the right dish.',
  },
  loyalty: {
    stats: [['Members', '2,846', 'info'], ['Points given, 30 days', '128,400', 'brand'], ['Points used', '41,250', 'ok'], ['Come back again', '64%', 'violet']],
    table: {
      title: 'Rewards',
      columns: ['Reward', 'Costs', 'Needs a bill over', 'Used this month', 'Status'],
      rows: [
        ['Free Watalappan', '500 pts', '—', '38', 'Active'],
        ['Rs 1,000 off', '1,000 pts', rs(5000), '21', 'Active'],
        ['Rs 2,500 off', '2,400 pts', rs(10000), '6', 'Active'],
      ],
    },
    action: 'Add reward',
    note: 'Guests earn points on every bill with their mobile number, with no sign-up. They spend them at the till or from their phone.',
  },
  coupons: {
    stats: [['Active coupons', '4', 'ok'], ['Used, 30 days', '312', 'brand'], ['Discount given', rs(148600), 'warn'], ['Extra sales', compact(1260000), 'violet']],
    table: {
      title: 'Coupons',
      columns: ['Code', 'Offer', 'For', 'Used', 'Status'],
      rows: [
        ['VIP15', '15% off, up to Rs 1,500', 'VIP customers', '96', 'Active'],
        ['WELCOME10', '10% off', 'New customers', '141', 'Active'],
        ['FEAST500', 'Rs 500 off over Rs 3,000', 'Everyone', '62', 'Active'],
        ['HAPPYHOUR', '20% off drinks', '3 pm to 6 pm', '13', 'Active'],
        ['NEWYEAR', '12% off', 'Everyone', '204', 'Expired'],
      ],
    },
    action: 'New coupon',
    note: 'Limit an offer by customer group, time of day, day of the week, branch, minimum spend or uses per customer.',
  },
  'stock-ledger': {
    stats: [['Movements today', '214', 'brand'], ['Value in', rs(146000), 'ok'], ['Value out', rs(154600), 'warn'], ['Locations', '5', 'info']],
    table: {
      title: 'Stock ledger, newest first',
      columns: ['When', 'Item', 'Movement', 'Qty', 'Value', 'Location'],
      rows: [
        ['7:42 pm', 'Chicken (whole)', 'Sale · #1047', '− 1.2 kg', rs(1500), 'Colombo 03'],
        ['7:40 pm', 'Basmati Rice', 'Sale · #1047', '− 0.9 kg', rs(378), 'Colombo 03'],
        ['5:15 pm', 'Prawns', 'Transfer out · TR-0148', '− 6 kg', rs(16800), 'Colombo 03'],
        ['2:30 pm', 'Seer Fish', 'Purchase · PO-0311', '+ 15 kg', rs(48000), 'Colombo 03'],
        ['11:05 am', 'Tomatoes', 'Wastage', '− 1.5 kg', rs(570), 'Kandy City'],
        ['9:00 am', 'Coffee Beans', 'Count adjustment', '− 0.2 kg', rs(1040), 'Galle Fort'],
      ],
    },
    note: 'Every movement, newest first, valued at the cost in force when it happened.',
  },
  'stock-counts': {
    stats: [['Counts this month', '6', 'brand'], ['Waiting for approval', '1', 'warn'], ['Items counted', '148', 'info'], ['Net difference', `− ${rs(4350)}`, 'bad']],
    table: {
      title: 'Stock counts',
      columns: ['Count', 'Location', 'Items', 'Difference', 'Status'],
      rows: [
        ['SC-0042 · 30 Sep', 'Colombo 03', '25', `− ${rs(1840)}`, 'Pending'],
        ['SC-0041 · 28 Sep', 'Galle Fort', '25', `− ${rs(2510)}`, 'Approved'],
        ['SC-0040 · 25 Sep', 'Kandy City', '24', rs(0), 'Approved'],
      ],
    },
    action: 'Start a count',
    note: 'Count the shelf, then have the difference approved. Counting never moves stock on its own.',
  },
  adjustments: {
    stats: [['This month', '11', 'brand'], ['Waiting', '1', 'warn'], ['Net value', `− ${rs(6200)}`, 'bad'], ['By count', '7', 'info']],
    table: {
      title: 'Stock adjustments',
      columns: ['Item', 'Change', 'Reason', 'By', 'Status'],
      rows: [
        ['Coffee Beans', '− 0.2 kg', 'Count difference', 'Ravi', 'Approved'],
        ['Eggs', '− 12 pcs', 'Broken in delivery', 'Anura', 'Approved'],
        ['Cooking Oil', '+ 2 L', 'Found in the store room', 'Ravi', 'Pending'],
      ],
    },
    action: 'New adjustment',
  },
  wastage: {
    stats: [['Wasted this month', rs(38400), 'bad'], ['Share of food cost', '1.9%', 'warn'], ['Most wasted', 'Tomatoes', 'info'], ['Entries', '42', 'brand']],
    table: {
      title: 'Wastage',
      columns: ['Item', 'Qty', 'Reason', 'Cost', 'By'],
      rows: [
        ['Tomatoes', '1.5 kg', 'Spoiled', rs(570), 'Anura'],
        ['Chicken (whole)', '0.8 kg', 'Dropped', rs(1000), 'Malik'],
        ['Fresh Milk', '2 L', 'Expired', rs(780), 'Ravi'],
        ['Mozzarella', '0.3 kg', 'Burnt pizza', rs(1170), 'Anura'],
      ],
    },
    action: 'Record wastage',
    note: 'What went in the bin, why, and what it cost. Never counted as a sale.',
  },
  expiry: {
    stats: [['Expiring in 3 days', '4', 'warn'], ['Expired', '1', 'bad'], ['Batches tracked', '63', 'info'], ['Value at risk', rs(11200), 'brand']],
    table: {
      title: 'Expiry',
      columns: ['Item', 'Batch', 'Expires', 'Qty', 'Status'],
      rows: [
        ['Fresh Milk', 'B-2291', 'Today', '6 L', 'Expired'],
        ['Mozzarella', 'B-2284', 'Tomorrow', '2 kg', 'Soon'],
        ['Prawns', 'B-2290', 'In 2 days', '4 kg', 'Soon'],
        ['Ice Cream', 'B-2270', 'In 21 days', '12 L', 'Active'],
      ],
    },
    note: 'Oldest stock is used first. You are warned before a batch expires, not after.',
  },
  variance: {
    stats: [['Counts compared', '6', 'info'], ['Items with a gap', '9', 'warn'], ['Total shortfall', rs(7640), 'bad'], ['Worst item', 'Coffee Beans', 'brand']],
    table: {
      title: 'Stock variance',
      columns: ['Item', 'System held', 'Counted', 'Gap', 'Value'],
      rows: [
        ['Coffee Beans', '3.2 kg', '3.0 kg', '− 0.2 kg', rs(1040)],
        ['Prawns', '6.5 kg', '6.0 kg', '− 0.5 kg', rs(1400)],
        ['Cooking Oil', '44 L', '46 L', '+ 2 L', rs(1380)],
        ['Butter', '7.4 kg', '7.0 kg', '− 0.4 kg', rs(1040)],
      ],
    },
    note: 'The gap between what the system held and what was actually on the shelf, from approved stock counts.',
  },
  reconciliation: {
    stats: [['Items reconciled', '25', 'ok'], ['Balanced', '23', 'ok'], ['To look at', '2', 'bad'], ['Period', 'September', 'info']],
    table: {
      title: 'Stock reconciliation',
      columns: ['Item', 'Opening', 'In', 'Out', 'Should be left', 'Result'],
      rows: [
        ['Basmati Rice', '120 kg', '+ 200 kg', '− 235 kg', '85 kg', 'Match'],
        ['Chicken (whole)', '40 kg', '+ 310 kg', '− 318 kg', '32 kg', 'Match'],
        ['Prawns', '8 kg', '+ 60 kg', '− 61.5 kg', '6.5 kg', 'Look here'],
        ['Coffee Beans', '5 kg', '+ 12 kg', '− 13.8 kg', '3.2 kg', 'Look here'],
      ],
    },
    note: 'What you started with, everything that came in and went out, and what should be left. If the books balance, every stock figure can be trusted.',
  },
  'daily-close': {
    stats: [['Days signed this month', '29', 'ok'], ['Waiting', '1', 'warn'], ['Sealed up to', '28 Sep', 'info'], ['Sales this month', compact(12846300), 'brand']],
    table: {
      title: 'Daily close',
      columns: ['Day', 'Sales', 'Cash counted', 'Signed by', 'Status'],
      rows: [
        ['30 Sep', rs(486250), '—', '—', 'Pending'],
        ['29 Sep', rs(309850), rs(71200), 'Priya', 'Signed'],
        ['28 Sep', rs(301900), rs(68900), 'Priya', 'Sealed'],
        ['27 Sep', rs(571300), rs(122400), 'Owner', 'Sealed'],
      ],
    },
    action: 'Sign off today',
    note: 'Sign off each day’s figures, then seal signed ranges so nothing edits into them.',
  },
  units: {
    stats: [['Units', '8', 'info'], ['Categories', '6', 'brand'], ['Items using them', '25', 'ok'], ['Unused', '0', 'violet']],
    table: {
      title: 'Units and categories',
      columns: ['Name', 'Kind', 'Used by', 'Status'],
      rows: [
        ['kg', 'Unit', '16 items', 'Active'],
        ['L', 'Unit', '5 items', 'Active'],
        ['pcs', 'Unit', '2 items', 'Active'],
        ['Meat & fish', 'Category', '5 items', 'Active'],
        ['Vegetables', 'Category', '6 items', 'Active'],
        ['Dry goods', 'Category', '6 items', 'Active'],
      ],
    },
    note: 'The two lists every stock item picks from. Getting these right once saves typing them differently forever after.',
  },
  suppliers: {
    stats: [['Suppliers', '12', 'info'], ['You owe', rs(384200), 'warn'], ['Overdue', rs(46000), 'bad'], ['Bought this month', compact(2140000), 'brand']],
    table: {
      title: 'Suppliers',
      columns: ['Supplier', 'Supplies', 'You owe', 'Last order', 'Status'],
      rows: [
        ['Lanka Seafood Suppliers', 'Prawns, fish, crab', rs(146000), 'Today', 'Active'],
        ['Hill Country Produce', 'Vegetables, fruit', rs(38200), 'Yesterday', 'Active'],
        ['Ceylon Dry Goods', 'Rice, flour, sugar, oil', rs(154000), '27 Sep', 'Active'],
        ['Highland Dairy', 'Milk, butter, cheese', rs(46000), '21 Sep', 'Overdue'],
      ],
    },
    action: 'Add supplier',
  },
  purchasing: {
    stats: [['Open orders', '5', 'brand'], ['Waiting for approval', '1', 'warn'], ['On the way', '2', 'violet'], ['Ordered this month', compact(2140000), 'ok']],
    table: {
      title: 'Purchase orders',
      columns: ['PO', 'Supplier', 'Items', 'Total', 'Status'],
      rows: [
        ['PO-0312', 'Lanka Seafood Suppliers', '3', rs(146000), 'Pending'],
        ['PO-0311', 'Lanka Seafood Suppliers', '2', rs(64000), 'Approved'],
        ['PO-0310', 'Hill Country Produce', '6', rs(38200), 'Ordered'],
        ['PO-0309', 'Ceylon Dry Goods', '4', rs(154000), 'Received'],
      ],
    },
    action: 'New purchase order',
    note: 'Request and get approval before purchasing. Stock only moves when goods arrive.',
  },
  'goods-received': {
    stats: [['To receive', '2', 'warn'], ['Received this month', '31', 'ok'], ['Short deliveries', '3', 'bad'], ['Value received', compact(1986000), 'brand']],
    table: {
      title: 'Goods received (GRN)',
      columns: ['GRN', 'PO', 'Supplier', 'Received', 'Status'],
      rows: [
        ['—', 'PO-0311', 'Lanka Seafood Suppliers', 'Waiting', 'Pending'],
        ['GRN-0298', 'PO-0309', 'Ceylon Dry Goods', 'All 4 items', 'Received'],
        ['GRN-0297', 'PO-0308', 'Highland Dairy', '5 of 6 items', 'Short'],
      ],
    },
    action: 'Receive goods',
    note: 'Receive goods against an approved purchase order. Stock moves then, and not before.',
  },
  'customer-insights': {
    stats: [['Customers', '2,846', 'info'], ['New this month', '214', 'ok'], ['Average visits', '3.4', 'violet'], ['Lifetime value', rs(14200), 'brand']],
    chart: { title: 'New customers by day', data: week([24, 31, 46, 41, 18, 22, 32]) },
    table: {
      title: 'Segments',
      columns: ['Segment', 'Customers', 'Share of sales', 'Average bill'],
      rows: [
        ['VIP', '184', '31%', rs(6900)],
        ['Regular', '1,122', '46%', rs(4180)],
        ['New', '214', '9%', rs(3300)],
        ['Not seen for 60 days', '1,326', '14%', rs(3650)],
      ],
    },
    note: 'Save any filter as a segment, then aim a coupon at it or export the numbers for an SMS campaign.',
  },
  staff: {
    stats: [['Staff', '46', 'info'], ['On shift now', '17', 'ok'], ['Roles', '9', 'violet'], ['Invites pending', '2', 'warn']],
    table: {
      title: 'Staff',
      columns: ['Name', 'Role', 'Location', 'Code', 'Status'],
      rows: [
        ['Priya', 'Manager', 'Kandy City', 'PR01', 'Active'],
        ['Sara', 'Cashier', 'Colombo 03', 'SA07', 'Active'],
        ['Dev', 'Waiter', 'Colombo 03', 'DV12', 'Active'],
        ['Anura', 'Chef', 'Colombo 03', 'AN03', 'Active'],
        ['Ravi', 'Store keeper', 'Colombo 03', 'RV09', 'Active'],
        ['Dilshan', 'Cashier', 'Colombo 03', 'DL15', 'Pending'],
      ],
    },
    action: 'Add staff',
  },
  shifts: {
    stats: [['Shift types', '3', 'info'], ['On shift now', '17', 'ok'], ['Handovers today', '4', 'brand'], ['Late starts', '1', 'warn']],
    table: {
      title: 'Shifts',
      columns: ['Shift', 'Hours', 'People on it', 'Handover', 'Status'],
      rows: [
        ['Morning', '7:00 am – 3:00 pm', '14', 'Balanced exactly', 'Completed'],
        ['Evening', '3:00 pm – 11:00 pm', '17', 'Due at 11:00 pm', 'Active'],
        ['Night close', '11:00 pm – 1:00 am', '4', '—', 'Scheduled'],
      ],
    },
    note: 'The kinds of shift you run, who is on them, and how every shift and handover went.',
  },
  roles: {
    stats: [['Roles', '9', 'violet'], ['Custom roles', '4', 'brand'], ['People assigned', '46', 'info'], ['Features to switch', '70+', 'ok']],
    table: {
      title: 'Roles and access',
      columns: ['Role', 'Can open', 'People', 'Location'],
      rows: [
        ['Administrator', 'Every tab', '2', 'Any location'],
        ['Front till', 'Dashboard, Transfers, POS', '5', 'Any location'],
        ['Floor lead', 'Live floor, Approvals, Waiter station', '3', 'Pinned to Colombo 03'],
        ['Store keeper', 'Stock, Transfers, Goods received', '4', 'Any location'],
        ['Accounts', 'Accounting, Reports', '2', 'Any location'],
      ],
    },
    action: 'Create role',
    note: 'Give a job title only the features it needs. Changes reach everyone in the role straight away.',
  },
  'staff-codes': {
    stats: [['Codes issued', '46', 'info'], ['Signed in today', '17', 'ok'], ['Orders credited today', '142', 'brand'], ['Links shared', '12', 'violet']],
    table: {
      title: 'Staff codes',
      columns: ['Name', 'Code', 'Sign-in link', 'Orders today'],
      rows: [
        ['Dev', 'DV12', 'Copied', '31'],
        ['Sara', 'SA07', 'Copied', '44'],
        ['Nimal', 'NM04', 'Not shared', '27'],
        ['Priya', 'PR01', 'Copied', '9'],
      ],
    },
    note: 'Every person has a short code and their own sign-in link. Orders they take are credited to that code.',
  },
  reviews: {
    stats: [['Average rating', '4.6 ★', 'ok'], ['Reviews', '1,284', 'info'], ['Waiting for a reply', '3', 'warn'], ['This month', '96', 'brand']],
    table: {
      title: 'Reviews',
      columns: ['Guest', 'Dish', 'Rating', 'Comment', 'Status'],
      rows: [
        ['Nimal P.', 'Jaffna Crab Curry', '5 ★', 'Best crab in Colombo.', 'Published'],
        ['Tharushi F.', 'Margherita Pizza', '4 ★', 'Good, a little slow.', 'Published'],
        ['Guest', 'Chicken Kottu', '2 ★', 'Too spicy for the kids.', 'Pending'],
      ],
    },
  },
  feedback: {
    stats: [['Responses this week', '212', 'info'], ['Great or good', '91%', 'ok'], ['Bad', '3%', 'bad'], ['With a note', '38', 'brand']],
    table: {
      title: 'Feedback',
      columns: ['When', 'Rating', 'Note', 'Table'],
      rows: [
        ['7:40 pm', '😍 Great', 'Ordering from the phone was so easy.', 'T7'],
        ['7:12 pm', '🙂 Good', '—', 'T4'],
        ['6:55 pm', '😐 Okay', 'Bill took a while to arrive.', 'T13'],
        ['1:20 pm', '😍 Great', 'Loved the tracker.', 'T3'],
      ],
    },
    note: 'Quick, anonymous guest feedback. No personal details, so guests actually leave it.',
  },
  'acc-overview': {
    stats: [['Income this month', compact(12846300), 'ok'], ['Costs this month', compact(8208800), 'warn'], ['Net profit', compact(4637500), 'brand'], ['Owed to suppliers', rs(384200), 'bad']],
    chart: { title: 'Net profit by day', data: week([142000, 188000, 224000, 209000, 104000, 109000, 175000]) },
    table: {
      title: 'Where the money went',
      columns: ['Category', 'This month', 'Share of income'],
      rows: [
        ['Cost of food', compact(4085000), '31.8%'],
        ['Staff', compact(2698000), '21.0%'],
        ['Rent and utilities', compact(1156000), '9.0%'],
        ['Discounts and refunds', compact(269800), '2.1%'],
      ],
    },
  },
  'money-out': {
    stats: [['Drafts', '2', 'info'], ['Waiting for sign-off', '3', 'warn'], ['Paid this month', compact(3420000), 'ok'], ['To pay this week', rs(212000), 'brand']],
    table: {
      title: 'Payments out',
      columns: ['Payment', 'To', 'Amount', 'Status'],
      rows: [
        ['PAY-0518', 'Lanka Seafood Suppliers', rs(146000), 'Submitted'],
        ['PAY-0517', 'Electricity Board', rs(84200), 'Approved'],
        ['PAY-0516', 'Ceylon Dry Goods', rs(154000), 'Paid'],
        ['PAY-0515', 'Staff advances', rs(40000), 'Draft'],
      ],
    },
    action: 'New payment',
    note: 'Draft it, submit it for the owner’s sign-off, then pay it. A paid payment cannot be edited; corrections reverse it.',
  },
  'acc-approvals': {
    stats: [['Waiting', '3', 'warn'], ['Approved this month', '41', 'ok'], ['Sent back', '2', 'info'], ['Rejected', '1', 'bad']],
    table: {
      title: 'Approvals',
      columns: ['Request', 'By', 'Amount', 'Status'],
      rows: [
        ['Pay Lanka Seafood Suppliers', 'Accounts · Ishara', rs(146000), 'Pending'],
        ['Gas cylinders, October', 'Priya', rs(36000), 'Pending'],
        ['Kitchen equipment repair', 'Anura', rs(18500), 'Pending'],
        ['Electricity, September', 'Accounts · Ishara', rs(84200), 'Approved'],
      ],
    },
    note: 'Money leaves the business only past this desk. Approve, reject with a reason, or send it back for changes.',
  },
  expenses: {
    stats: [['This month', compact(1284000), 'warn'], ['Entries', '64', 'info'], ['Biggest', 'Rent', 'brand'], ['Waiting', '2', 'warn']],
    table: {
      title: 'Expenses',
      columns: ['Expense', 'Category', 'Amount', 'Date', 'Status'],
      rows: [
        ['Rent, October', 'Rent', rs(650000), '30 Sep', 'Approved'],
        ['Electricity, September', 'Utilities', rs(84200), '28 Sep', 'Paid'],
        ['Gas cylinders', 'Utilities', rs(36000), '27 Sep', 'Pending'],
        ['Cleaning supplies', 'Housekeeping', rs(12400), '26 Sep', 'Paid'],
      ],
    },
  },
  payables: {
    stats: [['You owe', rs(384200), 'warn'], ['Overdue', rs(46000), 'bad'], ['Due this week', rs(184200), 'brand'], ['Suppliers', '4', 'info']],
    table: {
      title: 'Supplier payables',
      columns: ['Supplier', 'Invoices', 'Owed', 'Oldest', 'Status'],
      rows: [
        ['Ceylon Dry Goods', '2', rs(154000), '9 days', 'Due soon'],
        ['Lanka Seafood Suppliers', '1', rs(146000), 'Today', 'Pending'],
        ['Highland Dairy', '1', rs(46000), '38 days', 'Overdue'],
        ['Hill Country Produce', '1', rs(38200), '2 days', 'Pending'],
      ],
    },
  },
  checks: {
    stats: [['Checks run', '6', 'info'], ['Match', '5', 'ok'], ['To look at', '1', 'bad'], ['Last run', 'Today', 'brand']],
    table: {
      title: 'Checks',
      columns: ['Check', 'Recorded', 'Actual', 'Difference', 'Result'],
      rows: [
        ['Sales against payments', rs(486250), rs(486250), rs(0), 'Match'],
        ['Cash sales against drawer', rs(68450), rs(68100), `− ${rs(350)}`, 'Look here'],
        ['Card sales against terminal', rs(186200), rs(186200), rs(0), 'Match'],
        ['Stock used against recipes', rs(154600), rs(154600), rs(0), 'Match'],
      ],
    },
    note: 'Compare what was recorded with what actually happened, and see exactly where to look when they differ.',
  },
  ledger: {
    stats: [['Entries this month', '3,914', 'info'], ['Debits', compact(21055000), 'brand'], ['Credits', compact(21055000), 'brand'], ['Balanced', 'Yes', 'ok']],
    table: {
      title: 'Ledger',
      columns: ['Date', 'Account', 'Description', 'Debit', 'Credit'],
      rows: [
        ['30 Sep', 'Cash drawer', 'Bill #1040 paid', rs(6050), '—'],
        ['30 Sep', 'Sales', 'Bill #1040', '—', rs(5500)],
        ['30 Sep', 'Service charge', 'Bill #1040', '—', rs(550)],
        ['30 Sep', 'Stock', 'PO-0311 received', rs(64000), '—'],
        ['30 Sep', 'Supplier payables', 'Lanka Seafood Suppliers', '—', rs(64000)],
      ],
    },
  },
  'acc-reports': {
    stats: [['Income', compact(12846300), 'ok'], ['Costs', compact(8208800), 'warn'], ['Net profit', compact(4637500), 'brand'], ['Margin', '36.1%', 'violet']],
    table: {
      title: 'Profit and loss, September',
      columns: ['Line', 'Amount', 'Share of income'],
      rows: [
        ['Sales', compact(12846300), '100%'],
        ['Cost of food', `− ${compact(4085000)}`, '31.8%'],
        ['Staff', `− ${compact(2698000)}`, '21.0%'],
        ['Rent and utilities', `− ${compact(1156000)}`, '9.0%'],
        ['Discounts and refunds', `− ${compact(269800)}`, '2.1%'],
        ['Net profit', compact(4637500), '36.1%'],
      ],
    },
    action: 'Export',
  },
  'close-month': {
    stats: [['Open month', 'September', 'info'], ['Days signed', '29 of 30', 'warn'], ['Checks passing', '5 of 6', 'warn'], ['Last closed', 'August', 'ok']],
    table: {
      title: 'Close month',
      columns: ['Month', 'Income', 'Costs', 'Net', 'Status'],
      rows: [
        ['September', compact(12846300), compact(8208800), compact(4637500), 'Open'],
        ['August', compact(11920000), compact(7710000), compact(4210000), 'Closed'],
        ['July', compact(11140000), compact(7390000), compact(3750000), 'Closed'],
      ],
    },
    action: 'Close September',
    note: 'Once a month is closed its figures are locked. Anything found later is corrected in the next month, in the open.',
  },
  tools: {
    stats: [['Bill calculator', 'Ready', 'ok'], ['Price change test', 'Ready', 'ok'], ['Saved', 'Nothing', 'info'], ['Uses your tax rules', 'Yes', 'brand']],
    table: {
      title: 'Test a price change: Jaffna Crab Curry',
      columns: ['', 'Today', 'If you change it'],
      rows: [
        ['Price', rs(2900), rs(3200)],
        ['Food cost', '45%', '41%'],
        ['Profit per plate', rs(1595), rs(1895)],
        ['Extra profit a month, at 121 sold', '—', rs(36300)],
      ],
    },
    note: 'Quick sums in the same math the bills use, and a way to test a price change safely. Nothing here is saved.',
  },
  'qr-menus': {
    stats: [['QR menus', '4', 'brand'], ['Scans today', '326', 'info'], ['Orders from QR', '38', 'ok'], ['Menu-only views', '112', 'violet']],
    table: {
      title: 'QR menus',
      columns: ['Name', 'Type', 'Asks for', 'Scans today', 'Status'],
      rows: [
        ['Table ordering', 'Ordering', 'Table number', '188', 'Active'],
        ['Takeaway and delivery', 'Ordering', 'Name, phone, place', '64', 'Active'],
        ['Instagram menu', 'Menu only', 'Nothing', '74', 'Active'],
        ['Hostel delivery', 'Ordering', 'Phone, customer type', '—', 'Draft'],
      ],
    },
    action: 'Create a QR menu',
    note: 'What a guest sees when they scan. Create one, choose what it shows and what it asks, then print the code. Open “Guest QR menu” in this demo to walk through it.',
  },
  'audit-log': {
    stats: [['Actions today', '412', 'info'], ['Discounts', '9', 'warn'], ['Cancelled items', '3', 'bad'], ['People active', '17', 'ok']],
    table: {
      title: 'Audit log',
      columns: ['When', 'Who', 'Action', 'Details'],
      rows: [
        ['7:44 pm', 'Owner', 'Approved a discount', '15% on Table 4, asked by Dev'],
        ['7:31 pm', 'Sara', 'Printed a bill', '#1043, first print'],
        ['7:12 pm', 'Dev', 'Cancelled an item', 'Garlic Bread on #1045 · guest changed their mind'],
        ['6:40 pm', 'Sara', 'Held a bill', '#1039 for Fathima Rizwan'],
        ['5:15 pm', 'Anura', 'Requested a transfer', 'TR-0148 to Galle Fort'],
      ],
    },
    note: 'Every administrative action, recorded with who did it and when.',
  },
  settings: {
    stats: [['Sections', '9', 'info'], ['Currency', 'LKR', 'brand'], ['Service charge', '10%', 'ok'], ['Receipt width', '80 mm', 'violet']],
    table: {
      title: 'Settings',
      columns: ['Section', 'What you set there'],
      rows: [
        ['Profile', 'Name, logo, address, opening hours'],
        ['Tax & charges', 'Tax rate and label, service charge, rounding'],
        ['Payments', 'Which payment methods are on, bank details for transfers'],
        ['Loyalty', 'How points are earned and what a point is worth'],
        ['Printer & bill', 'Paper width and what prints on the receipt'],
        ['Cash controls', 'Discount limits and what needs approval'],
        ['Live floor', 'Waiting-time warnings and table colours'],
        ['Guest experience', 'What the guest menu shows and asks'],
        ['SMS', 'Order-ready and delivery texts to guests'],
      ],
    },
  },
  'share-links': {
    stats: [['Links', '14', 'info'], ['Personal', '11', 'brand'], ['Shared screens', '3', 'violet'], ['Opened today', '9', 'ok']],
    table: {
      title: 'Access links',
      columns: ['For', 'Type', 'Opens', 'Status'],
      rows: [
        ['Dev (Waiter)', 'Personal', 'Waiter station', 'Active'],
        ['Sara (Cashier)', 'Personal', 'POS', 'Active'],
        ['Kitchen TV', 'Shared screen', 'Kitchen display', 'Active'],
        ['Bar tablet', 'Shared screen', 'Kitchen section · Bar', 'Active'],
      ],
    },
    action: 'Create a link',
    note: 'One link per person or screen. A personal link asks for an email and code; a shared screen signs itself in.',
  },
}

export const hasGenericScreen = (id: string) => id in SCREENS || id === 'qr-code'

export function GenericScreen({ id, qr }: { id: string; qr: QrShape }) {
  const notify = useNotify()
  if (id === 'qr-code') return <QrCodes qr={qr} />
  const screen = SCREENS[id]
  if (!screen) return null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {screen.stats.map(([label, value, tone]) => (
          <Card key={label} className="flex flex-col gap-1">
            <span className={cn('tfd-pill w-fit', `tfd-pill-${tone ?? 'neutral'}`)}>{label}</span>
            <p className="text-lg font-bold tabular-nums tracking-tight sm:text-xl">{value}</p>
          </Card>
        ))}
      </div>

      {screen.chart ? (
        <Card>
          <CardTitle>{screen.chart.title}</CardTitle>
          <AreaChart data={screen.chart.data} format={(v) => (v > 5000 ? compact(v) : String(v))} height={190} />
        </Card>
      ) : null}

      {screen.table ? (
        <Card className="!p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
            <h3 className="text-sm font-semibold">{screen.table.title}</h3>
            {screen.action ? (
              <button type="button" className="tfd-btn tfd-btn-primary px-3.5 py-1.5 text-xs" onClick={() => notify(`“${screen.action}” works in the real system. This demo shows sample data only.`)}>
                {screen.action}
              </button>
            ) : null}
          </div>
          <div className="tfd-thin-scroll mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="tfd-muted text-[11px] uppercase tracking-wider">
                  {screen.table.columns.map((c, i) => (
                    <th key={i} className="tfd-line whitespace-nowrap border-b px-4 py-2 font-semibold">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {screen.table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} className={cn('tfd-line border-b px-4 py-2.5 align-top', c === 0 && 'font-semibold', cell.length < 28 && 'whitespace-nowrap', r === screen.table!.rows.length - 1 && 'border-b-0')}>
                        {BADGES[cell] ? <Pill tone={BADGES[cell]}>{cell}</Pill> : cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {screen.note ? (
        <p className="tfd-muted flex items-start gap-2 text-xs">
          <Sparkles className="tfd-brand mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {screen.note}
        </p>
      ) : null}
    </div>
  )
}

// ── Table QR codes ──────────────────────────────────────────────────────────

function QrCodes({ qr }: { qr: QrShape }) {
  const notify = useNotify()
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'].map((t) => (
          <Card key={t} className="text-center">
            <div className="mx-auto w-fit rounded-xl bg-white p-2">
              <QrCode qr={qr} className="h-24 w-24" />
            </div>
            <p className="mt-2 text-sm font-bold">Table {t.slice(1)}</p>
            <p className="tfd-muted text-[11px]">Scan to order</p>
          </Card>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="tfd-btn tfd-btn-primary px-4 py-2 text-xs" onClick={() => notify('In the real system this downloads every table’s QR as a print-ready sheet.')}>
          Print all table codes
        </button>
        <button type="button" className="tfd-btn tfd-btn-glass px-4 py-2 text-xs" onClick={() => notify('In the real system this downloads one code as an image.')}>
          Download one
        </button>
      </div>
      <p className="tfd-muted flex items-start gap-2 text-xs">
        <Sparkles className="tfd-brand mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        Every table has its own code, so the order arrives already knowing the table. The codes here all open this demo.
      </p>
    </div>
  )
}
