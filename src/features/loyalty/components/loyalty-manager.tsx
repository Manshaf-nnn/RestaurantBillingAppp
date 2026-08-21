'use client'

import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/primitives'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { updateLoyaltySettings } from '../actions'
import { callAction } from '@/lib/use-action'

export function LoyaltyManager({
  currency,
  canManage,
  initial,
}: {
  currency: string
  canManage: boolean
  initial: { enabled: boolean; earnRate: number; pointValue: number }
}) {
  const [form, setForm] = React.useState(initial)
  const [saving, setSaving] = React.useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const save = async () => {
    setSaving(true)
    const result = await callAction(() => updateLoyaltySettings(form))
    setSaving(false)
    if (result.ok) toast.success('Loyalty settings saved')
    else toast.error(result.error)
  }

  const sampleOrder = 1000
  const earned = Math.round(sampleOrder * (form.earnRate || 0))
  const worth = Math.round(earned * (form.pointValue || 0))

  return (
    <SectionCard title="Programme settings">
      <p className="text-sm text-muted-foreground">
        Reward guests with points on every order that they can redeem for money off future visits.
        Guests see this on the ordering page right after they scan your QR.
      </p>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <Switch
          checked={form.enabled}
          onCheckedChange={(v) => set('enabled', v)}
          disabled={!canManage}
        />
        Enable loyalty points
      </label>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label={`Points earned per 1 ${currency} spent`} hint="e.g. 1 point for every ₹1 on the bill">
          <Input
            type="number"
            step="0.1"
            min="0"
            value={form.earnRate}
            onChange={(e) => set('earnRate', Number(e.target.value))}
            disabled={!canManage || !form.enabled}
          />
        </Field>
        <Field label={`Value of 1 point (in ${currency})`} hint="e.g. 0.10 means 10 points = ₹1 off">
          <Input
            type="number"
            step="0.01"
            min="0"
            value={form.pointValue}
            onChange={(e) => set('pointValue', Number(e.target.value))}
            disabled={!canManage || !form.enabled}
          />
        </Field>
      </div>

      {form.enabled ? (
        <p className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Example: a {currency} 1,000 order earns{' '}
          <strong className="text-foreground">{earned.toLocaleString()} points</strong>
          {form.pointValue > 0 ? (
            <>
              {' '}— worth about{' '}
              <strong className="text-foreground">
                {currency} {worth.toLocaleString()}
              </strong>{' '}
              off a future visit.
            </>
          ) : (
            '.'
          )}
        </p>
      ) : null}

      {canManage ? (
        <Button onClick={save} loading={saving} className="mt-4">
          Save loyalty settings
        </Button>
      ) : null}
    </SectionCard>
  )
}
