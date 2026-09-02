'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Download, FileSpreadsheet, FileText } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import type { ReportSummary } from '@/features/analytics/queries'
import { formatMoney } from '@/lib/money'

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
  { key: 'quarter', label: 'Last 90 days' },
  { key: 'year', label: 'Last 12 months' },
]

export function ReportsView({
  summary,
  currency,
  locale,
  range,
}: {
  summary: ReportSummary
  currency: string
  locale: string
  range: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  const money = (value: number) => formatMoney(value, currency, locale)

  const setRange = (value: string) => {
    const next = new URLSearchParams(params.toString())
    next.set('range', value)
    router.push(`/dashboard/reports?${next.toString()}`)
  }

  const exportUrl = (type: string, format: string) =>
    `/api/reports/export?type=${type}&format=${format}&range=${range}`

  return (
    <>
      <PageHeader
        title="Reports"
        description="Sales, revenue, profit and more — export anytime"
        actions={
          <>
            <Select value={range} onValueChange={setRange}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" asChild>
              <a href={exportUrl('summary', 'xlsx')} download>
                <FileSpreadsheet /> Excel
              </a>
            </Button>
            <Button variant="outline" asChild>
              <a href={exportUrl('orders', 'csv')} download>
                <FileText /> Orders CSV
              </a>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Net sales" value={money(summary.netSales)} tone="primary" hint={`${summary.orderCount} orders · after discounts & refunds`} href="/dashboard/reports/sales" />
        <StatCard label="Collected" value={money(summary.collected)} hint="payments in, refunds out" href="/dashboard/reports/sales" />
        <StatCard label="Gross profit" value={money(summary.grossProfit)} tone="success" hint={`cost ${money(summary.foodCost)}`} href="/dashboard/reports/profit" />
        <StatCard label="Average order" value={money(summary.averageOrderValue)} hint={`${summary.uniqueCustomers} customers`} href="/dashboard/reports/sales" />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Breakdown" bodyClassName="p-0">
          <div className="divide-y">
            <Row label="Tax collected" value={money(summary.tax)} />
            <Row label="Service charge" value={money(summary.serviceCharge)} />
            <Row label="Discounts given" value={`− ${money(summary.discounts)}`} />
            <Row label="Refunds" value={`− ${money(summary.refunds)}`} />
            <Row label="Tips" value={money(summary.tips)} />
            <Row label="Cancelled orders" value={String(summary.cancelledCount)} />
          </div>
        </SectionCard>

        <SectionCard
          title="Payment methods"
          bodyClassName="p-0"
          actions={
            <Button variant="ghost" size="sm" asChild>
              <a href={exportUrl('summary', 'csv')} download>
                <Download /> CSV
              </a>
            </Button>
          }
        >
          {summary.payments.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">No payments in this period.</p>
          ) : (
            <div className="divide-y">
              {summary.payments.map((payment) => (
                <Row
                  key={payment.method}
                  label={`${payment.method} · ${payment.count}`}
                  value={money(payment.amount)}
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard title="Top selling items" bodyClassName="p-0">
          {summary.topItems.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">No sales in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.topItems.map((item) => (
                  <TableRow key={item.name}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{money(item.revenue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </div>
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  )
}
