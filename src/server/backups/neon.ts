import 'server-only'

/**
 * What the database provider actually says about backups (production.md §10).
 *
 * ── The rule this file exists to obey ───────────────────────────────────────
 *
 * §10: "The application MUST NOT pretend to perform database backups if backups
 * are actually handled by the database provider." Neon handles them — the
 * point-in-time recovery window, the retention, the restore machinery. This
 * application performs none of it and must not draw a screen implying it does.
 *
 * `scripts/backup.ts` does exist and does run `pg_dump`, and DEPLOYMENT.md
 * describes wiring it to a VPS crontab — a filesystem the serverless host does
 * not have. So on the deployed platform that script is an off-site convenience
 * somebody may run by hand, not the backup strategy, and the Backups page says
 * so in as many words.
 *
 * ── Not configured is a first-class answer ──────────────────────────────────
 *
 * With no `NEON_API_KEY` this returns `configured: false` and the page shows
 * how to set it up. It does not show zeroes, a green tick, or "backups: OK".
 * A backup page that reports health it has not checked is worse than no backup
 * page, because it is the screen somebody looks at before deciding they are
 * safe.
 */

export interface NeonBackupStatus {
  configured: boolean
  /** Why it is not configured, in words an operator can act on. */
  reason?: string
  projectName?: string
  regionId?: string
  /** Days of point-in-time recovery the plan retains. */
  historyRetentionDays?: number
  /** The oldest moment the database can be restored to. */
  pitrOldest?: string
  branches?: Array<{
    id: string
    name: string
    isDefault: boolean
    isProtected: boolean
    createdAt: string
    logicalSizeBytes: number | null
    /** A branch created from a past moment IS a restore. */
    restoredFrom?: string | null
  }>
  fetchedAt: string
  error?: string
}

const API = 'https://console.neon.tech/api/v2'

/**
 * Ask Neon. Never throw — this feeds a status page, and a status page that
 * 500s during an incident is the least useful thing in the building.
 */
export async function getNeonBackupStatus(): Promise<NeonBackupStatus> {
  const key = process.env.NEON_API_KEY
  const projectId = process.env.NEON_PROJECT_ID
  const fetchedAt = new Date().toISOString()

  if (!key || !projectId) {
    return {
      configured: false,
      fetchedAt,
      reason:
        'NEON_API_KEY and NEON_PROJECT_ID are not set, so this page cannot read the real backup state. ' +
        'Create an API key in the Neon console under Account settings → API keys, find the project id on the project page, ' +
        'and set both as environment variables. Until then, check backups in the Neon console directly.',
    }
  }

  try {
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    // 8 seconds: comfortably inside the serverless function budget, so a slow
    // provider degrades this one panel rather than failing the whole page.
    const signal = AbortSignal.timeout(8_000)

    const [projectResponse, branchesResponse] = await Promise.all([
      fetch(`${API}/projects/${projectId}`, { headers, signal, cache: 'no-store' }),
      fetch(`${API}/projects/${projectId}/branches`, { headers, signal, cache: 'no-store' }),
    ])

    if (!projectResponse.ok) {
      return {
        configured: true,
        fetchedAt,
        error:
          `Neon replied ${projectResponse.status} for the project. ` +
          (projectResponse.status === 401 || projectResponse.status === 403
            ? 'The API key is wrong, expired, or lacks access to this project.'
            : 'Check NEON_PROJECT_ID.'),
      }
    }

    const project = (await projectResponse.json()) as {
      project?: {
        name?: string
        region_id?: string
        history_retention_seconds?: number
      }
    }
    const branches = branchesResponse.ok
      ? ((await branchesResponse.json()) as {
          branches?: Array<{
            id: string
            name: string
            default?: boolean
            protected?: boolean
            created_at: string
            logical_size?: number
            parent_timestamp?: string
          }>
        })
      : { branches: [] }

    const retentionSeconds = project.project?.history_retention_seconds ?? 0
    const retentionDays = Math.round(retentionSeconds / 86_400)

    return {
      configured: true,
      fetchedAt,
      projectName: project.project?.name,
      regionId: project.project?.region_id,
      historyRetentionDays: retentionDays,
      pitrOldest:
        retentionSeconds > 0
          ? new Date(Date.now() - retentionSeconds * 1000).toISOString()
          : undefined,
      branches: (branches.branches ?? []).map((branch) => ({
        id: branch.id,
        name: branch.name,
        isDefault: Boolean(branch.default),
        isProtected: Boolean(branch.protected),
        createdAt: branch.created_at,
        logicalSizeBytes: branch.logical_size ?? null,
        // Neon records the moment a branch was cut from; a branch with one is a
        // point-in-time restore, which is the closest thing to restore history
        // the API exposes.
        restoredFrom: branch.parent_timestamp ?? null,
      })),
    }
  } catch (error) {
    return {
      configured: true,
      fetchedAt,
      error:
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Neon did not answer within 8 seconds. Backups are unaffected by this page failing to load; check the Neon console.'
          : `Could not reach the Neon API: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
