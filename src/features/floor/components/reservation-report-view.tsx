'use client'

import * as React from 'react'
import Link from 'next/link'
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ArrowDown, ArrowRight, ArrowUp, Ban, CalendarClock, CalendarX2, CheckCircle2, Users } from 'lucide-react'

import { RESERVATION_STATUS_META } from '@/components/ui/status'
import { cn } from '@/lib/utils'

import type { ReservationReportData } from '../reservation-report'

/**
 * Reservations report — the same shape as every other report: five figures,
 * the trend beside the split, three summaries.
 */

const VIZ = ['hsl(var(--viz-1))', 'hsl(var(--viz-2))', 'hsl(var(--viz-3))', 'hsl(var(--viz-4))', 'hsl(var(--viz-5))', 'hsl(var(--viz-6))']

export function ReservationReportView({
  data,
  locale,
  rangeLabel,
  branchLabel,
  timeZone,
}: {
  data: ReservationReportData
  locale: string
  rangeLabel: string
  branchLabel: string
  timeZone: string
}) {
  const slices = React.useMemo(
    () => data.byStatus.map((row, index) => ({ name: RESERVATION_STATUS_META[row.status].label, value: row.count, share: row.share, fill: VIZ[index % VIZ.length] })),
    [data.byStatus],
  )
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
  const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Tile label="Bookings" value={String(data.bookings)} change={data.bookingsChange} caption="vs last period" icon={<CalendarClock className="size-4" />} tone="primary" />
        <Tile label="Covers" value={String(data.covers)} caption="guests booked" icon={<Users className="size-4" />} tone="info" />
        <Tile
          label="Honoured"
          value={String(data.honoured)}
          caption={data.honouredRate === null ? 'seated or completed' : `${Math.round(data.honouredRate * 100)}% of those not cancelled`}
          icon={<CheckCircle2 className="size-4" />}
          tone="success"
        />
        <Tile label="Cancelled" value={String(data.cancelled)} caption={data.bookings ? `${Math.round((data.cancelled / data.bookings) * 100)}% of bookings` : 'none'} icon={<CalendarX2 className="size-4" />} tone="warning" />
        <Tile label="No-shows" value={String(data.noShows)} caption={`${data.upcoming} still to come`} icon={<Ban className="size-4" />} tone="destructive" href="/dashboard/reservations" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <section className="rounded-xl border bg-card p-5 shadow-soft">
          <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Bookings by Day</h2>
              <p className="text-xs text-muted-foreground">Bookings held each day, cancelled ones included · {rangeLabel}</p>
            </div>
            <span className="text-xs text-muted-foreground">{branchLabel}</span>
          </header>
          {data.bookings === 0 ? (
            <Empty>No bookings in this period.</Empty>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="bookingsFill" x1="0" y1="0" x2="0" y2="1">
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
                      const point = payload[0].payload as ReservationReportData['trend'][number]
                      return (
                        <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-elevated">
                          <p className="font-semibold text-popover-foreground">{dayLabel(String(label), locale, true)}</p>
                          <p className="mt-0.5 text-muted-foreground">{point.bookings} booking{point.bookings === 1 ? '' : 's'} · {point.covers} covers · {point.cancelled} cancelled</p>
                        </div>
                      )
                    }}
                  />
                  <Area type="monotone" dataKey="bookings" stroke="hsl(var(--viz-1))" strokeWidth={2} fill="url(#bookingsFill)" activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="rounded-xl border bg-card p-5 shadow-soft">
          <header className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Bookings by Status</h2>
            <Link href="/dashboard/reservations" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              Diary <ArrowRight className="size-3" />
            </Link>
          </header>
          {slices.length === 0 ? (
            <Empty>Nothing to split yet.</Empty>
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
                            <p className="mt-0.5 text-muted-foreground">{String(payload[0].value ?? 0)} bookings</p>
                          </div>
                        ) : null
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-bold tabular-nums">{data.bookings}</span>
                  <span className="text-[11px] text-muted-foreground">Bookings</span>
                </div>
              </div>
              <ul className="mt-3 space-y-1.5">
                {slices.map((slice) => (
                  <li key={slice.name} className="flex items-center gap-2 text-xs">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: slice.fill }} />
                    <span className="min-w-0 flex-1 truncate">{slice.name}</span>
                    <span className="tabular-nums text-muted-foreground">{(slice.share * 100).toFixed(1)}%</span>
                    <span className="w-12 text-right font-medium tabular-nums">{slice.value}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Busiest Times" href="/dashboard/reservations" linkLabel="Diary">
          {data.byHour.length === 0 ? (
            <Empty>No bookings in this period.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">Hour</th>
                  <th className="pb-2 pr-2 text-right font-medium">Bookings</th>
                  <th className="pb-2 text-right font-medium">Covers</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.byHour.map((row) => (
                  <tr key={row.hour}>
                    <td className="py-2 pr-2 font-medium tabular-nums">{hourLabel(row.hour)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{row.bookings}</td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">{row.covers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Most Booked Tables" href="/dashboard/tables" linkLabel="Tables">
          {data.byTable.length === 0 ? (
            <Empty>No bookings were assigned a table.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">Table</th>
                  <th className="pb-2 pr-2 text-right font-medium">Bookings</th>
                  <th className="pb-2 pr-2 text-right font-medium">Covers</th>
                  <th className="pb-2 text-right font-medium">No-shows</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.byTable.map((row) => (
                  <tr key={`${row.branch}-${row.table}`}>
                    <td className="py-2 pr-2 font-medium">
                      Table {row.table}
                      {row.branch ? <span className="ml-1 text-xs text-muted-foreground">{row.branch}</span> : null}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">{row.bookings}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">{row.covers}</td>
                    <td className={cn('py-2 text-right tabular-nums', row.noShows ? 'text-destructive' : 'text-muted-foreground')}>{row.noShows || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Cancellations & No-shows" href="/dashboard/reservations" linkLabel="Diary">
          {data.cancellations.length === 0 ? (
            <Empty>Every booking in this period was kept.</Empty>
          ) : (
            <ul className="space-y-2.5">
              {data.cancellations.map((row) => (
                <li key={row.id} className="flex items-start gap-3">
                  <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', row.status === 'NO_SHOW' ? 'bg-destructive/10 text-destructive' : 'bg-warning/15 text-warning')}>
                    {row.status === 'NO_SHOW' ? <Ban className="size-4" /> : <CalendarX2 className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {row.guest} · {row.partySize}
                      {row.table ? ` · Table ${row.table}` : ''}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {when(row.reservedAt)} · {row.status === 'NO_SHOW' ? 'did not arrive' : [row.reason, row.by ? `by ${row.by}` : null].filter(Boolean).join(' · ') || 'cancelled'}
                    </span>
                  </span>
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
