'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight, Package, Receipt, ShoppingCart, Tag, Wallet, BarChart3 } from 'lucide-react'

import { StatCard } from '@/features/dashboard/components/page-header'
import {
  CategoryShareChart,
  PaymentMixChart,
  PeakHoursChart,
  RevenueTrendChart,
} from '@/features/analytics/components/charts'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'

/**
 * The sales report, at a glance.
 *
 * Six figures, then the six questions an owner asks next: how it moved, what
 * sold, when, how they paid, and where. Each panel that has a table behind it
 * says so and links to it, because a share of a pie is a claim and the table
 * is the working.
 *
 * A client component for one reason: the charts are. Everything it needs —
 * currency, locale, every href — arrives as a plain value, never a function,
 * since none of those can cross from the server page that renders it.
 */

export interface DashRow {
  key: string
  label: string
  sub: string | null
  orders: number
  itemsSold: number
  gross: number
  discount: number
  net: number
  share: number
}

export interface SalesDashboardProps {
  totals: {
    grossSales: number
    orders: number
    averageOrderValue: number
    itemsSold: number
    discounts: number
    netSales: number
  }
  deltas: {
    grossSales: number | null
    orders: number | null
    averageOrderValue: number | null
    itemsSold: number | null
    discounts: number | null
    netSales: number | null
  }
  trend: Array<{ label: string; revenue: number; orders: number }>
  hours: Array<{ label: string; orders: number; revenue: number }>
  categories: Array<{ name: string; revenue: number }>
  payments: Array<{ label: string; amount: number; share: number }>
  branches: Array<{ label: string; amount: number; share: number }>
  topItems: Array<{
    key: string
    label: string
    quantity: number
    sales: number
    imageUrl: string | null
  }>
  /** Where each "View details" goes — built by the server page, so the period travels. */
  links: { item: string; time: string; payment: string; category: string; branch: string }
  currency: string
  locale: string
}

export function SalesDashboard(props: SalesDashboardProps) {
  const { totals, deltas, currency, locale, links } = props
  const money = (value: number) => formatMoney(value, currency, locale)

  return (
    <div className="space-y-4">
      {/*
        Six tiles, in the order an owner reads them: what came in, how many
        bills, what a bill was worth, how many things, what was given away, and
        what is left. `change` is null when the period before sold nothing, and
        StatCard then shows no arrow rather than inventing a trend.
      */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Total Sales"
          value={money(totals.grossSales)}
          change={deltas.grossSales ?? undefined}
          icon={<BarChart3 className="size-4" />}
        />
        <StatCard
          label="Total Orders"
          value={totals.orders.toLocaleString(locale)}
          change={deltas.orders ?? undefined}
          icon={<ShoppingCart className="size-4" />}
        />
        <StatCard
          label="Average Order Value"
          value={money(totals.averageOrderValue)}
          change={deltas.averageOrderValue ?? undefined}
          icon={<Wallet className="size-4" />}
        />
        <StatCard
          label="Total Items Sold"
          value={totals.itemsSold.toLocaleString(locale)}
          change={deltas.itemsSold ?? undefined}
          icon={<Package className="size-4" />}
        />
        <StatCard
          label="Total Discounts"
          value={money(totals.discounts)}
          change={deltas.discounts ?? undefined}
          icon={<Tag className="size-4" />}
        />
        <StatCard
          label="Net Sales (After Discounts)"
          value={money(totals.netSales)}
          change={deltas.netSales ?? undefined}
          icon={<Receipt className="size-4" />}
        />
      </div>

      {/* The shape of the period, and what made it up. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title="Sales Trend">
          {props.trend.length > 0 ? (
            <RevenueTrendChart data={props.trend} currency={currency} locale={locale} />
          ) : (
            <Empty>Nothing sold in this period.</Empty>
          )}
        </Panel>

        <Panel title="Sales by Category" href={links.category}>
          {props.categories.length > 0 ? (
            <>
              <CategoryShareChart data={props.categories} currency={currency} locale={locale} />
              <Legend
                rows={props.categories.map((row) => ({
                  label: row.name,
                  amount: row.revenue,
                  share: shareOf(row.revenue, props.categories.reduce((s, r) => s + r.revenue, 0)),
                }))}
                currency={currency}
                locale={locale}
              />
            </>
          ) : (
            <Empty>No categories sold.</Empty>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Top Selling Items" href={links.item} cta="View all">
          {props.topItems.length > 0 ? (
            <ol className="space-y-2">
              {props.topItems.map((item, index) => (
                <li key={item.key} className="flex items-center gap-3">
                  {/*
                    The dish's picture where it still has one, and its rank
                    where it does not — a row keyed on the snapshotted name can
                    outlive the dish, and a blank square would read as a
                    missing image rather than a deleted dish.

                    A plain <img>: these are small, already-sized thumbnails
                    from arbitrary upload URLs, and next/image would want a
                    configured remote host for each.
                  */}
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt=""
                      loading="lazy"
                      className="size-9 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold tabular-nums">
                      {index + 1}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.label}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {item.quantity.toLocaleString(locale)} sold
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {money(item.sales)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>Nothing sold yet.</Empty>
          )}
        </Panel>

        <Panel title="Sales by Time" href={links.time}>
          {props.hours.some((h) => h.orders > 0) ? (
            <PeakHoursChart data={props.hours} currency={currency} locale={locale} />
          ) : (
            <Empty>No trade recorded by hour.</Empty>
          )}
        </Panel>

        <Panel title="Sales by Payment Method" href={links.payment}>
          {props.payments.length > 0 ? (
            <>
              <PaymentMixChart
                data={props.payments.map((row) => ({ method: row.label, amount: row.amount }))}
                currency={currency}
                locale={locale}
              />
              <Legend rows={props.payments} currency={currency} locale={locale} />
            </>
          ) : (
            <Empty>Nothing was settled in this period.</Empty>
          )}
        </Panel>

        {/*
          Bars rather than a third pie: a branch list is read as a ranking, and
          five slices of one colour family are harder to rank than five bars.
        */}
        <Panel title="Sales by Branch" href={links.branch}>
          {props.branches.length > 0 ? (
            <ul className="space-y-3">
              {props.branches.map((row) => (
                <li key={row.label}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-sm">{row.label}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {row.share.toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, Math.max(0, row.share))}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-xs font-medium tabular-nums">
                      {money(row.amount)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No locations sold in this period.</Empty>
          )}
        </Panel>
      </div>
    </div>
  )
}

function shareOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0
}

function Panel({
  title,
  href,
  cta = 'View details',
  className,
  children,
}: {
  title: string
  /** Present when there is a table behind this panel. */
  href?: string
  cta?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn('rounded-xl border bg-card p-4', className)}>
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

function Legend({
  rows,
  currency,
  locale,
}: {
  rows: Array<{ label: string; amount: number; share: number }>
  currency: string
  locale: string
}) {
  return (
    <ul className="mt-3 space-y-1.5">
      {rows.map((row) => (
        <li key={row.label} className="flex items-baseline justify-between gap-2 text-xs">
          <span className="min-w-0 truncate">{row.label}</span>
          <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
            <span className="text-muted-foreground">{row.share.toFixed(1)}%</span>
            <span className="font-medium">{formatMoney(row.amount, currency, locale)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
  )
}
