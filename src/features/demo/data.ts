/*
 * Mock data for the public demo at /demo.
 *
 * Nothing here is read from, or written to, a database. It is a made-up
 * restaurant ("Spice Garden", three branches) that exists only so a visitor
 * who scans the visiting-card QR has something alive to look at.
 */

export const WHATSAPP_NUMBER = '94710135558'
export const WHATSAPP_DISPLAY = '+94 71 013 5558'

export function whatsappLink(message: string) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`
}

export const BOOK_LINK = whatsappLink(
  "Hi! I saw the TableFlow demo and I'd like to book a free demo for my restaurant.",
)
export const CHAT_LINK = whatsappLink('Hi! I have a question about TableFlow.')

/** Rupees, the way a Sri Lankan till prints them. Fixed locale so server and browser agree. */
export function rs(amount: number) {
  return `Rs ${Math.round(amount).toLocaleString('en-US')}`
}

export function compact(amount: number) {
  if (amount >= 1_000_000) return `Rs ${(amount / 1_000_000).toFixed(2)}M`
  if (amount >= 1_000) return `Rs ${(amount / 1_000).toFixed(amount >= 100_000 ? 0 : 1)}K`
  return rs(amount)
}

export const BRANCHES = ['Colombo 03', 'Kandy City', 'Galle Fort'] as const
export type Branch = (typeof BRANCHES)[number]

// ── Menu ────────────────────────────────────────────────────────────────────

export type MenuCategory = 'Starters' | 'Mains' | 'Desserts' | 'Drinks'

export interface MenuItem {
  id: string
  name: string
  category: MenuCategory
  price: number
  emoji: string
  tag?: 'Popular' | 'Spicy' | 'New' | 'Veg'
  station: 'Hot kitchen' | 'Grill' | 'Bar' | 'Pastry'
}

export const MENU_CATEGORIES: MenuCategory[] = ['Starters', 'Mains', 'Desserts', 'Drinks']

export const MENU: MenuItem[] = [
  { id: 'm01', name: 'Chicken Satay', category: 'Starters', price: 950, emoji: '🍢', tag: 'Popular', station: 'Grill' },
  { id: 'm02', name: 'Devilled Prawns', category: 'Starters', price: 1450, emoji: '🍤', tag: 'Spicy', station: 'Hot kitchen' },
  { id: 'm03', name: 'Crispy Calamari', category: 'Starters', price: 1350, emoji: '🦑', station: 'Hot kitchen' },
  { id: 'm04', name: 'Vegetable Spring Rolls', category: 'Starters', price: 750, emoji: '🥟', tag: 'Veg', station: 'Hot kitchen' },
  { id: 'm05', name: 'Cream of Mushroom Soup', category: 'Starters', price: 690, emoji: '🍲', tag: 'Veg', station: 'Hot kitchen' },
  { id: 'm06', name: 'Garlic Bread', category: 'Starters', price: 550, emoji: '🥖', tag: 'Veg', station: 'Grill' },
  { id: 'm07', name: 'Chicken Kottu', category: 'Mains', price: 1250, emoji: '🍛', tag: 'Popular', station: 'Hot kitchen' },
  { id: 'm08', name: 'Cheese Kottu', category: 'Mains', price: 1450, emoji: '🧀', tag: 'Popular', station: 'Hot kitchen' },
  { id: 'm09', name: 'Seafood Fried Rice', category: 'Mains', price: 1550, emoji: '🍚', station: 'Hot kitchen' },
  { id: 'm10', name: 'Chicken Biryani', category: 'Mains', price: 1650, emoji: '🍗', tag: 'Popular', station: 'Hot kitchen' },
  { id: 'm11', name: 'Mutton Biryani', category: 'Mains', price: 2100, emoji: '🍖', station: 'Hot kitchen' },
  { id: 'm12', name: 'Nasi Goreng', category: 'Mains', price: 1600, emoji: '🍳', tag: 'Spicy', station: 'Hot kitchen' },
  { id: 'm13', name: 'Rice & Curry', category: 'Mains', price: 950, emoji: '🍱', station: 'Hot kitchen' },
  { id: 'm14', name: 'Grilled Seer Fish', category: 'Mains', price: 2250, emoji: '🐟', station: 'Grill' },
  { id: 'm15', name: 'Butter Chicken', category: 'Mains', price: 1750, emoji: '🥘', station: 'Hot kitchen' },
  { id: 'm16', name: 'Beef Burger', category: 'Mains', price: 1490, emoji: '🍔', tag: 'New', station: 'Grill' },
  { id: 'm17', name: 'Margherita Pizza', category: 'Mains', price: 1890, emoji: '🍕', tag: 'Veg', station: 'Grill' },
  { id: 'm18', name: 'Chicken Pasta Alfredo', category: 'Mains', price: 1690, emoji: '🍝', station: 'Hot kitchen' },
  { id: 'm19', name: 'Hot Butter Cuttlefish', category: 'Mains', price: 1850, emoji: '🌶️', tag: 'Spicy', station: 'Hot kitchen' },
  { id: 'm20', name: 'Jaffna Crab Curry', category: 'Mains', price: 2900, emoji: '🦀', tag: 'Spicy', station: 'Hot kitchen' },
  { id: 'm21', name: 'Watalappan', category: 'Desserts', price: 550, emoji: '🍮', tag: 'Popular', station: 'Pastry' },
  { id: 'm22', name: 'Chocolate Lava Cake', category: 'Desserts', price: 850, emoji: '🍫', station: 'Pastry' },
  { id: 'm23', name: 'Curd & Treacle', category: 'Desserts', price: 450, emoji: '🥣', station: 'Pastry' },
  { id: 'm24', name: 'Ice Cream Sundae', category: 'Desserts', price: 690, emoji: '🍨', station: 'Pastry' },
  { id: 'm25', name: 'Fresh Lime Juice', category: 'Drinks', price: 390, emoji: '🍋', station: 'Bar' },
  { id: 'm26', name: 'Mango Smoothie', category: 'Drinks', price: 590, emoji: '🥭', tag: 'Popular', station: 'Bar' },
  { id: 'm27', name: 'Iced Milo', category: 'Drinks', price: 450, emoji: '🥤', station: 'Bar' },
  { id: 'm28', name: 'Ceylon Tea', category: 'Drinks', price: 250, emoji: '🍵', station: 'Bar' },
  { id: 'm29', name: 'King Coconut', category: 'Drinks', price: 350, emoji: '🥥', station: 'Bar' },
  { id: 'm30', name: 'Cappuccino', category: 'Drinks', price: 550, emoji: '☕', station: 'Bar' },
  { id: 'm31', name: 'Faluda', category: 'Drinks', price: 590, emoji: '🧋', tag: 'New', station: 'Bar' },
]

export const menuById = (id: string) => MENU.find((m) => m.id === id)!

// ── Live order feed (command center) ────────────────────────────────────────

export type Channel = 'Dine-in' | 'QR order' | 'Takeaway' | 'Delivery'

export interface FeedOrder {
  no: number
  channel: Channel
  where: string
  items: string
  total: number
  branch: Branch
}

export const FEED_POOL: Omit<FeedOrder, 'no'>[] = [
  { channel: 'QR order', where: 'Table 7', items: 'Chicken Kottu ×2, Lime Juice ×2', total: 3280, branch: 'Colombo 03' },
  { channel: 'Delivery', where: 'Wellawatte', items: 'Chicken Biryani ×3, Watalappan ×2', total: 6050, branch: 'Colombo 03' },
  { channel: 'Dine-in', where: 'Table 12', items: 'Crab Curry, Seafood Rice, Tea ×2', total: 4950, branch: 'Galle Fort' },
  { channel: 'Takeaway', where: 'Counter', items: 'Beef Burger ×2, Iced Milo ×2', total: 3880, branch: 'Kandy City' },
  { channel: 'QR order', where: 'Table 3', items: 'Margherita Pizza, Mango Smoothie', total: 2480, branch: 'Colombo 03' },
  { channel: 'Dine-in', where: 'Table 9', items: 'Grilled Seer Fish ×2, Garlic Bread', total: 5050, branch: 'Galle Fort' },
  { channel: 'Delivery', where: 'Peradeniya Rd', items: 'Cheese Kottu ×2, Faluda ×2', total: 4080, branch: 'Kandy City' },
  { channel: 'QR order', where: 'Table 15', items: 'Butter Chicken, Nasi Goreng, Tea', total: 3600, branch: 'Colombo 03' },
  { channel: 'Takeaway', where: 'Counter', items: 'Rice & Curry ×4', total: 3800, branch: 'Colombo 03' },
  { channel: 'Dine-in', where: 'Table 2', items: 'Chicken Satay, Mutton Biryani ×2', total: 5150, branch: 'Kandy City' },
]

export const SALES_BY_HOUR = [
  { label: '9am', value: 12400 },
  { label: '10', value: 18900 },
  { label: '11', value: 27600 },
  { label: '12pm', value: 58200 },
  { label: '1', value: 74300 },
  { label: '2', value: 51800 },
  { label: '3', value: 26400 },
  { label: '4', value: 22100 },
  { label: '5', value: 31700 },
  { label: '6', value: 48900 },
  { label: '7', value: 69800 },
  { label: '8', value: 44150 },
]

export const BRANCH_SALES: { branch: Branch; sales: number; orders: number; target: number }[] = [
  { branch: 'Colombo 03', sales: 248600, orders: 71, target: 280000 },
  { branch: 'Kandy City', sales: 139400, orders: 43, target: 150000 },
  { branch: 'Galle Fort', sales: 98250, orders: 28, target: 140000 },
]

export const CHANNEL_MIX: { channel: Channel; share: number; color: string }[] = [
  { channel: 'Dine-in', share: 44, color: '#f2611a' },
  { channel: 'QR order', share: 27, color: '#8b5cf6' },
  { channel: 'Delivery', share: 18, color: '#14b8a6' },
  { channel: 'Takeaway', share: 11, color: '#f5a524' },
]

// ── Live floor ──────────────────────────────────────────────────────────────

export type TableStatus = 'Free' | 'Seated' | 'Ordered' | 'Served' | 'Bill requested' | 'Reserved'

export interface FloorTable {
  id: string
  seats: number
  zone: 'Indoor' | 'Terrace'
  status: TableStatus
  guests?: number
  waiter?: string
  /** Minutes already at the table when the demo opens. */
  minutes?: number
  lines?: { id: string; qty: number }[]
  reservedFor?: string
  /** Who is sitting there, as the real live floor shows it. Absent = guest not identified. */
  guest?: FloorGuest
}

export interface FloorGuest {
  name: string
  tier: 'VIP' | 'Regular' | 'Returning' | 'First visit'
  /** Completed visits before this one. */
  visits: number
  lastVisit?: string
  /** Days since the last visit; 0 when this is the first. */
  gapDays?: number
  spent: number
  points: number
  phone: string
}

export const FLOOR: FloorTable[] = [
  { id: 'T1', seats: 2, zone: 'Indoor', status: 'Served', guests: 2, waiter: 'Dev', minutes: 34, lines: [{ id: 'm10', qty: 2 }, { id: 'm25', qty: 2 }], guest: { name: 'Fathima Rizwan', tier: 'VIP', visits: 41, lastVisit: '27 Sep 2026', gapDays: 3, spent: 241900, points: 2419, phone: '071 234 8830' } },
  { id: 'T2', seats: 2, zone: 'Indoor', status: 'Free' },
  { id: 'T3', seats: 4, zone: 'Indoor', status: 'Ordered', guests: 3, waiter: 'Sara', minutes: 9, lines: [{ id: 'm17', qty: 1 }, { id: 'm16', qty: 2 }, { id: 'm26', qty: 3 }], guest: { name: 'Dilani Jayawardena', tier: 'Regular', visits: 14, lastVisit: '26 Sep 2026', gapDays: 4, spent: 52600, points: 526, phone: '072 456 3358' } },
  { id: 'T4', seats: 4, zone: 'Indoor', status: 'Bill requested', guests: 4, waiter: 'Dev', minutes: 58, lines: [{ id: 'm20', qty: 1 }, { id: 'm09', qty: 2 }, { id: 'm14', qty: 1 }, { id: 'm21', qty: 4 }, { id: 'm28', qty: 4 }], guest: { name: 'Nimal Perera', tier: 'VIP', visits: 48, lastVisit: '29 Sep 2026', gapDays: 1, spent: 286400, points: 2864, phone: '077 123 4521' } },
  { id: 'T5', seats: 6, zone: 'Indoor', status: 'Seated', guests: 5, waiter: 'Nimal', minutes: 3, guest: { name: 'Shenali de Silva', tier: 'First visit', visits: 0, spent: 0, points: 0, phone: '071 567 2485' } },
  { id: 'T6', seats: 4, zone: 'Indoor', status: 'Free' },
  { id: 'T7', seats: 4, zone: 'Indoor', status: 'Ordered', guests: 2, waiter: 'QR', minutes: 6, lines: [{ id: 'm07', qty: 2 }, { id: 'm25', qty: 2 }] },
  { id: 'T8', seats: 8, zone: 'Indoor', status: 'Reserved', reservedFor: 'Fernando · 8:00 pm · 8 guests' },
  { id: 'T9', seats: 2, zone: 'Terrace', status: 'Served', guests: 2, waiter: 'Sara', minutes: 41, lines: [{ id: 'm14', qty: 2 }, { id: 'm06', qty: 1 }, { id: 'm30', qty: 2 }], guest: { name: 'Hiruni Wickramasinghe', tier: 'VIP', visits: 33, lastVisit: '29 Sep 2026', gapDays: 1, spent: 176500, points: 1765, phone: '070 456 8891' } },
  { id: 'T10', seats: 2, zone: 'Terrace', status: 'Free' },
  { id: 'T11', seats: 4, zone: 'Terrace', status: 'Ordered', guests: 4, waiter: 'Nimal', minutes: 14, lines: [{ id: 'm11', qty: 2 }, { id: 'm15', qty: 1 }, { id: 'm12', qty: 1 }, { id: 'm29', qty: 4 }], guest: { name: 'Arjun Selvam', tier: 'Returning', visits: 16, lastVisit: '18 Aug 2026', gapDays: 43, spent: 61200, points: 612, phone: '075 567 7719' } },
  { id: 'T12', seats: 4, zone: 'Terrace', status: 'Served', guests: 3, waiter: 'Dev', minutes: 27, lines: [{ id: 'm20', qty: 1 }, { id: 'm09', qty: 1 }, { id: 'm28', qty: 2 }], guest: { name: 'Ruwan Bandara', tier: 'Regular', visits: 27, lastVisit: '26 Sep 2026', gapDays: 4, spent: 118700, points: 1187, phone: '078 678 5093' } },
  { id: 'T13', seats: 6, zone: 'Terrace', status: 'Bill requested', guests: 6, waiter: 'Sara', minutes: 72, lines: [{ id: 'm10', qty: 3 }, { id: 'm07', qty: 2 }, { id: 'm01', qty: 2 }, { id: 'm31', qty: 6 }], guest: { name: 'Kavindu Silva', tier: 'Regular', visits: 19, lastVisit: '29 Sep 2026', gapDays: 1, spent: 84300, points: 843, phone: '076 345 1207' } },
  { id: 'T14', seats: 4, zone: 'Terrace', status: 'Free' },
  { id: 'T15', seats: 4, zone: 'Terrace', status: 'Ordered', guests: 3, waiter: 'QR', minutes: 4, lines: [{ id: 'm15', qty: 1 }, { id: 'm12', qty: 1 }, { id: 'm28', qty: 1 }] },
  { id: 'T16', seats: 2, zone: 'Terrace', status: 'Seated', guests: 2, waiter: 'Nimal', minutes: 1, guest: { name: 'Zainab Hameed', tier: 'Returning', visits: 9, lastVisit: '12 Sep 2026', gapDays: 18, spent: 38200, points: 382, phone: '075 567 1946' } },
]

// ── Delivery ────────────────────────────────────────────────────────────────

export const DELIVERY_STAGES = ['Order received', 'Preparing', 'Out for delivery', 'Delivered'] as const

export interface DeliveryOrder {
  no: number
  customer: string
  address: string
  rider: string
  items: string
  total: number
  payment: 'Cash on delivery' | 'Paid online' | 'Card on delivery'
  /** 0–100 along the journey when the demo opens. */
  progress: number
}

export const DELIVERIES: DeliveryOrder[] = [
  { no: 2207, customer: 'Fathima R.', address: '42 Galle Road, Wellawatte', rider: 'Kasun', items: 'Chicken Biryani ×3, Watalappan ×2', total: 6050, payment: 'Cash on delivery', progress: 52 },
  { no: 2208, customer: 'Arjun S.', address: '17 Flower Road, Colombo 07', rider: 'Imran', items: 'Cheese Kottu ×2, Faluda ×2', total: 4080, payment: 'Paid online', progress: 30 },
  { no: 2209, customer: 'Dilani J.', address: '8 Marine Drive, Bambalapitiya', rider: 'Suresh', items: 'Margherita Pizza, Garlic Bread, Iced Milo ×2', total: 3340, payment: 'Paid online', progress: 12 },
  { no: 2206, customer: 'Ruwan B.', address: '115 Havelock Road, Colombo 05', rider: 'Kasun', items: 'Rice & Curry ×4, King Coconut ×4', total: 5200, payment: 'Card on delivery', progress: 78 },
  { no: 2205, customer: 'Shenali D.', address: '3 Park Street, Colombo 02', rider: 'Imran', items: 'Beef Burger ×2, Mango Smoothie ×2', total: 4160, payment: 'Paid online', progress: 100 },
]

// ── Stock ───────────────────────────────────────────────────────────────────

export interface StockItem {
  name: string
  group: 'Meat & fish' | 'Vegetables' | 'Dry goods' | 'Dairy' | 'Beverages' | 'Bakery'
  unit: string
  /** On hand per branch, in BRANCHES order. */
  onHand: [number, number, number]
  /** Reorder level per branch. */
  par: number
  cost: number
}

export const STOCK: StockItem[] = [
  { name: 'Basmati Rice', group: 'Dry goods', unit: 'kg', onHand: [85, 60, 42], par: 30, cost: 420 },
  { name: 'Chicken (whole)', group: 'Meat & fish', unit: 'kg', onHand: [32, 24, 18], par: 15, cost: 1250 },
  { name: 'Prawns', group: 'Meat & fish', unit: 'kg', onHand: [6, 9, 4], par: 8, cost: 2800 },
  { name: 'Seer Fish', group: 'Meat & fish', unit: 'kg', onHand: [9, 5, 11], par: 6, cost: 3200 },
  { name: 'Mutton', group: 'Meat & fish', unit: 'kg', onHand: [12, 8, 6], par: 6, cost: 3600 },
  { name: 'Lagoon Crab', group: 'Meat & fish', unit: 'kg', onHand: [5, 2, 7], par: 4, cost: 4200 },
  { name: 'Eggs', group: 'Dairy', unit: 'pcs', onHand: [420, 260, 180], par: 150, cost: 48 },
  { name: 'Red Onions', group: 'Vegetables', unit: 'kg', onHand: [38, 26, 19], par: 15, cost: 310 },
  { name: 'Tomatoes', group: 'Vegetables', unit: 'kg', onHand: [14, 8, 12], par: 10, cost: 380 },
  { name: 'Green Chillies', group: 'Vegetables', unit: 'kg', onHand: [5, 4, 3], par: 3, cost: 900 },
  { name: 'Garlic', group: 'Vegetables', unit: 'kg', onHand: [2, 5, 1], par: 3, cost: 780 },
  { name: 'Limes', group: 'Vegetables', unit: 'kg', onHand: [11, 7, 6], par: 5, cost: 450 },
  { name: 'Mangoes', group: 'Vegetables', unit: 'kg', onHand: [16, 12, 9], par: 8, cost: 520 },
  { name: 'Coconut Milk', group: 'Dry goods', unit: 'L', onHand: [22, 18, 14], par: 10, cost: 560 },
  { name: 'Cooking Oil', group: 'Dry goods', unit: 'L', onHand: [46, 30, 22], par: 15, cost: 690 },
  { name: 'Wheat Flour', group: 'Dry goods', unit: 'kg', onHand: [60, 35, 25], par: 20, cost: 240 },
  { name: 'Sugar', group: 'Dry goods', unit: 'kg', onHand: [44, 28, 20], par: 12, cost: 275 },
  { name: 'Pasta', group: 'Dry goods', unit: 'kg', onHand: [18, 9, 7], par: 6, cost: 640 },
  { name: 'Mozzarella', group: 'Dairy', unit: 'kg', onHand: [4, 7, 3], par: 5, cost: 3900 },
  { name: 'Butter', group: 'Dairy', unit: 'kg', onHand: [7, 6, 4], par: 4, cost: 2600 },
  { name: 'Fresh Milk', group: 'Dairy', unit: 'L', onHand: [30, 22, 16], par: 15, cost: 390 },
  { name: 'Ice Cream', group: 'Dairy', unit: 'L', onHand: [12, 9, 8], par: 6, cost: 1150 },
  { name: 'Ceylon Tea Leaves', group: 'Beverages', unit: 'kg', onHand: [8, 6, 5], par: 3, cost: 1900 },
  { name: 'Coffee Beans', group: 'Beverages', unit: 'kg', onHand: [3, 5, 2], par: 4, cost: 5200 },
  { name: 'Burger Buns', group: 'Bakery', unit: 'pcs', onHand: [96, 60, 48], par: 40, cost: 85 },
]

// ── Transfers ───────────────────────────────────────────────────────────────

export type TransferStatus = 'Requested' | 'Approved' | 'In transit' | 'Received'

export interface Transfer {
  ref: string
  from: Branch
  to: Branch
  items: { name: string; qty: string }[]
  value: number
  by: string
  when: string
  status: TransferStatus
}

export const TRANSFERS: Transfer[] = [
  { ref: 'TR-0148', from: 'Colombo 03', to: 'Galle Fort', items: [{ name: 'Prawns', qty: '6 kg' }, { name: 'Garlic', qty: '3 kg' }], value: 19140, by: 'Chef Anura', when: 'Today, 10:20 am', status: 'In transit' },
  { ref: 'TR-0147', from: 'Kandy City', to: 'Colombo 03', items: [{ name: 'Mozzarella', qty: '3 kg' }, { name: 'Coffee Beans', qty: '2 kg' }], value: 22100, by: 'Manager Priya', when: 'Today, 9:05 am', status: 'Approved' },
  { ref: 'TR-0146', from: 'Colombo 03', to: 'Kandy City', items: [{ name: 'Basmati Rice', qty: '25 kg' }], value: 10500, by: 'Store · Ravi', when: 'Today, 8:40 am', status: 'Requested' },
  { ref: 'TR-0145', from: 'Galle Fort', to: 'Colombo 03', items: [{ name: 'Lagoon Crab', qty: '4 kg' }, { name: 'Seer Fish', qty: '3 kg' }], value: 26400, by: 'Chef Malik', when: 'Yesterday, 4:15 pm', status: 'Received' },
  { ref: 'TR-0144', from: 'Colombo 03', to: 'Galle Fort', items: [{ name: 'Cooking Oil', qty: '10 L' }, { name: 'Sugar', qty: '8 kg' }, { name: 'Wheat Flour', qty: '10 kg' }], value: 11500, by: 'Store · Ravi', when: 'Yesterday, 11:30 am', status: 'Received' },
  { ref: 'TR-0143', from: 'Kandy City', to: 'Galle Fort', items: [{ name: 'Burger Buns', qty: '40 pcs' }], value: 3400, by: 'Manager Priya', when: '28 Sep, 2:10 pm', status: 'Received' },
]

// ── Approvals ───────────────────────────────────────────────────────────────

export interface Approval {
  id: string
  kind: 'Discount' | 'Void item' | 'Refund' | 'Stock transfer' | 'Purchase order' | 'Price change'
  title: string
  detail: string
  by: string
  branch: Branch
  amount: number
  ago: string
}

export const APPROVALS: Approval[] = [
  { id: 'a1', kind: 'Discount', title: '15% discount on Table 4 bill', detail: 'Regular guest, birthday dinner. Bill total Rs 12,450.', by: 'Dev (Waiter)', branch: 'Colombo 03', amount: 1868, ago: '2 min ago' },
  { id: 'a2', kind: 'Void item', title: 'Void Grilled Seer Fish on Table 9', detail: 'Guest changed the order before it was fired to the grill.', by: 'Sara (Cashier)', branch: 'Galle Fort', amount: 2250, ago: '6 min ago' },
  { id: 'a3', kind: 'Refund', title: 'Refund delivery order #2198', detail: 'Wrong item delivered. Customer called the branch.', by: 'Priya (Manager)', branch: 'Kandy City', amount: 1650, ago: '14 min ago' },
  { id: 'a4', kind: 'Stock transfer', title: 'Send 25 kg Basmati Rice to Kandy City', detail: 'Kandy is below reorder level before the weekend.', by: 'Ravi (Store)', branch: 'Colombo 03', amount: 10500, ago: '25 min ago' },
  { id: 'a5', kind: 'Purchase order', title: 'PO-0312 to Lanka Seafood Suppliers', detail: 'Prawns 20 kg, Seer Fish 15 kg, Lagoon Crab 10 kg.', by: 'Anura (Chef)', branch: 'Colombo 03', amount: 146000, ago: '40 min ago' },
  { id: 'a6', kind: 'Price change', title: 'Raise Jaffna Crab Curry to Rs 3,200', detail: 'Crab cost is up 12% this month. Margin fell below 55%.', by: 'Priya (Manager)', branch: 'Kandy City', amount: 300, ago: '1 hr ago' },
]

// ── Reports ─────────────────────────────────────────────────────────────────

export type ReportRange = 'Today' | '7 days' | '30 days'

export interface ReportSet {
  revenue: number
  orders: number
  profit: number
  guests: number
  delta: { revenue: number; orders: number; profit: number; guests: number }
  trend: { label: string; value: number }[]
}

export const REPORTS: Record<ReportRange, ReportSet> = {
  Today: {
    revenue: 486250,
    orders: 142,
    profit: 301475,
    guests: 318,
    delta: { revenue: 12.4, orders: 8.1, profit: 14.2, guests: 6.3 },
    trend: SALES_BY_HOUR,
  },
  '7 days': {
    revenue: 3184900,
    orders: 936,
    profit: 1942800,
    guests: 2105,
    delta: { revenue: 9.6, orders: 7.2, profit: 11.0, guests: 5.4 },
    trend: [
      { label: 'Thu', value: 398200 },
      { label: 'Fri', value: 512600 },
      { label: 'Sat', value: 604800 },
      { label: 'Sun', value: 571300 },
      { label: 'Mon', value: 301900 },
      { label: 'Tue', value: 309850 },
      { label: 'Wed', value: 486250 },
    ],
  },
  '30 days': {
    revenue: 12846300,
    orders: 3812,
    profit: 7836200,
    guests: 8640,
    delta: { revenue: 18.3, orders: 15.9, profit: 21.1, guests: 13.7 },
    trend: [
      { label: 'Wk 1', value: 2864100 },
      { label: 'Wk 2', value: 3102500 },
      { label: 'Wk 3', value: 3221400 },
      { label: 'Wk 4', value: 3658300 },
    ],
  },
}

export const TOP_ITEMS = [
  { name: 'Chicken Kottu', emoji: '🍛', sold: 412, revenue: 515000 },
  { name: 'Chicken Biryani', emoji: '🍗', sold: 356, revenue: 587400 },
  { name: 'Cheese Kottu', emoji: '🧀', sold: 298, revenue: 432100 },
  { name: 'Mango Smoothie', emoji: '🥭', sold: 274, revenue: 161660 },
  { name: 'Jaffna Crab Curry', emoji: '🦀', sold: 121, revenue: 350900 },
  { name: 'Watalappan', emoji: '🍮', sold: 233, revenue: 128150 },
]

export const PAYMENT_MIX = [
  { label: 'Card', share: 46, color: '#8b5cf6' },
  { label: 'Cash', share: 31, color: '#f2611a' },
  { label: 'LankaQR', share: 15, color: '#14b8a6' },
  { label: 'Online', share: 8, color: '#f5a524' },
]

export const CATEGORY_SALES = [
  { label: 'Mains', share: 58 },
  { label: 'Drinks', share: 17 },
  { label: 'Starters', share: 15 },
  { label: 'Desserts', share: 10 },
]

// ── Customers ───────────────────────────────────────────────────────────────

export interface Customer {
  name: string
  phone: string
  tier: 'VIP' | 'Regular' | 'New'
  visits: number
  spend: number
  last: string
  favourite: string
  points: number
}

export const CUSTOMERS: Customer[] = [
  { name: 'Nimal Perera', phone: '077 ••• 4521', tier: 'VIP', visits: 48, spend: 286400, last: 'Today', favourite: 'Jaffna Crab Curry', points: 2864 },
  { name: 'Fathima Rizwan', phone: '071 ••• 8830', tier: 'VIP', visits: 41, spend: 241900, last: 'Today', favourite: 'Chicken Biryani', points: 2419 },
  { name: 'Kavindu Silva', phone: '076 ••• 1207', tier: 'Regular', visits: 19, spend: 84300, last: 'Yesterday', favourite: 'Cheese Kottu', points: 843 },
  { name: 'Tharushi Fernando', phone: '070 ••• 6644', tier: 'Regular', visits: 23, spend: 97850, last: '2 days ago', favourite: 'Margherita Pizza', points: 978 },
  { name: 'Mohamed Ashraf', phone: '077 ••• 9012', tier: 'VIP', visits: 37, spend: 198200, last: 'Yesterday', favourite: 'Mutton Biryani', points: 1982 },
  { name: 'Dilani Jayawardena', phone: '072 ••• 3358', tier: 'Regular', visits: 14, spend: 52600, last: 'Today', favourite: 'Chicken Pasta Alfredo', points: 526 },
  { name: 'Arjun Selvam', phone: '075 ••• 7719', tier: 'Regular', visits: 16, spend: 61200, last: '3 days ago', favourite: 'Nasi Goreng', points: 612 },
  { name: 'Shenali de Silva', phone: '071 ••• 2485', tier: 'New', visits: 2, spend: 8320, last: 'Today', favourite: 'Beef Burger', points: 83 },
  { name: 'Ruwan Bandara', phone: '078 ••• 5093', tier: 'Regular', visits: 27, spend: 118700, last: '4 days ago', favourite: 'Rice & Curry', points: 1187 },
  { name: 'Aisha Nazeer', phone: '076 ••• 4170', tier: 'New', visits: 1, spend: 3340, last: 'Today', favourite: 'Mango Smoothie', points: 33 },
  { name: 'Pradeep Kumar', phone: '077 ••• 6026', tier: 'Regular', visits: 11, spend: 43900, last: '1 week ago', favourite: 'Chicken Kottu', points: 439 },
  { name: 'Hiruni Wickramasinghe', phone: '070 ••• 8891', tier: 'VIP', visits: 33, spend: 176500, last: 'Yesterday', favourite: 'Grilled Seer Fish', points: 1765 },
  { name: 'Sanjaya Gunasekara', phone: '071 ••• 3302', tier: 'New', visits: 3, spend: 11450, last: '2 days ago', favourite: 'Hot Butter Cuttlefish', points: 114 },
  { name: 'Zainab Hameed', phone: '075 ••• 1946', tier: 'Regular', visits: 9, spend: 38200, last: '5 days ago', favourite: 'Faluda', points: 382 },
]
