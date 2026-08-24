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
const permissionsField = z
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

export const createRoleSchema = z.object({
  name: nameField,
  description: z.string().trim().max(160).optional().or(z.literal('')),
  preset: z.enum(ROLE_PRESETS),
  branchId: branchIdField,
  permissions: permissionsField,
})
export type CreateRoleInput = z.infer<typeof createRoleSchema>

export const updateRoleSchema = createRoleSchema.extend({
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
})

export const setRoleActiveSchema = z.object({
  id: z.string().cuid(),
  isActive: z.coerce.boolean(),
})

export const deleteRoleSchema = z.object({ id: z.string().cuid() })
