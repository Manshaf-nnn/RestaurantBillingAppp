/**
 * The database refuses what the application forbids (production.md §1, §17).
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 *
 * Every rule in this file is also enforced in TypeScript, and that is exactly
 * why it needs testing here. Application guards protect the paths that go
 * through them. They do nothing for a repair script, a hand-written migration,
 * a psql session at 2am during an incident, or the next code path somebody adds
 * without knowing the rule existed — and those are the moments when the data is
 * least likely to be sane and most likely to be trusted afterwards.
 *
 * So every check below goes AROUND the service layer deliberately, writing with
 * the raw client or raw SQL, and requires the database itself to say no.
 *
 * Two things this suite is careful about:
 *
 *   • It asserts the constraint by NAME wherever Postgres reports one, not just
 *     that "something threw". A test that accepts any error passes just as
 *     happily when the insert fails for a missing column, which is how a
 *     constraint gets quietly dropped and nobody notices.
 *   • It pins the DELIBERATE gaps too — the writes that are allowed and look as
 *     though they should not be — so that a future reader tightening the rules
 *     finds out here why they are shaped this way, rather than in production.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/db-constraint-test.ts
 */
import { prisma } from '../src/server/db/prisma'

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

/** The full error text, however Prisma chose to wrap it. */
function messageOf(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current && depth < 4; depth += 1) {
    const e = current as { message?: string; meta?: unknown; cause?: unknown }
    if (typeof e.message === 'string') parts.push(e.message)
    if (e.meta) parts.push(JSON.stringify(e.meta))
    current = e.cause
  }
  return parts.join(' | ')
}

/**
 * The write must be refused, and refused for the stated reason.
 *
 * `expect` is matched against the error text; for a CHECK or UNIQUE violation
 * that is the constraint name, which is what makes this a test of THAT rule
 * rather than of "an error happened".
 */
async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'the database allowed it')
  } catch (error) {
    const message = messageOf(error)
    check(name, expect.test(message), `wrong error: ${message.slice(0, 160)}`)
  }
}

/** The write must succeed — a pinned deliberate allowance. */
async function allows(name: string, run: () => Promise<unknown>) {
  try {
    await run()
    check(name, true)
  } catch (error) {
    check(name, false, `refused: ${messageOf(error).slice(0, 160)}`)
  }
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Cons ${stamp}`, slug: `cons-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `cons-${stamp}@test.local`, name: 'Cashier',
      passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
    },
  })

  const newOrder = (extra: Record<string, unknown> = {}) =>
    prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id,
        orderNumber: `C-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
        customerName: 'Walk-in', customerPhone: '',
        subtotal: 100_000, grandTotal: 100_000,
        ...extra,
      },
    })

  console.log('\n── 1. Money cannot be stored negative ──')
  {
    await refuses(
      'an order with a negative subtotal is refused',
      () => newOrder({ subtotal: -1 }),
      /orders_money_nonneg/,
    )
    await refuses(
      'a negative tip is refused',
      () => newOrder({ tipAmount: -500 }),
      /orders_money_nonneg/,
    )
    await refuses(
      'a negative paid total is refused',
      () => newOrder({ paidTotal: -1 }),
      /orders_money_nonneg/,
    )

    const order = await newOrder()
    await refuses(
      'a negative payment is refused',
      () => prisma.payment.create({
        data: {
          restaurantId: restaurant.id, orderId: order.id,
          method: 'CASH', status: 'PAID', amount: -100_000,
        },
      }),
      /payments_amount_nonneg/,
    )

    const payment = await prisma.payment.create({
      data: {
        restaurantId: restaurant.id, orderId: order.id,
        method: 'CASH', status: 'PAID', amount: 100_000,
      },
    })
    await refuses(
      'a refund of nothing is refused',
      () => prisma.refund.create({
        data: {
          restaurantId: restaurant.id, orderId: order.id, paymentId: payment.id,
          amount: 0, method: 'CASH', reason: 'nothing', refundedById: user.id,
        },
      }),
      /refunds_amount_positive/,
    )
    await refuses(
      'a negative refund — money taken under cover of giving it back — is refused',
      () => prisma.refund.create({
        data: {
          restaurantId: restaurant.id, orderId: order.id, paymentId: payment.id,
          amount: -50_000, method: 'CASH', reason: 'reverse', refundedById: user.id,
        },
      }),
      /refunds_amount_positive/,
    )
  }

  console.log('\n── 2. Loyalty points cannot go negative ──')
  {
    await refuses(
      'a customer cannot hold a negative balance',
      () => prisma.customer.create({
        data: {
          restaurantId: restaurant.id, name: 'Debtor',
          phone: `070${stamp.slice(-7)}`, loyaltyPoints: -1,
        },
      }),
      /customers_loyaltyPoints_nonneg/,
    )
  }

  console.log('\n── 3. The stock ledger cannot hold a movement of nothing ──')
  {
    const item = await prisma.inventoryItem.create({
      data: {
        restaurantId: restaurant.id, name: `Item ${stamp}`, unit: 'KG',
        quantity: 10, costPerUnit: 100_00, branchId: branch.id,
      },
    })

    await refuses(
      'a movement of zero is refused — there would be nothing to reverse',
      () => prisma.stockMovement.create({
        data: {
          restaurantId: restaurant.id, itemId: item.id, branchId: branch.id,
          type: 'ADJUSTMENT', quantity: 0, balanceAfter: 10,
        },
      }),
      /stock_movements_quantity_nonzero/,
    )

    /*
     * DELIBERATE allowance: the legacy ADJUSTMENT type carries its own sign, so
     * a downward correction is legitimately negative. Constraining quantity to
     * "> 0" instead of "<> 0" would break every stock correction.
     */
    await allows(
      'but a signed ADJUSTMENT may be negative — that is how corrections work',
      () => prisma.stockMovement.create({
        data: {
          restaurantId: restaurant.id, itemId: item.id, branchId: branch.id,
          type: 'ADJUSTMENT', quantity: -3, balanceAfter: 7,
        },
      }),
    )

    await refuses(
      'an item cannot cost a negative amount',
      () => prisma.inventoryItem.create({
        data: {
          restaurantId: restaurant.id, name: `Bad ${stamp}`, unit: 'KG',
          quantity: 0, costPerUnit: -1, branchId: branch.id,
        },
      }),
      /inventory_items_cost_nonneg/,
    )
  }

  console.log('\n── 4. Identity cannot collide ──')
  {
    const number = `DUP-${stamp}`
    await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: number,
        customerName: 'A', customerPhone: '', subtotal: 1000, grandTotal: 1000,
      },
    })
    await refuses(
      'two orders cannot share a number in one restaurant',
      () => prisma.order.create({
        data: {
          restaurantId: restaurant.id, branchId: branch.id, orderNumber: number,
          customerName: 'B', customerPhone: '', subtotal: 1000, grandTotal: 1000,
        },
      }),
      /orderNumber|Unique constraint/,
    )

    const key = `idem-${stamp}`
    await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `K1-${stamp}`,
        customerName: 'A', customerPhone: '', subtotal: 1000, grandTotal: 1000,
        idempotencyKey: key,
      },
    })
    await refuses(
      'a replayed cart cannot become a second order',
      () => prisma.order.create({
        data: {
          restaurantId: restaurant.id, branchId: branch.id, orderNumber: `K2-${stamp}`,
          customerName: 'A', customerPhone: '', subtotal: 1000, grandTotal: 1000,
          idempotencyKey: key,
        },
      }),
      /idempotencyKey|Unique constraint/,
    )

    // production.md §2 — the same protection for money in and money out.
    const order = await newOrder()
    const payKey = `pay-${stamp}`
    await prisma.payment.create({
      data: {
        restaurantId: restaurant.id, orderId: order.id, method: 'CASH',
        status: 'PAID', amount: 50_000, clientRequestId: payKey,
      },
    })
    await refuses(
      'a replayed settle cannot become a second payment',
      () => prisma.payment.create({
        data: {
          restaurantId: restaurant.id, orderId: order.id, method: 'CASH',
          status: 'PAID', amount: 50_000, clientRequestId: payKey,
        },
      }),
      /clientRequestId|Unique constraint/,
    )

    /*
     * DELIBERATE: the key is nullable and Postgres treats NULLs as distinct in
     * a unique index, so the paths that predate it — and the guest surfaces
     * that never mint one — are not forced through a key they do not have.
     */
    await allows(
      'but unkeyed payments do not collide with each other',
      async () => {
        await prisma.payment.create({
          data: {
            restaurantId: restaurant.id, orderId: order.id, method: 'CARD',
            status: 'PAID', amount: 10_000,
          },
        })
        await prisma.payment.create({
          data: {
            restaurantId: restaurant.id, orderId: order.id, method: 'CARD',
            status: 'PAID', amount: 10_000,
          },
        })
      },
    )
  }

  console.log('\n── 5. Nothing may reference a tenant that is not there ──')
  {
    await refuses(
      'an order cannot belong to a restaurant that does not exist',
      () => prisma.order.create({
        data: {
          restaurantId: 'no-such-restaurant', branchId: branch.id,
          orderNumber: `FK-${stamp}`, customerName: 'X', customerPhone: '',
          subtotal: 1000, grandTotal: 1000,
        },
      }),
      /[Ff]oreign key|violates foreign key|restaurantId/,
    )
    await refuses(
      'a stock movement cannot reference a missing item',
      () => prisma.stockMovement.create({
        data: {
          restaurantId: restaurant.id, itemId: 'no-such-item', branchId: branch.id,
          type: 'PURCHASE', quantity: 1, balanceAfter: 1,
        },
      }),
      /[Ff]oreign key|violates foreign key|itemId/,
    )
  }

  console.log('\n── 6. Deleting a tenant takes its data with it ──')
  {
    const doomed = await prisma.restaurant.create({
      data: {
        name: `Doomed ${stamp}`, slug: `doomed-${stamp}`, status: 'ACTIVE',
        isActive: true, currency: 'LKR',
      },
    })
    const doomedBranch = await prisma.branch.create({
      data: { restaurantId: doomed.id, name: 'Main', code: 'M', isDefault: true },
    })
    const doomedOrder = await prisma.order.create({
      data: {
        restaurantId: doomed.id, branchId: doomedBranch.id, orderNumber: `D-${stamp}`,
        customerName: 'X', customerPhone: '', subtotal: 1000, grandTotal: 1000,
      },
    })
    await prisma.payment.create({
      data: {
        restaurantId: doomed.id, orderId: doomedOrder.id,
        method: 'CASH', status: 'PAID', amount: 1000,
      },
    })

    await prisma.restaurant.delete({ where: { id: doomed.id } })

    const orphanOrders = await prisma.order.count({ where: { restaurantId: doomed.id } })
    const orphanPayments = await prisma.payment.count({ where: { restaurantId: doomed.id } })
    check('no order survives its restaurant', orphanOrders === 0, `${orphanOrders}`)
    check('no payment survives its restaurant', orphanPayments === 0, `${orphanPayments}`)
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
