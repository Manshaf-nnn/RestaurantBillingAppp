'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  Ban,
  BarChart3,
  Coins,
  Package,
  SlidersHorizontal,
} from 'lucide-react'

import { formatMoney, formatMoneyCompact, type CurrencyCode } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { InventoryReportData } from '../inventory-report'

/**
 * Inventory Reports.
 *
 * ── The chart palette ───────────────────────────────────────────────────────
 *
 * `--viz-1..6`, a categorical set: one hue per category, in a fixed order,
 * never cycled. A seventh category folds into "Others" in muted grey rather
 * than repeating a hue, because two slices sharing a colour is a chart that
 * lies about how many things there are. Both light and dark steps were
 * validated — lightness band, chroma floor, colour-blind separation of every
 * adjacent pair, and contrast against the surface — rather than eyeballed.
 *
 * Identity is never colour alone: the donut's legend names every slice with
 * its share and its value, and the slices carry a surface-coloured gap so
 * neighbours stay distinct in greyscale and on paper.
 *
 * ── One axis, and what the trend actually plots ─────────────────────────────
 *
 * Value only. Quantity and value on one chart would need two y-scales, which
 * is the one thing a chart must never have — the crossing point would be an
 * artefact of the scales rather than a fact about the stock. Quantity lives
 * in the movement card and the drill-downs, in its own units.
 */

const VIZ = [
  'hsl(var(--viz-1))',
  'hsl(var(--viz-2))',
  'hsl(var(--viz-3))',
  'hsl(var(--viz-4))',
  'hsl(var(--viz-5))',
  'hsl(var(--viz-6))',
]
/** The tail bucket. Grey on purpose: it is not a category, it is the rest. */
const OTHERS = 'hsl(var(--muted-foreground))'

/** Categories beyond this fold into "Others" rather than inventing hues. */
const MAX_SLICES = VIZ.length

export function InventoryReportView({
  data,
  currency,
  locale,
  rangeLabel,
  branchLabel,
}: {
  data: InventoryReportData
  currency: CurrencyCode
  locale: string
  rangeLabel: string
  branchLabel: string
}) {
  const money = (value: number) => formatMoney(value, currency, locale)
  const compact = (value: number) => formatMoneyCompact(value, currency, locale)

  /** Top categories by value, with the tail folded into one grey slice. */
  const slices = React.useMemo(() => {
    const head = data.byCategory.slice(0, MAX_SLICES)
    const tail = data.byCategory.slice(MAX_SLICES)
    const rows = head.map((row, index) => ({ ...row, fill: VIZ[index] }))
    if (tail.length > 0) {
      rows.push({
        category: 'Others',
        items: tail.reduce((sum, row) => sum + row.items, 0),
        quantity: tail.reduce((sum, row) => sum + row.quantity, 0),
        value: tail.reduce((sum, row) => sum + row.value, 0),
        share: tail.reduce((sum, row) => sum + row.share, 0),
        fill: OTHERS,
      })
    }
    return rows
  }, [data.byCategory])

  return (
    <div className="space-y-4">
      {/* ── the five figures ───────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Tile
          label="Total Inventory Value"
          value={money(data.totalValue)}
          change={data.totalValueChange}
          caption="vs period start"
          icon={<Coins className="size-4" />}
          tone="primary"
        />
        <Tile
          label="Total Items"
          value={String(data.totalItems)}
          caption={`${data.categoryCount} categories`}
          icon={<Package className="size-4" />}
          tone="success"
        />
        <Tile
          label="Low Stock Items"
          value={String(data.lowStock.value)}
          caption="need attention"
          icon={<AlertTriangle className="size-4" />}
          tone="warning"
          href="/dashboard/reports/inventory/low-stock"
        />
        <Tile
          label="Out of Stock Items"
          value={String(data.outOfStock.value)}
          caption="take action"
          icon={<Ban className="size-4" />}
          tone="destructive"
          href="/dashboard/reports/inventory/low-stock?only=out"
        />
        <Tile
          label="Stock Usage Value"
          value={money(data.usageValue.value)}
          change={data.usageValue.change}
          caption="vs last period"
          icon={<BarChart3 className="size-4" />}
          tone="info"
        />
      </div>

      {/* ── trend and category split ───────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <section className="rounded-xl border bg-card p-5 shadow-soft">
          <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Inventory Value Trend</h2>
              <p className="text-xs text-muted-foreground">
                What the stock on hand was worth at the close of each day · {rangeLabel}
              </p>
            </div>
            <span className="text-xs text-muted-foreground">{branchLabel}</span>
          </header>

          {data.trend.length === 0 ? (
            <Empty>No movements in this period, so there is no trend to draw.</Empty>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
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
                  {/* Crosshair + tooltip: an SVG chart that cannot be
                      interrogated is a picture of data, not a reading of it. */}
                  <Tooltip
                    cursor={{ stroke: 'hsl(var(--viz-1))', strokeWidth: 1, strokeDasharray: '3 3' }}
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-elevated">
                          <p className="font-semibold text-popover-foreground">
                            {dayLabel(String(label), locale, true)}
                          </p>
                          <p className="mt-0.5 text-muted-foreground">
                            Stock on hand{' '}
                            <span className="font-semibold text-popover-foreground">
                              {money(Number(payload[0].value ?? 0))}
                            </span>
                          </p>
                        </div>
                      ) : null
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="hsl(var(--viz-1))"
                    strokeWidth={2}
                    fill="url(#valueFill)"
                    // One series, so the title names it and no legend is needed.
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
            <h2 className="text-sm font-semibold">Stock Value by Category</h2>
            <Link
              href="/dashboard/reports/inventory/categories"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              View Details <ArrowRight className="size-3" />
            </Link>
          </header>

          {slices.length === 0 ? (
            <Empty>Nothing in stock, so there is nothing to split by category.</Empty>
          ) : (
            <>
              <div className="relative h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={slices}
                      dataKey="value"
                      nameKey="category"
                      innerRadius="62%"
                      outerRadius="100%"
                      // A surface-coloured gap between neighbours, so the
                      // slices stay separable in greyscale and on paper.
                      paddingAngle={2}
                      stroke="hsl(var(--card))"
                      strokeWidth={2}
                    >
                      {slices.map((slice) => (
                        <Cell key={slice.category} fill={slice.fill} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) =>
                        active && payload?.length ? (
                          <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-elevated">
                            <p className="font-semibold text-popover-foreground">
                              {String(payload[0].name ?? '')}
                            </p>
                            <p className="mt-0.5 text-muted-foreground">
                              {money(Number(payload[0].value ?? 0))}
                            </p>
                          </div>
                        ) : null
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-bold tabular-nums">{compact(data.totalValue)}</span>
                  <span className="text-[11px] text-muted-foreground">Total Value</span>
                </div>
              </div>

              {/*
                The legend is the direct labelling: every slice is named here
                with its share and its value, so identity never rests on the
                colour alone.
              */}
              <ul className="mt-3 space-y-1.5">
                {slices.map((slice) => (
                  <li key={slice.category} className="flex items-center gap-2 text-xs">
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: slice.fill }}
                    />
                    <span className="min-w-0 flex-1 truncate">{slice.category}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {(slice.share * 100).toFixed(1)}%
                    </span>
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
        <Card
          title="Top Consumed Items (by Cost)"
          href="/dashboard/reports/inventory/items"
          linkLabel="View Details"
        >
          {data.topConsumed.length === 0 ? (
            <Empty>Nothing was used in this period.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">#</th>
                  <th className="pb-2 pr-2 font-medium">Item</th>
                  <th className="pb-2 pr-2 font-medium">Category</th>
                  <th className="pb-2 pr-2 text-right font-medium">Qty Used</th>
                  <th className="pb-2 text-right font-medium">Cost Value</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.topConsumed.map((row, index) => (
                  <tr key={row.itemId}>
                    <td className="py-2 pr-2 text-muted-foreground">{index + 1}</td>
                    <td className="py-2 pr-2">
                      <Link href={`/dashboard/inventory/${row.itemId}`} className="font-medium hover:underline">
                        {row.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-2 text-muted-foreground">{row.category}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {row.quantity} {row.unit.toLowerCase()}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums">{money(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Low Stock Items" href="/dashboard/reports/inventory/low-stock" linkLabel="View All">
          {data.lowStockItems.length === 0 ? (
            <Empty>Everything is above its reorder level.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">Item</th>
                  <th className="pb-2 pr-2 text-right font-medium">Current Stock</th>
                  <th className="pb-2 text-right font-medium">Reorder Level</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.lowStockItems.map((row) => (
                  <tr key={row.itemId}>
                    <td className="py-2 pr-2">
                      <Link href={`/dashboard/inventory/${row.itemId}`} className="font-medium hover:underline">
                        {row.name}
                      </Link>
                      {row.outOfStock ? (
                        <span className="ml-1.5 text-[11px] font-semibold text-destructive">out</span>
                      ) : null}
                    </td>
                    <td
                      className={cn(
                        'py-2 pr-2 text-right tabular-nums',
                        row.outOfStock ? 'font-semibold text-destructive' : 'text-warning',
                      )}
                    >
                      {row.quantity} {row.unit.toLowerCase()}
                    </td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {row.reorderLevel} {row.unit.toLowerCase()}
                      {row.alertBranchName ? <span className="block text-xs">at {row.alertBranchName}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title="Stock Movements Summary"
          href="/dashboard/reports/inventory/movements"
          linkLabel="View Details"
        >
          <ul className="space-y-2.5">
            {data.movements.map((row) => (
              <li key={row.bucket} className="flex items-center gap-3">
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-lg',
                    MOVEMENT_TONE[row.bucket],
                  )}
                >
                  {MOVEMENT_ICON[row.bucket]}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.label}</span>
                <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                  {row.units} units
                </span>
                <span className="w-28 text-right text-sm font-semibold tabular-nums">{money(row.value)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

const MOVEMENT_ICON: Record<string, React.ReactNode> = {
  IN: <ArrowDown className="size-4" />,
  OUT: <ArrowRight className="size-4" />,
  TRANSFER: <ArrowLeftRight className="size-4" />,
  ADJUSTMENT: <SlidersHorizontal className="size-4" />,
}

/*
 * Status tones, not series colours. These four say what KIND of movement a
 * row is, and they are deliberately drawn from the status palette rather than
 * from `--viz-*`: reusing a categorical hue for a state is how a legend stops
 * meaning anything.
 */
const MOVEMENT_TONE: Record<string, string> = {
  IN: 'bg-success/10 text-success',
  OUT: 'bg-warning/15 text-warning',
  TRANSFER: 'bg-primary/10 text-primary',
  ADJUSTMENT: 'bg-muted text-muted-foreground',
}

const TONES = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
  info: 'bg-chart-2/10 text-chart-2',
} as const

/** One headline figure. A tile, not a chart — there is nothing to plot. */
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
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', TONES[tone])}>
          {icon}
        </span>
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
    <Link
      href={href}
      className="rounded-xl border bg-card p-4 shadow-soft transition-colors hover:border-primary/40"
    >
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
