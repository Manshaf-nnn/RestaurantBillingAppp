'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { saveLoyaltyReward } from '../actions'

export interface RewardRow {
  id: string
  name: string
  description: string | null
  pointsCost: number
  value: number
  minOrderAmount: number
  expiresAt: string | null
  isActive: boolean
}

/**
 * The rewards catalogue (loyalty).
 *
 * Points on their own are a number. A reward is the thing a guest recognises
 * and comes back for, so this is where an owner writes them: what it costs,
 * what it is worth, the smallest bill it may be used on, and when it stops.
 *
 * Nothing is ever deleted — a reward somebody has already redeemed is part of
 * their history. Retiring one takes it off the guest's list and leaves the
 * record readable.
 */
export function RewardsManager({
  rewards,
  currency,
  locale,
  canManage,
}: {
  rewards: RewardRow[]
  currency: string
  locale: string
  canManage: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = React.useState<RewardRow | null>(null)
  const [open, setOpen] = React.useState(false)
  const money = (value: number) => formatMoney(value, currency, locale)

  const start = (reward: RewardRow | null) => {
    setEditing(reward)
    setOpen(true)
  }

  return (
    <SectionCard
      title="Rewards"
      description="What guests can spend their points on."
      actions={
        canManage ? (
          <Button size="sm" onClick={() => start(null)}>
            <Plus /> New reward
          </Button>
        ) : null
      }
    >
      {rewards.length === 0 ? (
        <EmptyState
          className="border-dashed py-8"
          title="No rewards yet"
          description="Add one and it appears on the till and on the guest's phone, with how many points it costs."
        />
      ) : (
        <ul className="divide-y">
          {rewards.map((reward) => (
            <li key={reward.id} className="flex flex-wrap items-center gap-3 py-2.5" data-active={reward.isActive}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {reward.name}
                  {!reward.isActive ? <Badge variant="secondary" size="sm">retired</Badge> : null}
                  {reward.expiresAt && new Date(reward.expiresAt) <= new Date() ? (
                    <Badge variant="destructive" size="sm">expired</Badge>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {reward.description ? `${reward.description} · ` : ''}
                  {money(reward.value)} off
                  {reward.minOrderAmount > 0 ? ` · on bills over ${money(reward.minOrderAmount)}` : ''}
                  {reward.expiresAt ? <> · until <LocalDateTime value={reward.expiresAt} /></> : ''}
                </p>
              </div>
              <span className="shrink-0 text-sm font-bold tabular-nums text-primary">
                {reward.pointsCost.toLocaleString()}
                <span className="ml-1 text-[11px] font-medium text-muted-foreground">pts</span>
              </span>
              {canManage ? (
                <Button variant="ghost" size="icon-sm" aria-label={`Edit ${reward.name}`} onClick={() => start(reward)}>
                  <Pencil />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <RewardDialog
        key={editing?.id ?? 'new'}
        open={open}
        reward={editing}
        currency={currency}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setOpen(false)
          router.refresh()
        }}
      />
    </SectionCard>
  )
}

function RewardDialog({
  open,
  reward,
  currency,
  onClose,
  onSaved,
}: {
  open: boolean
  reward: RewardRow | null
  currency: string
  onClose: () => void
  onSaved: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [name, setName] = React.useState(reward?.name ?? '')
  const [description, setDescription] = React.useState(reward?.description ?? '')
  const [pointsCost, setPointsCost] = React.useState(String(reward?.pointsCost ?? ''))
  const [value, setValue] = React.useState(reward ? String(reward.value / 100) : '')
  const [minOrder, setMinOrder] = React.useState(reward ? String(reward.minOrderAmount / 100) : '0')
  const [expiresAt, setExpiresAt] = React.useState(reward?.expiresAt?.slice(0, 10) ?? '')
  const [isActive, setIsActive] = React.useState(reward?.isActive ?? true)

  const ready = name.trim().length >= 2 && Number(pointsCost) > 0 && Number(value) >= 0

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    const result = await callAction(() =>
      saveLoyaltyReward({
        id: reward?.id,
        name: name.trim(),
        description: description.trim() || undefined,
        pointsCost: Number(pointsCost),
        value: Number(value),
        minOrderAmount: Number(minOrder) || 0,
        expiresAt: expiresAt || undefined,
        isActive,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(reward ? 'Reward updated' : 'Reward added')
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{reward ? 'Edit reward' : 'New reward'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="reward-name">What is it</Label>
            <Input id="reward-name" value={name} maxLength={80} placeholder="A free dessert"
              onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="reward-desc">Description (optional)</Label>
            <Input id="reward-desc" value={description} maxLength={200}
              placeholder="Any dessert from the menu"
              onChange={(event) => setDescription(event.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="reward-points">Costs (points)</Label>
              <Input id="reward-points" type="number" min={1} step="1" value={pointsCost}
                onChange={(event) => setPointsCost(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="reward-value">Worth ({currency})</Label>
              <Input id="reward-value" type="number" min={0} step="any" value={value}
                onChange={(event) => setValue(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="reward-min">Minimum bill ({currency})</Label>
              <Input id="reward-min" type="number" min={0} step="any" value={minOrder}
                onChange={(event) => setMinOrder(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="reward-expiry">Offered until (optional)</Label>
              <Input id="reward-expiry" type="date" value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
            Offered to guests
          </label>
          <p className="text-xs text-muted-foreground">
            Retiring a reward takes it off the till and the guest&rsquo;s phone. It is never deleted — somebody
            has already spent points on it.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button disabled={busy || !ready} loading={busy} onClick={submit}>
              {reward ? 'Save' : 'Add reward'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
