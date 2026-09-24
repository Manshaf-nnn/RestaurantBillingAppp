import { z } from 'zod'

/**
 * Server-side environment contract.
 *
 * Validated lazily so that `next build` (which imports modules without a real
 * environment) does not explode, while any runtime code path that actually
 * reads config gets a hard, descriptive failure on misconfiguration.
 */
const serverSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /// Un-pooled connection for migrations; optional so a local setup with no
  /// pooler needs no extra configuration.
  DIRECT_URL: z.string().optional(),
  /// Override the Prisma connection limit if a host needs a different one.
  DB_CONNECTION_LIMIT: z.string().optional(),
  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /*
   * Session lifetimes beyond the staff defaults (athu.md). All optional; the
   * readers in src/server/auth/jwt.ts fall back to the same defaults, so these
   * exist to document the knobs and validate a value somebody does set.
   *
   *   ADMIN_REFRESH_TOKEN_TTL_HOURS  platform-admin session, absolute (12)
   *   REFRESH_ROTATE_AFTER_HOURS     how old a refresh token gets before it
   *                                  rotates (24) — must exceed 12, the
   *                                  "remember me: off" lifetime; jwt.ts asserts it
   *   REFRESH_GRACE_SECONDS          how long a just-rotated token still
   *                                  resolves to its successor (30)
   */
  ADMIN_REFRESH_TOKEN_TTL_HOURS: z.coerce.number().positive().optional(),
  REFRESH_ROTATE_AFTER_HOURS: z.coerce.number().positive().optional(),
  REFRESH_GRACE_SECONDS: z.coerce.number().nonnegative().optional(),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('TableFlow <no-reply@tableflow.app>'),

  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().default(14),

  /*
   * Encrypts third-party credentials at rest — today, the SMS gateway keys a
   * shop owner pastes into Settings.
   *
   * Optional, falling back to JWT_ACCESS_SECRET so an existing deployment
   * keeps working the moment this ships. Setting it properly is still worth
   * doing: rotating JWT_ACCESS_SECRET is a routine action that signs everyone
   * out, and if gateway keys hang off it too, that routine action ALSO breaks
   * every tenant's SMS days later with nothing to connect the two. See
   * src/server/crypto/secret-box.ts.
   */
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(32).optional(),
})

export type ServerEnv = z.infer<typeof serverSchema>

let cached: ServerEnv | null = null

export function env(): ServerEnv {
  if (cached) return cached

  const parsed = serverSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the required values.',
    )
  }

  cached = parsed.data
  return cached
}

/**
 * Public base URL — explicit env first, then the host's (Netlify/Render).
 *
 * Tolerant on purpose: a value pasted without a scheme (e.g. "myapp.netlify.app")
 * is upgraded to https, and anything unparseable falls back to localhost so a
 * stray env value can never crash `new URL(appUrl())` during the build.
 */
export const appUrl = () => {
  const raw = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.URL ||
    process.env.RENDER_EXTERNAL_URL ||
    'http://localhost:3000'
  )
    .trim()
    .replace(/\/$/, '')

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(candidate).origin
  } catch {
    return 'http://localhost:3000'
  }
}

export const isProduction = () => process.env.NODE_ENV === 'production'

export const isCloudinaryConfigured = () =>
  Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET,
  )

export const isSmtpConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD)

/**
 * Whether credentials can be sealed at all.
 *
 * Per-tenant rather than global, unlike its neighbours: the gateway belongs to
 * the shop, so "is SMS configured" is a question about a restaurant row. This
 * only answers the platform half — whether there is a key to encrypt with.
 */
export const isCredentialStoreReady = () =>
  Boolean(process.env.CREDENTIAL_ENCRYPTION_KEY || process.env.JWT_ACCESS_SECRET)
