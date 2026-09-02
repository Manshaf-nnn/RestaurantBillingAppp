'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { closeDayAction, closePeriodAction, reopenPeriodAction } from '@/features/accounting/actions'
import type { DailyCloseSnapshot } from '@/features/accounting/service'
import { callAction } from '@/lib/use-action'
import { formatMoney } from '@/lib/money'

export function DailyCloseView({
  days,
  todayKey,
  periods,
  canClose,
  currency,
  locale,
}: {
  days: Array<{ date: string; closed: boolean; snapshot: DailyCloseSnapshot }>
  todayKey: string
  periods: Array<{ id: string; from: string; to: string; status: string; notes: string | null }>
  canClose: boolean
  currency: string
  locale: string
}) {
  const router = useRouter()
  const money = (value: number) => formatMoney(value, currency, locale)
  const [pendingDate, setPendingDate] = React.useState<string | null>(null)
  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [periodPending, setPeriodPending] = React.useState(false)

  const closeDay = async (date: string) => {
    setPendingDate(date)
    const result = await callAction(() => closeDayAction({ date }))
    setPendingDate(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${date} closed`)
    router.refresh()
  }

  const sealPeriod = async () => {
    setPeriodPending(true)
    const result = await callAction(() => closePeriodAction({ from, to }))
    setPeriodPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Period sealed')
    setFrom('')
    setTo('')
    router.refresh()
  }

  const reopen = async (periodId: string) => {
    const result = await callAction(() => reopenPeriodAction({ periodId }))
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Period reopened — on the record')
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <SectionCard
        title="The last seven days"
        description="A closed day shows its frozen snapshot — the figures exactly as signed, whatever has happened since."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">Date</th>
                <th className="pb-2 pr-3 text-right font-medium">Net sales</th>
                <th className="pb-2 pr-3 text-right font-medium">Collected</th>
                <th className="pb-2 pr-3 text-right font-medium">Refunds</th>
                <th className="pb-2 pr-3 text-right font-medium">COGS</th>
                <th className="pb-2 pr-3 text-right font-medium">Cash variance</th>
                <th className="pb-2 pr-3 text-right font-medium">Outstanding</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {days.map((day) => (
                <tr key={day.date}>
                  <td className="whitespace-nowrap py-2.5 pr-3 font-medium">
                    {day.date}
                    {day.date === todayKey ? (
                      <span className="ml-2 text-xs text-muted-foreground">today</span>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{money(day.snapshot.sales.netSales)}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{money(day.snapshot.payments.collected)}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{money(day.snapshot.sales.refunds)}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{money(day.snapshot.profit.cogs)}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    {day.snapshot.payments.cashDiscrepancy === 0
                      ? '—'
                      : money(day.snapshot.payments.cashDiscrepancy)}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    {day.snapshot.outstanding === 0 ? '—' : money(day.snapshot.outstanding)}
                  </td>
                  <td className="py-2.5 text-right">
                    {day.closed ? (
                      <Badge variant="secondary">closed</Badge>
                    ) : day.date === todayKey ? (
                      <span className="text-xs text-muted-foreground">still trading</span>
                    ) : canClose ? (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={pendingDate === day.date}
                        onClick={() => closeDay(day.date)}
                      >
                        Close day
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">open</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        title="Accounting periods"
        description="A sealed period refuses cancellations, voids and discount edits to the orders inside it. Reopening is allowed — and recorded."
      >
        {canClose ? (
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <Field label="From" htmlFor="period-from">
              <Input id="period-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To (inclusive)" htmlFor="period-to">
              <Input id="period-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Button loading={periodPending} disabled={!from || !to} onClick={sealPeriod}>
              Seal period
            </Button>
          </div>
        ) : null}

        {periods.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No periods sealed yet. Close your days first, then seal the range your accountant has filed.
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {periods.map((period) => (
              <li key={period.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="font-medium tabular-nums">
                  {period.from} → {period.to}
                </span>
                <span className="flex items-center gap-3">
                  <Badge variant={period.status === 'CLOSED' ? 'secondary' : 'outline'}>
                    {period.status === 'CLOSED' ? 'sealed' : 'reopened'}
                  </Badge>
                  {canClose && period.status === 'CLOSED' ? (
                    <Button size="sm" variant="ghost" onClick={() => reopen(period.id)}>
                      Reopen
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  )
}
