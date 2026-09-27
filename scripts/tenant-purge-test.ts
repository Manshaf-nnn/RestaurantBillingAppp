/**
 * Removing a tenant, against a tenant that has actually been used.
 *
 * ── Why the fixture is elaborate ────────────────────────────────────────────
 *
 * A purge over an empty restaurant proves nothing: `DELETE FROM restaurants`
 * already works when nothing references it. What breaks the naive version is
 * the forty-three RESTRICT foreign keys, and none of them is reached until
 * the tenant has stock, transfers, receipts and orders hanging off its
 * branches and inventory items. So this builds a small but genuinely used
 * restaurant — menu, staff, a bill that was paid, stock received against a
 * purchase, a transfer between two branches, a wastage, and audit rows — and
 * only then asks for it to be removed.
 *
 * It also pins the guards, because a purge that cannot be triggered by
 * accident is most of what makes it safe to have at all.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/tenant-purge-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { planTenantPurge, purgeTenant } from '../src/features/platform/tenant-purge'

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

async function refuses(name: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = String((error as Error)?.message ?? error)
    check(name, pattern.test(message), message.slice(0, 160))
  }
}

/** A restaurant that has been traded in, not just created. */
async function buildTenant(tag: string) {
  const stamp = `${tag}${Math.random().toString(36).slice(2, 8)}`
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Purge ${stamp}`,
      slug: `purge-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      currency: 'LKR',
      taxRateBps: 0,
      serviceChargeBps: 0,
      taxInclusive: false,
    },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: `M${stamp.slice(-5).toUpperCase()}`, isDefault: true },
  })
  const second = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Second', code: `S${stamp.slice(-5).toUpperCase()}` },
  })
  const staff = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `${stamp}@purge.test`,
      name: 'Cashier',
      passwordHash: 'x',
      role: 'CASHIER',
      branchId: main.id,
    },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Kottu',
      slug: `kottu-${stamp}`,
      price: 50_000,
      isAvailable: true,
    },
  })
  const supplier = await prisma.supplier.create({
    data: { restaurantId: restaurant.id, name: 'Wholesaler' },
  })
  const item = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Chicken ${stamp}` },
  })

  // Bought, received, and put on a shelf.
  const purchase = await prisma.purchase.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: `PO-${stamp}`, supplierId: supplier.id },
  })
  const purchaseItem = await prisma.purchaseItem.create({
    data: { purchaseId: purchase.id, itemId: item.id, quantity: 10, unitCost: 1_000, lineTotal: 10_000 },
  })
  const receipt = await prisma.goodsReceipt.create({
    data: { restaurantId: restaurant.id, purchaseId: purchase.id, branchId: main.id, number: `GRN-${stamp}` },
  })
  await prisma.goodsReceiptLine.create({
    data: { receiptId: receipt.id, purchaseItemId: purchaseItem.id, itemId: item.id, acceptedQty: 10 },
  })
  const batch = await prisma.stockBatch.create({
    data: {
      restaurantId: restaurant.id, branchId: main.id, itemId: item.id,
      batchNo: `B-${stamp}`, receivedQty: 10, remainingQty: 10,
      unitCost: 1_000, receivedValue: 10_000, remainingValue: 10_000,
    },
  })
  await prisma.inventoryStock.create({
    data: { restaurantId: restaurant.id, branchId: main.id, itemId: item.id, available: 10 },
  })
  await prisma.stockMovement.create({
    data: {
      restaurantId: restaurant.id, branchId: main.id, itemId: item.id,
      type: 'PURCHASE', quantity: 10, unitCost: 1_000, valueMoved: 10_000, batchId: batch.id,
    },
  })

  // Moved between sites — this is what trips the RESTRICT web.
  const transfer = await prisma.stockTransfer.create({
    data: {
      restaurantId: restaurant.id, fromBranchId: main.id, toBranchId: second.id,
      number: `TRF-${stamp}`, status: 'COMPLETED',
    },
  })
  await prisma.stockTransferLine.create({
    data: { transferId: transfer.id, itemId: item.id, requestedQty: 2, batchId: batch.id },
  })

  // Thrown away.
  await prisma.wastageRecord.create({
    data: {
      restaurantId: restaurant.id, branchId: main.id, itemId: item.id,
      quantity: 1, reason: 'SPOILED', costValue: 1_000,
    },
  })

  // Sold and paid for.
  const order = await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: main.id, orderNumber: `ORD-${stamp}`,
      customerName: 'Walk-in', customerPhone: '',
      type: 'TAKEAWAY', status: 'COMPLETED', paymentStatus: 'PAID',
      subtotal: 50_000, grandTotal: 50_000, paidTotal: 50_000,
    },
  })
  await prisma.orderItem.create({
    data: {
      orderId: order.id, foodId: dish.id, name: 'Kottu',
      quantity: 1, unitPrice: 50_000, lineTotal: 50_000,
    },
  })
  await prisma.payment.create({
    data: {
      restaurantId: restaurant.id, orderId: order.id, method: 'CASH',
      amount: 50_000, status: 'PAID', receivedById: staff.id,
    },
  })

  // And somebody was watching.
  await prisma.auditLog.createMany({
    data: [
      {
        restaurantId: restaurant.id, userId: staff.id, actorName: 'Cashier', branchId: main.id,
        action: 'ORDER_CREATED', entity: 'Order', entityId: order.id,
      },
      {
        restaurantId: restaurant.id, userId: staff.id, actorName: 'Cashier',
        action: 'PAYMENT_TAKEN', entity: 'Payment', entityId: order.id,
      },
    ],
  })

  return { restaurant, main, second, staff, item, order }
}

async function main() {
  const doomed = await buildTenant('a')
  const bystander = await buildTenant('b')

  console.log('\n── 1. The plan knows what is there, and refuses while the tenant is live ──')
  {
    const plan = await planTenantPurge(doomed.restaurant.id)
    check('the plan finds rows across many tables', plan.tables.length >= 15, `${plan.tables.length} tables`)
    check('and counts them', plan.totalRows >= 20, `${plan.totalRows} rows`)
    check('orders are in it', plan.tables.some((t) => t.table === 'orders'))
    check('so are the transfer lines, which have no tenant of their own',
      plan.tables.some((t) => t.table === 'stock_transfer_lines'))
    check('and the audit trail', plan.tables.some((t) => t.table === 'audit_logs'))
    check('an active tenant is a blocker', plan.blockers.some((b) => /still active/i.test(b)),
      plan.blockers.join(' | '))
  }

  console.log('\n── 2. The guards ──')
  {
    await refuses(
      'a live tenant cannot be purged',
      () => purgeTenant({
        restaurantId: doomed.restaurant.id, confirmation: doomed.restaurant.slug,
        actorId: null, actorName: 'test',
      }),
      /not ready to be purged|still active/i,
    )

    await prisma.restaurant.update({
      where: { id: doomed.restaurant.id },
      data: { isActive: false, status: 'SUSPENDED' },
    })

    await refuses(
      'the wrong slug is refused',
      () => purgeTenant({
        restaurantId: doomed.restaurant.id, confirmation: 'not-the-slug',
        actorId: null, actorName: 'test',
      }),
      /repeat its slug back/i,
    )
    await refuses(
      'so is an empty confirmation',
      () => purgeTenant({
        restaurantId: doomed.restaurant.id, confirmation: '',
        actorId: null, actorName: 'test',
      }),
      /repeat its slug back/i,
    )
    await refuses(
      "another tenant's slug does not unlock this one",
      () => purgeTenant({
        restaurantId: doomed.restaurant.id, confirmation: bystander.restaurant.slug,
        actorId: null, actorName: 'test',
      }),
      /repeat its slug back/i,
    )
  }

  console.log('\n── 3. Work in flight holds it back ──')
  {
    const register = await prisma.cashRegister.create({
      data: { restaurantId: doomed.restaurant.id, branchId: doomed.main.id, name: 'Till 1' },
    })
    const drawer = await prisma.cashDrawerSession.create({
      data: {
        restaurantId: doomed.restaurant.id, branchId: doomed.main.id,
        registerId: register.id, sessionNumber: `CD-${Date.now()}`,
        openedById: doomed.staff.id, openingFloat: 10_000, status: 'OPEN',
      },
    })
    const plan = await planTenantPurge(doomed.restaurant.id)
    check('an open till blocks the purge', plan.blockers.some((b) => /drawer/i.test(b)), plan.blockers.join(' | '))
    await refuses(
      'and the purge itself refuses',
      () => purgeTenant({
        restaurantId: doomed.restaurant.id, confirmation: doomed.restaurant.slug,
        actorId: null, actorName: 'test',
      }),
      /not ready to be purged/i,
    )
    await prisma.cashDrawerSession.update({
      where: { id: drawer.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    })
    const after = await planTenantPurge(doomed.restaurant.id)
    check('closing it clears the blocker', after.blockers.length === 0, after.blockers.join(' | '))
  }

  console.log('\n── 4. The purge itself ──')
  {
    const before = await planTenantPurge(doomed.restaurant.id)
    const result = await purgeTenant({
      restaurantId: doomed.restaurant.id,
      confirmation: doomed.restaurant.slug,
      actorId: null,
      actorName: 'purge-test',
    })
    check('it reports what it removed', result.totalRows >= before.totalRows, `${result.totalRows}`)
    check('across the tables the plan named', result.deleted.length >= 15, `${result.deleted.length}`)

    const gone = await prisma.restaurant.findUnique({ where: { id: doomed.restaurant.id } })
    check('the restaurant is gone', gone === null)

    for (const [label, count] of [
      ['orders', prisma.order.count({ where: { restaurantId: doomed.restaurant.id } })],
      ['payments', prisma.payment.count({ where: { restaurantId: doomed.restaurant.id } })],
      ['stock movements', prisma.stockMovement.count({ where: { restaurantId: doomed.restaurant.id } })],
      ['stock batches', prisma.stockBatch.count({ where: { restaurantId: doomed.restaurant.id } })],
      ['inventory items', prisma.inventoryItem.count({ where: { restaurantId: doomed.restaurant.id } })],
      ['transfers', prisma.stockTransfer.count({ where: { restaurantId: doomed.restaurant.id } })],
      ['purchases', prisma.purchase.count({ where: { restaurantId: doomed.restaurant.id } })],
      ['audit rows', prisma.auditLog.count({ where: { restaurantId: doomed.restaurant.id } })],
      ['users', prisma.user.count({ where: { restaurantId: doomed.restaurant.id } })],
      ['branches', prisma.branch.count({ where: { restaurantId: doomed.restaurant.id } })],
    ] as const) {
      check(`no ${label} remain`, (await count) === 0)
    }

    const orphanItems = await prisma.orderItem.count({ where: { orderId: doomed.order.id } })
    check('nor the order lines, which had no tenant column', orphanItems === 0)
  }

  console.log('\n── 5. The neighbour is untouched ──')
  {
    const still = await prisma.restaurant.findUnique({ where: { id: bystander.restaurant.id } })
    check('the other restaurant is still there', still !== null)
    const orders = await prisma.order.count({ where: { restaurantId: bystander.restaurant.id } })
    check('with its order', orders === 1, `${orders}`)
    const audit = await prisma.auditLog.count({ where: { restaurantId: bystander.restaurant.id } })
    check('and its audit trail', audit === 2, `${audit}`)
  }

  console.log('\n── 6. The platform kept a record of the erasure ──')
  {
    const record = await prisma.auditLog.findFirst({
      where: { action: 'TENANT_PURGED', entityId: doomed.restaurant.id },
    })
    check('a TENANT_PURGED row exists', record !== null)
    check('it belongs to the platform, not the deleted tenant', record?.restaurantId === null)
    check('and names who asked', record?.actorName === 'purge-test', String(record?.actorName))
    // Clean up the one row this test intentionally leaves behind.
    if (record) await prisma.auditLog.delete({ where: { id: record.id } })
  }

  console.log('\n── 7. A tenant that does not exist ──')
  {
    await refuses(
      'planning a purge for an unknown id is refused',
      () => planTenantPurge('no-such-restaurant'),
      /not found/i,
    )
  }

  // Tidy the bystander.
  await purgeTenant({
    restaurantId: bystander.restaurant.id,
    confirmation: bystander.restaurant.slug,
    actorId: null,
    actorName: 'cleanup',
  }).catch(async () => {
    await prisma.restaurant.update({
      where: { id: bystander.restaurant.id },
      data: { isActive: false },
    })
    await purgeTenant({
      restaurantId: bystander.restaurant.id,
      confirmation: bystander.restaurant.slug,
      actorId: null,
      actorName: 'cleanup',
    })
  })
  await prisma.auditLog.deleteMany({ where: { action: 'TENANT_PURGED', entityId: bystander.restaurant.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect().catch(() => undefined)
  process.exit(1)
})
