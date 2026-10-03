'use client'

import * as React from 'react'
import Link from 'next/link'
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ArrowDown, ArrowRight, ArrowUp, Ban, Bike, Clock, Coins, MapPin, Wallet } from 'lucide-react'

import { formatMoney, formatMoneyCompact, type CurrencyCode } from '@/lib/money'
import { cn } from '@/lib/utils'

import type { DeliveryReportData } from '../delivery-report'

/**
 * Delivery Desk report — the Inventory report's layout: five figures, the
 * trend beside the split, three summaries. Categorical colours in a fixed
 * order, a grey "Others" rather than a repeated hue, every slice named in
 * the legend with its share, one series per chart.
 */

const VIZ = ['hsl(var(--viz-1))', 'hsl(var(--viz-2))', 'hsl(var(--viz-3))', 'hsl(var(--viz-4))', 'hsl(var(--viz-5))', 'hsl(var(--viz-6))']
const OTHERS = 'hsl(var(--muted-foreground))'

export function DeliveryReportView({
  data,
  currency,
  locale,
  rangeLabel,
  branchLabel,
  timeZone,
}: {
  data: DeliveryReportData
  currency: CurrencyCode
  locale: string
  rangeLabel: string
  branchLabel: string
  timeZone: string
}) {
  const money = (value: number) => formatMoney(value, currency, locale)
  const compact = (value: number) => formatMoneyCompact(value, currency, locale)
  const mins = (value: number | null) => (value === null ? '—' : value >= 60 ? `${Math.floor(value / 60)} h ${value % 60} min` : `${value} min`)
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

  const slices = React.useMemo(() => {
    const head = data.byPlace.slice(0, VIZ.length)
    const tail = data.byPlace.slice(VIZ.length)
    const rows = head.map((row, index) => ({ name: row.place, value: row.delivered, share: row.share, fill: VIZ[index] }))
    if (tail.length) {
      rows.push({
        name: 'Others',
        value: tail.reduce((s, r) => s + r.delivered, 0),
        share: tail.reduce((s, r) => s + r.share, 0),
        fill: OTHERS,
      })
    }
    return rows
  }, [data.byPlace])

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Tile label="Deliveries" value={String(data.delivered)} change={data.deliveredChange} caption="vs last period" icon={<Bike className="size-4" />} tone="primary" />
        <Tile label="Delivery Sales" value={money(data.sales)} caption={data.delivered ? `avg ${money(data.averageOrder)} per order` : 'none delivered'} icon={<Wallet className="size-4" />} tone="success" />
        <Tile label="Average Time" value={mins(data.averageMinutes)} caption={`order to door · ride ${mins(data.averageRideMinutes)}`} icon={<Clock className="size-4" />} tone="info" />
        <Tile label="Cash at the Door" value={money(data.cashCollected)} caption={`${data.cashCount} collected on delivery`} icon={<Coins className="size-4" />} tone="warning" />
        <Tile label="Cancelled" value={String(data.cancelled)} caption={`${data.outNow} out for delivery now`} icon={<Ban className="size-4" />} tone="destructive" href="/dashboard/delivery" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <section className="rounded-xl border bg-card p-5 shadow-soft">
          <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Deliveries by Day</h2>
              <p className="text-xs text-muted-foreground">Orders handed over at the door each day · {rangeLabel}</p>
            </div>
            <span className="text-xs text-muted-foreground">{branchLabel}</span>
          </header>
          {data.delivered === 0 ? (
            <Empty>No deliveries were completed in this period.</Empty>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="deliveryFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--viz-1))" stopOpacity={0.24} />
                      <stop offset="100%" stopColor="hsl(var(--viz-1))" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={(value: string) => dayLabel(value, locale)} minTickGap={24} />
                  <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                  <Tooltip
                    cursor={{ stroke: 'hsl(var(--viz-1))', strokeWidth: 1, strokeDasharray: '3 3' }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null
                      const point = payload[0].payload as DeliveryReportData['trend'][number]
                      return (
                        <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-elevated">
                          <p className="font-semibold text-popover-foreground">{dayLabel(String(label), locale, true)}</p>
                          <p className="mt-0.5 text-muted-foreground">
                            {point.delivered} deliver{point.delivered === 1 ? 'y' : 'ies'} · <span className="font-semibold text-popover-foreground">{money(point.sales)}</span>
                          </p>
                        </div>
                      )
                    }}
                  />
                  <Area type="monotone" dataKey="delivered" stroke="hsl(var(--viz-1))" strokeWidth={2} fill="url(#deliveryFill)" activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="rounded-xl border bg-card p-5 shadow-soft">
          <header className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Deliveries by Area</h2>
            <Link href="/dashboard/locations" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              Places <ArrowRight className="size-3" />
            </Link>
          </header>
          {slices.length === 0 ? (
            <Empty>Nothing delivered, so nothing to split by area.</Empty>
          ) : (
            <>
              <div className="relative h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={slices} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="100%" paddingAngle={2} stroke="hsl(var(--card))" strokeWidth={2}>
                      {slices.map((slice) => (
                        <Cell key={slice.name} fill={slice.fill} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) =>
                        active && payload?.length ? (
                          <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-elevated">
                            <p className="font-semibold text-popover-foreground">{String(payload[0].name ?? '')}</p>
                            <p className="mt-0.5 text-muted-foreground">{String(payload[0].value ?? 0)} deliveries</p>
                          </div>
                        ) : null
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-bold tabular-nums">{data.delivered}</span>
                  <span className="text-[11px] text-muted-foreground">Delivered</span>
                </div>
              </div>
              <ul className="mt-3 space-y-1.5">
                {slices.map((slice) => (
                  <li key={slice.name} className="flex items-center gap-2 text-xs">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: slice.fill }} />
                    <span className="min-w-0 flex-1 truncate">{slice.name}</span>
                    <span className="tabular-nums text-muted-foreground">{(slice.share * 100).toFixed(1)}%</span>
                    <span className="w-10 text-right font-medium tabular-nums">{slice.value}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Top Places" href="/dashboard/locations" linkLabel="View All">
          {data.byPlace.length === 0 ? (
            <Empty>No deliveries in this period.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">Place</th>
                  <th className="pb-2 pr-2 text-right font-medium">Orders</th>
                  <th className="pb-2 pr-2 text-right font-medium">Avg Time</th>
                  <th className="pb-2 text-right font-medium">Sales</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.byPlace.slice(0, 8).map((row) => (
                  <tr key={row.place}>
                    <td className="py-2 pr-2">
                      <span className="flex items-center gap-1 font-medium">
                        <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{row.place}</span>
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">{row.delivered}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">{mins(row.averageMinutes)}</td>
                    <td className="py-2 text-right font-medium tabular-nums">{compact(row.sales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Handed Over By" href="/dashboard/staff" linkLabel="Staff">
          {data.byRider.length === 0 ? (
            <Empty>No deliveries in this period.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">Staff</th>
                  <th className="pb-2 pr-2 text-right font-medium">Orders</th>
                  <th className="pb-2 pr-2 text-right font-medium">Ride</th>
                  <th className="pb-2 pr-2 text-right font-medium">Cash</th>
                  <th className="pb-2 text-right font-medium">Earned</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.byRider.slice(0, 8).map((row) => (
                  <tr key={row.name}>
                    <td className="py-2 pr-2 font-medium">{row.name}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{row.delivered}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">{mins(row.averageRideMinutes)}</td>
                    <td className="py-2 pr-2 text-right font-medium tabular-nums">{row.cash ? compact(row.cash) : '—'}</td>
                    <td className="py-2 text-right font-medium tabular-nums">{row.earned ? compact(row.earned) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent Deliveries" href="/dashboard/orders" linkLabel="Orders">
          {data.recent.length === 0 ? (
            <Empty>No deliveries in this period.</Empty>
          ) : (
            <ul className="space-y-2.5">
              {data.recent.map((row) => (
                <li key={row.id} className="flex items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
                    <Bike className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <Link href={`/dashboard/orders/${row.id}`} className="block truncate text-sm font-medium hover:underline">
                      {row.orderNumber} · {row.place ?? row.customerName}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">
                      {when(row.deliveredAt)} · {mins(row.minutes)} · {row.paidBy}
                    </span>
                  </span>
                  <span className="w-24 text-right text-sm font-semibold tabular-nums">{money(row.grandTotal)}</span>
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

function Tile({ label, value, change, caption, icon, tone, href }: { label: string; value: string; change?: number | null; caption: string; icon: React.ReactNode; tone: keyof typeof TONES; href?: string }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', TONES[tone])}>{icon}</span>
      </div>
      <p className="mt-1.5 text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 flex items-center gap-1 text-xs">
        {change !== null && change !== undefined ? (
          <span className={cn('inline-flex items-center gap-0.5 font-medium tabular-nums', change >= 0 ? 'text-success' : 'text-destructive')}>
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

function Card({ title, href, linkLabel, children }: { title: string; href: string; linkLabel: string; children: React.ReactNode }) {
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

function dayLabel(iso: string, locale: string, long = false): string {
  const date = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: long ? 'long' : 'short', ...(long ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(date)
}
