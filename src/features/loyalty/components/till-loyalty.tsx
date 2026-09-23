'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Gift, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { redeemLoyaltyPoints, redeemLoyaltyReward } from '../actions'
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
  pointValue = 0,
  /** What is left on the bill for points to take off, in minor units. */
  room = 0,
}: {
  orderId: string
  customerName: string | null
  points: number
  rewards: RewardOffer[]
  currency: string
  locale: string
  /**
   * What one point is worth (pro.A.md §10). Zero, or absent, hides the
   * spend-points box — a restaurant that has not set a rate cannot honour one.
   */
  pointValue?: number
  room?: number
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [wanted, setWanted] = React.useState('')
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

  /*
   * Points, not only rewards (pro.A.md §10).
   *
   * A reward is a named offer and the right thing to show a guest. It is the
   * wrong thing to show a cashier whose customer has 1,340 points and says
   * "take some off" — and a restaurant with no rewards written had a loyalty
   * programme nobody could spend from at the counter at all.
   */
  const affordableByBill = pointValue > 0 ? Math.floor(Math.max(0, room) / pointValue) : 0
  const maxPoints = Math.min(points, affordableByBill)
  const asked = Math.max(0, Math.floor(Number(wanted) || 0))

  const spendPoints = async () => {
    const take = Math.min(asked, maxPoints)
    if (take <= 0) return
    setBusy('points')
    const result = await callAction(() => redeemLoyaltyPoints({ orderId, points: take }))
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setWanted('')
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

      {pointValue > 0 && points > 0 ? (
        <div className="mb-2 space-y-1 border-b border-border pb-2">
          {maxPoints <= 0 ? (
            <p className="text-xs text-muted-foreground">
              This bill is already covered — no more points can come off it.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={maxPoints}
                  className="h-8"
                  placeholder="Points"
                  value={wanted}
                  onChange={(event) => setWanted(event.target.value)}
                  aria-label="Points to use"
                />
                <Button size="sm" variant="outline" onClick={() => setWanted(String(maxPoints))}>
                  Max
                </Button>
                <Button
                  size="sm"
                  disabled={asked <= 0 || busy !== null}
                  loading={busy === 'points'}
                  onClick={spendPoints}
                >
                  Use
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {asked > 0
                  ? `Takes ${money(Math.min(asked, maxPoints) * pointValue)} off this bill.`
                  : `Up to ${maxPoints.toLocaleString()} points here · ${money(maxPoints * pointValue)}`}
              </p>
            </>
          )}
        </div>
      ) : null}

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
