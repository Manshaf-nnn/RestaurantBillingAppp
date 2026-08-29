'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Check, Clock, Flame, Play, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { updateItemStatus } from '@/features/orders/actions'
import type { StationTicketItem } from '../queries'

const COLUMNS = [
  { key: 'QUEUED', title: 'To cook', tone: 'text-muted-foreground' },
  { key: 'PREPARING', title: 'Cooking', tone: 'text-warning' },
  { key: 'READY', title: 'Ready', tone: 'text-success' },
] as const

/**
 * A single section's rail.
 *
 * ── What it deliberately does not show ──────────────────────────────────────
 *
 * Only this section's dishes, and nothing about the rest of the order. A pizza
 * cook does not need the table's drinks, and §6 forbids putting them here.
 * There is no money on this screen either — a kitchen has no use for a bill.
 *
 * ── Where a card stops ──────────────────────────────────────────────────────
 *
 * Cooks take a dish to READY and no further. SERVED belongs to whoever carries
 * it out, which is the waiter's screen. Keeping the two apart is the point of
 * §7: a cook tapping through to "served" would tell the floor food had been
 * delivered while it sat on the pass.
 */
export function StationBoard({
  stationId,
  stationName,
  items,
  siblings,
}: {
  stationId: string
  stationName: string
  items: StationTicketItem[]
  siblings: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const [pendingId, setPendingId] = React.useState<string | null>(null)

  /*
   * One clock for the whole board, ticking locally.
   *
   * Elapsed times are worked out here rather than on the server, or every
   * "waiting 6m" would freeze until the next poll while the digits beside it
   * carried on.
   */
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const move = async (item: StationTicketItem, status: 'PREPARING' | 'READY') => {
    setPendingId(item.id)
    const result = await callAction(() =>
      updateItemStatus({ orderId: item.orderId, itemId: item.id, status }),
    )
    setPendingId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    router.refresh()
  }

  const minutesSince = (iso: string | null) =>
    iso === null ? null : Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000))

  const byStatus = (status: string) => items.filter((item) => item.status === status)

  return (
    <div className="p-3 sm:p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link
          href="/kitchen"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Kitchen
        </Link>
        <h1 className="text-xl font-bold tracking-tight">{stationName}</h1>
        <Badge variant="secondary">{items.length} on</Badge>

        {/* Only sections this cook may stand at, so the tabs cannot be a map
            of what they are not allowed to open. */}
        {siblings.length > 1 ? (
          <nav className="ml-auto flex flex-wrap gap-1.5">
            {siblings.map((sibling) => (
              <Link
                key={sibling.id}
                href={`/kitchen/${sibling.id}`}
                className={cn(
                  'rounded-lg px-2.5 py-1.5 text-sm',
                  sibling.id === stationId
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border text-muted-foreground hover:bg-muted',
                )}
              >
                {sibling.name}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {COLUMNS.map((column) => {
          const cards = byStatus(column.key)
          return (
            <section key={column.key} className="min-w-0">
              <h2 className={cn('mb-2 text-sm font-semibold uppercase tracking-wide', column.tone)}>
                {column.title}
                <span className="ml-1.5 tabular-nums">{cards.length}</span>
              </h2>

              {cards.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                  Nothing here
                </p>
              ) : (
                <ul className="space-y-2">
                  {cards.map((item) => {
                    const waited =
                      column.key === 'PREPARING'
                        ? minutesSince(item.preparingAt)
                        : minutesSince(item.routedAt)
                    const urgent = item.priority !== 'NORMAL'

                    return (
                      <li
                        key={item.id}
                        className={cn(
                          'rounded-xl border-2 bg-card p-3',
                          urgent ? 'border-destructive' : 'border-border',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-bold text-primary">
                                {item.quantity}
                              </span>
                              {item.name}
                            </p>
                            {item.optionsLabel ? (
                              <p className="mt-1 text-xs text-muted-foreground">{item.optionsLabel}</p>
                            ) : null}
                            {item.notes ? (
                              <p className="mt-1 text-xs font-medium text-warning">{item.notes}</p>
                            ) : null}
                          </div>
                          <span className="shrink-0 text-right">
                            <span className="block font-mono text-xs font-semibold tabular-nums">
                              #{item.orderNumber}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {item.tableNumber
                                ? `Table ${item.tableNumber}`
                                : item.orderType.replace(/_/g, ' ').toLowerCase()}
                            </span>
                          </span>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {urgent ? (
                            <Badge variant="destructive">
                              <Flame className="mr-1 size-3" />
                              {item.priority.toLowerCase()}
                            </Badge>
                          ) : null}
                          {/* §10: a later round at a table that already has
                              food, so the kitchen can see it is an add-on
                              rather than a ticket it has somehow missed. */}
                          {item.isAddition ? (
                            <Badge variant="secondary">
                              <Sparkles className="mr-1 size-3" />
                              added later
                            </Badge>
                          ) : null}
                          {waited !== null ? (
                            <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                              <Clock className="size-3" />
                              {waited}m
                            </span>
                          ) : null}

                          {column.key === 'QUEUED' ? (
                            <Button
                              size="sm"
                              className="ml-auto"
                              loading={pendingId === item.id}
                              onClick={() => move(item, 'PREPARING')}
                            >
                              <Play className="mr-1.5 size-4" />
                              Start
                            </Button>
                          ) : null}
                          {column.key === 'PREPARING' ? (
                            <Button
                              size="sm"
                              variant="success"
                              className="ml-auto"
                              loading={pendingId === item.id}
                              onClick={() => move(item, 'READY')}
                            >
                              <Check className="mr-1.5 size-4" />
                              Ready
                            </Button>
                          ) : null}
                          {column.key === 'READY' ? (
                            <span className="ml-auto text-xs text-muted-foreground">
                              waiting for the floor
                            </span>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
