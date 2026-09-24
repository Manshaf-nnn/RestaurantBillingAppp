import 'server-only'

import { prisma } from '@/server/db/prisma'
import { openSecret, sealSecret, credentialHint } from '@/server/crypto/secret-box'

import { specFor, credentialFieldsFor } from './presets'
import { LK } from './msisdn'
import {
  DEFAULT_SMS_CONFIG,
  type HttpGatewaySpec,
  type ResolvedSmsConfig,
  type SmsConfig,
  type SmsCredentialField,
} from './types'

/**
 * Reading and writing one tenant's gateway configuration.
 *
 * Stored the same way every other per-tenant policy in this schema is stored —
 * a `Json?` column on `Restaurant`, merged over a complete default on read, so
 * a row written before a field existed still yields a whole object. See
 * `src/features/live/policy.ts`, which this deliberately mirrors.
 *
 * Its own column rather than a corner of `paymentConfig`, for the reason
 * `receiptConfig` was split out of `printerConfig`: two forms writing one
 * column is how one silently erases the other's fields.
 */

export const SMS_SECRET_NAMESPACE = 'sms'

export const PLATFORM_SMS_DISABLED_KEY = 'sms.disabled'
export const PLATFORM_SMS_ALLOWLIST_KEY = 'sms.hostAllowlist'

/** Merged over the defaults, so callers always get a complete object. */
export async function readSmsConfig(restaurantId: string): Promise<SmsConfig> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { smsConfig: true },
  })
  const stored = restaurant?.smsConfig as Partial<SmsConfig> | null
  return mergeSmsConfig(stored)
}

/**
 * Nested objects need their own spread — a shallow merge over a stored `caps`
 * that predates `otpPerHour` yields a config whose cap is `undefined`, and an
 * undefined cap compares false against every count.
 */
export function mergeSmsConfig(stored: Partial<SmsConfig> | null | undefined): SmsConfig {
  return {
    ...DEFAULT_SMS_CONFIG,
    ...(stored ?? {}),
    caps: { ...DEFAULT_SMS_CONFIG.caps, ...(stored?.caps ?? {}) },
    triggers: { ...DEFAULT_SMS_CONFIG.triggers, ...(stored?.triggers ?? {}) },
    credentials: { ...(stored?.credentials ?? {}) },
    credentialHints: { ...(stored?.credentialHints ?? {}) },
    templates: { ...(stored?.templates ?? {}) },
    /* Fixed in v1. Never inherited from Restaurant.country, which defaults to "IN". */
    defaultCountry: 'LK',
  }
}

/** The country whose dialling plan resolves this tenant's local numbers. */
export const countryFor = (_config: SmsConfig) => LK

/* `publicSmsConfig` and its type live in ./types, which carries no
 * `server-only`, so a client component can name the shape it receives. */
export { publicSmsConfig, type PublicSmsConfig } from './types'

// ── Credentials ──────────────────────────────────────────────────────────────

/**
 * Merge newly typed credentials into the stored ones.
 *
 * An empty incoming value means LEAVE UNCHANGED, not "clear it". That is what
 * lets an owner correct their sender mask without re-typing an API key they no
 * longer have to hand, and it is the one rule that makes the write-only secret
 * field usable rather than infuriating. Clearing is a separate, explicit act.
 */
export function mergeCredentials(
  existing: SmsConfig,
  incoming: Partial<Record<SmsCredentialField, string>>,
): { credentials: SmsConfig['credentials']; hints: SmsConfig['credentialHints']; changed: SmsCredentialField[] } {
  const credentials = { ...existing.credentials }
  const hints = { ...existing.credentialHints }
  const changed: SmsCredentialField[] = []

  for (const [field, raw] of Object.entries(incoming) as [SmsCredentialField, string | undefined][]) {
    if (raw === undefined) continue

    /* A trailing newline from a copy-paste is the commonest support ticket. */
    const value = raw.trim()
    if (!value) continue

    credentials[field] = sealSecret(value, SMS_SECRET_NAMESPACE)
    hints[field] = credentialHint(value)
    changed.push(field)
  }

  return { credentials, hints, changed }
}

/** Drop credential slots this gateway does not use, so a switch leaves nothing behind. */
export function pruneCredentials(
  config: SmsConfig,
): { credentials: SmsConfig['credentials']; hints: SmsConfig['credentialHints'] } {
  const allowed = new Set(credentialFieldsFor(config.provider).map((field) => field.name))
  const credentials: SmsConfig['credentials'] = {}
  const hints: SmsConfig['credentialHints'] = {}

  for (const [field, value] of Object.entries(config.credentials) as [SmsCredentialField, string][]) {
    if (allowed.has(field)) credentials[field] = value
  }
  for (const [field, value] of Object.entries(config.credentialHints) as [SmsCredentialField, string][]) {
    if (allowed.has(field)) hints[field] = value
  }

  return { credentials, hints }
}

/**
 * The config an adapter can actually use: spec chosen, credentials decrypted.
 *
 * Returns null when the tenant has not finished configuring, so every caller
 * has one obvious branch for "this shop does not do SMS" rather than each
 * inventing its own check.
 */
export async function resolveSmsConfig(restaurantId: string): Promise<ResolvedSmsConfig | null> {
  const config = await readSmsConfig(restaurantId)
  return resolveFrom(config)
}

export function resolveFrom(config: SmsConfig): ResolvedSmsConfig | null {
  const spec: HttpGatewaySpec | null = specFor(config.provider, config.spec)
  if (!spec || !spec.url) return null

  const credentials: Partial<Record<SmsCredentialField, string>> = {}
  for (const [field, sealed] of Object.entries(config.credentials) as [SmsCredentialField, string][]) {
    if (!sealed) continue
    credentials[field] = openSecret(sealed, SMS_SECRET_NAMESPACE)
  }

  return { config, spec, credentials }
}

// ── Platform-level switches ──────────────────────────────────────────────────

/**
 * The operator's global stop.
 *
 * Fails CLOSED in the opposite direction to `readMaintenance`: if this lookup
 * breaks we keep sending, because a database blip should not silently mute
 * every tenant's OTPs. The switch exists for a deliberate act, and a deliberate
 * act can be repeated.
 */
export async function isPlatformSmsDisabled(): Promise<boolean> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: PLATFORM_SMS_DISABLED_KEY } })
    if (!row) return false
    return JSON.parse(row.value)?.enabled === true
  } catch {
    return false
  }
}

/** Empty means any public host, which is the default. */
export async function gatewayHostAllowlist(): Promise<string[]> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: PLATFORM_SMS_ALLOWLIST_KEY } })
    if (!row) return []
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed?.hosts) ? parsed.hosts.map((h: string) => h.toLowerCase()) : []
  } catch {
    return []
  }
}
