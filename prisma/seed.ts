/**
 * Seed script — a realistic, ready-to-demo restaurant.
 *
 *   npm run db:seed
 *
 * Idempotent: it upserts the demo restaurant by slug and clears its child data
 * before reseeding, so it is safe to run repeatedly.
 */
import { PrismaClient, type Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const SLUG = 'the-copper-spoon'
const PASSWORD = process.env.SEED_PASSWORD || 'Nila@123'
const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL || 'shop@gmail.com'

// Deterministic pseudo-random so seeded analytics look natural but stable.
let seedState = 1234567
function rand() {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff
  return seedState / 0x7fffffff
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]
}
function between(min: number, max: number) {
  return Math.floor(rand() * (max - min + 1)) + min
}

const IMG = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=600&q=70`

async function main() {
  console.log('🌱 Seeding TableFlow…')

  const passwordHash = await bcrypt.hash(PASSWORD, 12)

  // ── restaurant ─────────────────────────────────────────────────────────────
  // ── platform super-admin (the developer / platform operator) ───────────────
  const SUPER_ADMIN_EMAIL = process.env.SEED_SUPERADMIN_EMAIL || 'test@gmail.com'
  await prisma.user.upsert({
    where: { email: SUPER_ADMIN_EMAIL },
    update: { role: 'SUPER_ADMIN', restaurantId: null, passwordHash },
    create: {
      email: SUPER_ADMIN_EMAIL,
      name: 'Platform Admin',
      role: 'SUPER_ADMIN',
      restaurantId: null,
      passwordHash,
      emailVerifiedAt: new Date(),
    },
  })

  const restaurant = await prisma.restaurant.upsert({
    where: { slug: SLUG },
    update: { status: 'ACTIVE', isActive: true },
    create: {
      slug: SLUG,
      status: 'ACTIVE',
      isActive: true,
      approvedAt: new Date(),
      name: 'The Copper Spoon',
      tagline: 'Modern comfort food & craft drinks',
      description: 'A neighbourhood favourite serving wood-fired pizzas, fresh bowls and great coffee.',
      logoUrl: 'https://ui-avatars.com/api/?name=Copper+Spoon&background=ea580c&color=fff&size=128',
      coverUrl: IMG('photo-1517248135467-4c7edcad34c4'),
      email: 'hello@coppersppoon.example',
      phone: '+91 98765 43210',
      addressLine: '42 Riverside Lane',
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'IN',
      postalCode: '560001',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      taxRateBps: 500,
      taxLabel: 'GST',
      serviceChargeBps: 500,
      plan: 'GROWTH',
      paymentConfig: { cash: true, card: true, qr: true, online: false, upiId: 'coppersppoon@okbank', payeeName: 'The Copper Spoon' },
      features: { reservations: true, loyalty: true, happyHour: true, inventory: true },
      loyaltyEnabled: true,
      loyaltyEarnRateX100: 100,
      loyaltyPointValue: 100,
    },
  })

  // Fresh start for child data (idempotent reseed).
  await prisma.$transaction([
    prisma.orderEvent.deleteMany({ where: { order: { restaurantId: restaurant.id } } }),
    prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } }),
    prisma.payment.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.invoice.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.review.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.order.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.recipeItem.deleteMany({ where: { food: { restaurantId: restaurant.id } } }),
    prisma.variantOption.deleteMany({ where: { group: { food: { restaurantId: restaurant.id } } } }),
    prisma.variantGroup.deleteMany({ where: { food: { restaurantId: restaurant.id } } }),
    prisma.food.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.category.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.customer.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.coupon.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.reservation.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } }),
    prisma.supplier.deleteMany({ where: { restaurantId: restaurant.id } }),
  ])

  // ── staff ──────────────────────────────────────────────────────────────────
  const staff: Array<{ email: string; name: string; role: Prisma.UserCreateInput['role'] }> = [
    { email: OWNER_EMAIL, name: 'Alex Fernandes', role: 'OWNER' },
    { email: 'manager@restaurantos.dev', name: 'Priya Nair', role: 'MANAGER' },
    { email: 'kitchen@restaurantos.dev', name: 'Raj Kumar', role: 'KITCHEN' },
    { email: 'cashier@restaurantos.dev', name: 'Sara Thomas', role: 'CASHIER' },
    { email: 'waiter@restaurantos.dev', name: 'Dev Patel', role: 'WAITER' },
  ]
  const users: Record<string, string> = {}
  for (const member of staff) {
    const user = await prisma.user.upsert({
      where: { email: member.email },
      update: { restaurantId: restaurant.id, name: member.name, role: member.role, passwordHash },
      create: {
        restaurantId: restaurant.id,
        email: member.email,
        name: member.name,
        role: member.role,
        passwordHash,
        emailVerifiedAt: new Date(),
        phone: `+9198${between(10000000, 99999999)}`,
      },
    })
    users[member.role as string] = user.id
  }

  // ── tables ─────────────────────────────────────────────────────────────────
  const existingTables = await prisma.restaurantTable.count({ where: { restaurantId: restaurant.id } })
  if (existingTables === 0) {
    await prisma.restaurantTable.createMany({
      data: Array.from({ length: 16 }, (_, index) => ({
        restaurantId: restaurant.id,
        number: String(index + 1),
        capacity: index < 6 ? 2 : index < 12 ? 4 : 6,
        area: index < 10 ? 'Main' : index < 14 ? 'Terrace' : 'Private',
        sortOrder: index,
      })),
    })
  }
  const tables = await prisma.restaurantTable.findMany({ where: { restaurantId: restaurant.id } })

  // ── suppliers & inventory ────────────────────────────────────────────────
  const supplier = await prisma.supplier.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Fresh Farms Wholesale',
      contactName: 'Mohan Rao',
      phone: '+91 90000 11111',
      email: 'orders@freshfarms.example',
    },
  })

  const inventoryData = [
    { name: 'Mozzarella', unit: 'KG' as const, quantity: 12, reorder: 5, cost: 45000 },
    { name: 'Pizza Dough', unit: 'PIECE' as const, quantity: 40, reorder: 15, cost: 2500 },
    { name: 'Tomato Sauce', unit: 'LITRE' as const, quantity: 8, reorder: 4, cost: 12000 },
    { name: 'Chicken Breast', unit: 'KG' as const, quantity: 3, reorder: 6, cost: 32000 },
    { name: 'Fresh Basil', unit: 'PACK' as const, quantity: 6, reorder: 3, cost: 4000 },
    { name: 'Olive Oil', unit: 'LITRE' as const, quantity: 10, reorder: 3, cost: 55000 },
    { name: 'Coffee Beans', unit: 'KG' as const, quantity: 7, reorder: 3, cost: 80000 },
    { name: 'Paneer', unit: 'KG' as const, quantity: 2, reorder: 4, cost: 38000 },
  ]
  const inventory: Record<string, string> = {}
  for (const item of inventoryData) {
    const record = await prisma.inventoryItem.create({
      data: {
        restaurantId: restaurant.id,
        name: item.name,
        unit: item.unit,
        quantity: item.quantity,
        reorderLevel: item.reorder,
        costPerUnit: item.cost,
        supplierId: supplier.id,
        category: 'Food',
      },
    })
    inventory[item.name] = record.id
  }

  // ── menu ───────────────────────────────────────────────────────────────────
  const categories = [
    { name: 'Starters', icon: '🥗', slug: 'starters' },
    { name: 'Pizzas', icon: '🍕', slug: 'pizzas' },
    { name: 'Mains', icon: '🍛', slug: 'mains' },
    { name: 'Bowls', icon: '🥙', slug: 'bowls' },
    { name: 'Desserts', icon: '🍰', slug: 'desserts' },
    { name: 'Drinks', icon: '🥤', slug: 'drinks' },
  ]
  const categoryIds: Record<string, string> = {}
  for (const [index, category] of categories.entries()) {
    const record = await prisma.category.create({
      data: { restaurantId: restaurant.id, name: category.name, slug: category.slug, icon: category.icon, sortOrder: index },
    })
    categoryIds[category.name] = record.id
  }

  interface SeedFood {
    name: string
    category: string
    price: number
    discount?: number
    veg: boolean
    spice?: 'NONE' | 'MILD' | 'MEDIUM' | 'HOT'
    prep: number
    img: string
    popular?: boolean
    recommended?: boolean
    desc: string
    recipe?: Array<{ item: string; qty: number }>
    sizes?: boolean
    addons?: boolean
    happyHour?: boolean
  }

  const foods: SeedFood[] = [
    { name: 'Garlic Bread', category: 'Starters', price: 18000, veg: true, prep: 10, img: 'photo-1573140247632-f8fd74997d5c', desc: 'Wood-fired bread with garlic butter and herbs.', recommended: true },
    { name: 'Crispy Calamari', category: 'Starters', price: 32000, veg: false, spice: 'MILD', prep: 15, img: 'photo-1599487488170-d11ec9c172f0', desc: 'Golden fried squid with lemon aioli.' },
    { name: 'Paneer Tikka', category: 'Starters', price: 26000, veg: true, spice: 'MEDIUM', prep: 18, img: 'photo-1601050690597-df0568f70950', desc: 'Char-grilled cottage cheese in spiced marinade.', popular: true, recipe: [{ item: 'Paneer', qty: 0.2 }] },
    { name: 'Margherita', category: 'Pizzas', price: 42000, veg: true, prep: 20, img: 'photo-1574071318508-1cdbab80d002', desc: 'San Marzano tomato, fresh mozzarella, basil.', popular: true, recommended: true, sizes: true, addons: true, recipe: [{ item: 'Pizza Dough', qty: 1 }, { item: 'Mozzarella', qty: 0.15 }, { item: 'Tomato Sauce', qty: 0.1 }] },
    { name: 'Pepperoni', category: 'Pizzas', price: 52000, veg: false, spice: 'MILD', prep: 22, img: 'photo-1628840042765-356cda07504e', desc: 'Loaded with spicy pepperoni and cheese.', popular: true, sizes: true, addons: true, recipe: [{ item: 'Pizza Dough', qty: 1 }, { item: 'Mozzarella', qty: 0.18 }] },
    { name: 'Truffle Mushroom', category: 'Pizzas', price: 58000, veg: true, prep: 22, img: 'photo-1513104890138-7c749659a591', desc: 'Wild mushrooms, truffle oil, parmesan.', sizes: true, addons: true },
    { name: 'Butter Chicken', category: 'Mains', price: 38000, veg: false, spice: 'MEDIUM', prep: 25, img: 'photo-1603894584373-5ac82b2ae398', desc: 'Creamy tomato curry with tender chicken.', popular: true, recommended: true, recipe: [{ item: 'Chicken Breast', qty: 0.25 }] },
    { name: 'Paneer Butter Masala', category: 'Mains', price: 32000, veg: true, spice: 'MILD', prep: 22, img: 'photo-1631452180519-c014fe946bc7', desc: 'Rich, buttery cottage cheese curry.', recipe: [{ item: 'Paneer', qty: 0.2 }] },
    { name: 'Grilled Chicken Bowl', category: 'Bowls', price: 34000, veg: false, spice: 'MILD', prep: 18, img: 'photo-1512621776951-a57141f2eefd', desc: 'Grilled chicken, quinoa, roasted veg, tahini.', recommended: true, recipe: [{ item: 'Chicken Breast', qty: 0.2 }] },
    { name: 'Buddha Bowl', category: 'Bowls', price: 28000, veg: true, prep: 15, img: 'photo-1546069901-ba9599a7e63c', desc: 'Chickpeas, avocado, greens and grains.', popular: true },
    { name: 'Tiramisu', category: 'Desserts', price: 22000, veg: true, prep: 8, img: 'photo-1571877227200-a0d98ea607e9', desc: 'Classic coffee-soaked mascarpone dessert.', recommended: true },
    { name: 'Chocolate Lava Cake', category: 'Desserts', price: 24000, veg: true, prep: 12, img: 'photo-1624353365286-3f8d62daad51', desc: 'Warm cake with a molten chocolate centre.', popular: true },
    { name: 'Cappuccino', category: 'Drinks', price: 16000, veg: true, prep: 5, img: 'photo-1572442388796-11668a67e53d', desc: 'Double shot with velvety steamed milk.', recipe: [{ item: 'Coffee Beans', qty: 0.02 }] },
    { name: 'Fresh Lime Soda', category: 'Drinks', price: 12000, veg: true, prep: 4, img: 'photo-1513558161293-cdaf765ed2fd', desc: 'Refreshing lime with soda, sweet or salt.', happyHour: true },
    { name: 'Craft Iced Tea', category: 'Drinks', price: 14000, veg: true, prep: 5, img: 'photo-1499638673689-79a0b5115d87', desc: 'House-brewed iced tea with citrus.', happyHour: true },
  ]

  const foodIds: Array<{ id: string; price: number; category: string; name: string }> = []
  for (const [index, food] of foods.entries()) {
    const created = await prisma.food.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: categoryIds[food.category],
        name: food.name,
        slug: food.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        description: food.desc,
        imageUrl: IMG(food.img),
        price: food.price,
        discountPrice: food.discount ?? null,
        costPrice: Math.round(food.price * 0.35),
        prepTimeMinutes: food.prep,
        isVeg: food.veg,
        spiceLevel: food.spice ?? 'NONE',
        isPopular: food.popular ?? false,
        isRecommended: food.recommended ?? false,
        sortOrder: index,
        happyHourPrice: food.happyHour ? Math.round(food.price * 0.7) : null,
        happyHourStartMin: food.happyHour ? 16 * 60 : null,
        happyHourEndMin: food.happyHour ? 19 * 60 : null,
        variantGroups: {
          create: [
            ...(food.sizes
              ? [
                  {
                    name: 'Size',
                    kind: 'VARIANT' as const,
                    isRequired: true,
                    minSelect: 1,
                    maxSelect: 1,
                    sortOrder: 0,
                    options: {
                      create: [
                        { name: 'Regular', priceDelta: 0, isDefault: true, sortOrder: 0 },
                        { name: 'Large', priceDelta: 15000, sortOrder: 1 },
                      ],
                    },
                  },
                ]
              : []),
            ...(food.addons
              ? [
                  {
                    name: 'Extra toppings',
                    kind: 'ADDON' as const,
                    isRequired: false,
                    minSelect: 0,
                    maxSelect: 4,
                    sortOrder: 1,
                    options: {
                      create: [
                        { name: 'Extra cheese', priceDelta: 8000, sortOrder: 0 },
                        { name: 'Mushrooms', priceDelta: 6000, sortOrder: 1 },
                        { name: 'Olives', priceDelta: 5000, sortOrder: 2 },
                        { name: 'Jalapeños', priceDelta: 5000, sortOrder: 3 },
                      ],
                    },
                  },
                ]
              : []),
          ],
        },
      },
    })

    if (food.recipe) {
      for (const line of food.recipe) {
        const itemId = inventory[line.item]
        if (itemId) {
          await prisma.recipeItem.create({
            data: { foodId: created.id, itemId, quantity: line.qty },
          })
        }
      }
    }

    foodIds.push({ id: created.id, price: food.price, category: food.category, name: food.name })
  }

  // ── coupons ────────────────────────────────────────────────────────────────
  await prisma.coupon.createMany({
    data: [
      { restaurantId: restaurant.id, code: 'WELCOME10', description: '10% off your first order', type: 'PERCENT', value: 1000, maxDiscount: 15000, minOrderAmount: 30000 },
      { restaurantId: restaurant.id, code: 'FLAT50', description: '₹50 off orders over ₹400', type: 'FIXED', value: 5000, minOrderAmount: 40000 },
      { restaurantId: restaurant.id, code: 'WEEKEND15', description: '15% weekend treat', type: 'PERCENT', value: 1500, maxDiscount: 20000, minOrderAmount: 50000 },
    ],
  })

  // ── customers ──────────────────────────────────────────────────────────────
  const customerNames = ['Aisha Khan', 'Rohan Mehta', 'Lena Fernandez', 'Karan Singh', 'Maya Iyer', 'Tom Rebello', 'Zoya Ali', 'Vikram Rao']
  const customers: Array<{ id: string }> = []
  for (const [index, name] of customerNames.entries()) {
    const customer = await prisma.customer.create({
      data: {
        restaurantId: restaurant.id,
        name,
        phone: `+9199${String(10000000 + index * 111111).slice(0, 8)}`,
        email: `${name.split(' ')[0].toLowerCase()}@example.com`,
        loyaltyPoints: between(0, 400),
      },
    })
    customers.push(customer)
  }

  // ── historical orders (last 30 days) for analytics ─────────────────────────
  console.log('🧾 Generating order history…')
  const statuses = ['COMPLETED', 'COMPLETED', 'COMPLETED', 'SERVED', 'CANCELLED'] as const
  const methods = ['CASH', 'CARD', 'QR', 'ONLINE'] as const
  let orderSeq = 0

  for (let dayOffset = 30; dayOffset >= 0; dayOffset -= 1) {
    const ordersToday = between(6, 22)
    for (let n = 0; n < ordersToday; n += 1) {
      orderSeq += 1
      const placedAt = new Date()
      placedAt.setDate(placedAt.getDate() - dayOffset)
      placedAt.setHours(between(11, 22), between(0, 59), 0, 0)

      const status = dayOffset === 0 && rand() < 0.3 ? pick(['PENDING', 'PREPARING', 'READY'] as const) : pick(statuses)
      const cancelled = status === 'CANCELLED'

      const lineCount = between(1, 4)
      const chosen = Array.from({ length: lineCount }, () => pick(foodIds))
      let subtotal = 0
      const items = chosen.map((food) => {
        const qty = between(1, 3)
        const lineTotal = food.price * qty
        subtotal += lineTotal
        return { foodId: food.id, name: food.name, unitPrice: food.price, quantity: qty, lineTotal, costPrice: Math.round(food.price * 0.35) }
      })

      const discountTotal = rand() < 0.15 ? Math.round(subtotal * 0.1) : 0
      const taxableBase = subtotal - discountTotal
      const serviceCharge = Math.round(taxableBase * 0.05)
      const taxTotal = Math.round((taxableBase + serviceCharge) * 0.05)
      const grandTotal = taxableBase + serviceCharge + taxTotal
      const customer = pick(customers)
      const table = pick(tables)

      const stamp = new Intl.DateTimeFormat('en-CA', { year: '2-digit', month: '2-digit', day: '2-digit' })
        .format(placedAt)
        .replace(/-/g, '')

      const order = await prisma.order.create({
        data: {
          restaurantId: restaurant.id,
          orderNumber: `${stamp}-${String(orderSeq).padStart(3, '0')}`,
          type: 'DINE_IN',
          status,
          paymentStatus: cancelled ? 'UNPAID' : status === 'COMPLETED' ? 'PAID' : 'UNPAID',
          tableId: table.id,
          customerId: customer.id,
          customerName: customerNames[customers.indexOf(customer)] ?? 'Guest',
          customerPhone: `+9199${between(10000000, 99999999)}`,
          createdById: rand() < 0.4 ? users.WAITER : null,
          subtotal,
          discountTotal,
          serviceCharge,
          taxTotal,
          grandTotal,
          paidTotal: status === 'COMPLETED' ? grandTotal : 0,
          taxRateBps: 500,
          serviceChargeBps: 500,
          estimatedMinutes: between(15, 35),
          placedAt,
          acceptedAt: cancelled ? null : placedAt,
          completedAt: status === 'COMPLETED' ? new Date(placedAt.getTime() + 40 * 60000) : null,
          cancelledAt: cancelled ? placedAt : null,
          cancelReason: cancelled ? 'Guest left' : null,
          items: { create: items },
          events: { create: { status, note: 'Seed data' } },
        },
      })

      if (status === 'COMPLETED') {
        await prisma.payment.create({
          data: {
            restaurantId: restaurant.id,
            orderId: order.id,
            method: pick(methods),
            status: 'PAID',
            amount: grandTotal,
            receivedById: users.CASHIER,
            paidAt: new Date(placedAt.getTime() + 45 * 60000),
          },
        })

        // Occasional review on completed orders.
        if (rand() < 0.35) {
          await prisma.review.create({
            data: {
              restaurantId: restaurant.id,
              orderId: order.id,
              customerId: customer.id,
              rating: between(3, 5),
              comment: pick(['Loved it!', 'Great food and service.', 'Will come again.', 'Quick and tasty.', 'A bit slow but delicious.']),
            },
          })
        }
      }
    }
  }

  // ── a couple of upcoming reservations ──────────────────────────────────────
  for (let i = 0; i < 4; i += 1) {
    const when = new Date()
    when.setDate(when.getDate() + between(0, 5))
    when.setHours(between(18, 21), pick([0, 30]), 0, 0)
    await prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        customerName: pick(customerNames),
        customerPhone: `+9199${between(10000000, 99999999)}`,
        partySize: between(2, 6),
        reservedAt: when,
        tableId: pick(tables).id,
        status: pick(['CONFIRMED', 'PENDING'] as const),
      },
    })
  }

  // ── a pending sign-up, so the platform approval queue has something in it ───
  const PENDING_SLUG = 'urban-tandoor'
  const pending = await prisma.restaurant.upsert({
    where: { slug: PENDING_SLUG },
    update: { status: 'PENDING', isActive: false },
    create: {
      slug: PENDING_SLUG,
      name: 'Urban Tandoor',
      tagline: 'North Indian street food',
      city: 'Mumbai',
      currency: 'INR',
      status: 'PENDING',
      isActive: false,
      email: 'hello@urbantandoor.example',
      phone: '+91 98111 22333',
    },
  })
  await prisma.user.upsert({
    where: { email: 'newowner@restaurantos.dev' },
    update: { restaurantId: pending.id, passwordHash },
    create: {
      restaurantId: pending.id,
      email: 'newowner@restaurantos.dev',
      name: 'Imran Shaikh',
      role: 'OWNER',
      passwordHash,
      emailVerifiedAt: new Date(),
    },
  })

  const orderCount = await prisma.order.count({ where: { restaurantId: restaurant.id } })

  console.log(`
✅ Seed complete.

   Restaurant:  ${restaurant.name}  (slug: ${restaurant.slug})
   Guest menu:  http://localhost:3000/order?r=${restaurant.slug}
   Orders:      ${orderCount} across the last 30 days

   Platform admin (approves new restaurants):
     Admin    ${SUPER_ADMIN_EMAIL}   → /admin

   Pending sign-up waiting in the approval queue:
     Owner    newowner@restaurantos.dev  → /pending-approval

   Sign in with any of these (password: ${PASSWORD}):
     Owner    ${OWNER_EMAIL}
     Manager  manager@restaurantos.dev
     Kitchen  kitchen@restaurantos.dev   → /kitchen
     Cashier  cashier@restaurantos.dev   → /cashier
     Waiter   waiter@restaurantos.dev    → /waiter
`)
}

main()
  .catch((error) => {
    console.error('❌ Seed failed:', error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
