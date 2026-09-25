'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import {
  assertCanUseAccount,
  createAccount,
  deposit,
  setAccountActive,
  setAccountStaff,
  transfer,
  updateAccount,
} from './accounts'
import {
  createAccountSchema,
  depositSchema,
  setAccountActiveSchema,
  setAccountStaffSchema,
  transferSchema,
  updateAccountSchema,
} from './accounts-schema'

/**
 * The account screens' write path (bank.md).
 *
 * Two gates on every one of these, and they answer different questions:
 *
 *   `requirePermission` — may this person do this KIND of thing at all
 *   `assertCanUseAccount` — may they do it to THIS account
 *
 * The second is bank.md §2 and it is checked here rather than in the screen,
 * because "Permissions must be enforced on the backend, not only hidden in the
 * UI" — a hidden button is not a rule.
 *
 * Auditing happens after the work, on the global client, never inside the
 * transaction: that is the house convention, and it keeps a failed audit from
 * rolling back money that really moved.
 */

function touched() {
  revalidatePath('/dashboard/payment-details')
}

export async function createAccountAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(createAccountSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNT_MANAGE)
    const account = await createAccount({ restaurantId: user.restaurantId, input: data })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.ACCOUNT_CREATED,
      entity: 'PaymentAccount',
      entityId: account.id,
      // `redact()` strips accountNumber, so the trail says an account was made
      // and by whom without copying the number into a second place.
      after: { name: account.name, code: account.code, bankName: account.bankName },
    })

    touched()
    return { id: account.id }
  })
}

export async function updateAccountAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(updateAccountSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNT_MANAGE)
    await assertCanUseAccount({ user, accountId: data.accountId, need: 'view' })
    await updateAccount({
      restaurantId: user.restaurantId,
      accountId: data.accountId,
      input: data,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.ACCOUNT_UPDATED,
      entity: 'PaymentAccount',
      entityId: data.accountId,
      after: { name: data.name, bankName: data.bankName },
    })

    touched()
    return { id: data.accountId }
  })
}

export async function setAccountActiveAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(setAccountActiveSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNT_MANAGE)
    await assertCanUseAccount({ user, accountId: data.accountId, need: 'view' })
    await setAccountActive({
      restaurantId: user.restaurantId,
      accountId: data.accountId,
      isActive: data.isActive,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.ACCOUNT_UPDATED,
      entity: 'PaymentAccount',
      entityId: data.accountId,
      after: { isActive: data.isActive },
    })

    touched()
    return { id: data.accountId }
  })
}

export async function depositAction(
  input: unknown,
): Promise<ActionResult<{ entryId: string; replayed: boolean }>> {
  return runAction(depositSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNT_MANAGE)
    /*
     * Depositing needs `need: 'transfer'`, not `'view'`.
     *
     * It moves money in, and bank.md §2 draws its line at moving money rather
     * than at the direction. Somebody who may only read an account should not
     * be able to inflate it.
     */
    const account = await assertCanUseAccount({ user, accountId: data.accountId, need: 'transfer' })

    const result = await deposit({
      restaurantId: user.restaurantId,
      accountId: data.accountId,
      amount: data.amount,
      reason: data.reason || null,
      userId: user.id,
      actorName: user.name,
      clientRequestId: data.clientRequestId || null,
    })

    // A replay is not news: the money arrived once and was recorded once.
    if (!result.replayed) {
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ACCOUNT_DEPOSIT,
        entity: 'PaymentAccountEntry',
        entityId: result.entryId,
        after: { account: account.name, amount: data.amount, reason: data.reason || null },
      })
    }

    touched()
    return result
  })
}

export async function transferAction(
  input: unknown,
): Promise<ActionResult<{ transferGroupId: string; replayed: boolean }>> {
  return runAction(transferSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNT_VIEW)
    /*
     * The source is what needs authorising. bank.md §2: "A staff member must
     * NOT be able to transfer money FROM an account unless explicitly
     * authorized." Receiving money is not the dangerous direction, so the
     * destination only has to be readable.
     */
    const from = await assertCanUseAccount({
      user,
      accountId: data.fromAccountId,
      need: 'transfer',
    })
    const to = await assertCanUseAccount({ user, accountId: data.toAccountId, need: 'view' })

    const result = await transfer({
      restaurantId: user.restaurantId,
      fromAccountId: data.fromAccountId,
      toAccountId: data.toAccountId,
      amount: data.amount,
      reason: data.reason,
      userId: user.id,
      actorName: user.name,
      clientRequestId: data.clientRequestId || null,
    })

    if (!result.replayed) {
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ACCOUNT_TRANSFER,
        entity: 'PaymentAccountEntry',
        entityId: result.transferGroupId,
        after: { from: from.name, to: to.name, amount: data.amount, reason: data.reason },
      })
    }

    touched()
    return result
  })
}

export async function setAccountStaffAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(setAccountStaffSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNT_MANAGE)
    const account = await assertCanUseAccount({ user, accountId: data.accountId, need: 'view' })
    await setAccountStaff({
      restaurantId: user.restaurantId,
      accountId: data.accountId,
      staff: data.staff,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.ACCOUNT_STAFF_SET,
      entity: 'PaymentAccount',
      entityId: data.accountId,
      after: {
        account: account.name,
        staff: data.staff.length,
        mayTransfer: data.staff.filter((row) => row.canTransfer).length,
      },
    })

    touched()
    return { id: data.accountId }
  })
}
