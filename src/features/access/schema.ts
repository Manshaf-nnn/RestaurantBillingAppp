import { z } from 'zod'

import { PERMISSIONS, ROLE_LABELS } from '@/lib/rbac'

/**
 * Roles a custom role may be based on.
 *
 * The preset is not cosmetic — it decides where the person lands after signing
 * in (`ROLE_HOME`), what the edge middleware lets through, and whether
 * `visibleBranchIds` confines them to a site. So it is a real choice, and the
 * same two exclusions apply as for staff: OWNER comes from registering the
 * restaurant and SUPER_ADMIN belongs to no restaurant at all.
 */
export const ROLE_PRESETS = (Object.keys(ROLE_LABELS) as Array<keyof typeof ROLE_LABELS>).filter(
  (role) => role !== 'OWNER' && role !== 'SUPER_ADMIN',
) as [keyof typeof ROLE_LABELS, ...Array<keyof typeof ROLE_LABELS>]

const PERMISSION_VALUES = Object.values(PERMISSIONS) as [string, ...string[]]

/**
 * The permission list, validated against the real vocabulary.
 *
 * An unknown key would sit in the array for ever doing nothing, and would read
 * in the grid as a switch that is on while granting nothing — the most
 * confusing possible state. Rejecting it at the door keeps the stored set and
 * the displayed set the same thing.
 */
export const permissionsField = z
  .array(z.enum(PERMISSION_VALUES))
  .max(200)
  .transform((list) => [...new Set(list)])

const nameField = z
  .string()
  .trim()
  .min(2, 'Give the role a name')
  .max(48, 'Keep the name short enough to read in a list')

/**
 * Empty means the role does not pin a location and the member's own applies.
 * Stored as null, the same convention `branchIdField` uses on the staff form.
 */
const branchIdField = z.string().trim().max(40).optional().nullable()

const roleFields = z.object({
  name: nameField,
  description: z.string().trim().max(160).optional().or(z.literal('')),
  /*
   * Blank means "start from scratch": no permissions seeded, and the LANDING
   * role inferred on the server from what was ticked (`inferPreset`) — one
   * the edge lets into every gated tab that is on, confined by the location
   * when one was chosen.
   *
   * It cannot simply be null. The preset is not cosmetic — it decides where the
   * person lands after signing in, what the edge middleware lets through, and
   * whether `visibleBranchIds` confines them — so every role needs one. What an
   * owner does not need is to be forced to declare which built-in role their
   * custom one resembles before they have decided what it does.
   */
  preset: z.enum(ROLE_PRESETS).or(z.literal('')).optional(),
  branchId: branchIdField,
  permissions: permissionsField,
})

/**
 * People put on the role as it is created, each with an optional location.
 *
 * Optional, and deduplicated by person: the same user listed twice is one
 * assignment, not an error to explain. Capped because two hundred people on
 * one role from one form is a bulk import, and this is not that screen.
 */
const assignmentsField = z
  .array(
    z.object({
      userId: z.string().cuid(),
      /** Where this person works. Null leaves them where they are. */
      branchId: branchIdField,
    }),
  )
  .max(200)
  .transform((rows) => {
    const seen = new Set<string>()
    return rows.filter((row) => (seen.has(row.userId) ? false : (seen.add(row.userId), true)))
  })
  .optional()

export const createRoleSchema = roleFields.extend({
  assignments: assignmentsField,
})
export type CreateRoleInput = z.infer<typeof createRoleSchema>

export const updateRoleSchema = roleFields.extend({
  id: z.string().cuid(),
  isActive: z.coerce.boolean().default(true),
})
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>

export const duplicateRoleSchema = z.object({
  /**
   * Either an existing role to copy, or a built-in to start from. Rolelogic
   * asks for both: "duplicate an existing role as a template", and a set of
   * predefined roles to begin with.
   */
  sourceRoleId: z.string().cuid().optional(),
  sourcePreset: z.enum(ROLE_PRESETS).optional(),
  name: nameField,
})
export type DuplicateRoleInput = z.infer<typeof duplicateRoleSchema>

export const assignRoleSchema = z.object({
  userId: z.string().cuid(),
  /** Null removes the custom role and returns them to their preset defaults. */
  staffRoleId: z.string().cuid().optional().nullable(),
  /**
   * Where this person works, when the role does not pin a location itself.
   * Role = what they can access; location = where they can operate. Absent
   * leaves their current location alone.
   */
  branchId: branchIdField,
})

export const setRoleActiveSchema = z.object({
  id: z.string().cuid(),
  isActive: z.coerce.boolean(),
})

export const deleteRoleSchema = z.object({ id: z.string().cuid() })
