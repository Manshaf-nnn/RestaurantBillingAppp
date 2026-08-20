/** Phase 7: roles, permissions, location scoping, approvals, audit. */
import { prisma } from '../src/server/db/prisma'
import {
  PERMISSIONS, ROLE_PERMISSIONS, ROLE_LABELS, ROLE_HOME,
  branchScope, canAccessBranch, seesAllLocations, visibleBranchIds,
} from '../src/lib/rbac'
import {
  needsApproval, requestApproval, decideApproval, withdrawApproval,
  assertApproved, getApprovalPolicy, listApprovals,
} from '../src/features/approvals/service'
import { AUDIT_ACTIONS, assertAuditImmutable } from '../src/server/audit'

let pass = 0, fail = 0
const shops: string[] = []
function ok(n: string, c: boolean, d = '') { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)) }
async function throws(n: string, fn: () => Promise<unknown>, code?: string) {
  try { await fn(); fail++; console.log(`  ✗ ${n} — expected rejection`) }
  catch (e) { const c = (e as { code?: string }).code
    if (code && c !== code) { fail++; console.log(`  ✗ ${n} — wanted ${code}, got ${c}`) }
    else { pass++; console.log(`  ✓ ${n} (${c ?? 'rejected'})`) } }
}

const ROLES = [
  'SUPER_ADMIN', 'OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN',
  'INVENTORY_MANAGER', 'PURCHASING_MANAGER', 'WAREHOUSE_STAFF', 'ACCOUNTANT',
] as const

async function main() {
  const S = Date.now().toString(36)
  const shop = await prisma.restaurant.create({
    data: { name: `RBAC ${S}`, slug: `rbac-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  shops.push(shop.id)
  const colombo = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Colombo', code: 'COL', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Kandy', code: 'KAN' },
  })

  console.log('\n── 1. Every role is defined ─────────────────────────────')
  for (const role of ROLES) {
    const perms = ROLE_PERMISSIONS[role]
    ok(`${role} has permissions`, Array.isArray(perms) && perms.length > 0, `${perms?.length}`)
    ok(`${role} has a label`, Boolean(ROLE_LABELS[role]))
    ok(`${role} has a landing page`, Boolean(ROLE_HOME[role]))
  }

  console.log('\n── 2. Separation of duties ──────────────────────────────')
  const has = (r: typeof ROLES[number], p: string) => ROLE_PERMISSIONS[r].includes(p as never)
  ok('a cashier cannot approve purchases', !has('CASHIER', PERMISSIONS.PURCHASE_APPROVE))
  ok('a cashier cannot adjust stock', !has('CASHIER', PERMISSIONS.INVENTORY_ADJUST))
  ok('a waiter cannot refund', !has('WAITER', PERMISSIONS.PAYMENT_REFUND))
  ok('a purchasing manager cannot approve their own orders', !has('PURCHASING_MANAGER', PERMISSIONS.PURCHASE_APPROVE))
  ok('warehouse staff cannot adjust a balance', !has('WAREHOUSE_STAFF', PERMISSIONS.INVENTORY_ADJUST))
  ok('warehouse staff cannot edit costs', !has('WAREHOUSE_STAFF', PERMISSIONS.INVENTORY_COST_EDIT))
  ok('an accountant cannot create orders', !has('ACCOUNTANT', PERMISSIONS.ORDER_CREATE))
  ok('an accountant cannot adjust stock', !has('ACCOUNTANT', PERMISSIONS.INVENTORY_ADJUST))
  ok('an accountant can read the audit log', has('ACCOUNTANT', PERMISSIONS.AUDIT_VIEW))
  ok('a kitchen user cannot see payments', !has('KITCHEN', PERMISSIONS.PAYMENT_VIEW))
  ok('an inventory manager can approve counts', has('INVENTORY_MANAGER', PERMISSIONS.INVENTORY_COUNT_APPROVE))
  ok('an inventory manager cannot refund', !has('INVENTORY_MANAGER', PERMISSIONS.PAYMENT_REFUND))
  ok('an admin has full access', ROLE_PERMISSIONS.ADMIN.length === ROLE_PERMISSIONS.OWNER.length)

  console.log('\n── 3. Location scoping ──────────────────────────────────')
  ok('an owner sees every location', seesAllLocations('OWNER'))
  ok('an admin sees every location', seesAllLocations('ADMIN'))
  ok('an accountant sees every location', seesAllLocations('ACCOUNTANT'))
  ok('warehouse staff do not', !seesAllLocations('WAREHOUSE_STAFF'))
  ok('a cashier does not', !seesAllLocations('CASHIER'))

  ok('an owner is unrestricted', visibleBranchIds({ role: 'OWNER' }) === null)
  ok('assigned staff see only their branch',
    JSON.stringify(visibleBranchIds({ role: 'WAREHOUSE_STAFF', branchId: colombo.id })) === JSON.stringify([colombo.id]))
  ok('unassigned staff see nothing, not everything',
    JSON.stringify(visibleBranchIds({ role: 'WAREHOUSE_STAFF', branchId: null })) === '[]')

  ok('an owner scope adds no filter', Object.keys(branchScope({ role: 'OWNER' })).length === 0)
  const scoped = branchScope({ role: 'CASHIER', branchId: colombo.id })
  ok('a scoped query filters to the branch', scoped.branchId?.in?.[0] === colombo.id)

  ok('a manager may access any branch', canAccessBranch({ role: 'MANAGER' }, kandy.id))
  ok('Colombo staff may access Colombo', canAccessBranch({ role: 'CASHIER', branchId: colombo.id }, colombo.id))
  ok('Colombo staff may NOT access Kandy', !canAccessBranch({ role: 'CASHIER', branchId: colombo.id }, kandy.id))
  ok('unassigned staff may access nothing', !canAccessBranch({ role: 'WAREHOUSE_STAFF', branchId: null }, colombo.id))

  console.log('\n── 4. Approval thresholds ───────────────────────────────')
  const policy = await getApprovalPolicy(shop.id)
  ok('defaults apply when nothing is configured', policy.enabled && policy.refundAbove === 10_000_00)
  ok('a refund below the limit needs no approval',
    (await needsApproval({ restaurantId: shop.id, kind: 'REFUND', amount: 5_000_00 })) === false)
  ok('a refund at the limit needs approval',
    (await needsApproval({ restaurantId: shop.id, kind: 'REFUND', amount: 10_000_00 })) === true)
  ok('a large discount needs approval',
    (await needsApproval({ restaurantId: shop.id, kind: 'DISCOUNT', amount: 6_000_00 })) === true)

  await prisma.restaurant.update({
    where: { id: shop.id }, data: { approvalPolicy: { enabled: false } },
  })
  ok('a restaurant can switch approvals off entirely',
    (await needsApproval({ restaurantId: shop.id, kind: 'REFUND', amount: 999_999_00 })) === false)
  await prisma.restaurant.update({
    where: { id: shop.id }, data: { approvalPolicy: { enabled: true, refundAbove: 2_000_00 } },
  })
  ok('a custom threshold overrides the default',
    (await needsApproval({ restaurantId: shop.id, kind: 'REFUND', amount: 2_500_00 })) === true)

  console.log('\n── 5. Approval workflow ─────────────────────────────────')
  const alice = await prisma.user.create({
    data: { restaurantId: shop.id, email: `a-${S}@t.lk`, name: 'Alice', role: 'CASHIER', passwordHash: 'x' },
  })
  const bob = await prisma.user.create({
    data: { restaurantId: shop.id, email: `b-${S}@t.lk`, name: 'Bob', role: 'MANAGER', passwordHash: 'x' },
  })

  const req = await requestApproval({
    restaurantId: shop.id, branchId: colombo.id, kind: 'REFUND',
    entity: 'Order', entityId: 'order-1', amount: 15_000_00,
    reason: 'guest complaint', userId: alice.id,
  })
  ok('a request starts pending', req.status === 'PENDING')

  const again = await requestApproval({
    restaurantId: shop.id, kind: 'REFUND', entity: 'Order', entityId: 'order-1',
    amount: 15_000_00, reason: 'guest complaint', userId: alice.id,
  })
  ok('asking twice reuses the open request', again.id === req.id)

  await throws('acting before approval is refused',
    () => assertApproved({ restaurantId: shop.id, entity: 'Order', entityId: 'order-1', kind: 'REFUND' }),
    'APPROVAL_REQUIRED')

  await throws('you cannot approve your own request',
    () => decideApproval({ restaurantId: shop.id, approvalId: req.id, approve: true, userId: alice.id }),
    'APPROVAL_SELF')

  const decided = await decideApproval({
    restaurantId: shop.id, approvalId: req.id, approve: true, userId: bob.id, note: 'fair enough',
  })
  ok('a manager can approve it', decided.status === 'APPROVED' && decided.decidedById === bob.id)
  await assertApproved({ restaurantId: shop.id, entity: 'Order', entityId: 'order-1', kind: 'REFUND' })
  ok('the action is now allowed', true)

  await throws('deciding twice is refused',
    () => decideApproval({ restaurantId: shop.id, approvalId: req.id, approve: false, userId: bob.id }),
    'APPROVAL_DECIDED')

  const req2 = await requestApproval({
    restaurantId: shop.id, kind: 'DISCOUNT', entity: 'Order', entityId: 'order-2',
    amount: 9_000_00, reason: 'regular customer', userId: alice.id,
  })
  await throws('someone else cannot withdraw your request',
    () => withdrawApproval({ restaurantId: shop.id, approvalId: req2.id, userId: bob.id }),
    'APPROVAL_NOT_YOURS')
  const withdrawn = await withdrawApproval({ restaurantId: shop.id, approvalId: req2.id, userId: alice.id })
  ok('you can withdraw your own', withdrawn.status === 'WITHDRAWN')

  const rejected = await requestApproval({
    restaurantId: shop.id, kind: 'STOCK_ADJUSTMENT', entity: 'InventoryItem', entityId: 'item-1',
    amount: 20_000_00, reason: 'miscount', userId: alice.id,
  })
  await decideApproval({ restaurantId: shop.id, approvalId: rejected.id, approve: false, userId: bob.id })
  await throws('a rejected request does not authorise the action',
    () => assertApproved({ restaurantId: shop.id, entity: 'InventoryItem', entityId: 'item-1', kind: 'STOCK_ADJUSTMENT' }),
    'APPROVAL_REQUIRED')

  const pending = await listApprovals({ restaurantId: shop.id, status: 'PENDING' })
  ok('the pending queue is filterable', pending.every((a) => a.status === 'PENDING'))

  console.log('\n── 6. Audit ─────────────────────────────────────────────')
  ok('role changes are auditable', Boolean(AUDIT_ACTIONS.ROLE_CHANGED))
  ok('price changes are auditable', Boolean(AUDIT_ACTIONS.PRICE_CHANGED))
  ok('logins are auditable', Boolean(AUDIT_ACTIONS.LOGIN))
  ok('refunds are auditable', Boolean(AUDIT_ACTIONS.PAYMENT_REFUNDED))
  ok('approvals are auditable', Boolean(AUDIT_ACTIONS.APPROVAL_DECIDED))

  let blocked = false
  try { assertAuditImmutable('delete') } catch { blocked = true }
  ok('the audit log refuses deletion from application code', blocked)

  const audit = await prisma.auditLog.create({
    data: { restaurantId: shop.id, branchId: colombo.id, userId: bob.id,
      action: AUDIT_ACTIONS.ROLE_CHANGED, entity: 'User', entityId: alice.id,
      before: { role: 'CASHIER' }, after: { role: 'MANAGER' } },
  })
  ok('an audit row records the branch', audit.branchId === colombo.id)
  ok('it keeps the old and new value', JSON.stringify(audit.before) === '{"role":"CASHIER"}')

  console.log('\n── 7. Tenant isolation ──────────────────────────────────')
  const shopB = await prisma.restaurant.create({
    data: { name: `Other ${S}`, slug: `other-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  shops.push(shopB.id)
  await throws('another tenant cannot decide this approval',
    () => decideApproval({ restaurantId: shopB.id, approvalId: rejected.id, approve: true, userId: bob.id }))
  const leak = await listApprovals({ restaurantId: shopB.id })
  ok('another tenant sees none of these approvals', leak.length === 0)

  // cleanup
  await prisma.auditLog.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.approvalRequest.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.user.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.branch.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.restaurant.deleteMany({ where: { id: { in: shops } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\nCRASHED:', e)
  await prisma.$disconnect()
  process.exit(1)
})
