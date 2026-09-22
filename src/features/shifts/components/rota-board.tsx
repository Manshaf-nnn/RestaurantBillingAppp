'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input, Textarea } from '@/components/ui/input'
import { ItemPicker } from '@/components/ui/item-picker'
import { Label } from '@/components/ui/label'
import { LocalTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import { assignShiftAction, cancelShiftAssignmentAction } from '../actions'
import type { RotaStaffOption, ShiftAssignmentView, ShiftTemplateView } from '../types'

/**
 * The rota (shifthandover.md §2): who works which shift, where, on which day.
 *
 * A week at a time, one column per day, every entry at every location the
 * viewer may see. The week lives in the URL (`?from=&to=`) so the export
 * below takes exactly the days on screen.
 */

const STATUS: Record<ShiftAssignmentView['status'], { label: string; variant: 'outline' | 'info' | 'success' | 'secondary' | 'destructive' }> = {
  PLANNED: { label: 'Planned', variant: 'outline' },
  STARTED: { label: 'Started', variant: 'info' },
  COMPLETED: { label: 'Done', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
}

function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

function dayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function RotaBoard({
  assignments,
  templates,
  staff,
  branches,
  from,
  to,
  today,
  canAssign,
}: {
  assignments: ShiftAssignmentView[]
  templates: ShiftTemplateView[]
  staff: RotaStaffOption[]
  branches: Array<{ id: string; name: string }>
  /** "YYYY-MM-DD", inclusive. */
  from: string
  to: string
  today: string
  canAssign: boolean
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [assigning, setAssigning] = React.useState<string | null>(null)
  const [cancelling, setCancelling] = React.useState<ShiftAssignmentView | null>(null)

  const days: string[] = []
  for (let key = from; key <= to && days.length < 14; key = addDays(key, 1)) days.push(key)

  const move = (offset: number) => {
    const next = new URLSearchParams(params.toString())
    next.set('from', addDays(from, offset))
    next.set('to', addDays(to, offset))
    router.push(`?${next.toString()}`)
  }

  const byDay = new Map<string, ShiftAssignmentView[]>()
  for (const row of assignments) {
    const list = byDay.get(row.date) ?? []
    list.push(row)
    byDay.set(row.date, list)
  }

  return (
    <SectionCard
      title="Rota"
      description={`${dayLabel(from)} – ${dayLabel(to)}`}
      actions={
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Previous week" onClick={() => move(-7)}><ChevronLeft /></Button>
          <Button variant="outline" size="icon-sm" aria-label="Next week" onClick={() => move(7)}><ChevronRight /></Button>
          {canAssign ? (
            <Button size="sm" className="ml-2" onClick={() => setAssigning(today >= from && today <= to ? today : from)}>
              <Plus /> Assign
            </Button>
          ) : null}
        </div>
      }
    >
      {templates.length === 0 ? (
        <EmptyState title="No shifts to roster" description="Define a shift template first, then put people on it." />
      ) : (
        <div className="-mx-2 overflow-x-auto px-2">
          <div className="grid min-w-[56rem] gap-2" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }} data-testid="rota">
            {days.map((day) => {
              const rows = byDay.get(day) ?? []
              return (
                <div key={day} className={`rounded-lg border p-2 ${day === today ? 'border-primary/50 bg-primary/5' : 'bg-muted/20'}`}>
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-xs font-semibold">{dayLabel(day)}</p>
                    {canAssign ? (
                      <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setAssigning(day)} aria-label={`Assign on ${day}`}>
                        +
                      </button>
                    ) : null}
                  </div>
                  {rows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">—</p>
                  ) : (
                    <ul className="space-y-1">
                      {rows.map((row) => (
                        <li key={row.id} className="rounded-md border bg-card px-2 py-1 text-xs" data-status={row.status}>
                          <p className="flex items-center gap-1 font-medium">
                            <span className="truncate">{row.userName}</span>
                            {canAssign && row.status === 'PLANNED' ? (
                              <button type="button" className="ml-auto text-muted-foreground hover:text-destructive" aria-label={`Take ${row.userName} off ${row.templateName}`} onClick={() => setCancelling(row)}>
                                <X className="size-3" />
                              </button>
                            ) : null}
                          </p>
                          <p className="text-muted-foreground">
                            {row.templateName} · <LocalTime value={row.scheduledStartAt} />–<LocalTime value={row.scheduledEndAt} />
                          </p>
                          <p className="flex items-center gap-1 text-muted-foreground">
                            {branches.length > 1 ? <span className="truncate">{row.branchName}</span> : null}
                            <Badge variant={STATUS[row.status].variant} size="sm" className="ml-auto">{STATUS[row.status].label}</Badge>
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <AssignDialog
        date={assigning}
        templates={templates.filter((t) => t.isActive)}
        staff={staff}
        branches={branches}
        onClose={() => setAssigning(null)}
      />

      <Dialog open={cancelling !== null} onOpenChange={(next) => (next ? null : setCancelling(null))}>
        <DialogContent className="sm:max-w-md">
          {cancelling ? <CancelForm row={cancelling} onClose={() => setCancelling(null)} /> : null}
        </DialogContent>
      </Dialog>
    </SectionCard>
  )
}

function AssignDialog({
  date,
  templates,
  staff,
  branches,
  onClose,
}: {
  date: string | null
  templates: ShiftTemplateView[]
  staff: RotaStaffOption[]
  branches: Array<{ id: string; name: string }>
  onClose: () => void
}) {
  const router = useRouter()
  const [day, setDay] = React.useState('')
  const [branchId, setBranchId] = React.useState('')
  const [templateId, setTemplateId] = React.useState('')
  const [userId, setUserId] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!date) return
    setDay(date)
    setBranchId(branches[0]?.id ?? '')
    setTemplateId('')
    setUserId('')
    setNotes('')
  }, [date, branches])

  const template = templates.find((t) => t.id === templateId) ?? null
  const usableTemplates = templates.filter((t) => t.branchId === null || t.branchId === branchId)
  // Only people the shift is for, at this site. The server checks again.
  const candidates = staff.filter(
    (s) => (template ? template.roles.includes(s.role) : true) && (s.branchId === null || s.branchId === branchId),
  )
  const valid = Boolean(day && branchId && templateId && userId)

  const save = async () => {
    if (!valid) return
    setBusy(true)
    const result = await callAction(() => assignShiftAction({ userId, templateId, branchId, date: day, notes }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Rostered.')
    onClose()
    router.refresh()
  }

  return (
    <Dialog open={date !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Put somebody on a shift</DialogTitle>
          <DialogDescription>Only people whose role the shift is for, at that location, are offered.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="as-date">Day</Label>
              <Input id="as-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="as-branch">Location</Label>
              <select id="as-branch" className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm" value={branchId} onChange={(e) => { setBranchId(e.target.value); setUserId('') }}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="as-template">Shift</Label>
            <select id="as-template" className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setUserId('') }}>
              <option value="">Choose a shift…</option>
              {usableTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name} · {t.startTime}–{t.endTime}{t.overnight ? ' (next day)' : ''}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Staff</Label>
            <ItemPicker
              options={candidates.map((s) => ({ value: s.id, label: s.name, hint: s.roleLabel }))}
              value={userId}
              onChange={setUserId}
              placeholder={template ? 'Choose who is working…' : 'Pick a shift first'}
              searchPlaceholder="Search by name…"
              disabled={!template}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="as-notes">Notes (optional)</Label>
            <Textarea id="as-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 300))} placeholder="e.g. covering for Priya" />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !valid} loading={busy} onClick={save}>Roster</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CancelForm({ row, onClose }: { row: ShiftAssignmentView; onClose: () => void }) {
  const router = useRouter()
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    if (reason.trim().length < 2) return
    setBusy(true)
    const result = await callAction(() => cancelShiftAssignmentAction({ assignmentId: row.id, reason: reason.trim() }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Taken off the rota.')
    onClose()
    router.refresh()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Take {row.userName} off {row.templateName}?</DialogTitle>
        <DialogDescription>{row.date} at {row.branchName}. The entry stays in the history as cancelled, with your reason.</DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="as-cancel">Why</Label>
        <Input id="as-cancel" autoFocus value={reason} onChange={(e) => setReason(e.target.value.slice(0, 300))} placeholder="e.g. called in sick" />
      </div>
      <div className="flex justify-end gap-2 border-t pt-3">
        <Button variant="ghost" disabled={busy} onClick={onClose}>Keep</Button>
        <Button variant="destructive" disabled={busy || reason.trim().length < 2} loading={busy} onClick={submit}>Take off the rota</Button>
      </div>
    </>
  )
}
