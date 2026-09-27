import 'server-only'

import { prisma } from '@/server/db/prisma'
import { captureError } from '@/server/errors'
import { sendMail, type MailInput } from '@/server/mailer'
import { appUrl } from '@/lib/env'

import { getOrganizationPlan, getProjectUsage, listEndpoints, listProjects } from './client'
import { readNeonConfig, readNeonStatus, resolveNeonCredentials, writeNeonStatus, type NeonCredentials } from './config'
import type { NeonAlert, NeonAlertLevel, NeonConfig, NeonSnapshot, NeonStatus } from './types'

/**
 * The database watcher.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * On 2026-09-27 the production database stopped answering because its Neon
 * project had used up a monthly allowance. Nothing in the platform noticed:
 * the first sign was a restaurant unable to sign in, and the diagnosis took an
 * evening because Prisma paraphrases "you are over quota" as "can't reach the
 * server". Every fact needed to see it coming — usage against limits, when the
 * period closes, whether the endpoint is enabled, and whether the app is even
 * pointed at the project somebody is watching — is one API call away. So an
 * hourly job asks, and says something BEFORE the door closes.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *
 * `takeSnapshot` asks Neon and the database; `evaluate` turns a snapshot into
 * alerts and is pure, so it is tested with fixtures rather than a live key;
 * `runNeonWatch` ties them together, announces what is new, and stores the
 * result for the admin page. Announcing is rate-limited PER ALERT: a reminder
 * that fires every hour for three days is noise, and noise is muted.
 */

const DAY_MS = 86_400_000
const GB = 1024 ** 3

export function appDatabaseHost(url: string | undefined = process.env.DATABASE_URL): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/**
 * What the connection string already says, without asking Neon anything.
 *
 * Role, host, database and region are not secrets and are the facts an
 * operator most often needs to match against the Neon console; the password
 * is never returned. Shown on the Database page so "which project is this?"
 * has an answer before an API key exists.
 */
export function describeDatabaseUrl(url: string | undefined = process.env.DATABASE_URL): {
  role: string | null
  host: string | null
  database: string | null
  region: string | null
  pooled: boolean
  neon: boolean
} | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    const host = parsed.hostname || null
    const region = host?.match(/\b([a-z]{2}-[a-z]+-\d)\b/)?.[1] ?? null
    return {
      role: parsed.username ? decodeURIComponent(parsed.username) : null,
      host,
      database: parsed.pathname.replace(/^\//, '') || null,
      region,
      pooled: Boolean(host?.includes('-pooler')),
      neon: Boolean(host?.includes('neon.tech')),
    }
  } catch {
    return null
  }
}

/** `ep-x-pooler.c-3.aws.neon.tech` and `ep-x.c-3.aws.neon.tech` are one endpoint. */
export function endpointKey(host: string): string {
  return host.toLowerCase().replace('-pooler', '')
}

const gb = (bytes: number) => Math.round((bytes / GB) * 100) / 100

function day(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Colombo' })
}

async function probeAppDatabase(): Promise<NeonSnapshot['app']> {
  const host = appDatabaseHost()
  const started = Date.now()
  try {
    await prisma.$queryRaw`SELECT 1`
    return { host, ok: true, latencyMs: Date.now() - started, error: null }
  } catch (error) {
    return { host, ok: false, latencyMs: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function takeSnapshot(credentials: NeonCredentials): Promise<NeonSnapshot> {
  const checkedAt = new Date().toISOString()
  const snapshot: NeonSnapshot = {
    checkedAt,
    api: { ok: true, error: null },
    project: null,
    endpoints: [],
    projects: [],
    app: await probeAppDatabase(),
  }

  try {
    snapshot.projects = await listProjects(credentials.apiKey)
    if (credentials.projectId) {
      const [usage, endpoints] = await Promise.all([
        getProjectUsage(credentials.apiKey, credentials.projectId),
        listEndpoints(credentials.apiKey, credentials.projectId),
      ])
      if (usage.orgId) usage.plan = await getOrganizationPlan(credentials.apiKey, usage.orgId)
      snapshot.project = usage
      snapshot.endpoints = endpoints
    }
  } catch (error) {
    snapshot.api = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return snapshot
}

/**
 * What, if anything, the operator should hear about. Pure.
 *
 * Ordered by how much they matter: the app not reaching its database first,
 * then things that WILL refuse connections, then money, then hygiene.
 */
export function evaluate(
  snapshot: NeonSnapshot,
  config: Pick<NeonConfig, 'reminderDaysBefore' | 'budgets'>,
  now: Date = new Date(),
): NeonAlert[] {
  const alerts: NeonAlert[] = []

  if (!snapshot.app.ok) {
    alerts.push({
      key: 'db-unreachable',
      level: 'critical',
      title: 'The application cannot reach its database',
      detail:
        `SELECT 1 failed${snapshot.app.host ? ` against ${snapshot.app.host}` : ''}: ${snapshot.app.error ?? 'no answer'}. ` +
        'Every sign-in and every order is failing right now. Run the "Diagnose database" workflow for the raw error.',
    })
  }

  if (!snapshot.api.ok) {
    alerts.push({
      key: 'api-unreachable',
      level: 'warning',
      title: "Neon's API did not answer",
      detail: `${snapshot.api.error ?? 'No response.'} Usage and the invoice date cannot be checked until it does.`,
    })
  }

  const project = snapshot.project
  if (!project) {
    if (snapshot.api.ok) {
      alerts.push({
        key: 'no-project',
        level: 'warning',
        title: 'No Neon project is selected',
        detail: 'Choose the project that holds the production database, so its usage and endpoint can be watched.',
      })
    }
    return alerts
  }

  const disabled = snapshot.endpoints.filter((endpoint) => endpoint.type === 'read_write' && endpoint.disabled)
  if (disabled.length) {
    alerts.push({
      key: 'endpoint-disabled',
      level: 'critical',
      title: 'A read-write endpoint is disabled',
      detail: `${disabled.map((endpoint) => endpoint.host).join(', ')} refuses every connection until it is enabled again in the Neon console.`,
    })
  }

  if (snapshot.app.host && snapshot.endpoints.length) {
    const appKey = endpointKey(snapshot.app.host)
    const connected = snapshot.endpoints.some((endpoint) => endpointKey(endpoint.host) === appKey)
    if (!connected) {
      alerts.push({
        key: 'project-mismatch',
        level: 'warning',
        title: 'The app is not connected to the project being watched',
        detail:
          `DATABASE_URL points at ${snapshot.app.host}, which is not an endpoint of “${project.name}”. ` +
          'Either the wrong project is selected here, or production is running on a database nobody is watching.',
      })
    }
  }

  if (project.periodEnd) {
    const end = new Date(project.periodEnd)
    const daysLeft = Math.ceil((end.getTime() - now.getTime()) / DAY_MS)
    if (daysLeft >= 0 && daysLeft <= config.reminderDaysBefore) {
      alerts.push({
        key: 'invoice-due',
        level: 'warning',
        title:
          daysLeft === 0
            ? 'Neon issues this period’s invoice today'
            : `Neon issues this period’s invoice in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        detail:
          `The billing period closes on ${day(end)}. Neon then invoices what was used and charges the card on file: ` +
          `${project.computeHours.toFixed(1)} compute hours, ${gb(project.storageBytes)} GB stored, ${gb(project.transferBytes)} GB transferred. ` +
          'Make sure the card is valid — an unpaid invoice is how a project gets suspended.',
      })
    }
  }

  if (project.periodStart) {
    const age = now.getTime() - new Date(project.periodStart).getTime()
    if (age >= 0 && age < 2 * DAY_MS) {
      alerts.push({
        key: 'invoice-issued',
        level: 'info',
        title: 'A new billing period has started',
        detail:
          `Neon opened a new period on ${day(project.periodStart)} and has issued the invoice for the previous one. ` +
          'Check Neon → Billing that it was paid.',
      })
    }
  }

  const budget = (kind: string, used: number, limit: number | null, unit: string) => {
    if (limit === null || limit <= 0) return
    if (used >= limit) {
      alerts.push({
        key: `${kind}-over-budget`,
        level: 'warning',
        title: `Over the ${kind} budget you set`,
        detail: `${used.toFixed(1)} ${unit} used this period against a budget of ${limit}. Expect the invoice to be higher than planned.`,
      })
    } else if (used >= 0.8 * limit) {
      alerts.push({
        key: `${kind}-near-budget`,
        level: 'info',
        title: `Approaching the ${kind} budget you set`,
        detail: `${used.toFixed(1)} of ${limit} ${unit} used this period.`,
      })
    }
  }
  budget('compute', project.computeHours, config.budgets.computeHours, 'compute hours')
  budget('storage', gb(project.storageBytes), config.budgets.storageGb, 'GB of storage')
  budget('transfer', gb(project.transferBytes), config.budgets.transferGb, 'GB of data transfer')

  const quota = (kind: string, used: number, limit: number | null, unit: string) => {
    if (limit === null || limit <= 0) return
    if (used >= 0.9 * limit) {
      alerts.push({
        key: `${kind}-quota-near`,
        level: 'critical',
        title: `The ${kind} quota is ${used >= limit ? 'reached' : 'almost reached'}`,
        detail:
          `${used.toFixed(1)} of ${limit.toFixed(1)} ${unit} used. Neon refuses every connection once a quota is reached — ` +
          'that is exactly the outage of 27 September 2026. Raise the quota or the plan before it does.',
      })
    }
  }
  quota('compute', project.computeHours, project.quota.computeHours, 'compute hours')
  quota('transfer', gb(project.transferBytes), project.quota.transferBytes === null ? null : gb(project.quota.transferBytes), 'GB of data transfer')

  if (project.historyRetentionSeconds > 0 && project.historyRetentionSeconds < DAY_MS / 1000) {
    const hours = Math.round(project.historyRetentionSeconds / 3600)
    alerts.push({
      key: 'retention-short',
      level: 'info',
      title: 'Point-in-time recovery reaches back less than a day',
      detail: `History is kept for ${hours} hour${hours === 1 ? '' : 's'}. A mistake found tomorrow morning could not be undone. Paid plans allow up to 30 days: Neon → Project settings → History retention.`,
    })
  }

  return alerts
}

/** How long an alert stays quiet after it has been announced once. */
export const NOTICE_INTERVAL_MS: Record<NeonAlertLevel, number> = {
  critical: 6 * 3_600_000,
  warning: DAY_MS,
  info: DAY_MS,
}

export function dueForNotice(alert: NeonAlert, notified: Record<string, string>, now: Date = new Date()): boolean {
  const last = notified[alert.key]
  if (!last) return true
  const lastAt = new Date(last).getTime()
  if (Number.isNaN(lastAt)) return true
  return now.getTime() - lastAt >= NOTICE_INTERVAL_MS[alert.level]
}

function levelLabel(level: NeonAlertLevel): string {
  return level === 'critical' ? 'CRITICAL' : level === 'warning' ? 'Warning' : 'Note'
}

export function neonAlertEmail(to: string, alerts: NeonAlert[], snapshot: NeonSnapshot): MailInput {
  const first = alerts[0]
  const subject = `[TableFlow] Neon: ${first?.title ?? 'database notice'}${alerts.length > 1 ? ` (+${alerts.length - 1} more)` : ''}`
  const projectLine = snapshot.project
    ? `Project “${snapshot.project.name}” · ${snapshot.project.computeHours.toFixed(1)} compute hours, ${gb(snapshot.project.storageBytes)} GB stored this period`
    : 'No project selected'
  const items = alerts
    .map(
      (alert) =>
        `<li style="margin:0 0 12px"><strong>${levelLabel(alert.level)} — ${escapeHtml(alert.title)}</strong><br>${escapeHtml(alert.detail)}</li>`,
    )
    .join('')
  const link = `${appUrl()}/admin/database`
  return {
    to,
    subject,
    html:
      `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;line-height:1.5">` +
      `<p>${escapeHtml(projectLine)}</p><ul style="padding-left:18px">${items}</ul>` +
      `<p><a href="${link}">Open the Database page</a> · checked ${escapeHtml(snapshot.checkedAt)}</p></div>`,
    text:
      `${projectLine}\n\n` +
      alerts.map((alert) => `${levelLabel(alert.level)} — ${alert.title}\n${alert.detail}`).join('\n\n') +
      `\n\n${link}`,
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

async function announce(alerts: NeonAlert[], snapshot: NeonSnapshot, config: NeonConfig): Promise<void> {
  for (const alert of alerts) {
    // The error centre is for things that need a human; a note is not one.
    if (alert.level === 'info') continue
    await captureError({
      severity: alert.level === 'critical' ? 'CRITICAL' : 'WARNING',
      kind: 'neon',
      operation: 'neon-watch',
      entity: 'NeonProject',
      entityId: snapshot.project?.id ?? null,
      message: `${alert.title}: ${alert.detail}`,
    })
  }
  if (config.alertEmail) await sendMail(neonAlertEmail(config.alertEmail, alerts, snapshot))
}

export interface NeonWatchResult {
  configured: boolean
  status: NeonStatus | null
  /** Alert keys announced on this run. */
  notified: string[]
  error?: string
}

/**
 * One tick of the watcher: look, judge, announce what is new, remember.
 *
 * `notify: false` looks and remembers without announcing — for the moment an
 * operator has just saved a key and wants the page filled in, not an email.
 */
export async function runNeonWatch(options: { notify?: boolean; now?: Date } = {}): Promise<NeonWatchResult> {
  const config = await readNeonConfig()

  let credentials: NeonCredentials | null
  try {
    credentials = await resolveNeonCredentials(config)
  } catch (error) {
    return {
      configured: true,
      status: null,
      notified: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!credentials) return { configured: false, status: null, notified: [] }

  const now = options.now ?? new Date()
  const previous = await readNeonStatus()
  const snapshot = await takeSnapshot(credentials)
  const alerts = evaluate(snapshot, config, now)

  const notified: Record<string, string> = { ...(previous?.notified ?? {}) }
  const announced: string[] = []

  if (options.notify !== false) {
    const due = alerts.filter((alert) => dueForNotice(alert, notified, now))
    if (due.length) {
      await announce(due, snapshot, config)
      for (const alert of due) {
        notified[alert.key] = now.toISOString()
        announced.push(alert.key)
      }
    }
  }

  // A condition that cleared is forgotten, so its return is announced afresh.
  for (const key of Object.keys(notified)) {
    if (!alerts.some((alert) => alert.key === key)) delete notified[key]
  }

  const status: NeonStatus = { snapshot, alerts, notified }
  await writeNeonStatus(status)
  return { configured: true, status, notified: announced }
}
