/*
 * Mock data for the POS, kitchen and guest-phone screens of the demo.
 *
 * The shapes follow the real till closely (option groups that replace the
 * price or add to it, offers that are checked against the customer and the
 * basket, bills with tenders) so the demo behaves like the product rather than
 * like a drawing of it. Every name and number is invented.
 */

import { MENU, menuById, type MenuItem } from './data'

// ── Dish codes, diet, sizes and add-ons ─────────────────────────────────────

const CODE_PREFIX: Record<MenuItem['category'], string> = { Starters: 'S', Mains: 'M', Desserts: 'D', Drinks: 'B' }

const CODES = new Map<string, string>()
for (const category of ['Starters', 'Mains', 'Desserts', 'Drinks'] as const) {
  MENU.filter((m) => m.category === category).forEach((m, i) => CODES.set(m.id, `${CODE_PREFIX[category]}${String(i + 1).padStart(2, '0')}`))
}
export const codeOf = (id: string) => CODES.get(id) ?? ''

const NON_VEG = new Set(['m01', 'm02', 'm03', 'm07', 'm09', 'm10', 'm11', 'm12', 'm14', 'm15', 'm16', 'm18', 'm19', 'm20'])
export const isVeg = (id: string) => !NON_VEG.has(id)

export interface OptionGroup {
  name: string
  /** `single` replaces the dish price (sizes); `multi` adds to it (add-ons). */
  kind: 'single' | 'multi'
  required: boolean
  max?: number
  choices: { name: string; price: number; soldOut?: boolean }[]
}

export const OPTION_GROUPS: Record<string, OptionGroup[]> = {
  m07: [
    { name: 'Size', kind: 'single', required: true, choices: [{ name: 'Regular', price: 1250 }, { name: 'Large', price: 1550 }] },
    { name: 'Add-ons', kind: 'multi', required: false, max: 3, choices: [{ name: 'Extra cheese', price: 300 }, { name: 'Fried egg', price: 150 }, { name: 'Extra chicken', price: 400 }] },
  ],
  m08: [
    { name: 'Size', kind: 'single', required: true, choices: [{ name: 'Regular', price: 1450 }, { name: 'Large', price: 1750 }] },
  ],
  m10: [
    { name: 'Portion', kind: 'single', required: true, choices: [{ name: 'Single', price: 1650 }, { name: 'Family (serves 3)', price: 4200 }] },
    { name: 'Add-ons', kind: 'multi', required: false, max: 2, choices: [{ name: 'Boiled egg', price: 100 }, { name: 'Raita', price: 150 }] },
  ],
  m16: [
    { name: 'Add-ons', kind: 'multi', required: false, max: 3, choices: [{ name: 'Cheese slice', price: 200 }, { name: 'Fries', price: 450 }, { name: 'Double patty', price: 600, soldOut: true }] },
  ],
  m17: [
    { name: 'Size', kind: 'single', required: true, choices: [{ name: 'Medium', price: 1890 }, { name: 'Large', price: 2590 }] },
    { name: 'Toppings', kind: 'multi', required: false, max: 3, choices: [{ name: 'Extra cheese', price: 350 }, { name: 'Olives', price: 200 }, { name: 'Mushrooms', price: 250 }] },
  ],
  m26: [{ name: 'Size', kind: 'single', required: true, choices: [{ name: 'Regular', price: 590 }, { name: 'Large', price: 790 }] }],
  m30: [{ name: 'Size', kind: 'single', required: true, choices: [{ name: 'Regular', price: 550 }, { name: 'Large', price: 690 }] }],
}

export function fromPrice(item: MenuItem) {
  const sizes = OPTION_GROUPS[item.id]?.find((g) => g.kind === 'single')
  return sizes ? { price: Math.min(...sizes.choices.map((c) => c.price)), sizes: sizes.choices.length } : { price: item.price, sizes: 0 }
}

/** Dishes the kitchen has run out of: hidden at the till, greyed for guests. */
export const SOLD_OUT = new Set(['m20'])

export const DISH_DETAIL: Record<string, { description: string; minutes: number; spice: 0 | 1 | 2 | 3; kcal: number; allergens?: string; rating: number }> = {
  m07: { description: 'Chopped godamba roti tossed on the hot plate with chicken, egg, leeks and our house curry gravy.', minutes: 15, spice: 2, kcal: 720, allergens: 'gluten, egg', rating: 4.8 },
  m08: { description: 'Our chicken kottu finished with a generous layer of melted cheese sauce.', minutes: 15, spice: 1, kcal: 860, allergens: 'gluten, egg, dairy', rating: 4.7 },
  m10: { description: 'Long-grain basmati layered with spiced chicken, served with mint sambol and gravy.', minutes: 20, spice: 2, kcal: 780, allergens: 'dairy, nuts', rating: 4.9 },
  m16: { description: 'Grilled beef patty, caramelised onion, pickles and house sauce in a toasted bun.', minutes: 14, spice: 0, kcal: 690, allergens: 'gluten, dairy', rating: 4.5 },
  m17: { description: 'Stone-baked base, tomato, fresh mozzarella and basil.', minutes: 18, spice: 0, kcal: 810, allergens: 'gluten, dairy', rating: 4.6 },
  m26: { description: 'Ripe Jaffna mango blended with curd and a touch of kithul treacle.', minutes: 5, spice: 0, kcal: 240, allergens: 'dairy', rating: 4.8 },
}

export function detailOf(id: string) {
  return DISH_DETAIL[id] ?? { description: 'Freshly prepared to order in our kitchen.', minutes: 12, spice: 0 as const, kcal: 450, rating: 4.4 }
}

// ── Customers, points and offers ────────────────────────────────────────────

export interface PosCustomer {
  name: string
  phone: string
  points: number
  category: 'VIP' | 'Regular' | 'New'
}

export const POS_CUSTOMERS: PosCustomer[] = [
  { name: 'Nimal Perera', phone: '0771234521', points: 2864, category: 'VIP' },
  { name: 'Fathima Rizwan', phone: '0712348830', points: 2419, category: 'VIP' },
  { name: 'Kavindu Silva', phone: '0763451207', points: 843, category: 'Regular' },
  { name: 'Tharushi Fernando', phone: '0704566644', points: 978, category: 'Regular' },
  { name: 'Shenali de Silva', phone: '0715672485', points: 83, category: 'New' },
  { name: 'Aisha Nazeer', phone: '0766784170', points: 0, category: 'New' },
]

export const prettyPhone = (p: string) => `${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)}`

export interface OfferResult {
  code: string
  title: string
  amount: number
  /** Set when the guest does not qualify; the offer is shown greyed with this line. */
  reason?: string
}

const money = (n: number) => `Rs ${Math.round(n).toLocaleString('en-US')}`

/** The offers this customer could use on this basket, with the reason when they cannot. */
export function offersFor(customer: PosCustomer | null, subtotal: number): OfferResult[] {
  const category = customer?.category
  return [
    {
      code: 'VIP15',
      title: '15% off for VIP guests, up to Rs 1,500',
      amount: Math.min(1500, subtotal * 0.15),
      reason: category === 'VIP' ? undefined : 'That offer is for vip customers',
    },
    {
      code: 'WELCOME10',
      title: '10% off your first visits',
      amount: subtotal * 0.1,
      reason: category === 'New' ? undefined : 'That offer is for new customers',
    },
    {
      code: 'FEAST500',
      title: 'Rs 500 off orders over Rs 3,000',
      amount: 500,
      reason: subtotal >= 3000 ? undefined : `Spend ${money(3000 - subtotal).replace('Rs ', '')} more to use that code`,
    },
    {
      code: 'HAPPYHOUR',
      title: '20% off drinks',
      amount: 0,
      reason: 'That offer runs between 15:00 and 18:00',
    },
  ]
}

// ── People and tables ───────────────────────────────────────────────────────

export const STAFF = ['Sara · Cashier', 'Dev · Waiter', 'Nimal · Waiter', 'Priya · Manager']

export const POS_TABLES = [
  { n: 2, area: 'Indoor', status: 'free' },
  { n: 6, area: 'Indoor', status: 'free' },
  { n: 10, area: 'Terrace', status: 'free' },
  { n: 14, area: 'Terrace', status: 'free' },
  { n: 5, area: 'Indoor', status: 'occupied' },
  { n: 8, area: 'Indoor', status: 'reserved' },
]

// ── Bills ───────────────────────────────────────────────────────────────────

export type OrderKind = 'Dine in' | 'Counter' | 'Takeaway' | 'Delivery'

export interface BillLine {
  name: string
  qty: number
  unit: number
  options?: string
  note?: string
  discount?: number
  discountReason?: string
  cancelled?: boolean
}

export interface Tender {
  method: string
  amount: number
}

export interface Bill {
  no: number
  kind: OrderKind
  table?: number
  customer?: PosCustomer | null
  walkIn?: string
  lines: BillLine[]
  discount: number
  discountNote?: string
  pointsUsed: number
  tip: number
  payments: Tender[]
  held: boolean
  status: 'Accepted' | 'Preparing' | 'Ready' | 'Served'
  placed: string
}

export const SERVICE_RATE = 0.1

export function billTotals(bill: Bill) {
  const live = bill.lines.filter((l) => !l.cancelled)
  const subtotal = live.reduce((s, l) => s + l.unit * l.qty - (l.discount ?? 0), 0)
  const afterDiscount = Math.max(0, subtotal - bill.discount - bill.pointsUsed)
  const service = bill.kind === 'Dine in' ? afterDiscount * SERVICE_RATE : 0
  const total = Math.round(afterDiscount + service + bill.tip)
  const paid = bill.payments.reduce((s, p) => s + p.amount, 0)
  return { subtotal, service, total, paid, due: Math.max(0, total - paid) }
}

const line = (id: string, qty: number, extra: Partial<BillLine> = {}): BillLine => ({ name: menuById(id).name, qty, unit: menuById(id).price, ...extra })

export const OPEN_BILLS: Bill[] = [
  {
    no: 1041, kind: 'Dine in', table: 4, customer: POS_CUSTOMERS[0],
    lines: [line('m20', 1), line('m09', 2), line('m14', 1), line('m21', 4), line('m28', 4)],
    discount: 0, pointsUsed: 0, tip: 0, payments: [], held: false, status: 'Served', placed: '7:12 pm',
  },
  {
    no: 1042, kind: 'Dine in', table: 13, customer: POS_CUSTOMERS[2],
    lines: [line('m10', 3, { options: 'Single' }), line('m07', 2, { options: 'Large · Extra cheese', unit: 1850 }), line('m01', 2), line('m31', 6)],
    discount: 0, pointsUsed: 0, tip: 0, payments: [{ method: 'Card', amount: 8000 }], held: false, status: 'Served', placed: '6:58 pm',
  },
  {
    no: 1043, kind: 'Takeaway', walkIn: 'Ruwan', customer: null,
    lines: [line('m16', 2, { options: 'Fries', unit: 1940 }), line('m27', 2)],
    discount: 0, pointsUsed: 0, tip: 0, payments: [], held: false, status: 'Ready', placed: '7:31 pm',
  },
  {
    no: 1044, kind: 'Dine in', table: 9, customer: POS_CUSTOMERS[3],
    lines: [line('m14', 2), line('m06', 1), line('m30', 2, { options: 'Large', unit: 690 })],
    discount: 0, pointsUsed: 0, tip: 0, payments: [], held: false, status: 'Preparing', placed: '7:26 pm',
  },
  {
    no: 1039, kind: 'Counter', customer: POS_CUSTOMERS[1],
    lines: [line('m13', 4), line('m29', 4)],
    discount: 0, pointsUsed: 0, tip: 0, payments: [], held: true, status: 'Served', placed: '6:40 pm',
  },
]

export interface IncomingOrder {
  no: number
  channel: 'QR' | 'Online'
  where: string
  table?: number
  lines: BillLine[]
}

export const INCOMING: IncomingOrder[] = [
  { no: 1045, channel: 'QR', where: 'T7', table: 7, lines: [line('m07', 2, { options: 'Regular', note: 'Less spicy' }), line('m25', 2)] },
  { no: 1046, channel: 'Online', where: 'Pickup', lines: [line('m17', 1, { options: 'Large', unit: 2590 }), line('m06', 1)] },
]

// ── Delivery desk ───────────────────────────────────────────────────────────

export const DESK_STEPS = ['Received', 'With the kitchen', 'Preparing', 'Ready — with the delivery desk'] as const
export const DESK_ACTIONS = ['Accept & send to kitchen', 'Cooking', 'Ready'] as const

export interface DeskOrder {
  no: number
  place: string
  phone: string
  source: string
  items: string
  note?: string
  total: number
  paid: boolean
  step: number
  pin: string
}

export const DESK_ORDERS: DeskOrder[] = [
  { no: 2210, place: '42 Galle Road, Wellawatte', phone: '077 123 4521', source: 'Delivery QR · Instagram link', items: '3 × Chicken Biryani · 2 × Watalappan', note: 'Ring the bell twice', total: 6050, paid: false, step: 0, pin: '4821' },
  { no: 2209, place: '8 Marine Drive, Bambalapitiya', phone: '072 456 3358', source: 'Taken at the counter', items: '1 × Margherita Pizza (Large) · 1 × Garlic Bread', total: 3140, paid: true, step: 1, pin: '7350' },
  { no: 2208, place: '17 Flower Road, Colombo 07', phone: '075 567 7719', source: 'Delivery QR · Website', items: '2 × Cheese Kottu · 2 × Faluda', total: 4080, paid: true, step: 2, pin: '1196' },
  { no: 2207, place: '115 Havelock Road, Colombo 05', phone: '078 678 5093', source: 'Taken at the counter', items: '4 × Rice & Curry · 4 × King Coconut', total: 5200, paid: false, step: 3, pin: '6604' },
]

// ── Kitchen ─────────────────────────────────────────────────────────────────

export type ItemState = 'QUEUED' | 'PREPARING' | 'READY'

export interface KdsItem {
  id: string
  name: string
  qty: number
  prepared: number
  state: ItemState
  section: 'Hot kitchen' | 'Grill' | 'Bar' | 'Pastry'
  veg: boolean
  options?: string
  note?: string
  cancelled?: boolean
}

export interface KdsTicket {
  no: number
  table?: number
  customer: string
  pickup?: boolean
  deliverTo?: string
  /** Seconds since the order was placed when the demo opens. */
  age: number
  estimate: number
  urgent?: boolean
  note?: string
  handedOver?: boolean
  items: KdsItem[]
}

const kds = (id: string, name: string, qty: number, section: KdsItem['section'], state: ItemState, extra: Partial<KdsItem> = {}): KdsItem => ({
  id, name, qty, section, state, veg: false, prepared: state === 'READY' ? qty : 0, ...extra,
})

export const KDS_TICKETS: KdsTicket[] = [
  {
    no: 1039, table: 11, customer: 'Arjun', age: 1010, estimate: 15, urgent: true, note: 'Birthday table. Please send together.',
    items: [
      kds('a1', 'Mutton Biryani', 2, 'Hot kitchen', 'PREPARING', { prepared: 1 }),
      kds('a2', 'Butter Chicken', 1, 'Hot kitchen', 'READY'),
      kds('a3', 'Nasi Goreng', 1, 'Hot kitchen', 'PREPARING', { note: 'Extra spicy' }),
      kds('a4', 'King Coconut', 4, 'Bar', 'READY', { veg: true }),
    ],
  },
  {
    no: 1038, table: 3, customer: 'Dilani', age: 560, estimate: 18,
    items: [
      kds('b1', 'Margherita Pizza', 1, 'Grill', 'PREPARING', { veg: true, options: 'Large · Extra cheese' }),
      kds('b2', 'Beef Burger', 2, 'Grill', 'QUEUED', { options: 'Fries', note: 'No onions' }),
      kds('b3', 'Mango Smoothie', 3, 'Bar', 'QUEUED', { veg: true, options: 'Regular' }),
    ],
  },
  {
    no: 2208, customer: 'Arjun S.', deliverTo: '17 Flower Road, Colombo 07', age: 340, estimate: 20,
    items: [
      kds('c1', 'Cheese Kottu', 2, 'Hot kitchen', 'PREPARING', { options: 'Large' }),
      kds('c2', 'Faluda', 2, 'Bar', 'QUEUED', { veg: true }),
    ],
  },
  {
    no: 1045, table: 7, customer: 'QR guest', age: 120, estimate: 15,
    items: [
      kds('d1', 'Chicken Kottu', 2, 'Hot kitchen', 'QUEUED', { options: 'Regular', note: 'Less spicy' }),
      kds('d2', 'Fresh Lime Juice', 2, 'Bar', 'QUEUED', { veg: true }),
      kds('d3', 'Garlic Bread', 1, 'Grill', 'QUEUED', { veg: true, cancelled: true }),
    ],
  },
  {
    no: 1043, customer: 'Ruwan', pickup: true, age: 420, estimate: 14,
    items: [
      kds('e1', 'Beef Burger', 2, 'Grill', 'READY', { options: 'Fries' }),
      kds('e2', 'Iced Milo', 2, 'Bar', 'READY', { veg: true }),
    ],
  },
  {
    no: 1047, table: 13, customer: 'Kavindu', age: 45, estimate: 10,
    items: [
      kds('f1', 'Watalappan', 4, 'Pastry', 'QUEUED', { veg: true }),
      kds('f2', 'Chocolate Lava Cake', 2, 'Pastry', 'QUEUED', { veg: true }),
    ],
  },
]

export const KDS_SECTIONS: KdsItem['section'][] = ['Hot kitchen', 'Grill', 'Bar', 'Pastry']
