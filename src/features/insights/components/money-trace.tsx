import Link from 'next/link'

import type { Explanation, MetricKey } from '@/features/accounting/explain'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { MONEY_TRACE, type TraceKey, type TraceNode } from '../money-trace'

/**
 * Money Trace (smart.md §3), rendered as nested disclosure blocks: every node
 * is one of the hub's explanations — its value, its formula with real numbers,
 * and the screens where the rows live. Server component; native <details>, so
 * nothing crosses to the client.
 */
export function MoneyTrace({
  explanations,
  lowStock,
  currency,
  revenueGap,
}: {
  explanations: Record<MetricKey, Explanation>
  lowStock: Explanation
  currency: CurrencyCode
  /** Set when the sales report's net sales and the profit engine's revenue base differ (partial refunds). */
  revenueGap: { netSales: number; profitRevenue: number } | null
}) {
  const money = (minor: number) => formatMoney(minor, currency)
  const lookup = (key: TraceKey): Explanation => (key === 'lowStock' ? lowStock : explanations[key])
  const show = (explanation: Explanation) =>
    explanation.valueKind === 'percent'
      ? `${explanation.value}%`
      : explanation.valueKind === 'count'
        ? String(explanation.value)
        : money(explanation.value)

  const render = (node: TraceNode, depth: number) => {
    const explanation = lookup(node.key)
    return (
      <details key={node.key} open={depth === 0} className="rounded-lg border bg-card">
        <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-3 px-4 py-3 text-sm">
          <span className="min-w-0">
            <span className="font-semibold">{explanation.title}</span>
            {node.note ? <span className="ml-2 text-xs text-muted-foreground">{node.note}</span> : null}
          </span>
          <span className="font-bold tabular-nums">{show(explanation)}</span>
        </summary>
        <div className="border-t px-4 py-3 text-sm">
          <p className="text-muted-foreground">{explanation.sentence}</p>
          {explanation.lines.length > 0 ? (
            <dl className="mt-2 grid gap-1 rounded-lg bg-muted/30 p-3">
              {explanation.lines.map((line) => (
                <div key={`${line.op}${line.label}`} className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">
                    {line.op === '−' ? '− ' : line.op === '+' ? '+ ' : line.op === '=' ? '= ' : ''}
                    {line.href ? (
                      <Link href={line.href} className="text-primary underline-offset-2 hover:underline">
                        {line.label}
                      </Link>
                    ) : (
                      line.label
                    )}
                  </dt>
                  <dd className={line.op === '=' ? 'font-bold tabular-nums' : 'font-medium tabular-nums'}>
                    {money(line.amount)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            <span className="text-muted-foreground">Records:</span>
            {explanation.sources.map((source) => (
              <Link
                key={source.href}
                href={source.href}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {source.label}
              </Link>
            ))}
          </div>
          {node.children?.length ? (
            <div className="mt-3 grid gap-2 border-l-2 border-border pl-3">
              {node.children.map((child) => render(child, depth + 1))}
            </div>
          ) : null}
        </div>
      </details>
    )
  }

  return (
    <SectionCard
      title="Where the money went"
      description="Profit → revenue and cost → orders and stock → payments, purchases and recipes. Every number opens to its records."
    >
      <div className="grid gap-3">{MONEY_TRACE.map((node) => render(node, 0))}</div>
      {revenueGap ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Net sales on the sales report ({money(revenueGap.netSales)}) and the revenue base the profit engine
          works from ({money(revenueGap.profitRevenue)}) differ by{' '}
          {money(Math.abs(revenueGap.profitRevenue - revenueGap.netSales))}. That is how partial refunds are
          treated: the sales report deducts every refund; the profit engine deducts only payments refunded in
          full. Both are shown; neither is adjusted.
        </p>
      ) : null}
    </SectionCard>
  )
}
