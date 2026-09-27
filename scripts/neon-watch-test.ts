/**
 * The Neon watcher's judgement, on fixtures.
 *
 * ── What is worth pinning ───────────────────────────────────────────────────
 *
 * `evaluate` is what stands between "the project ran out of quota" and "a
 * restaurant could not sign in" (2026-09-27). It is pure on purpose, so every
 * condition it must catch is checked here without a key or a network: the
 * invoice reminder window and the period rollover, a quota about to close the
 * door, a disabled endpoint, the app pointed at a project nobody watches, and
 * the operator's own budgets. And `dueForNotice`, because a reminder that
 * fires every hour for three days is a reminder that gets muted.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/neon-watch-test.ts
 */
import { dueForNotice, endpointKey, evaluate } from '../src/server/neon/monitor'
import type { NeonAlert, NeonSnapshot } from '../src/server/neon/types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const NOW = new Date('2026-09-27T12:00:00Z')
const DAY = 86_400_000

function snapshot(overrides: Partial<NeonSnapshot> = {}, project: Partial<NeonSnapshot['project'] & object> = {}): NeonSnapshot {
  return {
    checkedAt: NOW.toISOString(),
    api: { ok: true, error: null },
    projects: [],
    endpoints: [
      {
        id: 'ep-1',
        host: 'ep-purple-mud-az41kemf.c-3.ap-southeast-1.aws.neon.tech',
        branchId: 'br-1',
        type: 'read_write',
        currentState: 'active',
        pendingState: null,
        disabled: false,
        minCu: 0.25,
        maxCu: 8,
        suspendTimeoutSeconds: 300,
        lastActive: NOW.toISOString(),
      },
    ],
    app: {
      host: 'ep-purple-mud-az41kemf-pooler.c-3.ap-southeast-1.aws.neon.tech',
      ok: true,
      latencyMs: 40,
      error: null,
    },
    project: {
      id: 'purple-waterfall-51210000',
      name: 'restaurantos',
      regionId: 'aws-ap-southeast-1',
      orgId: 'org-1',
      pgVersion: 18,
      createdAt: '2026-07-26T13:22:41Z',
      plan: 'scale',
      historyRetentionSeconds: 7 * 86_400,
      computeHours: 42,
      activeHours: 600,
      storageBytes: 35 * 1024 ** 2,
      transferBytes: 2 * 1024 ** 3,
      writtenBytes: 0,
      periodStart: '2026-09-01T00:00:00Z',
      periodEnd: '2026-10-01T00:00:00Z',
      quota: { computeHours: null, activeHours: null, transferBytes: null, writtenBytes: null, logicalSizeBytes: null },
      ...project,
    },
    ...overrides,
  }
}

const config = { reminderDaysBefore: 3, budgets: { computeHours: null, storageGb: null, transferGb: null } }
const keys = (alerts: NeonAlert[]) => alerts.map((alert) => alert.key)

console.log('neon-watch-test')

// ── A healthy project says nothing ──────────────────────────────────────────
{
  const alerts = evaluate(snapshot(), config, NOW)
  check('a healthy, paid, connected project raises no alert', alerts.length === 0, keys(alerts).join(','))
}

// ── Invoice reminder window ─────────────────────────────────────────────────
{
  const threeDaysBefore = new Date('2026-09-28T06:00:00Z')
  const alerts = evaluate(snapshot(), config, threeDaysBefore)
  const due = alerts.find((alert) => alert.key === 'invoice-due')
  check('the invoice reminder starts N days before the period closes', Boolean(due), keys(alerts).join(','))
  check('the reminder is a warning that names the close date', due?.level === 'warning' && /1 October 2026/.test(due.detail), due?.detail)

  const fourDaysBefore = new Date('2026-09-26T12:00:00Z')
  check(
    'no reminder outside the window',
    !evaluate(snapshot(), config, fourDaysBefore).some((alert) => alert.key === 'invoice-due'),
  )

  const onTheDay = new Date('2026-10-01T00:00:00Z')
  const today = evaluate(snapshot(), config, onTheDay).find((alert) => alert.key === 'invoice-due')
  check('on the day it says "today"', today?.title.includes('today') === true, today?.title)
}

// ── Period rollover ─────────────────────────────────────────────────────────
{
  const justRolled = evaluate(snapshot({}, { periodStart: '2026-09-27T00:30:00Z', periodEnd: '2026-10-27T00:30:00Z' }), config, NOW)
  check('a period that began yesterday announces the issued invoice', keys(justRolled).includes('invoice-issued'), keys(justRolled).join(','))
  check('that announcement is a note, not an error', justRolled.find((alert) => alert.key === 'invoice-issued')?.level === 'info')
  const old = evaluate(snapshot(), config, NOW)
  check('a period three weeks old does not', !keys(old).includes('invoice-issued'))
}

// ── The door about to close ─────────────────────────────────────────────────
{
  const near = evaluate(snapshot({}, { computeHours: 95, quota: { computeHours: 100, activeHours: null, transferBytes: null, writtenBytes: null, logicalSizeBytes: null } }), config, NOW)
  const alert = near.find((a) => a.key === 'compute-quota-near')
  check('95 of a 100-hour quota is critical', alert?.level === 'critical', keys(near).join(','))
  check('and it says what happens at the limit', /refuses every connection/.test(alert?.detail ?? ''))
  const fine = evaluate(snapshot({}, { computeHours: 50, quota: { computeHours: 100, activeHours: null, transferBytes: null, writtenBytes: null, logicalSizeBytes: null } }), config, NOW)
  check('50 of 100 is not', !keys(fine).includes('compute-quota-near'))
}

// ── Endpoint and connection ─────────────────────────────────────────────────
{
  const base = snapshot()
  const disabled = evaluate({ ...base, endpoints: [{ ...base.endpoints[0]!, disabled: true }] }, config, NOW)
  check('a disabled read-write endpoint is critical', disabled.find((a) => a.key === 'endpoint-disabled')?.level === 'critical')

  const elsewhere = evaluate(
    snapshot({ app: { ...base.app, host: 'ep-weathered-band-azy9fnhg-pooler.c-3.ap-southeast-1.aws.neon.tech' } }),
    config,
    NOW,
  )
  check('the app pointed at another project is flagged', keys(elsewhere).includes('project-mismatch'), keys(elsewhere).join(','))
  check('the pooler host and the direct host are the same endpoint', endpointKey('ep-a-pooler.c-3.x') === endpointKey('ep-a.c-3.x'))

  const down = evaluate(snapshot({ app: { host: base.app.host, ok: false, latencyMs: null, error: 'exceeded the quota' } }), config, NOW)
  check('the app failing SELECT 1 is critical and first', down[0]?.key === 'db-unreachable' && down[0].level === 'critical', keys(down).join(','))

  const apiDown = evaluate(snapshot({ api: { ok: false, error: 'Neon replied 401' }, project: null, endpoints: [] }), config, NOW)
  check('Neon not answering is a warning', apiDown.find((a) => a.key === 'api-unreachable')?.level === 'warning')
  check('with no project it does not also complain about the missing project', !keys(apiDown).includes('no-project'))

  const noProject = evaluate(snapshot({ project: null, endpoints: [] }), config, NOW)
  check('a working key with no project chosen says so', keys(noProject).includes('no-project'))
}

// ── The operator's own budgets ──────────────────────────────────────────────
{
  const budgets = { reminderDaysBefore: 3, budgets: { computeHours: 50, storageGb: 1, transferGb: 1 } }
  const alerts = evaluate(snapshot({}, { computeHours: 42, transferBytes: 3 * 1024 ** 3 }), budgets, NOW)
  check('84% of the compute budget is a note', alerts.find((a) => a.key === 'compute-near-budget')?.level === 'info', keys(alerts).join(','))
  check('3 GB against a 1 GB transfer budget is a warning', alerts.find((a) => a.key === 'transfer-over-budget')?.level === 'warning')
  check('35 MB against a 1 GB storage budget is nothing', !keys(alerts).some((key) => key.startsWith('storage-')))
}

// ── Recovery window ─────────────────────────────────────────────────────────
{
  const short = evaluate(snapshot({}, { historyRetentionSeconds: 6 * 3600 }), config, NOW)
  check('six hours of history is noted', short.find((a) => a.key === 'retention-short')?.level === 'info', keys(short).join(','))
}

// ── Not every hour ──────────────────────────────────────────────────────────
{
  const warning: NeonAlert = { key: 'invoice-due', level: 'warning', title: '', detail: '' }
  const critical: NeonAlert = { key: 'db-unreachable', level: 'critical', title: '', detail: '' }
  check('a new alert is announced', dueForNotice(warning, {}, NOW))
  check('a warning announced an hour ago is not repeated', !dueForNotice(warning, { 'invoice-due': new Date(NOW.getTime() - 3_600_000).toISOString() }, NOW))
  check('a warning announced yesterday is repeated', dueForNotice(warning, { 'invoice-due': new Date(NOW.getTime() - DAY).toISOString() }, NOW))
  check('a critical announced five hours ago is not repeated', !dueForNotice(critical, { 'db-unreachable': new Date(NOW.getTime() - 5 * 3_600_000).toISOString() }, NOW))
  check('a critical announced seven hours ago is', dueForNotice(critical, { 'db-unreachable': new Date(NOW.getTime() - 7 * 3_600_000).toISOString() }, NOW))
  check('a corrupt timestamp does not silence an alert for ever', dueForNotice(warning, { 'invoice-due': 'not a date' }, NOW))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
