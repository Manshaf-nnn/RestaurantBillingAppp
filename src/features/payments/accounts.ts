import 'server-only'

import type { PaymentAccount } from '@prisma/client'

import { AppError, ConflictError, NotFoundError } from '@/lib/errors'
import { visibleBranchIds } from '@/lib/rbac'
import type { TenantUser } from '@/server/auth/guard'
import { isUniqueViolation, prisma, type TxClient } from '@/server/db/prisma'
import {
  accountBalances,
  balanceOf,
  findReplay,
  lockAccounts,
  postAccountEntry,
  type AccountBalance,
} from './accounts-ledger'
import { slugifyDestinationCode } from './destinations'

/**
 * Creating accounts, putting money in, and moving it between them (bank.md).
 *
 * Everything that changes a balance goes through `postAccountEntry`; this file
 * is the four operations an owner actually performs, and the rule about who
 * may perform them.
 */

/* ── Who may touch an account ─────────────────────────────────────────────── */

/**
 * Whether this person may use this account, and if not, why.
 *
 * ── Why this is not a permission ────────────────────────────────────────────
 *
 * bank.md §2 asks a per-RECORD question — "which staff can transfer money FROM
 * that account" — and a permission cannot express "from that one". So this is a
 * routing rule checked beside the permission, in the shape `whyCannotApprove`
 * already established for approvals, and `permissionsFor` stays the single
 * answer to "what may this person do anywhere".
 *
 * ── The default is closed ───────────────────────────────────────────────────
 *
 * bank.md is explicit: "A staff member must NOT be able to transfer from an
 * account unless explicitly authorized." So an account with no staff rows is
 * reachable by the owner and admins and by nobody else — the opposite default
 * from `KitchenStationStaff`, where an empty list means "sees every station",
 * because a section of a kitchen is a convenience and a bank account is money.
 *
 * Unconfined people — an owner or admin, who `visibleBranchIds` returns null
 * for — bypass the list entirely. They are who assigns it.
 */
export type AccountRefusal = 'NOT_ASSIGNED' | 'NOT_A_TRANSFER_USER'

export function unconfined(user: TenantUser): boolean {
  return visibleBranchIds(user) === null
}

export function whyCannotUseAccount(params: {
  user: TenantUser
  access: { canTransfer: boolean } | null
  need: 'view' | 'transfer'
}): AccountRefusal | null {
  if (unconfined(params.user)) return null
  if (!params.access) return 'NOT_ASSIGNED'
  if (params.need === 'transfer' && !params.access.canTransfer) return 'NOT_A_TRANSFER_USER'
  return null
}

const REFUSAL_MESSAGE: Record<AccountRefusal, string> = {
  NOT_ASSIGNED: 'You do not have access to that account. An owner can assign it to you.',
  NOT_A_TRANSFER_USER:
    'You can see that account but not move money out of it. An owner can allow that.',
}

/** The accounts this person may see, with their balances. */
export async function visibleAccountsFor(user: TenantUser): Promise<AccountBalance[]> {
  const balances = await accountBalances(prisma, user.restaurantId)
  if (unconfined(user)) return balances

  const mine = await prisma.paymentAccountStaff.findMany({
    where: { userId: user.id, account: { restaurantId: user.restaurantId } },
    select: { accountId: true },
  })
  const allowed = new Set(mine.map((row) => row.accountId))
  return balances.filter((row) => allowed.has(row.accountId))
}

/**
 * Refuse unless this person may do this to this account.
 *
 * Called by every action, never only by the screen: bank.md §2 says
 * "Permissions must be enforced on the backend, not only hidden in the UI."
 */
export async function assertCanUseAccount(params: {
  user: TenantUser
  accountId: string
  need: 'view' | 'transfer'
}): Promise<PaymentAccount> {
  const account = await prisma.paymentAccount.findFirst({
    where: { id: params.accountId, restaurantId: params.user.restaurantId },
  })
  if (!account) throw new NotFoundError('Account')

  const access = await prisma.paymentAccountStaff.findUnique({
    where: { accountId_userId: { accountId: account.id, userId: params.user.id } },
    select: { canTransfer: true },
  })

  const refusal = whyCannotUseAccount({ user: params.user, access, need: params.need })
  if (refusal) throw new AppError(REFUSAL_MESSAGE[refusal], 403, refusal)
  return account
}

/**
 * The book of accounts a brand-new restaurant starts with.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 *
 * `readPaymentConfig` has always handed an unconfigured restaurant a default
 * set of destinations, so a till worked on day one and an owner renamed them to
 * real banks when they got round to it. Now that a payment resolves an account
 * ROW, a restaurant with no rows could not take money at all — the sign-up
 * flow would end in a cashier being told to go and configure something.
 *
 * So the same defaults are created with the restaurant, in the same
 * transaction, for the same reason the main branch is: a state the app cannot
 * function in should not be reachable. Named after the methods because that is
 * the one naming nobody can find wrong.
 */
export const DEFAULT_ACCOUNTS: Array<{ code: string; name: string }> = [
  { code: 'cash', name: 'Cash' },
  { code: 'card', name: 'Card' },
  { code: 'qr', name: 'QR' },
  { code: 'online', name: 'Online' },
  { code: 'wallet', name: 'Wallet' },
  { code: 'bank_transfer', name: 'Bank transfer' },
  { code: 'other', name: 'Other' },
]

export async function seedDefaultAccounts(
  /** The registration transaction, or the client itself for a fixture. */
  db: TxClient | typeof prisma,
  restaurantId: string,
): Promise<void> {
  await db.paymentAccount.createMany({
    data: DEFAULT_ACCOUNTS.map((account) => ({ restaurantId, ...account })),
    skipDuplicates: true,
  })
}

/* ── The accounts themselves ──────────────────────────────────────────────── */

export interface AccountInput {
  name: string
  bankName?: string | null
  accountNumber?: string | null
  holderName?: string | null
}

/**
 * A new account.
 *
 * The code is minted once from the name by the same `slugifyDestinationCode`
 * the JSON destinations used, and never recomputed on rename — it is the
 * identity every payment stamps, and rewriting it on a typo fix is exactly what
 * would orphan a year of settlements.
 */
export async function createAccount(params: {
  restaurantId: string
  input: AccountInput
}): Promise<PaymentAccount> {
  const name = params.input.name.trim()
  if (!name) throw new AppError('Give the account a name', 400, 'ACCOUNT_NAME')

  const taken = await prisma.paymentAccount.findMany({
    where: { restaurantId: params.restaurantId },
    select: { code: true },
  })
  const code = slugifyDestinationCode(name, taken.map((row) => row.code))

  try {
    return await prisma.paymentAccount.create({
      data: {
        restaurantId: params.restaurantId,
        code,
        name,
        bankName: params.input.bankName?.trim() || null,
        accountNumber: params.input.accountNumber?.trim() || null,
        holderName: params.input.holderName?.trim() || null,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('There is already an account with that name')
    }
    throw error
  }
}

/** Rename an account or correct its bank details. The code never moves. */
export async function updateAccount(params: {
  restaurantId: string
  accountId: string
  input: AccountInput
}): Promise<void> {
  const name = params.input.name.trim()
  if (!name) throw new AppError('Give the account a name', 400, 'ACCOUNT_NAME')

  const touched = await prisma.paymentAccount.updateMany({
    where: { id: params.accountId, restaurantId: params.restaurantId },
    data: {
      name,
      bankName: params.input.bankName?.trim() || null,
      accountNumber: params.input.accountNumber?.trim() || null,
      holderName: params.input.holderName?.trim() || null,
    },
  })
  if (touched.count === 0) throw new NotFoundError('Account')
}

/**
 * Retire an account, or bring it back.
 *
 * Never a delete: payments already point at this code and the history has to
 * keep resolving.
 *
 * An account still holding money cannot be retired. Without that rule
 * "balance and history always reconcile" becomes a sentence about money nobody
 * can see — the owner transfers it somewhere first, which is a movement the
 * ledger records, rather than having it quietly disappear off a screen.
 */
export async function setAccountActive(params: {
  restaurantId: string
  accountId: string
  isActive: boolean
}): Promise<void> {
  if (!params.isActive) {
    const balance = await balanceOf(prisma, {
      restaurantId: params.restaurantId,
      accountId: params.accountId,
    })
    if (balance !== 0) {
      throw new ConflictError(
        'That account still holds money. Transfer it to another account before retiring this one.',
      )
    }
  }

  const touched = await prisma.paymentAccount.updateMany({
    where: { id: params.accountId, restaurantId: params.restaurantId },
    data: { isActive: params.isActive },
  })
  if (touched.count === 0) throw new NotFoundError('Account')
}

/* ── Money in, and money across ───────────────────────────────────────────── */

/**
 * Put money in (bank.md §1).
 *
 * Not a real bank transaction — it records that the owner considers this money
 * to be in this account. It is also how an opening balance is set, which is why
 * accounts are created at zero: the first deposit IS the opening figure, and it
 * appears in the history like everything else rather than as a number that was
 * simply always there.
 */
export async function deposit(params: {
  restaurantId: string
  accountId: string
  amount: number
  reason?: string | null
  userId?: string | null
  actorName?: string | null
  clientRequestId?: string | null
}): Promise<{ entryId: string; replayed: boolean }> {
  return prisma.$transaction(async (tx) => {
    await lockAccounts(tx, {
      restaurantId: params.restaurantId,
      accountIds: [params.accountId],
    })

    const already = await findReplay(tx, params)
    if (already) return { entryId: already.id, replayed: true }

    const entry = await postAccountEntry(tx, {
      restaurantId: params.restaurantId,
      accountId: params.accountId,
      type: 'DEPOSIT',
      amount: params.amount,
      reason: params.reason ?? null,
      userId: params.userId ?? null,
      actorName: params.actorName ?? null,
      clientRequestId: params.clientRequestId ?? null,
    })
    return { entryId: entry.id, replayed: false }
  })
}

/**
 * Move money between two accounts (bank.md §1).
 *
 * ── One transaction, both halves, or neither ────────────────────────────────
 *
 * "The transfer must be one atomic transaction. Never allow the transfer to
 * partially complete." Both entries are written inside one `$transaction`, so
 * a failure on the second rolls the first back — there is no window in which
 * money has left one account and not arrived at the other.
 *
 * Both accounts are locked in one ordered statement BEFORE either write, so a
 * simultaneous transfer the other way waits rather than deadlocking with this
 * one. See `lockAccounts`.
 *
 * The source balance is re-read inside that fence, so "you cannot move money
 * you do not have" is decided against the balance as it is at the moment of the
 * write rather than the one the screen was showing a minute ago.
 */
export async function transfer(params: {
  restaurantId: string
  fromAccountId: string
  toAccountId: string
  amount: number
  reason?: string | null
  userId?: string | null
  actorName?: string | null
  clientRequestId?: string | null
}): Promise<{ transferGroupId: string; replayed: boolean }> {
  if (params.fromAccountId === params.toAccountId) {
    throw new AppError('Choose two different accounts', 400, 'ACCOUNT_SAME')
  }

  return prisma.$transaction(async (tx) => {
    await lockAccounts(tx, {
      restaurantId: params.restaurantId,
      accountIds: [params.fromAccountId, params.toAccountId],
    })

    /*
     * Keyed on the OUT leg. One key per attempt from the screen; the two legs
     * suffix it so both rows satisfy the unique index while one lookup still
     * answers "has this transfer already happened".
     */
    const outKey = params.clientRequestId ? `${params.clientRequestId}#out` : null
    const already = await findReplay(tx, {
      restaurantId: params.restaurantId,
      clientRequestId: outKey,
    })
    if (already) {
      return { transferGroupId: already.transferGroupId ?? already.id, replayed: true }
    }

    const amount = Math.round(params.amount)
    const available = await balanceOf(tx, {
      restaurantId: params.restaurantId,
      accountId: params.fromAccountId,
    })
    if (amount > available) {
      throw new AppError(
        'That account does not hold enough to transfer that much.',
        409,
        'ACCOUNT_INSUFFICIENT',
      )
    }

    /*
     * The id that ties the two halves together. Minted here rather than taken
     * from the client so a caller cannot merge its transfer into somebody
     * else's pair.
     */
    const transferGroupId = `xfer_${crypto.randomUUID()}`

    await postAccountEntry(tx, {
      restaurantId: params.restaurantId,
      accountId: params.fromAccountId,
      type: 'TRANSFER_OUT',
      amount,
      reason: params.reason ?? null,
      counterpartyAccountId: params.toAccountId,
      transferGroupId,
      userId: params.userId ?? null,
      actorName: params.actorName ?? null,
      clientRequestId: outKey,
    })

    await postAccountEntry(tx, {
      restaurantId: params.restaurantId,
      accountId: params.toAccountId,
      type: 'TRANSFER_IN',
      amount,
      reason: params.reason ?? null,
      counterpartyAccountId: params.fromAccountId,
      transferGroupId,
      userId: params.userId ?? null,
      actorName: params.actorName ?? null,
      clientRequestId: params.clientRequestId ? `${params.clientRequestId}#in` : null,
    })

    return { transferGroupId, replayed: false }
  })
}

/* ── Who may use it ───────────────────────────────────────────────────────── */

/**
 * Replace an account's staff list wholesale (bank.md §2).
 *
 * Delete-then-create rather than a diff, copying `setStationStaff`: the list is
 * short, the screen sends the whole thing, and a diff is three code paths where
 * one will do.
 */
export async function setAccountStaff(params: {
  restaurantId: string
  accountId: string
  staff: Array<{ userId: string; canTransfer: boolean }>
}): Promise<void> {
  const account = await prisma.paymentAccount.findFirst({
    where: { id: params.accountId, restaurantId: params.restaurantId },
    select: { id: true },
  })
  if (!account) throw new NotFoundError('Account')

  // Only people who actually work here, so a stale id from an old form cannot
  // grant access to somebody who has left or never belonged to this tenant.
  const members = await prisma.user.findMany({
    where: {
      id: { in: params.staff.map((row) => row.userId) },
      restaurantId: params.restaurantId,
      deletedAt: null,
    },
    select: { id: true },
  })
  const real = new Set(members.map((row) => row.id))

  await prisma.$transaction(async (tx) => {
    await tx.paymentAccountStaff.deleteMany({ where: { accountId: account.id } })
    const rows = params.staff.filter((row) => real.has(row.userId))
    if (rows.length > 0) {
      await tx.paymentAccountStaff.createMany({
        data: rows.map((row) => ({
          accountId: account.id,
          userId: row.userId,
          canTransfer: row.canTransfer,
        })),
        skipDuplicates: true,
      })
    }
  })
}
