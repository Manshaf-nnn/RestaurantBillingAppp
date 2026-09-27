'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { type ActionResult, runAction } from '@/lib/action'
import { AppError } from '@/lib/errors'
import { requireSuperAdmin } from '@/server/auth/guard'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { openSecret } from '@/server/crypto/secret-box'
import { NeonApiError, listProjects } from '@/server/neon/client'
import {
  NEON_SECRET_NAMESPACE,
  clearNeonConfig,
  readNeonConfig,
  sealApiKey,
  writeNeonConfig,
} from '@/server/neon/config'
import { runNeonWatch } from '@/server/neon/monitor'
import type { NeonConfig, NeonProjectSummary } from '@/server/neon/types'

/**
 * What the platform operator may do about the database provider.
 *
 * Same shape as ops-actions.ts: `requireSuperAdmin()` first, an audit row
 * last, and nothing that can change the database itself. Connecting Neon here
 * gives the platform READ access to usage, endpoint state and billing dates;
 * there is no action that could suspend, delete or restore anything.
 */

/** Empty string means "not set"; anything else must be a non-negative number. */
const optionalBudget = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.coerce.number().min(0).max(1_000_000).nullable(),
)

const saveSchema = z.object({
  /** Blank keeps the stored key — the write-only field rule from the SMS settings. */
  apiKey: z.string().trim().max(300).default(''),
  projectId: z.string().trim().max(120).default(''),
  alertEmail: z.union([z.literal(''), z.string().trim().email().max(200)]).default(''),
  reminderDaysBefore: z.coerce.number().int().min(0).max(28).default(3),
  computeHoursBudget: optionalBudget,
  storageGbBudget: optionalBudget,
  transferGbBudget: optionalBudget,
})

function describeKeyError(error: unknown): string {
  if (error instanceof NeonApiError && (error.status === 401 || error.status === 403)) {
    return 'Neon rejected that API key. Create one under Account settings → API keys (or Organization → API keys) and paste it whole.'
  }
  return `Neon could not be reached with that key: ${error instanceof Error ? error.message : String(error)}`
}

export async function saveNeonConfigAction(
  input: unknown,
): Promise<ActionResult<{ projectId: string | null; projects: NeonProjectSummary[] }>> {
  return runAction(
    saveSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()
      const existing = await readNeonConfig()

      const apiKey =
        data.apiKey ||
        (existing.apiKeySealed ? openSecret(existing.apiKeySealed, NEON_SECRET_NAMESPACE) : '') ||
        process.env.NEON_API_KEY ||
        ''
      if (!apiKey) {
        throw new AppError(
          'Enter a Neon API key. Create one in the Neon console under Account settings → API keys.',
          400,
          'NEON_NO_KEY',
        )
      }

      // Proving the key works is one cheap call, and it doubles as the project list.
      let projects: NeonProjectSummary[]
      try {
        projects = await listProjects(apiKey)
      } catch (error) {
        throw new AppError(describeKeyError(error), 400, 'NEON_KEY_REJECTED')
      }

      const projectId =
        data.projectId ||
        existing.projectId ||
        process.env.NEON_PROJECT_ID ||
        (projects.length === 1 ? projects[0]!.id : null)
      if (projectId && !projects.some((project) => project.id === projectId)) {
        throw new AppError(
          `This key cannot see a project with id "${projectId}". A key made inside an organisation sees only that organisation's projects — make the key where the production project lives.`,
          400,
          'NEON_PROJECT_UNSEEN',
        )
      }

      const sealed = data.apiKey
        ? sealApiKey(data.apiKey)
        : { apiKeySealed: existing.apiKeySealed, apiKeyHint: existing.apiKeyHint }

      const next: NeonConfig = {
        ...existing,
        ...sealed,
        projectId,
        alertEmail: data.alertEmail || existing.alertEmail || admin.email,
        reminderDaysBefore: data.reminderDaysBefore,
        budgets: {
          computeHours: data.computeHoursBudget ?? null,
          storageGb: data.storageGbBudget ?? null,
          transferGb: data.transferGbBudget ?? null,
        },
      }
      await writeNeonConfig(next, admin.id)

      await audit({
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.PLATFORM_NEON_CHANGED,
        entity: 'PlatformSetting',
        entityId: 'neon.config',
        before: {
          projectId: existing.projectId,
          alertEmail: existing.alertEmail,
          reminderDaysBefore: existing.reminderDaysBefore,
          apiKeyHint: existing.apiKeyHint,
        },
        after: {
          projectId,
          alertEmail: next.alertEmail,
          reminderDaysBefore: next.reminderDaysBefore,
          apiKeyHint: next.apiKeyHint,
          keyReplaced: Boolean(data.apiKey),
        },
      })

      // Fill the page in straight away, quietly: saving a key is not an incident.
      await runNeonWatch({ notify: false })

      revalidatePath('/admin/database')
      revalidatePath('/admin/backups')
      return { projectId, projects }
    },
    'Neon connected.',
    'saveNeonConfig',
  )
}

export async function checkNeonNowAction(): Promise<ActionResult<{ alerts: number; announced: number }>> {
  return runAction(
    z.object({}).default({}),
    {},
    async () => {
      await requireSuperAdmin()
      const result = await runNeonWatch()
      if (!result.configured) throw new AppError('Neon is not connected yet.', 400, 'NEON_NOT_CONFIGURED')
      if (result.error) throw new AppError(result.error, 500, 'NEON_CHECK_FAILED')
      revalidatePath('/admin/database')
      return { alerts: result.status?.alerts.length ?? 0, announced: result.notified.length }
    },
    'Checked.',
    'checkNeonNow',
  )
}

export async function clearNeonConfigAction(): Promise<ActionResult<{ cleared: true }>> {
  return runAction(
    z.object({}).default({}),
    {},
    async () => {
      const admin = await requireSuperAdmin()
      const existing = await readNeonConfig()
      await clearNeonConfig()
      await audit({
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.PLATFORM_NEON_CHANGED,
        entity: 'PlatformSetting',
        entityId: 'neon.config',
        before: { projectId: existing.projectId, apiKeyHint: existing.apiKeyHint },
        after: null,
      })
      revalidatePath('/admin/database')
      revalidatePath('/admin/backups')
      return { cleared: true as const }
    },
    'Neon disconnected.',
    'clearNeonConfig',
  )
}
