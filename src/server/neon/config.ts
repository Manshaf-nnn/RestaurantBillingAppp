import 'server-only'

import { prisma } from '@/server/db/prisma'
import { credentialHint, credentialKeyStatus, openSecret, sealSecret } from '@/server/crypto/secret-box'

import {
  DEFAULT_NEON_CONFIG,
  type NeonConfig,
  type NeonStatus,
  type PublicNeonConfig,
} from './types'

/**
 * Where the platform keeps what it knows about its own database provider.
 *
 * Two `PlatformSetting` rows: the configuration the operator typed, and the
 * last snapshot the watcher took. The API key is sealed with
 * `src/server/crypto/secret-box.ts` under its own namespace, so a ciphertext
 * written for an SMS gateway can never be opened as a Neon key or vice versa.
 *
 * ── What is deliberately NOT stored here ────────────────────────────────────
 *
 * The database password. The application already holds it in DATABASE_URL —
 * storing a second copy inside the database it opens would protect nothing
 * and add one more place to rotate. And the Neon console login: an API key is
 * scoped, revocable and read-only for what this feature does; a console
 * password is none of those, and no screen here should ever ask for one.
 */

export const NEON_SECRET_NAMESPACE = 'neon'
export const NEON_CONFIG_KEY = 'neon.config'
export const NEON_STATUS_KEY = 'neon.status'

export function mergeNeonConfig(stored: Partial<NeonConfig> | null | undefined, updatedAt?: Date): NeonConfig {
  return {
    ...DEFAULT_NEON_CONFIG,
    ...(stored ?? {}),
    budgets: { ...DEFAULT_NEON_CONFIG.budgets, ...(stored?.budgets ?? {}) },
    updatedAt: updatedAt?.toISOString() ?? stored?.updatedAt ?? null,
  }
}

export async function readNeonConfig(): Promise<NeonConfig> {
  const row = await prisma.platformSetting.findUnique({ where: { key: NEON_CONFIG_KEY } })
  if (!row) return mergeNeonConfig(null)
  try {
    return mergeNeonConfig(JSON.parse(row.value) as Partial<NeonConfig>, row.updatedAt)
  } catch {
    return mergeNeonConfig(null)
  }
}

export async function writeNeonConfig(config: NeonConfig, updatedById: string | null): Promise<void> {
  // `updatedAt` belongs to the row, not the JSON.
  const { updatedAt: _ignored, ...value } = config
  void _ignored
  const data = { value: JSON.stringify(value), updatedById }
  await prisma.platformSetting.upsert({
    where: { key: NEON_CONFIG_KEY },
    create: { key: NEON_CONFIG_KEY, ...data },
    update: data,
  })
}

export async function clearNeonConfig(): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: { in: [NEON_CONFIG_KEY, NEON_STATUS_KEY] } } })
}

export function sealApiKey(plain: string): Pick<NeonConfig, 'apiKeySealed' | 'apiKeyHint'> {
  const trimmed = plain.trim()
  return { apiKeySealed: sealSecret(trimmed, NEON_SECRET_NAMESPACE), apiKeyHint: credentialHint(trimmed) }
}

export interface NeonCredentials {
  apiKey: string
  projectId: string | null
  source: 'stored' | 'env'
}

/**
 * The key to use: what the operator saved, else the environment.
 *
 * The environment fallback keeps `/admin/backups` working for a deployment
 * that set NEON_API_KEY before this screen existed. Throws when a stored key
 * cannot be opened — that is the encryption key having changed, which the
 * operator must hear about rather than have quietly swallowed.
 */
export async function resolveNeonCredentials(config?: NeonConfig): Promise<NeonCredentials | null> {
  const stored = config ?? (await readNeonConfig())
  if (stored.apiKeySealed) {
    return {
      apiKey: openSecret(stored.apiKeySealed, NEON_SECRET_NAMESPACE),
      projectId: stored.projectId ?? process.env.NEON_PROJECT_ID ?? null,
      source: 'stored',
    }
  }
  const envKey = process.env.NEON_API_KEY
  if (envKey) {
    return { apiKey: envKey, projectId: stored.projectId ?? process.env.NEON_PROJECT_ID ?? null, source: 'env' }
  }
  return null
}

/** Whether there is anything to watch. Never throws — the scheduler calls this. */
export async function isNeonConfigured(): Promise<boolean> {
  try {
    return (await resolveNeonCredentials()) !== null
  } catch {
    return false
  }
}

export function publicNeonConfig(config: NeonConfig): PublicNeonConfig {
  const source: PublicNeonConfig['source'] = config.apiKeySealed
    ? 'stored'
    : process.env.NEON_API_KEY
      ? 'env'
      : 'none'
  return {
    configured: source !== 'none',
    source,
    apiKeyHint:
      config.apiKeyHint ?? (source === 'env' ? credentialHint(process.env.NEON_API_KEY ?? '') : null),
    projectId: config.projectId ?? (source === 'env' ? (process.env.NEON_PROJECT_ID ?? null) : null),
    alertEmail: config.alertEmail,
    reminderDaysBefore: config.reminderDaysBefore,
    budgets: config.budgets,
    updatedAt: config.updatedAt,
    encryptionKey: credentialKeyStatus().source,
  }
}

export async function readNeonStatus(): Promise<NeonStatus | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: NEON_STATUS_KEY } })
  if (!row) return null
  try {
    return JSON.parse(row.value) as NeonStatus
  } catch {
    return null
  }
}

export async function writeNeonStatus(status: NeonStatus): Promise<void> {
  const value = JSON.stringify(status)
  await prisma.platformSetting.upsert({
    where: { key: NEON_STATUS_KEY },
    create: { key: NEON_STATUS_KEY, value },
    update: { value },
  })
}
