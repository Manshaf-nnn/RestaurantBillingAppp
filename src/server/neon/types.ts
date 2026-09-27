/**
 * Shapes shared between the Neon watcher (server) and the admin panel (client).
 *
 * No `server-only` here on purpose, so a client component can name what it
 * receives — the same split `src/features/sms/types.ts` makes.
 */

export interface NeonProjectSummary {
  id: string
  name: string
  regionId: string | null
  orgId: string | null
  pgVersion: number | null
  createdAt: string | null
}

export interface NeonEndpointInfo {
  id: string
  host: string
  branchId: string
  type: string
  /** `init`, `active` or `idle` as Neon reports it. */
  currentState: string
  pendingState: string | null
  /** A disabled endpoint refuses every connection until re-enabled. */
  disabled: boolean
  minCu: number | null
  maxCu: number | null
  suspendTimeoutSeconds: number | null
  lastActive: string | null
}

/** What Neon has measured for the CURRENT billing period, plus the fixed facts. */
export interface NeonProjectUsage extends NeonProjectSummary {
  /** The organisation's plan name when the API reveals it; `null` otherwise. */
  plan: string | null
  historyRetentionSeconds: number
  /** Compute-unit hours consumed since `periodStart`. */
  computeHours: number
  /** Wall-clock hours an endpoint was awake since `periodStart`. */
  activeHours: number
  storageBytes: number
  transferBytes: number
  writtenBytes: number
  periodStart: string | null
  /** When Neon closes the period and issues its invoice. */
  periodEnd: string | null
  /** Hard limits Neon enforces on this project, where set. Reaching one refuses connections. */
  quota: {
    computeHours: number | null
    activeHours: number | null
    transferBytes: number | null
    writtenBytes: number | null
    logicalSizeBytes: number | null
  }
}

export interface NeonSnapshot {
  checkedAt: string
  api: { ok: boolean; error: string | null }
  project: NeonProjectUsage | null
  endpoints: NeonEndpointInfo[]
  /** Every project the key can see, so the panel can offer a choice. */
  projects: NeonProjectSummary[]
  /** The application's own connection: does `SELECT 1` answer, and where does DATABASE_URL point. */
  app: { host: string | null; ok: boolean; latencyMs: number | null; error: string | null }
}

export type NeonAlertLevel = 'info' | 'warning' | 'critical'

export interface NeonAlert {
  /** Stable per condition, so a repeat is recognised and not re-announced every hour. */
  key: string
  level: NeonAlertLevel
  title: string
  detail: string
}

export interface NeonStatus {
  snapshot: NeonSnapshot
  alerts: NeonAlert[]
  /** alert key → ISO time it was last announced. */
  notified: Record<string, string>
}

export interface NeonBudgets {
  computeHours: number | null
  storageGb: number | null
  transferGb: number | null
}

export interface NeonConfig {
  apiKeySealed: string | null
  apiKeyHint: string | null
  projectId: string | null
  alertEmail: string | null
  /** How many days before the period closes the invoice reminder starts. */
  reminderDaysBefore: number
  budgets: NeonBudgets
  updatedAt: string | null
}

/** The config with the secret removed — what a browser may hold. */
export interface PublicNeonConfig {
  configured: boolean
  source: 'stored' | 'env' | 'none'
  apiKeyHint: string | null
  projectId: string | null
  alertEmail: string | null
  reminderDaysBefore: number
  budgets: NeonBudgets
  updatedAt: string | null
  /** Which key seals the stored API key; `fallback` means the session secret is doing double duty. */
  encryptionKey: 'dedicated' | 'fallback' | 'none'
}

export const DEFAULT_NEON_CONFIG: NeonConfig = {
  apiKeySealed: null,
  apiKeyHint: null,
  projectId: null,
  alertEmail: null,
  reminderDaysBefore: 3,
  budgets: { computeHours: null, storageGb: null, transferGb: null },
  updatedAt: null,
}
