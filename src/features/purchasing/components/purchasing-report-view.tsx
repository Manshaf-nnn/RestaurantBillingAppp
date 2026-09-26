'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  ArrowRight, BarChart3, FileText, RotateCcw, ShoppingCart, Target, Users,
} from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis, Area, AreaChart,
} from 'recharts'

import { StatCard } from '@/features/dashboard/components/page-header'
import { formatMoney, formatMoneyCompact } from '@/lib/money'
import { cn } from '@/lib/utils'

/**
 * What the restaurant bought, at a glance.
 *
 * Client-side because the charts are; everything it needs arrives as a plain
 * value, never a function, since none of those cross from the server page.
 *
 * Colours come from `--viz-1..6`, the validated categorical palette, rather
 * than from `--chart-*`: the viz set is checked for lightness band, chroma
 * floor, separation for colour-vision deficiency between adjacent pairs, and
 * contrast against the card surface, in both themes.
 */

const VIZ = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)']
const hsl = (token: string) => `hsl(${token})`

export interface Bucket {
  key: string
  label: string
  value: number
  share: number
}

export interface PurchasingReportViewProps {
  totals: {
    purchaseValue: number
    orders: number
    suppliers: number
    newSuppliers: number
    averageOrderValue: number
    returns: number
    variance: { committed: number; actual: number; amount: number; percent: number | null }
  }
  deltas: {
    purchaseValue: number | null
    orders: number | null
    averageOrderValue: number | null
    returns: number | null
  }
  trend: Array<{ label: string; value: number }>
  byCategory: Bucket[]
  bySupplier: Bucket[]
  byStatus: Array<{ key: string; label: string; count: number; share: number }>
  awaitingApproval: number
  monthly: Array<{ label: string; thisYear: number; lastYear: number }>
  links: { orders: string; item: string; supplier: string; category: string }
  currency: string
  locale: string
}

export function PurchasingReportView(props: PurchasingReportViewProps) {
  const { totals, deltas, currency, locale, links } = props
  const money = (v: number) => formatMoney(v, currency, locale)
  const compact = (v: number) => formatMoneyCompact(v, currency, locale)

  const variance = totals.variance
  /* Under is good. The sign is the story, so it leads the label. */
  const over = variance.amount > 0
  const totalPos = props.byStatus.reduce((s, r) => s + r.count, 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Total Purchase Value"
          value={money(totals.purchaseValue)}
          change={deltas.purchaseValue ?? undefined}
          icon={<ShoppingCart className="size-4" />}
        />
        <StatCard
          label="Total Purchase Orders"
          value={totals.orders.toLocaleString(locale)}
          change={deltas.orders ?? undefined}
          icon={<FileText className="size-4" />}
        />
        <StatCard
          label="Total Suppliers"
          value={totals.suppliers.toLocaleString(locale)}
          hint={
            totals.newSuppliers > 0
              ? `${totals.newSuppliers} new supplier${totals.newSuppliers === 1 ? '' : 's'}`
              : 'none new this period'
          }
          icon={<Users className="size-4" />}
        />
        <StatCard
          label="Average Order Value"
          value={money(totals.averageOrderValue)}
          change={deltas.averageOrderValue ?? undefined}
          icon={<BarChart3 className="size-4" />}
        />
        <StatCard
          label="Purchase Returns"
          value={money(totals.returns)}
          change={deltas.returns ?? undefined}
          icon={<RotateCcw className="size-4" />}
        />
        {/*
          Not "vs budget": there is no budget in this system, so the tile the
          design asked for could only have been invented. This is the question
          the data does answer — the order committed one figure and the delivery
          was invoiced at another — and the hint says so in as many words, so
          nobody reads it as a budget.
        */}
        <StatCard
          label="Variance vs Ordered"
          value={variance.percent === null ? '—' : `${variance.percent > 0 ? '+' : ''}${variance.percent}%`}
          hint={
            variance.percent === null
              ? 'nothing received yet'
              : `${money(Math.abs(variance.amount))} ${over ? 'over' : 'under'} what was ordered`
          }
          tone={variance.percent === null ? 'default' : over ? 'warning' : 'success'}
          icon={<Target className="size-4" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title="Purchase Value Trend">
          {props.trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={props.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="purchTrend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={hsl(VIZ[0])} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={hsl(VIZ[0])} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => compact(v)}
                  width={64}
                />
                <Tooltip
                  formatter={(v: number) => [money(v), 'Purchases']}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={hsl(VIZ[0])}
                  strokeWidth={2}
                  fill="url(#purchTrend)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <Empty>Nothing was bought in this period.</Empty>
          )}
        </Panel>

        <Panel title="Purchases by Category" href={links.category}>
          {props.byCategory.length > 0 ? (
            <>
              <Donut
                data={props.byCategory.map((r) => ({ name: r.label, value: r.value }))}
                centre={compact(totals.purchaseValue)}
                caption="Total Purchases"
                money={money}
              />
              <Legend2 rows={props.byCategory} money={money} />
            </>
          ) : (
            <Empty>No purchases to break down.</Empty>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Purchases by Supplier (Top 5)" href={links.supplier} cta="View all">
          {props.bySupplier.length > 0 ? (
            <ul className="space-y-3">
              {props.bySupplier.slice(0, 5).map((row, i) => (
                <li key={row.key}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-sm">{row.label}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {row.share.toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, Math.max(0, row.share))}%`,
                          background: hsl(VIZ[i % VIZ.length]),
                        }}
                      />
                    </div>
                    <span className="shrink-0 text-xs font-medium tabular-nums">
                      {money(row.value)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No suppliers were bought from.</Empty>
          )}
        </Panel>

        <Panel title="Purchase Orders by Status" href={links.orders}>
          {totalPos > 0 ? (
            <>
              <Donut
                data={props.byStatus.map((r) => ({ name: r.label, value: r.count }))}
                centre={String(totalPos)}
                caption="Total POs"
                money={(v) => String(v)}
              />
              <ul className="mt-3 space-y-1.5">
                {props.byStatus.map((row, i) => (
                  <li key={row.key} className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: hsl(VIZ[i % VIZ.length]) }}
                      />
                      <span className="truncate">{row.label}</span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
                      <span className="text-muted-foreground">{row.share.toFixed(1)}%</span>
                      <span className="font-medium">{row.count}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {/*
                Requests are not orders and are kept out of the figures above —
                said here rather than silently, so a pile of unapproved requests
                is visible instead of merely absent.
              */}
              {props.awaitingApproval > 0 ? (
                <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
                  {props.awaitingApproval} request{props.awaitingApproval === 1 ? '' : 's'} not yet
                  approved — not counted above.
                </p>
              ) : null}
            </>
          ) : (
            <Empty>No purchase orders in this period.</Empty>
          )}
        </Panel>

        <Panel title="Monthly Purchase Comparison">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={props.monthly} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => compact(v)}
                width={60}
              />
              <Tooltip
                formatter={(v: number, name: string) => [money(v), name]}
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="thisYear" name="This Year" fill={hsl(VIZ[0])} radius={[3, 3, 0, 0]} />
              <Bar dataKey="lastYear" name="Last Year" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>
    </div>
  )
}

function Donut({
  data,
  centre,
  caption,
  money,
}: {
  data: Array<{ name: string; value: number }>
  centre: string
  caption: string
  money: (value: number) => string
}) {
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={58} outerRadius={84} paddingAngle={2}>
            {data.map((_, i) => (
              <Cell key={i} fill={hsl(VIZ[i % VIZ.length])} />
            ))}
          </Pie>
          <Tooltip
            formatter={(v: number, name: string) => [money(v), name]}
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-base font-bold">{centre}</span>
        <span className="text-[11px] text-muted-foreground">{caption}</span>
      </div>
    </div>
  )
}

function Legend2({ rows, money }: { rows: Bucket[]; money: (v: number) => string }) {
  return (
    <ul className="mt-3 space-y-1.5">
      {rows.slice(0, 8).map((row, i) => (
        <li key={row.key} className="flex items-baseline justify-between gap-2 text-xs">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: hsl(VIZ[i % VIZ.length]) }}
            />
            <span className="truncate">{row.label}</span>
          </span>
          <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
            <span className="text-muted-foreground">{row.share.toFixed(1)}%</span>
            <span className="font-medium">{money(row.value)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function Panel({
  title,
  href,
  cta = 'View details',
  className,
  children,
}: {
  title: string
  href?: string
  cta?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn('rounded-xl border bg-card p-4 shadow-soft', className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {href ? (
          <Link
            href={href}
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {cta} <ArrowRight className="size-3" />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>
}
