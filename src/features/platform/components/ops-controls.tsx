'use client'

import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { callAction } from '@/lib/use-action'
import { newRequestKey } from '@/lib/request-key'
import {
  recordRestoreTestAction,
  resolveErrorAction,
  retryJobAction,
  revokeUserSessionsAction,
  runJobsNowAction,
  setMaintenanceAction,
  setRestaurantPlanAction,
  setUserActiveAction,
} from '@/features/platform/ops-actions'

/**
 * The operator's controls (production.md §8).
 *
 * §8 says twice to keep this simple and add nothing unnecessary, so each of
 * these is a single button or a single field, does exactly what its label says,
 * and reloads the page rather than maintaining its own view of the world. There
 * is no optimistic UI here on purpose: an operator acting during an incident
 * needs to see what the server actually did, not what the client hoped.
 */

function useRun() {
  const [busy, setBusy] = React.useState(false)
  const run = React.useCallback(
    async (call: () => Promise<{ ok: boolean; error?: string; message?: string }>, success: string) => {
      setBusy(true)
      const result = await callAction(call as never)
      setBusy(false)
      if (!result.ok) {
        toast.error(result.error)
        return false
      }
      toast.success(success)
      window.location.reload()
      return true
    },
    [],
  )
  return { busy, run }
}

export function RetryJobButton({ jobId }: { jobId: string }) {
  const { busy, run } = useRun()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => run(() => retryJobAction({ jobId }), 'Queued to run again.')}
    >
      {busy ? 'Retrying…' : 'Retry'}
    </Button>
  )
}

export function RunJobsButton() {
  const { busy, run } = useRun()
  return (
    <Button size="sm" disabled={busy} onClick={() => run(() => runJobsNowAction(), 'Queue drained.')}>
      {busy ? 'Running…' : 'Run due jobs now'}
    </Button>
  )
}

export function ResolveErrorControl({ errorId }: { errorId: string }) {
  const [note, setNote] = React.useState('')
  const { busy, run } = useRun()
  return (
    <div className="flex items-center gap-2">
      <Input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What was done about it"
        className="h-8 w-56"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy || note.trim().length < 3}
        onClick={() => run(() => resolveErrorAction({ errorId, resolution: note }), 'Marked resolved.')}
      >
        Resolve
      </Button>
    </div>
  )
}

export function UserStateControl({
  userId,
  isActive,
}: {
  userId: string
  isActive: boolean
}) {
  const { busy, run } = useRun()
  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          run(
            () => setUserActiveAction({ userId, isActive: !isActive }),
            isActive ? 'Account deactivated.' : 'Account restored.',
          )
        }
      >
        {isActive ? 'Deactivate' : 'Restore'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => run(() => revokeUserSessionsAction({ userId }), 'Sessions ended.')}
      >
        Sign out
      </Button>
    </div>
  )
}

const PLANS = ['TRIAL', 'STARTER', 'GROWTH', 'ENTERPRISE'] as const

export function PlanControl({
  restaurantId,
  plan,
}: {
  restaurantId: string
  plan: string
}) {
  const { busy, run } = useRun()
  return (
    <div className="flex flex-wrap gap-1">
      {PLANS.map((option) => (
        <Button
          key={option}
          size="sm"
          variant={option === plan ? 'default' : 'outline'}
          disabled={busy || option === plan}
          onClick={() =>
            run(
              () => setRestaurantPlanAction({ restaurantId, plan: option }),
              `Moved to ${option.toLowerCase()}.`,
            )
          }
        >
          {option.toLowerCase()}
        </Button>
      ))}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          run(
            () => setRestaurantPlanAction({ restaurantId, plan: 'TRIAL', trialDays: 14 }),
            'Trial extended by 14 days.',
          )
        }
      >
        +14 days trial
      </Button>
    </div>
  )
}

export function MaintenanceControl({
  enabled,
  message,
}: {
  enabled: boolean
  message: string
}) {
  const [text, setText] = React.useState(message)
  const { busy, run } = useRun()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="What tenants should be told"
        className="h-9 w-80"
      />
      <Button
        size="sm"
        disabled={busy}
        variant={enabled ? 'outline' : 'default'}
        onClick={() =>
          run(
            () => setMaintenanceAction({ enabled: !enabled, message: text }),
            enabled ? 'Notice taken down.' : 'Notice published.',
          )
        }
      >
        {enabled ? 'Take the notice down' : 'Show the notice'}
      </Button>
    </div>
  )
}

export function RecordRestoreTestControl() {
  const [target, setTarget] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [outcome, setOutcome] = React.useState<'PASSED' | 'FAILED' | 'PARTIAL'>('PASSED')
  const { busy, run } = useRun()
  // Not sent anywhere — it exists so a double-submit cannot record two tests.
  const key = React.useRef(newRequestKey('restore'))

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">What was restored</label>
        <Input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="e.g. neon branch restore-2026-09-04"
          className="h-9 w-72"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Result</label>
        <div className="flex gap-1">
          {(['PASSED', 'PARTIAL', 'FAILED'] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={outcome === option ? 'default' : 'outline'}
              onClick={() => setOutcome(option)}
            >
              {option.toLowerCase()}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Notes</label>
        <Input
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="What you checked"
          className="h-9 w-64"
        />
      </div>
      <Button
        size="sm"
        disabled={busy || target.trim().length === 0}
        onClick={() => {
          void key.current
          return run(
            () => recordRestoreTestAction({ target, outcome, notes }),
            'Restore test recorded.',
          )
        }}
      >
        Record
      </Button>
    </div>
  )
}
