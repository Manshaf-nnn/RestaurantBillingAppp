import type { Metadata } from 'next'
import Link from 'next/link'

import { NoteButton, type NoteRow } from '@/features/accounting/components/note-button'
import { getFinancialReconciliation } from '@/features/accounting/financial-reconciliation'
import { runIntegrityChecks } from '@/features/accounting/integrity'
import { issueAdvice, issueExampleHref } from '@/features/accounting/issue-links'
import { latestIssueNotes } from '@/features/accounting/notes'
import { getPaymentReconciliation } from '@/features/payments/reconciliation'
import { getBankReconciliation } from '@/features/ledger/bank-matching'
import { BankReconcile } from '@/features/ledger/components/bank-reconcile'
import type { CurrencyCode } from '@/lib/money'
import { can } from '@/lib/rbac'
import { Badge } from '@/components/ui/badge'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Checks' }

/**
 * The Checks screen (acCal.md §5, §7, §11): the money identities, the
 * per-bill payment reconciliation, and the row-level integrity checker —
 * one place that answers "is anything wrong?". Both sides of every equation
 * come from the module that owns it, so a mismatch means something is
 * genuinely wrong, not two screens computing differently.
 */

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'payments', label: 'Payments' },
  { key: 'bank', label: 'Bank' },
  { key: 'issues', label: 'Issues' },
] as const

type TabKey = (typeof TABS)[number]['key']

export default async function FinancialReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.ACCOUNTING_VIEW,
    '/dashboard/accounting/reconciliation',
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)

  const params = await searchParams
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'TODAY',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const selection = await selectedBranch(user, params)
  const locations = await listLocations(user.restaurantId, selection.branchIds)
  const tab: TabKey = TABS.some((entry) => entry.key === str('tab')) ? (str('tab') as TabKey) : 'overview'

  const tabHref = (key: TabKey) => {
    const query = new URLSearchParams()
    for (const name of ['preset', 'from', 'to', 'branch'] as const) {
      if (str(name)) query.set(name, str(name))
    }
    if (key !== 'overview') query.set('tab', key)
    const qs = query.toString()
    return `/dashboard/accounting/reconciliation${qs ? `?${qs}` : ''}`
  }

  const tone = (status: string) =>
    status === 'ERROR' ? 'destructive' : status === 'WARNING' ? 'outline' : 'secondary'

  const report =
    tab === 'overview'
      ? await getFinancialReconciliation({
          restaurantId: user.restaurantId,
          range,
          branchIds: selection.branchIds,
        })
      : null
  const paymentsRecon =
    tab === 'payments'
      ? await getPaymentReconciliation({
          restaurantId: user.restaurantId,
          range,
          branchIds: selection.branchIds,
          money,
        })
      : null
  const issues =
    tab === 'issues'
      ? await Promise.all([runIntegrityChecks(user.restaurantId), latestIssueNotes(user.restaurantId)])
      : null
  const bank =
    tab === 'bank'
      ? await getBankReconciliation({ restaurantId: user.restaurantId, branchIds: selection.branchIds })
      : null
  const canNote = can(user, PERMISSIONS.ACCOUNTING_NOTE)

  return (
    <>
      <PageHeader
        title="Checks"
        description="Compare what was recorded with what actually happened — and see exactly where to look when they differ."
      />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={selection.branchId}
      />

      <nav className="mt-4 flex gap-1 border-b">
        {TABS.map((entry) => (
          <Link
            key={entry.key}
            href={tabHref(entry.key)}
            className={cn(
              'rounded-t-lg px-4 py-2 text-sm font-medium',
              tab === entry.key
                ? 'border border-b-0 bg-card text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      {report ? (
        <div className="mt-5 space-y-5">
          <SectionCard
            title="The identities"
            description="Both sides of each equation computed through the engines that own them, compared to the minor unit."
          >
            <ul className="divide-y text-sm">
              {report.identities.map((row) => (
                <li key={row.key} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <Link href={row.href} className="font-medium text-primary underline-offset-2 hover:underline">
                      {row.label}
                    </Link>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">{row.working}</p>
                  </div>
                  <Badge variant={tone(row.status)}>{row.status}</Badge>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard
            title="Row-level integrity"
            description="The §115 checker: questions the database should never answer yes to, including the money-out workflow."
          >
            <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
              {report.integrity.checks.map((check) => (
                <li key={check.key} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{check.label}</span>
                    {check.status !== 'OK' ? (
                      <span className="block truncate text-xs text-muted-foreground" title={check.examples.join(', ')}>
                        {check.count} affected · e.g. {check.examples[0]}
                      </span>
                    ) : null}
                  </span>
                  <Badge variant={tone(check.status)}>{check.status}</Badge>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      ) : null}

      {paymentsRecon ? (
        <div className="mt-5 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Paid" value={paymentsRecon.counts.PAID} tone="success" />
            <StatCard label="Partially paid" value={paymentsRecon.counts.PARTIAL} tone={paymentsRecon.counts.PARTIAL > 0 ? 'warning' : 'default'} />
            <StatCard label="Unpaid" value={paymentsRecon.counts.UNPAID} tone={paymentsRecon.counts.UNPAID > 0 ? 'warning' : 'default'} />
            <StatCard label="Overpaid" value={paymentsRecon.counts.OVERPAID} tone={paymentsRecon.counts.OVERPAID > 0 ? 'destructive' : 'default'} />
            <StatCard label="Mismatch" value={paymentsRecon.counts.MISMATCH} tone={paymentsRecon.counts.MISMATCH > 0 ? 'destructive' : 'default'} hint="records disagree — should be zero" />
          </div>

          <SectionCard
            title="Bills needing eyes"
            description={
              paymentsRecon.problems.length === 0
                ? 'Every bill in the period is settled cleanly.'
                : 'Worst first. Each row says exactly what to do.'
            }
          >
            {paymentsRecon.truncated ? (
              <p className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                This period has more bills than one scan shows — narrow the date range for a complete pass.
              </p>
            ) : null}
            {paymentsRecon.problems.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3">Bill</th>
                      <th className="py-2 pr-3">Branch</th>
                      <th className="py-2 pr-3 text-right">Billed</th>
                      <th className="py-2 pr-3 text-right">Received (net)</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2">What to do</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {paymentsRecon.problems.map((row) => (
                      <tr key={row.orderId}>
                        <td className="py-2 pr-3">
                          <Link href={`/dashboard/orders/${row.orderId}`} className="font-medium text-primary underline-offset-2 hover:underline">
                            {row.invoiceNumber ?? row.orderNumber}
                          </Link>
                        </td>
                        <td className="py-2 pr-3">{row.branchName ?? '—'}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{money(row.billed)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{money(row.net)}</td>
                        <td className="py-2 pr-3">
                          <Badge variant={row.bucket === 'PARTIAL' ? 'outline' : 'destructive'}>
                            {row.bucket === 'PARTIAL' ? 'Partially paid' : row.bucket === 'OVERPAID' ? 'Overpaid' : 'Mismatch'}
                          </Badge>
                        </td>
                        <td className="py-2 text-xs text-muted-foreground">{row.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </SectionCard>
        </div>
      ) : null}

      {bank ? (
        <div className="mt-5">
          <BankReconcile
            counts={bank.counts}
            currency={restaurant.currency as CurrencyCode}
            canReconcile={can(user, PERMISSIONS.ACCOUNTING_RECONCILE)}
            statements={bank.statements.map((statement) => ({
              ...statement,
              createdAt: statement.createdAt.toISOString(),
            }))}
            lines={bank.open.map(({ line, suggestion }) => ({
              id: line.id,
              lineDate: line.lineDate.toISOString(),
              description: line.description,
              reference: line.reference,
              amount: line.amount,
              status: line.status as 'UNMATCHED' | 'MATCHED' | 'DUPLICATE' | 'IGNORED',
              suggestion: suggestion
                ? {
                    type: suggestion.type,
                    id: suggestion.id,
                    label: suggestion.label,
                    amount: suggestion.amount,
                    date: suggestion.date.toISOString(),
                    href: suggestion.href,
                  }
                : null,
            }))}
          />
        </div>
      ) : null}

      {issues ? (
        (() => {
          const [integrity, ackNotes] = issues
          const groups = [
            {
              title: '🔴 Critical',
              blurb: 'The books disagree with themselves. Fix these before trusting any report.',
              rows: integrity.checks.filter((row) => row.status === 'ERROR'),
            },
            {
              title: '🟠 Worth a look',
              blurb: 'Legal on their own — flagged so a human looks. Acknowledge with a note once verified.',
              rows: integrity.checks.filter((row) => row.status === 'WARNING'),
            },
            {
              title: '🟢 Clear',
              blurb: 'Checked just now and clean.',
              rows: integrity.checks.filter((row) => row.status === 'OK'),
            },
          ]
          return (
            <div className="mt-5 space-y-5">
              {groups.map((group) =>
                group.rows.length > 0 ? (
                  <SectionCard key={group.title} title={`${group.title} (${group.rows.length})`} description={group.blurb}>
                    <ul className="divide-y text-sm">
                      {group.rows.map((row) => {
                        const ack = ackNotes.get(row.key)
                        const noteRows: NoteRow[] = ack
                          ? [{ id: ack.id, body: ack.body, authorName: ack.authorName, createdAt: ack.createdAt.toISOString() }]
                          : []
                        return (
                          <li key={row.key} className="py-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium">{row.label}</span>
                              <span className="flex items-center gap-3">
                                {row.status !== 'OK' ? (
                                  <span className="text-xs text-muted-foreground">{row.count} affected</span>
                                ) : null}
                                {row.status === 'WARNING' || (row.status === 'OK' && ack) ? (
                                  <NoteButton entity="issue" entityId={row.key} notes={noteRows} canNote={canNote && row.status === 'WARNING'} />
                                ) : null}
                              </span>
                            </div>
                            {row.status !== 'OK' ? (
                              <>
                                <p className="mt-1 text-xs text-muted-foreground">{issueAdvice(row.key)}</p>
                                {row.examples.length > 0 ? (
                                  <p className="mt-1 flex flex-wrap gap-2 text-xs">
                                    <span className="text-muted-foreground">Look at:</span>
                                    {row.examples.map((exampleId) => (
                                      <Link
                                        key={exampleId}
                                        href={issueExampleHref(row.key, exampleId)}
                                        className="font-mono text-primary underline-offset-2 hover:underline"
                                      >
                                        {exampleId.slice(0, 12)}
                                      </Link>
                                    ))}
                                  </p>
                                ) : null}
                                {ack ? (
                                  <p className="mt-1 text-xs text-success">
                                    Acknowledged by {ack.authorName} · “{ack.body}”
                                  </p>
                                ) : null}
                              </>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  </SectionCard>
                ) : null,
              )}
            </div>
          )
        })()
      ) : null}
    </>
  )
}
