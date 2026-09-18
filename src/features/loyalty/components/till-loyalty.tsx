'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Gift, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { redeemLoyaltyReward } from '../actions'
import type { RewardOffer } from '../service'

/**
 * Points and rewards at the till (loyalty spec).
 *
 * The cashier asks for a phone at the door already; this is what that number
 * is worth. It shows the balance on the bill in front of them and the rewards
 * that bill can take, with the ones out of reach still listed and how far off
 * they are — "300 more points" is the sentence that brings somebody back.
 *
 * The same service the guest's own screen calls, so a reward cannot be spent
 * twice by using both at once: the ledger is the guard, not this component.
 */
export function TillLoyalty({
  orderId,
  customerName,
  points,
  rewards,
  currency,
  locale,
}: {
  orderId: string
  customerName: string | null
  points: number
  rewards: RewardOffer[]
  currency: string
  locale: string
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const money = (value: number) => formatMoney(value, currency, locale)

  const redeem = async (rewardId: string) => {
    setBusy(rewardId)
    const result = await callAction(() => redeemLoyaltyReward({ orderId, rewardId }))
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${money(result.data.discount)} off · ${result.data.balance} points left`)
    router.refresh()
  }

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4 text-primary" />
          {customerName ?? 'Guest'}
        </span>
        <span className="text-sm font-bold tabular-nums text-primary">
          {points.toLocaleString()}
          <span className="ml-1 text-[11px] font-medium text-muted-foreground">pts</span>
        </span>
      </div>

      {rewards.length === 0 ? (
        <p className="text-xs text-muted-foreground">No rewards are on offer just now.</p>
      ) : (
        <ul className="space-y-1.5">
          {rewards.map((reward) => {
            const blocked = !reward.affordable || !reward.meetsMinimum
            return (
              <li key={reward.id} className="flex items-center gap-2 text-sm">
                <Gift className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {reward.name}
                  <span className="ml-1 text-xs text-muted-foreground">{money(reward.value)} off</span>
                </span>
                <Badge variant={reward.affordable ? 'success' : 'secondary'} size="sm">
                  {reward.pointsCost.toLocaleString()}
                </Badge>
                <Button
                  size="sm"
                  variant={blocked ? 'outline' : 'default'}
                  disabled={blocked || busy !== null}
                  loading={busy === reward.id}
                  onClick={() => redeem(reward.id)}
                  title={
                    !reward.affordable
                      ? `${reward.pointsNeeded} more points needed`
                      : !reward.meetsMinimum
                        ? `Needs a bill over ${money(reward.minOrderAmount)}`
                        : undefined
                  }
                >
                  Apply
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
