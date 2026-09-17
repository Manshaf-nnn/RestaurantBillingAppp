'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { CreditCard, HandPlatter, Wallet } from 'lucide-react'

import { cn } from '@/lib/utils'
import { POS_TAB_LABEL, type PosTab } from '../pos-tabs'

const ICON: Record<PosTab, typeof HandPlatter> = {
  orders: HandPlatter,
  cashier: CreditCard,
  drawer: Wallet,
}

/**
 * The POS tab strip (abc.md §8). Links, not buttons: the tab is in the URL,
 * so a bookmark, a refresh and the sidebar all land on the same view, and
 * the branch the till chose (`?branch=`) travels with it.
 */
export function PosTabs({ tabs, active }: { tabs: PosTab[]; active: PosTab }) {
  const params = useSearchParams()
  const hrefFor = (tab: PosTab) => {
    const next = new URLSearchParams(params.toString())
    next.set('tab', tab)
    // The order-type deep link only means anything on the orders tab.
    if (tab !== 'orders') next.delete('type')
    next.delete('mode')
    return `/cashier/pos?${next.toString()}`
  }

  return (
    <nav aria-label="POS sections" className="inline-flex rounded-lg border bg-muted/40 p-1" data-testid="pos-tabs">
      {tabs.map((tab) => {
        const Icon = ICON[tab]
        const current = tab === active
        return (
          <Link
            key={tab}
            href={hrefFor(tab)}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              current ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            {POS_TAB_LABEL[tab]}
          </Link>
        )
      })}
    </nav>
  )
}
