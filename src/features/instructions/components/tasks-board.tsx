'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Plus, Undo2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input, Textarea } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { useAction } from '@/lib/use-action'
import {
  cancelInstructionAction,
  completeInstructionAction,
  createInstructionAction,
} from '../actions'

export interface TaskView {
  id: string
  title: string
  body: string | null
  priority: 'NORMAL' | 'URGENT'
  status: 'OPEN' | 'DONE' | 'CANCELLED'
  dueAt: string | null
  branchId: string | null
  branchName: string | null
  createdByName: string
  createdAt: string
  doneByName: string | null
  doneAt: string | null
  doneNote: string | null
}

/**
 * The owner's instructions to a location, and the manager's answer.
 *
 * One board, two readings of it. An owner sees every location and a button to
 * add; a branch manager sees only what is addressed to them and a button to
 * tick it off. Same component, because they are looking at the same list — the
 * difference is what they may do to it, and that is decided on the server.
 */
export function TasksBoard({
  initial,
  locations,
  canInstruct,
}: {
  initial: TaskView[]
  locations: Array<{ id: string; name: string }>
  /** True for an owner or group manager — the only people who may write one. */
  canInstruct: boolean
}) {
  const [tasks, setTasks] = React.useState(initial)
  const [open, setOpen] = React.useState(false)
  const [completing, setCompleting] = React.useState<TaskView | null>(null)
  const { busy, run } = useAction()
  const router = useRouter()

  React.useEffect(() => setTasks(initial), [initial])

  const [form, setForm] = React.useState({
    branchId: '',
    title: '',
    body: '',
    priority: 'NORMAL' as 'NORMAL' | 'URGENT',
    dueAt: '',
  })
  const [note, setNote] = React.useState('')

  const outstanding = tasks.filter((t) => t.status === 'OPEN')
  const settled = tasks.filter((t) => t.status !== 'OPEN')

  const send = () =>
    run(() => createInstructionAction(form), {
      success: 'Instruction sent.',
      onDone: () => {
        setOpen(false)
        setForm({ branchId: '', title: '', body: '', priority: 'NORMAL', dueAt: '' })
        router.refresh()
      },
    })

  const markDone = () => {
    if (!completing) return
    const id = completing.id
    return run(() => completeInstructionAction({ instructionId: id, note }), {
      success: 'Marked done.',
      onDone: () => {
        setCompleting(null)
        setNote('')
        router.refresh()
      },
    })
  }

  const withdraw = (id: string) =>
    run(() => cancelInstructionAction({ instructionId: id }), {
      success: 'Withdrawn.',
      onDone: () => router.refresh(),
    })

  return (
    <>
      {canInstruct ? (
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setOpen(true)}>
            <Plus /> New instruction
          </Button>
        </div>
      ) : null}

      <SectionCard
        title="Outstanding"
        description={
          canInstruct
            ? 'What you have asked each location to do, and whether they have done it.'
            : 'What the owner has asked for here. Tick one off when it is done.'
        }
      >
        {outstanding.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description={
              canInstruct
                ? 'Every location is clear. Add an instruction and the people there will be notified.'
                : 'Nothing to do right now.'
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {outstanding.map((task) => (
              <li key={task.id} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {task.priority === 'URGENT' ? (
                      <Badge variant="destructive">
                        <AlertTriangle /> Urgent
                      </Badge>
                    ) : null}
                    <span className="font-medium">{task.title}</span>
                    <Badge variant="secondary">{task.branchName ?? 'All locations'}</Badge>
                  </div>
                  {task.body ? (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {task.body}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {task.createdByName} · <LocalDateTime value={task.createdAt} />
                    {task.dueAt ? (
                      <>
                        {' · due '}
                        <LocalDateTime value={task.dueAt} />
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" disabled={busy} onClick={() => setCompleting(task)}>
                    <Check /> Done
                  </Button>
                  {canInstruct ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => withdraw(task.id)}
                      aria-label="Withdraw"
                    >
                      <Undo2 />
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {settled.length > 0 ? (
        <div className="mt-5">
          <SectionCard title="Settled" description="Done or withdrawn. Kept so there is a record.">
            <ul className="divide-y divide-border">
              {settled.map((task) => (
                <li key={task.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={task.status === 'DONE' ? 'success' : 'secondary'}>
                      {task.status === 'DONE' ? 'Done' : 'Withdrawn'}
                    </Badge>
                    <span className="text-sm font-medium">{task.title}</span>
                    <Badge variant="secondary">{task.branchName ?? 'All locations'}</Badge>
                  </div>
                  {task.status === 'DONE' ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {task.doneByName ?? 'Someone'}
                      {task.doneAt ? (
                        <>
                          {' · '}
                          <LocalDateTime value={task.doneAt} />
                        </>
                      ) : null}
                      {task.doneNote ? ` · “${task.doneNote}”` : ''}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      ) : null}

      {/* ── new instruction ─────────────────────────────────────── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New instruction</DialogTitle>
            <DialogDescription>
              The managers at that location are notified straight away, and it stays on their list
              until someone marks it done.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Location</label>
              <Select
                value={form.branchId || 'ALL'}
                onValueChange={(v) => setForm((f) => ({ ...f, branchId: v === 'ALL' ? '' : v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All locations</SelectItem>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">What needs doing</label>
              <Input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value.slice(0, 120) }))}
                placeholder="Count the cold room before Friday"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Detail (optional)</label>
              <Textarea
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value.slice(0, 1000) }))}
                placeholder="Chicken and fish especially — the last two counts did not match the ledger."
                rows={3}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">Priority</label>
                <Select
                  value={form.priority}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, priority: v as 'NORMAL' | 'URGENT' }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NORMAL">Normal</SelectItem>
                    <SelectItem value="URGENT">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Due (optional)</label>
                <Input
                  type="date"
                  value={form.dueAt}
                  onChange={(e) => setForm((f) => ({ ...f, dueAt: e.target.value }))}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={send} disabled={busy || form.title.trim().length < 3}>
              {busy ? 'Sending…' : 'Send'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── marking one done ────────────────────────────────────── */}
      <Dialog open={Boolean(completing)} onOpenChange={(v) => !v && setCompleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{completing?.title}</DialogTitle>
            <DialogDescription>
              Say what you found or did, if it is worth saying. Your name goes against it either
              way.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 300))}
            placeholder="Counted — 3kg of chicken short, wastage recorded."
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleting(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={markDone} disabled={busy}>
              {busy ? 'Saving…' : 'Mark done'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
