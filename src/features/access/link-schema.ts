import { z } from 'zod'

import { ROLE_PRESETS } from './schema'

/**
 * Creating an access link.
 *
 * The old endpoint took `{ role, days }` and cast the role straight out of the
 * request body with no validation of any kind. Everything here is checked, and
 * then checked again by `vetLink` against what the person creating it may
 * actually hand out — a link is an account, so it passes the same rules as
 * creating one.
 */
export const createLinkSchema = z
  .object({
    mode: z.enum(['PERSONAL', 'SHARED_DEVICE']),
    role: z.enum(ROLE_PRESETS),
    /** The custom role this link grants, if any. */
    staffRoleId: z.string().cuid().optional().nullable(),
    /** Empty means "wherever the role says", resolved server-side. */
    branchId: z.string().trim().max(40).optional().nullable(),
    /** Required for PERSONAL — whose account the link signs in to. */
    userId: z.string().cuid().optional().nullable(),
    label: z.string().trim().max(60).optional().or(z.literal('')),
    /**
     * Days until it stops working. Zero means never, which is the honest
     * option for a wall-mounted screen — an expiring kitchen link fails at
     * dinner service on a day nobody remembers setting it.
     */
    days: z.coerce.number().int().min(0).max(365).default(30),
  })
  .refine((data) => data.mode !== 'PERSONAL' || Boolean(data.userId), {
    message: 'Choose who this link is for',
    path: ['userId'],
  })
export type CreateLinkInput = z.infer<typeof createLinkSchema>

export const linkIdSchema = z.object({ id: z.string().cuid() })

/**
 * Signing in through a link.
 *
 * The token comes from the URL rather than a form field, but it is validated
 * like any other input — a token shape is cheap to check and stops a malformed
 * one reaching the database lookup.
 */
export const joinSchema = z.object({
  token: z.string().trim().min(16).max(128),
  email: z.string().trim().email().max(255),
  /** Formatted `XXXX-XXXX`, but accepted with or without the dash. */
  code: z.string().trim().min(4).max(32),
})
