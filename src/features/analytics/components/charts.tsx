'use client'

import * as React from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { formatMoney, formatMoneyCompact } from '@/lib/money'

/**
 * Chart palette.
 *
 * Ordered for maximum separation between adjacent series, and driven by the
 * same CSS variables as the rest of the UI so charts follow the theme (and
 * dark mode) without a second source of truth.
 */
const SERIES = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--muted-foreground))',
]

const AXIS_STYLE = {
  fontSize: 11,
  fill: 'hsl(var(--muted-foreground))',
}

function ChartTooltip({
  active,
  payload,
  label,
  currency,
  locale,
  moneyKeys = ['revenue', 'amount', 'value'],
}: {
  active?: boolean
  payload?: Array<{ name?: string; dataKey?: string | number; value?: number; color?: string }>
  label?: string
  currency: string
  locale: string
  moneyKeys?: string[]
}) {
  if (!active || !payload?.length) return null

  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-elevated">
      {label ? <p className="mb-1 font-semibold text-popover-foreground">{label}</p> : null}
      {payload.map((entry, index) => {
        const key = String(entry.dataKey ?? '')
        const isMoney = moneyKeys.includes(key)
        return (
          <p key={index} className="flex items-center gap-2 text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: entry.color }} />
            <span className="capitalize">{entry.name ?? key}</span>
            <span className="ml-auto font-semibold text-popover-foreground">
              {isMoney ? formatMoney(entry.value ?? 0, currency, locale) : (entry.value ?? 0).toLocaleString()}
            </span>
          </p>
        )
      })}
    </div>
  )
}

export function RevenueTrendChart({
  data,
  currency,
  locale,
}: {
  data: Array<{ label: string; revenue: number; orders: number }>
  currency: string
  locale: string
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.28} />
            <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
        <YAxis
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={false}
          width={64}
          tickFormatter={(value: number) => formatMoneyCompact(value, currency, locale)}
        />
        <Tooltip content={<ChartTooltip currency={currency} locale={locale} />} />
        <Area
          type="monotone"
          dataKey="revenue"
          name="Revenue"
          stroke={SERIES[0]}
          strokeWidth={2}
          fill="url(#revenueFill)"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function OrdersTrendChart({
  data,
  currency,
  locale,
}: {
  data: Array<{ label: string; orders: number }>
  currency: string
  locale: string
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
          content={<ChartTooltip currency={currency} locale={locale} />}
        />
        <Bar dataKey="orders" name="Orders" fill={SERIES[1]} radius={[6, 6, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function PeakHoursChart({
  data,
  currency,
  locale,
}: {
  data: Array<{ label: string; orders: number; revenue: number }>
  currency: string
  locale: string
}) {
  // Trading hours only — a 24-bar chart of mostly zeros hides the signal.
  const active = data.filter((point) => point.orders > 0)
  const first = active.length ? data.indexOf(active[0]) : 8
  const last = active.length ? data.indexOf(active[active.length - 1]) : 23
  const windowed = data.slice(Math.max(0, first - 1), Math.min(24, last + 2))
  const peak = Math.max(...windowed.map((point) => point.orders), 0)

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={windowed} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_STYLE} tickLine={false} axisLine={false} interval={0} angle={-35} textAnchor="end" height={48} />
        <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
          content={<ChartTooltip currency={currency} locale={locale} />}
        />
        <Bar dataKey="orders" name="Orders" radius={[6, 6, 0, 0]} maxBarSize={28}>
          {windowed.map((point, index) => (
            <Cell key={index} fill={point.orders === peak && peak > 0 ? SERIES[0] : SERIES[1]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export function CategoryShareChart({
  data,
  currency,
  locale,
}: {
  data: Array<{ name: string; revenue: number }>
  currency: string
  locale: string
}) {
  if (!data.length) {
    return (
      <p className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
        No sales in this period yet.
      </p>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie
          data={data}
          dataKey="revenue"
          nameKey="name"
          innerRadius={54}
          outerRadius={84}
          paddingAngle={2}
          stroke="hsl(var(--background))"
          strokeWidth={2}
        >
          {data.map((_, index) => (
            <Cell key={index} fill={SERIES[index % SERIES.length]} />
          ))}
        </Pie>
        <Tooltip content={<ChartTooltip currency={currency} locale={locale} />} />
        <Legend
          verticalAlign="bottom"
          iconType="circle"
          iconSize={8}
          formatter={(value: string) => (
            <span className="text-xs text-muted-foreground">{value}</span>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

export function PaymentMixChart({
  data,
  currency,
  locale,
}: {
  data: Array<{ method: string; amount: number }>
  currency: string
  locale: string
}) {
  if (!data.length) {
    return (
      <p className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
        No payments recorded yet.
      </p>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value: number) => formatMoneyCompact(value, currency, locale)}
        />
        <YAxis type="category" dataKey="method" tick={AXIS_STYLE} tickLine={false} axisLine={false} width={64} />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
          content={<ChartTooltip currency={currency} locale={locale} />}
        />
        <Bar dataKey="amount" name="Collected" fill={SERIES[2]} radius={[0, 6, 6, 0]} maxBarSize={26} />
      </BarChart>
    </ResponsiveContainer>
  )
}
