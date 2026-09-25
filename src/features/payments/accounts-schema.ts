import { z } from 'zod'

/**
 * What the account screens may send.
 *
 * A separate file from `accounts-actions.ts` because a `'use server'` module
 * may export only async functions — a Zod schema exported beside an action
 * kills every action in the file at runtime, which is what
 * `no-bad-server-exports` exists to catch.
 */

/** Minor units. A whole number, never negative, and bounded so a typo is caught. */
const money = z.coerce
  .number()
  .int('Enter a whole amount')
  .positive('Enter an amount greater than zero')
  .max(1_000_000_000, 'That is more than this system will move in one go')

const accountFields = {
  /** What the owner calls it — "BOC Main Account". */
  name: z.string().trim().min(1, 'Give the account a name').max(60),
  /** The three bank details bank.md §1 asks for. All optional, deliberately:
   *  an owner who knows "card goes to HNB" and not the number should be able to
   *  say so and move on rather than abandon the form. */
  bankName: z.string().trim().max(60).optional().or(z.literal('')),
  accountNumber: z.string().trim().max(40).optional().or(z.literal('')),
  holderName: z.string().trim().max(60).optional().or(z.literal('')),
}

export const createAccountSchema = z.object(accountFields)

export const updateAccountSchema = z.object({
  accountId: z.string().cuid(),
  ...accountFields,
})

export const setAccountActiveSchema = z.object({
  accountId: z.string().cuid(),
  isActive: z.coerce.boolean(),
})

export const depositSchema = z.object({
  accountId: z.string().cuid(),
  amount: money,
  reason: z.string().trim().max(160).optional().or(z.literal('')),
  /** One key per attempt, so a double tap deposits once. */
  clientRequestId: z.string().trim().min(8).max(64).optional().or(z.literal('')),
})

export const transferSchema = z
  .object({
    fromAccountId: z.string().cuid('Choose the account the money leaves'),
    toAccountId: z.string().cuid('Choose the account the money goes to'),
    amount: money,
    /* Required on a transfer, unlike a deposit. A deposit explains itself —
     * money came in — while "why did 50,000 move from BOC to HNB" is the only
     * question anybody asks about it three months later. */
    reason: z.string().trim().min(1, 'Say why the money is moving').max(160),
    clientRequestId: z.string().trim().min(8).max(64).optional().or(z.literal('')),
  })
  .superRefine((value, ctx) => {
    if (value.fromAccountId === value.toAccountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toAccountId'],
        message: 'Choose a different account to move the money to',
      })
    }
  })

export const setAccountStaffSchema = z.object({
  accountId: z.string().cuid(),
  staff: z
    .array(
      z.object({
        userId: z.string().cuid(),
        /** Seeing an account is not permission to move money out of it. */
        canTransfer: z.coerce.boolean().default(false),
      }),
    )
    .max(100),
})
