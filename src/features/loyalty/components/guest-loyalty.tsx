'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Gift, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { lookupLoyalty, redeemRewardAsGuest } from '../guest-actions'
import type { RewardOffer } from '../service'

/**
 * Loyalty on the guest's own phone (loyalty spec).
 *
 * No account and no sign-up: a mobile number is the whole identity, which is
 * how the rest of the app already knows a guest. They see what they have, what
 * it is close to, and what they can have now.
 *
 * ── What they may actually spend, and where ───────────────────────────────
 *
 * Only against the bill in front of them, and only when the number they enter
 * is the one that bill was placed with. A phone number is not proof of
 * anything — knowing somebody's number must not be enough to spend their
 * points — so the order does the proving, and the server checks it again.
 */
export function GuestLoyalty({
  orderId,
  slug,
  currency,
  locale,
  /** The number on this order, when it has one, so most guests type nothing. */
  knownPhone,
}: {
  orderId: string
  slug: string
  currency: string
  locale: string
  knownPhone: string | null
}) {
  const router = useRouter()
  const [phone, setPhone] = React.useState(knownPhone ?? '')
  const [busy, setBusy] = React.useState(false)
  const [redeeming, setRedeeming] = React.useState<string | null>(null)
  const [view, setView] = React.useState<{ name: string | null; points: number; rewards: RewardOffer[] } | null>(null)

  const money = (value: number) => formatMoney(value, currency, locale)

  const look = async () => {
    if (phone.trim().length < 7) return
    setBusy(true)
    const result = await callAction(() => lookupLoyalty({ phone: phone.trim(), orderId }, slug))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setView({ name: result.data.name, points: result.data.points, rewards: result.data.rewards })
  }

  const redeem = async (rewardId: string) => {
    setRedeeming(rewardId)
    const result = await callAction(() =>
      redeemRewardAsGuest({ orderId, rewardId, phone: phone.trim() }, slug),
    )
    setRedeeming(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${money(result.data.discount)} off — ${result.data.balance} points left`)
    await look()
    router.refresh()
  }

  return (
    <section className="surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <h2 className="text-sm font-semibold">Points &amp; rewards</h2>
      </div>

      {view === null ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Enter your mobile number to see your points. No sign-up.
          </p>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label className="sr-only" htmlFor="loyalty-phone">Mobile number</Label>
              <Input
                id="loyalty-phone"
                type="tel"
                inputMode="tel"
                placeholder="07X XXX XXXX"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void look()
                }}
              />
            </div>
            <Button disabled={busy || phone.trim().length < 7} loading={busy} onClick={look}>
              Check
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm">
              {view.name ? `${view.name} — ` : ''}
              <strong className="text-lg tabular-nums text-primary">{view.points.toLocaleString()}</strong>{' '}
              <span className="text-muted-foreground">points</span>
            </p>
            <Button variant="ghost" size="sm" onClick={() => setView(null)}>Use another number</Button>
          </div>

          {view.rewards.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rewards are on offer just now. Your points keep adding up.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {view.rewards.map((reward) => {
                const blocked = !reward.affordable || !reward.meetsMinimum
                return (
                  <li key={reward.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                    <Gift className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{reward.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {money(reward.value)} off
                        {reward.minOrderAmount > 0 ? ` · bills over ${money(reward.minOrderAmount)}` : ''}
                        {reward.pointsNeeded > 0
                          ? ` · ${reward.pointsNeeded.toLocaleString()} more points to go`
                          : ''}
                        {reward.pointsNeeded === 0 && !reward.meetsMinimum
                          ? ' · your bill is not big enough yet'
                          : ''}
                      </p>
                    </div>
                    <Badge variant={reward.affordable ? 'success' : 'secondary'} size="sm">
                      {reward.pointsCost.toLocaleString()} pts
                    </Badge>
                    <Button
                      size="sm"
                      variant={blocked ? 'outline' : 'default'}
                      disabled={blocked || redeeming !== null}
                      loading={redeeming === reward.id}
                      onClick={() => redeem(reward.id)}
                    >
                      Use it
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
