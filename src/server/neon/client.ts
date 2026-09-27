import 'server-only'

import type { NeonEndpointInfo, NeonProjectSummary, NeonProjectUsage } from './types'

/**
 * The few Neon API calls the platform makes, and nothing else.
 *
 * Read-only by construction: there is no call here that creates, changes or
 * deletes anything at Neon. production.md §10–§11 forbid dangerous database
 * controls in the console, and the cheapest way to obey that is to have no
 * function that could be miswired into one.
 */

const API = 'https://console.neon.tech/api/v2'

export class NeonApiError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or 0 when Neon was never reached. */
    readonly status: number,
  ) {
    super(message)
    this.name = 'NeonApiError'
  }
}

async function call<T>(apiKey: string, path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      // Ten seconds: an hourly job can afford it, a page render cannot much more.
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    throw new NeonApiError(
      timedOut
        ? 'Neon did not answer within 10 seconds.'
        : `Could not reach the Neon API: ${error instanceof Error ? error.message : String(error)}`,
      0,
    )
  }

  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? 'The API key is wrong, expired, or has no access to this project.'
        : response.status === 404
          ? 'No such project is visible to this key.'
          : ''
    throw new NeonApiError(`Neon replied ${response.status} for ${path}. ${hint}`.trim(), response.status)
  }

  return (await response.json()) as T
}

interface RawProject {
  id: string
  name?: string
  region_id?: string
  org_id?: string
  pg_version?: number
  created_at?: string
  history_retention_seconds?: number
  compute_time_seconds?: number
  active_time_seconds?: number
  data_transfer_bytes?: number
  written_data_bytes?: number
  synthetic_storage_size?: number
  consumption_period_start?: string
  consumption_period_end?: string
  settings?: {
    quota?: {
      active_time_seconds?: number
      compute_time_seconds?: number
      written_data_bytes?: number
      data_transfer_bytes?: number
      logical_size_bytes?: number
    }
  }
}

function summarise(raw: RawProject): NeonProjectSummary {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    regionId: raw.region_id ?? null,
    orgId: raw.org_id ?? null,
    pgVersion: raw.pg_version ?? null,
    createdAt: raw.created_at ?? null,
  }
}

/** Every project the key can see. Also the cheapest way to prove a key works. */
export async function listProjects(apiKey: string): Promise<NeonProjectSummary[]> {
  const data = await call<{ projects?: RawProject[] }>(apiKey, '/projects?limit=100')
  return (data.projects ?? []).map(summarise)
}

/** A quota of zero or absent means "none set"; Neon sends 0 for unlimited. */
const quotaOrNull = (value: number | undefined) => (value && value > 0 ? value : null)

export async function getProjectUsage(apiKey: string, projectId: string): Promise<NeonProjectUsage> {
  const data = await call<{ project?: RawProject }>(apiKey, `/projects/${encodeURIComponent(projectId)}`)
  const raw = data.project
  if (!raw) throw new NeonApiError('Neon returned no project for that id.', 0)

  const quota = raw.settings?.quota ?? {}
  return {
    ...summarise(raw),
    plan: null,
    historyRetentionSeconds: raw.history_retention_seconds ?? 0,
    computeHours: (raw.compute_time_seconds ?? 0) / 3600,
    activeHours: (raw.active_time_seconds ?? 0) / 3600,
    storageBytes: raw.synthetic_storage_size ?? 0,
    transferBytes: raw.data_transfer_bytes ?? 0,
    writtenBytes: raw.written_data_bytes ?? 0,
    periodStart: raw.consumption_period_start ?? null,
    periodEnd: raw.consumption_period_end ?? null,
    quota: {
      computeHours: quotaOrNull(quota.compute_time_seconds) === null ? null : quota.compute_time_seconds! / 3600,
      activeHours: quotaOrNull(quota.active_time_seconds) === null ? null : quota.active_time_seconds! / 3600,
      transferBytes: quotaOrNull(quota.data_transfer_bytes),
      writtenBytes: quotaOrNull(quota.written_data_bytes),
      logicalSizeBytes: quotaOrNull(quota.logical_size_bytes),
    },
  }
}

interface RawEndpoint {
  id: string
  host?: string
  branch_id?: string
  type?: string
  current_state?: string
  pending_state?: string
  disabled?: boolean
  autoscaling_limit_min_cu?: number
  autoscaling_limit_max_cu?: number
  suspend_timeout_seconds?: number
  last_active?: string
}

export async function listEndpoints(apiKey: string, projectId: string): Promise<NeonEndpointInfo[]> {
  const data = await call<{ endpoints?: RawEndpoint[] }>(
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/endpoints`,
  )
  return (data.endpoints ?? []).map((raw) => ({
    id: raw.id,
    host: raw.host ?? '',
    branchId: raw.branch_id ?? '',
    type: raw.type ?? 'read_write',
    currentState: raw.current_state ?? 'unknown',
    pendingState: raw.pending_state ?? null,
    disabled: Boolean(raw.disabled),
    minCu: raw.autoscaling_limit_min_cu ?? null,
    maxCu: raw.autoscaling_limit_max_cu ?? null,
    suspendTimeoutSeconds: raw.suspend_timeout_seconds ?? null,
    lastActive: raw.last_active ?? null,
  }))
}

/**
 * The plan name, when the organisation endpoint reveals it.
 *
 * Best effort: a personal-account key has no organisation, and the field is
 * not promised. `null` is shown as nothing rather than guessed.
 */
export async function getOrganizationPlan(apiKey: string, orgId: string): Promise<string | null> {
  try {
    const data = await call<{ plan?: string }>(apiKey, `/organizations/${encodeURIComponent(orgId)}`)
    return typeof data.plan === 'string' && data.plan ? data.plan : null
  } catch {
    return null
  }
}
