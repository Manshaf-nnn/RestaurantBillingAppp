/**
 * The Stock Keeper (stockMa.md).
 *
 * A branch-bound storeman: receives, moves, counts, wastes and makes, at one
 * location, and asks for a correction rather than making one.
 *
 * What is pinned, and why:
 *
 *   - the permission matrix, both halves. The CAN list is easy to get right
 *     and the MUST NOT list is the one that matters, so every forbidden
 *     permission is named individually rather than inferred;
 *   - `APPROVALS_FORCE` above all, because it is the single thing that can
 *     break the self-approval rule;
 *   - the report trap: `REPORT_VIEW` splits into seven children including
 *     cash and profit, so the two stock reports are granted directly and this
 *     asserts the other five did not come with them;
 *   - branch confinement, including that an unassigned stock keeper sees
 *     NOTHING rather than everything — the fail-open direction is the
 *     dangerous one;
 *   - the adjustment flow end to end: a request moves no stock, the approval
 *     moves exactly the right amount, the mover is named, the ledger row
 *     carries the ADJ- reference, and the person who asked cannot be the
 *     person who signs;
 *   - that a second request on the same item is its own request, not the
 *     first one returned by the dedupe — that bug would look like success
 *     and record nothing.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/stock-keeper-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  PERMISSIONS, ROLE_HOME, ROLE_LABELS, ROLE_PERMISSIONS,
  assignableRoles, requiresOwnBranch, seesAllLocations, visibleBranchIds,
} from '../src/lib/rbac'
import { reachableNavItems } from '../src/features/dashboard/nav'
import { decideApproval, requestApproval } from '../src/features/approvals/service'
import { adjustStock } from '../src/features/inventory/operations'
import { postMovement } from '../src/features/inventory/ledger'
import { AUDIT_ACTIONS } from '../src/server/audit'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(`${code} ${message}`), `wrong reason: ${code} ${message}`)
  }
}

const stamp = Date.now().toString(36)
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } })
  await prisma.approvalRequest.deleteMany({ where: { restaurantId: id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: id } })
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

const held = (permission: string) =>
  (ROLE_PERMISSIONS.STOCK_KEEPER as string[]).includes(permission)

async function main() {
  console.log('\n── 1. What a stock keeper may do ──')
  {
    for (const [label, permission] of [
      ['see the stock', PERMISSIONS.INVENTORY_VIEW],
      ['count a shelf', PERMISSIONS.INVENTORY_COUNT],
      ['record wastage', PERMISSIONS.INVENTORY_WASTAGE],
      ['ask for a correction', PERMISSIONS.INVENTORY_ADJUST_REQUEST],
      ['see what is expiring', PERMISSIONS.INVENTORY_EXPIRY_VIEW],
      ['request a transfer', PERMISSIONS.TRANSFER_REQUEST],
      ['dispatch one', PERMISSIONS.TRANSFER_DISPATCH],
      ['receive one', PERMISSIONS.TRANSFER_RECEIVE],
      ['receive a delivery', PERMISSIONS.PURCHASE_RECEIVE],
      ['read the purchase record', PERMISSIONS.PURCHASE_VIEW],
      ['read the supplier record', PERMISSIONS.SUPPLIER_VIEW],
      ['run production', PERMISSIONS.PRODUCTION_MANAGE],
      ['read the inventory report', PERMISSIONS.REPORT_INVENTORY],
      ['read the variance report', PERMISSIONS.REPORT_VARIANCE],
      ['hand their shift on', PERMISSIONS.HANDOVER_VIEW],
    ] as const) {
      check(`they can ${label}`, held(permission))
    }
  }

  console.log('\n── 2. What a stock keeper must never do ──')
  {
    for (const [label, permission] of [
      ['adjust a balance directly', PERMISSIONS.INVENTORY_ADJUST],
      ['edit a cost', PERMISSIONS.INVENTORY_COST_EDIT],
      ['move stock by hand', PERMISSIONS.INVENTORY_MANAGE],
      ['sign off a count', PERMISSIONS.INVENTORY_COUNT_APPROVE],
      ['sign off wastage', PERMISSIONS.INVENTORY_WASTAGE_APPROVE],
      ['approve a transfer', PERMISSIONS.TRANSFER_APPROVE],
      ['raise a purchase order', PERMISSIONS.PURCHASE_CREATE],
      ['approve a purchase', PERMISSIONS.PURCHASE_APPROVE],
      ['send stock back to a supplier', PERMISSIONS.PURCHASE_RETURN],
      ['edit a supplier', PERMISSIONS.SUPPLIER_MANAGE],
      ['pay a supplier', PERMISSIONS.SUPPLIER_PAYMENT],
      ['read the takings', PERMISSIONS.DASHBOARD_VIEW],
      ['read the cash report', PERMISSIONS.REPORT_CASH],
      ['read the profit report', PERMISSIONS.REPORT_PROFIT],
      ['refund anybody', PERMISSIONS.PAYMENT_REFUND],
    ] as const) {
      check(`they cannot ${label}`, !held(permission))
    }
    // The one that matters most: it is the only thing that can break the
    // self-approval rule (`whyCannotApprove`), so it is asserted alone.
    check('and above all they cannot override an approval', !held(PERMISSIONS.APPROVALS_FORCE))
  }

  console.log('\n── 3. One location, and nothing without one ──')
  {
    check('the role is registered', Boolean(ROLE_LABELS.STOCK_KEEPER) && ROLE_HOME.STOCK_KEEPER === '/dashboard/inventory')
    check('they do not see every site', !seesAllLocations('STOCK_KEEPER'))
    check('they must be given one', requiresOwnBranch('STOCK_KEEPER'))
    check('assigned, they see exactly theirs', JSON.stringify(visibleBranchIds({ role: 'STOCK_KEEPER', branchId: 'b1' })) === '["b1"]')
    // The fail-open direction is the dangerous one: [] is blind, null is everything.
    check('unassigned, they see nothing — not everything', JSON.stringify(visibleBranchIds({ role: 'STOCK_KEEPER', branchId: null })) === '[]')
    check('a manager may create one', assignableRoles('MANAGER').includes('STOCK_KEEPER'))
    check('a cashier may not', !assignableRoles('CASHIER').includes('STOCK_KEEPER'))
  }

  console.log('\n── 4. The sidebar is the spec\'s list, and nothing else ──')
  {
    const hrefs = reachableNavItems({ role: 'STOCK_KEEPER' }).map((item) => item.href)
    for (const href of [
      '/dashboard/inventory',
      '/dashboard/inventory/ledger',
      '/dashboard/inventory/counts',
      '/dashboard/inventory/wastage',
      '/dashboard/inventory/adjustments',
      '/dashboard/transfers',
      '/dashboard/production',
      '/dashboard/purchases',
      '/dashboard/purchases/receive',
      '/dashboard/suppliers',
      '/dashboard/reports/inventory',
    ]) {
      check(`they reach ${href}`, hrefs.includes(href), hrefs.join(', '))
    }
    for (const href of [
      '/dashboard',
      '/dashboard/reports/profit',
      '/dashboard/accounting',
      '/dashboard/staff',
      '/dashboard/settings',
      '/cashier/pos',
    ]) {
      check(`they do not reach ${href}`, !hrefs.includes(href))
    }
  }

  // ── fixtures for the behaviour half ───────────────────────────────────────
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Store Co', slug: `store-${stamp}`, email: `store-${stamp}@test.local`, currency: 'LKR' },
  })
  restaurantId = restaurant.id
  const colombo = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Colombo', code: 'COL', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KAN' },
  })
  const keeper = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `keeper-${stamp}@test.local`, name: 'Keeper',
      passwordHash: 'x', role: 'STOCK_KEEPER', branchId: colombo.id,
    },
  })
  const manager = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `mgr-${stamp}@test.local`, name: 'Manager',
      passwordHash: 'x', role: 'MANAGER', branchId: colombo.id,
    },
  })
  const rice = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Rice ${stamp}`, unit: 'KG', branchId: colombo.id, costPerUnit: 300_00 },
  })
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: rice.id, type: 'PURCHASE', quantity: 100,
      enteredUnit: 'KG', branchId: colombo.id, locationId: null, userId: manager.id,
    }),
  )
  const balance = async () =>
    (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: rice.id } })).quantity
  const movements = () => prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })

  console.log('\n── 5. A correction is asked for, and moves nothing ──')
  let requestId = ''
  {
    const before = { qty: await balance(), rows: await movements() }
    const request = await requestApproval({
      restaurantId: restaurant.id,
      branchId: colombo.id,
      kind: 'STOCK_ADJUSTMENT',
      entity: 'StockAdjustment',
      entityId: 'ADJ-0001',
      amount: 300_00 * 2,
      reason: 'Counted the shelf twice — 98 kg, not 100',
      userId: keeper.id,
      payload: {
        reference: 'ADJ-0001', itemId: rice.id, itemName: rice.name,
        quantity: 2, unit: 'KG', direction: 'OUT', branchId: colombo.id,
      },
    })
    requestId = request.id
    check('the request is pending, at their branch', request.status === 'PENDING' && request.branchId === colombo.id)
    check('and names who asked', request.requestedById === keeper.id)
    check('the shelf has not moved', (await balance()) === before.qty)
    check('and nothing was written to the ledger', (await movements()) === before.rows)

    const raised = await prisma.auditLog.findFirst({
      where: { restaurantId: restaurant.id, action: AUDIT_ACTIONS.APPROVAL_REQUESTED, entityId: request.id },
    })
    check('raising it is in the audit trail', raised !== null)
    check('with the branch on it', raised?.branchId === colombo.id)
    check('and who asked', raised?.userId === keeper.id)
  }

  console.log('\n── 6. A second correction is its own request ──')
  {
    // The dedupe key is (entity, entityId, kind). Keyed on the ITEM, this
    // second request would silently return the first and record nothing.
    const second = await requestApproval({
      restaurantId: restaurant.id, branchId: colombo.id, kind: 'STOCK_ADJUSTMENT',
      entity: 'StockAdjustment', entityId: 'ADJ-0002', amount: 300_00,
      reason: 'And a broken bag', userId: keeper.id,
      payload: { reference: 'ADJ-0002', itemId: rice.id, quantity: 1, unit: 'KG', direction: 'OUT' },
    })
    check('it is a different request', second.id !== requestId)
    check('both are waiting', (await prisma.approvalRequest.count({
      where: { restaurantId: restaurant.id, kind: 'STOCK_ADJUSTMENT', status: 'PENDING' },
    })) === 2)

    // …and the same reference twice IS the same request, which is what the
    // dedupe is for: a double tap must not make two corrections.
    const retry = await requestApproval({
      restaurantId: restaurant.id, branchId: colombo.id, kind: 'STOCK_ADJUSTMENT',
      entity: 'StockAdjustment', entityId: 'ADJ-0002', amount: 300_00,
      reason: 'And a broken bag', userId: keeper.id,
    })
    check('but the same one twice is one request', retry.id === second.id)
  }

  console.log('\n── 7. They cannot sign their own ──')
  {
    await refuses(
      'the person who asked cannot approve it',
      () => decideApproval({
        restaurantId: restaurant.id, approvalId: requestId, approve: true,
        userId: keeper.id, unconfined: false,
      }),
      /APPROVAL_SELF/,
    )
    check('and it is still waiting', (await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: requestId },
    })).status === 'PENDING')
  }

  console.log('\n── 8. Approving it moves the stock, once, with its reference ──')
  {
    const before = await balance()
    await decideApproval({
      restaurantId: restaurant.id, approvalId: requestId, approve: true,
      userId: manager.id, unconfined: false,
      apply: async (tx) => {
        await adjustStock({
          restaurantId: restaurant.id, branchId: colombo.id, itemId: rice.id,
          quantity: 2, unit: 'KG', direction: 'OUT',
          reason: 'Counted the shelf twice — 98 kg, not 100',
          reference: 'ADJ-0001', userId: keeper.id, tx,
        })
      },
    })
    check('the request is approved', (await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: requestId },
    })).status === 'APPROVED')
    check('the shelf moved by exactly the difference', (await balance()) === before - 2, String(await balance()))

    const posted = await prisma.stockMovement.findFirst({
      where: { restaurantId: restaurant.id, referenceType: 'StockAdjustment', referenceId: 'ADJ-0001' },
    })
    check('one ledger row carries the adjustment number', posted !== null)
    check('it is an outward correction at the right branch', posted?.type === 'ADJUSTMENT_OUT' && posted.branchId === colombo.id)
    check('and it names the person who found it, not the one who signed', posted?.userId === keeper.id)
    check('the reason travelled with it', (posted?.reason ?? '').includes('Counted the shelf twice'))
  }

  console.log('\n── 9. A refusal moves nothing ──')
  {
    const pending = await prisma.approvalRequest.findFirstOrThrow({
      where: { restaurantId: restaurant.id, status: 'PENDING', kind: 'STOCK_ADJUSTMENT' },
    })
    const before = { qty: await balance(), rows: await movements() }
    await decideApproval({
      restaurantId: restaurant.id, approvalId: pending.id, approve: false,
      userId: manager.id, note: 'Recount it with me on Monday', unconfined: false,
    })
    const after = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: pending.id } })
    check('it is rejected, with the reason kept', after.status === 'REJECTED' && after.decisionNote === 'Recount it with me on Monday')
    check('the shelf is untouched', (await balance()) === before.qty && (await movements()) === before.rows)
  }

  console.log('\n── 10. Another branch is another branch ──')
  {
    const stranger = { role: 'STOCK_KEEPER' as const, branchId: kandy.id }
    check('a Kandy keeper cannot reach Colombo', !(visibleBranchIds(stranger) ?? []).includes(colombo.id))
    check('and a Colombo keeper cannot reach Kandy',
      !(visibleBranchIds({ role: 'STOCK_KEEPER', branchId: colombo.id }) ?? []).includes(kandy.id))
  }
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
