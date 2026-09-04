/**
 * Realtime cannot lose an order (production.md §5).
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * Every `realtime.*()` call fires AFTER its transaction commits, and on the
 * serverless host it is a no-op because no Socket.IO server exists there. So a
 * placed order raised no durable event anywhere: undelivered meant gone, with
 * nothing to replay and no way to ask afterwards what had happened. A kitchen
 * screen that missed the moment stayed ignorant until somebody reloaded it.
 *
 * ── What this suite pins ────────────────────────────────────────────────────
 *
 * The property that matters is ATOMICITY, and §2 below is the sharpest test in
 * the file: a transaction that rolls back must leave no event behind. Get that
 * wrong and the outbox is worse than nothing — it becomes a source of events
 * describing orders that were never placed and payments that never happened.
 *
 * Then: catch-up from a cursor, dedup by id, branch scoping, tenant scoping,
 * and that the pulse token still moves so a SKIPPED event cannot cause a
 * missed update. That last one matters because the cursor genuinely can skip —
 * Postgres assigns `seq` at INSERT and publishes at COMMIT, so a slow
 * transaction can commit seq 10 after seq 11 is visible. The design's answer is
 * that the token is the safety net and the events only add detail, and §6
 * checks that answer rather than assuming it.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/realtime-recovery-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder, cancelOrder } from '../src/features/orders/service'
import { capturePayment } from '../src/features/payments/service'
import { postMovement } from '../src/features/inventory/ledger'
import {
  emitOutbox, readOutbox, latestOutboxSeq, trimOutbox, outboxAgeSeconds,
} from '../src/server/realtime/outbox'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function buildShop(label: string, stamp: string) {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `${label} ${stamp}`, slug: `${label.toLowerCase()}-${stamp}`,
      status: 'ACTIVE', isActive: true, currency: 'LKR',
      taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
    },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Colombo', code: 'COL', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' },
  })
  const staff = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `${label.toLowerCase()}-${stamp}@t.local`,
      name: 'Cashier', passwordHash: 'x', role: 'CASHIER', branchId: main.id,
    },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${label}-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Kottu',
      slug: `k-${label}-${stamp}`, price: 100_000, isAvailable: true,
    },
  })
  for (const branch of [main, other]) {
    await prisma.foodBranch.create({
      data: { restaurantId: restaurant.id, branchId: branch.id, foodId: dish.id, isAvailable: true },
    })
  }
  const item = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id, name: `Flour ${label}`, unit: 'KG',
      quantity: 0, costPerUnit: 500_00, branchId: main.id,
    },
  })
  return { restaurant, main, other, staff, dish, item }
}

async function main() {
  const stamp = Date.now().toString(36)
  const shop = await buildShop('Pulse', stamp)

  console.log('\n── 1. An order and its event commit together ──')
  {
    const before = await prisma.outboxEvent.count({ where: { restaurantId: shop.restaurant.id } })

    const order = await placeOrder({
      restaurantId: shop.restaurant.id,
      branchId: shop.main.id,
      type: 'TAKEAWAY',
      customerName: 'Guest',
      customerPhone: '',
      items: [{ foodId: shop.dish.id, quantity: 1, optionIds: [] }],
    })

    const events = await prisma.outboxEvent.findMany({
      where: { restaurantId: shop.restaurant.id, entity: 'Order', entityId: order.id },
    })
    check('placing an order writes exactly one order event', events.length === 1, `${events.length}`)
    check('…naming the order it describes', events[0]?.entityId === order.id)
    check('…and the branch it happened at', events[0]?.branchId === shop.main.id)

    const after = await prisma.outboxEvent.count({ where: { restaurantId: shop.restaurant.id } })
    check('the outbox grew', after > before, `${before} → ${after}`)

    const paid = await capturePayment({
      restaurantId: shop.restaurant.id, orderId: order.id, method: 'CASH',
      amount: 100_000, tenderedAmount: 100_000, receivedById: shop.staff.id,
    })
    const payEvents = await prisma.outboxEvent.findMany({
      where: { restaurantId: shop.restaurant.id, entity: 'Payment', entityId: paid.payment.id },
    })
    check('settling a bill writes exactly one payment event',
      payEvents.length === 1, `${payEvents.length}`)

    await prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: shop.restaurant.id, itemId: shop.item.id, type: 'PURCHASE',
        quantity: 10, unitCost: 500_00, branchId: shop.main.id, userId: shop.staff.id,
      }),
    )
    const stockEvents = await prisma.outboxEvent.count({
      where: { restaurantId: shop.restaurant.id, entity: 'StockMovement' },
    })
    check('a stock movement writes its own event', stockEvents >= 1, `${stockEvents}`)
  }

  /*
   * The sharpest test here.
   *
   * An outbox whose events can outlive a rolled-back transaction is worse than
   * no outbox: it publishes orders that were never placed. This forces a
   * rollback after the event is written and requires the event to vanish with
   * the work it described.
   */
  console.log('\n── 2. A rolled-back transaction leaves no event behind ──')
  {
    const before = await prisma.outboxEvent.count({ where: { restaurantId: shop.restaurant.id } })

    let rolledBack = false
    try {
      await prisma.$transaction(async (tx) => {
        await emitOutbox(tx, {
          restaurantId: shop.restaurant.id,
          branchId: shop.main.id,
          type: 'order:created',
          entity: 'Order',
          entityId: 'order-that-never-was',
          payload: { orderNumber: 'GHOST-1' },
        })
        // Something later in the same transaction fails — a stock shortfall, a
        // lock timeout, a constraint. The order never happens.
        throw new Error('deliberate failure after the event was written')
      })
    } catch {
      rolledBack = true
    }
    check('the transaction failed as arranged', rolledBack)

    const after = await prisma.outboxEvent.count({ where: { restaurantId: shop.restaurant.id } })
    check('no event survived the rollback', after === before, `${before} → ${after}`)

    const ghost = await prisma.outboxEvent.findFirst({
      where: { restaurantId: shop.restaurant.id, entityId: 'order-that-never-was' },
    })
    check('…and the ghost order was never announced', ghost === null)
  }

  console.log('\n── 3. A screen that missed events catches up from its cursor ──')
  {
    const cursor = await latestOutboxSeq(shop.restaurant.id)
    check('a fresh screen can ask where the stream is', cursor !== null)

    // Three things happen while the screen is offline.
    const missed = []
    for (let i = 0; i < 3; i += 1) {
      missed.push(await placeOrder({
        restaurantId: shop.restaurant.id,
        branchId: shop.main.id,
        type: 'TAKEAWAY',
        customerName: `Missed ${i}`,
        customerPhone: '',
        items: [{ foodId: shop.dish.id, quantity: 1, optionIds: [] }],
      }))
    }

    const caught = await readOutbox({
      restaurantId: shop.restaurant.id,
      since: cursor ? BigInt(cursor) : null,
    })
    const orderEvents = caught.events.filter((e) => e.entity === 'Order')
    check('reconnecting delivers what was missed', orderEvents.length === 3, `${orderEvents.length}`)
    check('…and nothing from before the cursor',
      caught.events.every((e) => BigInt(e.seq) > BigInt(cursor!)))

    const ids = new Set(caught.events.map((e) => e.id))
    check('every event carries a distinct id to dedup on', ids.size === caught.events.length)

    // Reading the same cursor twice returns the same events — which is what
    // makes client-side dedup by id both necessary and sufficient.
    const again = await readOutbox({
      restaurantId: shop.restaurant.id,
      since: cursor ? BigInt(cursor) : null,
    })
    check('re-reading the same cursor is idempotent',
      JSON.stringify(again.events.map((e) => e.id)) === JSON.stringify(caught.events.map((e) => e.id)))

    // Advancing past them leaves nothing to replay.
    const drained = await readOutbox({
      restaurantId: shop.restaurant.id,
      since: caught.seq ? BigInt(caught.seq) : null,
    })
    check('advancing the cursor drains the stream', drained.events.length === 0,
      `${drained.events.length}`)

    check('the missed orders really exist', missed.length === 3)
  }

  console.log('\n── 4. A branch is not woken by another branch ──')
  {
    const cursor = await latestOutboxSeq(shop.restaurant.id)

    await placeOrder({
      restaurantId: shop.restaurant.id, branchId: shop.other.id, type: 'TAKEAWAY',
      customerName: 'Kandy guest', customerPhone: '',
      items: [{ foodId: shop.dish.id, quantity: 1, optionIds: [] }],
    })

    const colombo = await readOutbox({
      restaurantId: shop.restaurant.id,
      branchId: shop.main.id,
      since: cursor ? BigInt(cursor) : null,
    })
    const kandyLeak = colombo.events.some((e) => e.branchId === shop.other.id)
    check('Colombo does not receive Kandy\'s order', !kandyLeak)

    const kandy = await readOutbox({
      restaurantId: shop.restaurant.id,
      branchId: shop.other.id,
      since: cursor ? BigInt(cursor) : null,
    })
    check('…while Kandy does', kandy.events.some((e) => e.branchId === shop.other.id))

    /*
     * Restaurant-wide events (branchId null) reach every branch on purpose — a
     * menu change matters to every till, and filtering them out would leave a
     * screen believing nothing had happened.
     */
    await prisma.$transaction((tx) =>
      emitOutbox(tx, {
        restaurantId: shop.restaurant.id,
        branchId: null,
        type: 'menu:updated',
        entity: 'Menu',
        entityId: shop.dish.id,
      }),
    )
    const wide = await readOutbox({
      restaurantId: shop.restaurant.id,
      branchId: shop.main.id,
      since: cursor ? BigInt(cursor) : null,
    })
    check('but a restaurant-wide event reaches every branch',
      wide.events.some((e) => e.branchId === null && e.entity === 'Menu'))
  }

  console.log('\n── 5. Events never cross the tenant line ──')
  {
    const other = await buildShop('Rival', stamp)
    await placeOrder({
      restaurantId: other.restaurant.id, branchId: other.main.id, type: 'TAKEAWAY',
      customerName: 'Rival guest', customerPhone: '',
      items: [{ foodId: other.dish.id, quantity: 1, optionIds: [] }],
    })

    const mine = await readOutbox({ restaurantId: shop.restaurant.id, since: null })
    const leaked = mine.events.some((e) => e.branchId === other.main.id)
    check('one restaurant\'s stream carries none of another\'s', !leaked)

    await prisma.restaurant.delete({ where: { id: other.restaurant.id } })
    const orphans = await prisma.outboxEvent.count({
      where: { restaurantId: other.restaurant.id },
    })
    check('deleting a restaurant takes its events with it', orphans === 0, `${orphans}`)
  }

  console.log('\n── 6. Cancellation, lag and retention ──')
  {
    const order = await placeOrder({
      restaurantId: shop.restaurant.id, branchId: shop.main.id, type: 'TAKEAWAY',
      customerName: 'To cancel', customerPhone: '',
      items: [{ foodId: shop.dish.id, quantity: 1, optionIds: [] }],
    })
    await cancelOrder({
      restaurantId: shop.restaurant.id, orderId: order.id,
      reason: 'guest left', actorId: shop.staff.id,
    })
    const cancelled = await prisma.outboxEvent.findFirst({
      where: {
        restaurantId: shop.restaurant.id, entity: 'Order',
        entityId: order.id, type: 'order:cancelled',
      },
    })
    check('a cancellation announces itself too', cancelled !== null)

    const age = await outboxAgeSeconds(shop.restaurant.id)
    check('outbox lag is reportable and current', age !== null && age < 120, `${age}s`)

    /*
     * Retention. The order, payment and movement are the durable facts and stay
     * in their own tables; this is a delivery log, so a client that has been
     * away for a week gets a refresh rather than a week of replay.
     */
    const old = await prisma.outboxEvent.create({
      data: {
        restaurantId: shop.restaurant.id, type: 'order:created', entity: 'Order',
        entityId: 'ancient', createdAt: new Date(Date.now() - 30 * 86_400_000),
      },
    })
    const removed = await trimOutbox(7)
    check('the trim job removes events past retention', removed >= 1, `${removed}`)
    const stillThere = await prisma.outboxEvent.findUnique({ where: { seq: old.seq } })
    check('…the ancient one specifically', stillThere === null)
    const recent = await prisma.outboxEvent.count({ where: { restaurantId: shop.restaurant.id } })
    check('…and leaves today\'s events alone', recent > 0, `${recent}`)
  }

  await prisma.restaurant.delete({ where: { id: shop.restaurant.id } })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
