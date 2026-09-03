import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { InfoTip } from '@/features/accounting/components/info-tip'
import { getLedger } from '@/features/ledger/queries'
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
export const metadata: Metadata = { title: 'Ledger' }

const TABS = [
  { key: 'journal', label: 'Journal' },
  { key: 'trial', label: 'Trial balance' },
  { key: 'cash', label: 'Cash book' },
  { key: 'position', label: 'Position' },
] as const

type TabKey = (typeof TABS)[number]['key']

/**
 * The ledger (acCal.md §9): proper double-entry, derived from the operating
 * records at read time. Nothing here is typed by a person and nothing here
 * can be edited — every line points back at the record that produced it.
 */
export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/accounting/ledger')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)

  const params = await searchParams
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'THIS_MONTH',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const selection = await selectedBranch(user, params)
  const locations = await listLocations(user.restaurantId, selection.branchIds)
  const tab: TabKey = TABS.some((entry) => entry.key === str('tab')) ? (str('tab') as TabKey) : 'journal'

  const tabHref = (key: TabKey) => {
    const query = new URLSearchParams()
    for (const name of ['preset', 'from', 'to', 'branch'] as const) {
      if (str(name)) query.set(name, str(name))
    }
    if (key !== 'journal') query.set('tab', key)
    const qs = query.toString()
    return `/dashboard/accounting/ledger${qs ? `?${qs}` : ''}`
  }

  const ledger = await getLedger({
    restaurantId: user.restaurantId,
    range,
    branchIds: selection.branchIds,
  })

  return (
    <>
      <PageHeader
        title="Ledger"
        description={`${range.label} · built from your records — every line links to what produced it. Nothing here is entered by hand.`}
      />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={selection.branchId}
      />

      <nav className="mt-4 flex flex-wrap gap-1 border-b">
        {TABS.map((entry) => (
          <Link
            key={entry.key}
            href={tabHref(entry.key)}
            className={cn(
              'rounded-t-lg px-4 py-2 text-sm font-medium',
              tab === entry.key ? 'border border-b-0 bg-card text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      {tab === 'journal' ? (
        <div className="mt-5">
          <SectionCard
            title="Journal"
            description={`${ledger.entries.length} entries. Every one balances: debits equal credits.`}
            actions={<InfoTip term="journal" />}
          >
            {ledger.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing happened in this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="pb-2 pr-3 font-medium">Date</th>
                      <th className="pb-2 pr-3 font-medium">What happened</th>
                      <th className="pb-2 pr-3 font-medium">Account</th>
                      <th className="pb-2 pr-3 text-right font-medium">Debit</th>
                      <th className="pb-2 text-right font-medium">Credit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {ledger.entries.map((entry) =>
                      entry.lines.map((line, index) => (
                        <tr key={`${entry.id}:${line.account}:${index}`} className={index === 0 ? '' : 'border-t-0'}>
                          <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">
                            {index === 0 ? entry.date.toLocaleDateString() : ''}
                          </td>
                          <td className="py-2 pr-3">
                            {index === 0 ? (
                              <Link href={entry.href} className="text-primary underline-offset-2 hover:underline">
                                {entry.narrative}
                              </Link>
                            ) : null}
                          </td>
                          <td className="py-2 pr-3">
                            <span className="font-mono text-xs text-muted-foreground">{line.account}</span>{' '}
                            {line.accountName}
                            {line.dimension ? (
                              <span className="ml-1 text-xs text-muted-foreground">· {line.dimension}</span>
                            ) : null}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{line.debit > 0 ? money(line.debit) : ''}</td>
                          <td className="py-2 text-right tabular-nums">{line.credit > 0 ? money(line.credit) : ''}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      ) : null}

      {tab === 'trial' ? (
        <div className="mt-5 space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Total debits" value={money(ledger.trialBalance.totalDebits)} />
            <StatCard label="Total credits" value={money(ledger.trialBalance.totalCredits)} />
            <StatCard
              label="Balanced"
              value={ledger.trialBalance.balanced ? 'Yes' : 'NO'}
              tone={ledger.trialBalance.balanced ? 'success' : 'destructive'}
              hint={ledger.trialBalance.balanced ? 'debits equal credits' : 'this must never happen — report it'}
            />
          </div>
          <SectionCard title="Trial balance" description="Every account with activity in the period." actions={<InfoTip term="trialBalance" />}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">Account</th>
                    <th className="pb-2 pr-3 text-right font-medium">Debits</th>
                    <th className="pb-2 pr-3 text-right font-medium">Credits</th>
                    <th className="pb-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ledger.trialBalance.rows.map((row) => (
                    <tr key={row.code}>
                      <td className="py-2 pr-3">
                        <span className="font-mono text-xs text-muted-foreground">{row.code}</span> {row.name}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(row.debits)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(row.credits)}</td>
                      <td className="py-2 text-right font-semibold tabular-nums">{money(row.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      ) : null}

      {tab === 'cash' ? (
        <div className="mt-5 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              label="Cash from trading"
              value={money(ledger.cashBook.closing)}
              info={<InfoTip term="cashBook" />}
              hint="takings in, payouts and differences out"
            />
            <StatCard label="Cash events" value={ledger.cashBook.rows.length} />
          </div>
          <SectionCard
            title="Cash book"
            description="Physical cash only. Float moved between your own till and safe is not trading and is deliberately left out."
          >
            {ledger.cashBook.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No cash moved in this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="pb-2 pr-3 font-medium">Date</th>
                      <th className="pb-2 pr-3 font-medium">What happened</th>
                      <th className="pb-2 pr-3 text-right font-medium">In</th>
                      <th className="pb-2 pr-3 text-right font-medium">Out</th>
                      <th className="pb-2 text-right font-medium">Running</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {ledger.cashBook.rows.map((row, index) => (
                      <tr key={`${row.href}:${index}`}>
                        <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">
                          {row.date.toLocaleDateString()}
                        </td>
                        <td className="py-2 pr-3">
                          <Link href={row.href} className="text-primary underline-offset-2 hover:underline">
                            {row.narrative}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{row.inflow > 0 ? money(row.inflow) : ''}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{row.outflow > 0 ? money(row.outflow) : ''}</td>
                        <td className="py-2 text-right font-medium tabular-nums">{money(row.runningBalance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      ) : null}

      {tab === 'position' ? (
        <div className="mt-5 space-y-5">
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
            <strong>This is not a statutory balance sheet.</strong> It is built only from what TableFlow
            records — sales, stock, suppliers, expenses and cash. It knows nothing about premises, equipment,
            loans or capital, so use it as a working view, not as accounts for filing.{' '}
            <InfoTip term="retainedEarningsDerived" />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            {[ledger.position.assets, ledger.position.liabilities, ledger.position.equity].map((section) => (
              <SectionCard key={section.title} title={section.title}>
                <ul className="divide-y text-sm">
                  {section.rows.map((row) => (
                    <li key={row.label} className="flex justify-between gap-3 py-2">
                      <span className={row.label.includes('derived') ? 'text-muted-foreground' : ''}>{row.label}</span>
                      <span className="font-medium tabular-nums">{money(row.amount)}</span>
                    </li>
                  ))}
                  <li className="flex justify-between gap-3 py-2 font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">{money(section.total)}</span>
                  </li>
                </ul>
              </SectionCard>
            ))}
          </div>
          <p className="text-sm">
            <Badge variant={ledger.position.balanced ? 'secondary' : 'destructive'}>
              {ledger.position.balanced
                ? 'What it holds = what it owes + what is left over'
                : 'This does not balance — please report it'}
            </Badge>
          </p>
        </div>
      ) : null}
    </>
  )
}
