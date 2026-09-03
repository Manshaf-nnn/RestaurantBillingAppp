'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { callAction } from '@/lib/use-action'
import { setFoodCostTargetAction } from '../actions'

/**
 * The one expected figure the system stores (acCal.md §8): what the owner
 * thinks food should cost. Everything else compares against last period,
 * because a target nobody set is not a fact.
 */
export function FoodCostTarget({ targetBps, canEdit }: { targetBps: number | null; canEdit: boolean }) {
  const router = useRouter()
  const [value, setValue] = React.useState(targetBps === null ? '' : String(targetBps / 100))
  const [pending, setPending] = React.useState(false)

  if (!canEdit) {
    return (
      <p className="text-xs text-muted-foreground">
        {targetBps === null
          ? 'No food-cost target set.'
          : `Target food cost: ${(targetBps / 100).toFixed(1)}%.`}
      </p>
    )
  }

  const save = async () => {
    setPending(true)
    const result = await callAction(() => setFoodCostTargetAction({ percent: value.trim() }))
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(value.trim() === '' ? 'Target cleared.' : 'Target saved.')
    router.refresh()
  }

  return (
    <span className="flex items-center gap-2">
      <label className="text-xs text-muted-foreground" htmlFor="food-cost-target">
        Target food cost
      </label>
      <Input
        id="food-cost-target"
        inputMode="decimal"
        value={value}
        placeholder="e.g. 30"
        onChange={(event) => setValue(event.target.value)}
        className="w-24 tabular-nums"
      />
      <span className="text-xs text-muted-foreground">%</span>
      <Button size="sm" variant="outline" loading={pending} onClick={save}>
        Save
      </Button>
    </span>
  )
}
