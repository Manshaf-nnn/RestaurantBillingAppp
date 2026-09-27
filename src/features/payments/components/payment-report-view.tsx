'use client'

import * as React from 'react'
import Link from 'next/link'
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  Landmark,
  Receipt,
  Undo2,
  Wallet,
} from 'lucide-react'

import { formatMoney, formatMoneyCompact, type CurrencyCode } from '@/lib/money'
import { cn } from '@/lib/utils'

import type { PaymentReportData } from '../report'

/**
 * Payment details report.
 *
 * The same shape as the Inventory and Sales reports on purpose — five
 * figures, the trend beside where it went, then three summaries — so an owner
 * reads every report the same way. Colours follow the inventory report's
 * rules: `--viz-1..6` for categories in a fixed order, a grey "Others" rather
 * than a repeated hue, every slice named in the legend with its share and
 * value so identity never rests on colour alone, and one series per chart.
 */

const VIZ = [
  'hsl(var(--viz-1))',
  'hsl(var(--viz-2))',
  'hsl(var(--viz-3))',
  'hsl(var(--viz-4))',
  'hsl(var(--viz-5))',
  'hsl(var(--viz-6))',
]
const OTHERS = 'hsl(var(--muted-foreground))'
const MAX_SLICES = VIZ.length

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  QR: 'QR',
  ONLINE: 'Online',
  WALLET: 'Wallet',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Other',
  COD: 'Cash on delivery',
}

export function PaymentReportView({
  data,
  currency,
  locale,
  rangeLabel,
  branchLabel,
}: {
  data: PaymentReportData
  currency: CurrencyCode
  locale: string
  rangeLabel: string
  branchLabel: string
}) {
  const money = (value: number) => formatMoney(value, currency, locale)
  const compact = (value: number) => formatMoneyCompact(value, currency, locale)

  /** Accounts by net collected, the tail folded into one grey slice. Only money that came in is a slice. */
  const slices = React.useMemo(() => {
    const positive = data.byAccount.filter((row) => row.net > 0)
    const head = positive.slice(0, MAX_SLICES)
    const tail = positive.slice(MAX_SLICES)
    const rows = head.map((row, index) => ({ name: row.name, value: row.net, share: row.share, fill: VIZ[index] }))
    if (tail.length > 0) {
      rows.push({
        name: 'Others',
        value: tail.reduce((sum, row) => sum + row.net, 0),
        share: tail.reduce((sum, row) => sum + row.share, 0),
        fill: OTHERS,
      })
    }
    return rows
  }, [data.byAccount])

  return (
    <div className="space-y-4">
      {/* ── the five figures ───────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Tile
          label="Net Collected"
          value={money(data.net)}
          change={data.netChange}
          caption="vs last period"
          icon={<Wallet className="size-4" />}
          tone="primary"
        />
        <Tile
          label="Payments"
          value={String(data.payments)}
          caption={data.payments ? `avg ${money(data.averagePayment)}` : 'none in this period'}
          icon={<Receipt className="size-4" />}
          tone="success"
        />
        <Tile
          label="Refunds"
          value={money(data.refunded)}
          caption={`${data.refunds} refund${data.refunds === 1 ? '' : 's'}`}
          icon={<Undo2 className="size-4" />}
          tone="warning"
        />
        <Tile
          label="Moved Between Accounts"
          value={money(data.moved.value)}
          caption={`${data.moved.count} transfer${data.moved.count === 1 ? '' : 's'}`}
          icon={<ArrowLeftRight className="size-4" />}
          tone="info"
        />
        <Tile
          label="Total Balance"
          value={money(data.totalBalance)}
          caption={`${data.accountCount} account${data.accountCount === 1 ? '' : 's'} · all locations`}
          icon={<Landmark className="size-4" />}
          tone="destructive"
          href="/dashboard/payment-details"
        />
      </div>

      {/* ── trend and account split ────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <section className="rounded-xl border bg-card p-5 shadow-soft">
          <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Net Collection Trend</h2>
              <p className="text-xs text-muted-foreground">
                Payments taken less refunds given, each day · {rangeLabel}
              </p>
            </div>
            <span className="text-xs text-muted-foreground">{branchLabel}</span>
          </header>

          {data.trend.every((point) => point.collected === 0 && point.refunded === 0) ? (
            <Empty>No payments in this period, so there is no trend to draw.</Empty>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="netFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--viz-1))" stopOpacity={0.24} />
                      <stop offset="100%" stopColor="hsl(var(--viz-1))" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(value: string) => dayLabel(value, locale)}
                    minTickGap={24}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={64}
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(value: number) => compact(value)}
                  />
                  <Tooltip
                    cursor={{ stroke: 'hsl(var(--viz-1))', strokeWidth: 1, strokeDasharray: '3 3' }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null
                      const point = payload[0].payload as PaymentReportData['trend'][number]
                      return (
                        <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-elevated">
                          <p className="font-semibold text-popover-foreground">{dayLabel(String(label), locale, true)}</p>
                          <p className="mt-0.5 text-muted-foreground">
                            Net <span className="font-semibold text-popover-foreground">{money(point.net)}</span>
                          </p>
                          <p className="text-muted-foreground">
                            Taken {money(point.collected)} · refunded {money(point.refunded)}
                          </p>
                        </div>
                      )
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="net"
                    stroke="hsl(var(--viz-1))"
                    strokeWidth={2}
                    fill="url(#netFill)"
                    activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="rounded-xl border bg-card p-5 shadow-soft">
          <header className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Collected by Account</h2>
            <Link
              href="/dashboard/payment-details"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              View Details <ArrowRight className="size-3" />
            </Link>
          </header>

          {slices.length === 0 ? (
            <Empty>Nothing was collected in this period, so there is nothing to split by account.</Empty>
          ) : (
            <>
              <div className="relative h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={slices}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="62%"
                      outerRadius="100%"
                      paddingAngle={2}
                      stroke="hsl(var(--card))"
                      strokeWidth={2}
                    >
                      {slices.map((slice) => (
                        <Cell key={slice.name} fill={slice.fill} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) =>
                        active && payload?.length ? (
                          <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-elevated">
                            <p className="font-semibold text-popover-foreground">{String(payload[0].name ?? '')}</p>
                            <p className="mt-0.5 text-muted-foreground">{money(Number(payload[0].value ?? 0))}</p>
                          </div>
                        ) : null
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-bold tabular-nums">{compact(data.net)}</span>
                  <span className="text-[11px] text-muted-foreground">Net Collected</span>
                </div>
              </div>

              <ul className="mt-3 space-y-1.5">
                {slices.map((slice) => (
                  <li key={slice.name} className="flex items-center gap-2 text-xs">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: slice.fill }} />
                    <span className="min-w-0 flex-1 truncate">{slice.name}</span>
                    <span className="tabular-nums text-muted-foreground">{(slice.share * 100).toFixed(1)}%</span>
                    <span className="w-24 text-right font-medium tabular-nums">{money(slice.value)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      {/* ── three summaries ────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Collections by Method" href="/dashboard/reports/sales" linkLabel="Sales Report">
          {data.byMethod.length === 0 ? (
            <Empty>No payments in this period.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">Method</th>
                  <th className="pb-2 pr-2 text-right font-medium">Payments</th>
                  <th className="pb-2 pr-2 text-right font-medium">Refunded</th>
                  <th className="pb-2 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.byMethod.map((row) => (
                  <tr key={row.method}>
                    <td className="py-2 pr-2 font-medium">{METHOD_LABEL[row.method] ?? row.method}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">{row.count}</td>
                    <td className={cn('py-2 pr-2 text-right tabular-nums', row.refunded ? 'text-warning' : 'text-muted-foreground')}>
                      {row.refunded ? money(row.refunded) : '—'}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums">{money(row.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Account Balances" href="/dashboard/payment-details" linkLabel="View All">
          {data.balances.length === 0 ? (
            <Empty>You have not been given access to any account. The owner can assign one.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">Account</th>
                  <th className="pb-2 pr-2 text-right font-medium">This Period</th>
                  <th className="pb-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.balances.map((row) => (
                  <tr key={row.code}>
                    <td className="py-2 pr-2">
                      <Link href={`/dashboard/payment-details/${row.code}`} className="font-medium hover:underline">
                        {row.name}
                      </Link>
                    </td>
                    <td
                      className={cn(
                        'py-2 pr-2 text-right tabular-nums',
                        row.netInPeriod < 0 ? 'text-destructive' : row.netInPeriod > 0 ? 'text-success' : 'text-muted-foreground',
                      )}
                    >
                      {row.netInPeriod ? money(row.netInPeriod) : '—'}
                    </td>
                    <td className={cn('py-2 text-right font-medium tabular-nums', row.balance < 0 && 'text-destructive')}>
                      {money(row.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Deposits & Transfers" href="/dashboard/payment-details" linkLabel="View Details">
          {data.movements.length === 0 ? (
            <Empty>No money was deposited or moved between accounts in this period.</Empty>
          ) : (
            <ul className="space-y-2.5">
              {data.movements.slice(0, 8).map((row) => (
                <li key={row.id} className="flex items-center gap-3">
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-lg',
                      row.kind === 'Deposit' ? 'bg-success/10 text-success' : 'bg-primary/10 text-primary',
                    )}
                  >
                    {row.kind === 'Deposit' ? <ArrowDownToLine className="size-4" /> : <ArrowLeftRight className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {row.kind === 'Deposit' ? `Deposit to ${row.account}` : `${row.account} → ${row.counterparty ?? '—'}`}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[dayLabel(row.at.slice(0, 10), locale), row.actorName, row.reason].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="w-28 text-right text-sm font-semibold tabular-nums">{money(row.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

const TONES = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
  info: 'bg-chart-2/10 text-chart-2',
} as const

/** One headline figure — the inventory report's tile, unchanged. */
function Tile({
  label,
  value,
  change,
  caption,
  icon,
  tone,
  href,
}: {
  label: string
  value: string
  change?: number | null
  caption: string
  icon: React.ReactNode
  tone: keyof typeof TONES
  href?: string
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', TONES[tone])}>{icon}</span>
      </div>
      <p className="mt-1.5 text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 flex items-center gap-1 text-xs">
        {change !== null && change !== undefined ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-medium tabular-nums',
              change >= 0 ? 'text-success' : 'text-destructive',
            )}
          >
            {change >= 0 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
            {Math.abs(change * 100).toFixed(1)}%
          </span>
        ) : null}
        <span className="text-muted-foreground">{caption}</span>
      </p>
    </>
  )

  if (!href) return <div className="rounded-xl border bg-card p-4 shadow-soft">{body}</div>
  return (
    <Link href={href} className="rounded-xl border bg-card p-4 shadow-soft transition-colors hover:border-primary/40">
      {body}
    </Link>
  )
}

function Card({
  title,
  href,
  linkLabel,
  children,
}: {
  title: string
  href: string
  linkLabel: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-soft">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          {linkLabel} <ArrowRight className="size-3" />
        </Link>
      </header>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
}

/** "5 Oct" on an axis, "5 October 2026" in a tooltip. */
function dayLabel(iso: string, locale: string, long = false): string {
  const date = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: long ? 'long' : 'short',
    ...(long ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(date)
}
