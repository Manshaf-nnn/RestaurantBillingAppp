'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { minorUnitFactor, type CurrencyCode } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { parseCsv } from './bank-import'
import { acceptMatch, importStatement, setLineStatus } from './bank-matching'

const importSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  /** The file's text. CSV as-is; a spreadsheet is converted client-side. */
  content: z.string().min(1).max(4_000_000),
})

const matchSchema = z.object({
  lineId: z.string().cuid(),
  type: z.enum(['PAYMENT', 'SUPPLIER_PAYMENT', 'OUTGOING_PAYMENT']),
  targetId: z.string().cuid(),
})

const statusSchema = z.object({
  lineId: z.string().cuid(),
  status: z.enum(['UNMATCHED', 'IGNORED']),
})

const refresh = () => {
  revalidatePath('/dashboard/accounting/reconciliation')
  revalidatePath('/dashboard/accounting/close')
}

/** Import a downloaded bank statement (acCal.md §6). */
export async function importBankStatementAction(
  input: unknown,
): Promise<ActionResult<{ imported: number; duplicates: number; skipped: number }>> {
  return runAction(importSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_RECONCILE)
    const restaurant = await requireRestaurant(user.restaurantId)

    const result = await importStatement({
      restaurantId: user.restaurantId,
      branchId: user.branchId ?? null,
      fileName: data.fileName,
      content: data.content,
      rows: parseCsv(data.content),
      currencyFactor: minorUnitFactor(restaurant.currency as CurrencyCode),
      uploadedById: user.id,
      uploadedByName: user.name,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.BANK_STATEMENT_IMPORTED,
      entity: 'BankStatement',
      entityId: result.statementId,
      after: { fileName: data.fileName, ...result },
    })

    refresh()
    return { imported: result.imported, duplicates: result.duplicates, skipped: result.skipped }
  }, 'Statement imported.')
}

/** Accept the suggested match for one line. */
export async function matchBankLineAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(matchSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_RECONCILE)

    const result = await acceptMatch({
      restaurantId: user.restaurantId,
      lineId: data.lineId,
      type: data.type,
      targetId: data.targetId,
      userId: user.id,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.BANK_LINE_MATCHED,
      entity: 'BankStatementLine',
      entityId: data.lineId,
      after: { matchedType: data.type, matchedId: data.targetId },
    })

    refresh()
    return result
  }, 'Matched.')
}

/** Undo a match, or set a line aside as not ours to reconcile. */
export async function setBankLineStatusAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(statusSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_RECONCILE)

    const result = await setLineStatus({
      restaurantId: user.restaurantId,
      lineId: data.lineId,
      status: data.status,
      userId: user.id,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: data.status === 'IGNORED' ? AUDIT_ACTIONS.BANK_LINE_IGNORED : AUDIT_ACTIONS.BANK_LINE_UNMATCHED,
      entity: 'BankStatementLine',
      entityId: data.lineId,
      after: { status: data.status },
    })

    refresh()
    return result
  }, 'Updated.')
}
