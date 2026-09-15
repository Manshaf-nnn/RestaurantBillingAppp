import Link from 'next/link'
import { ArrowRight, ListTodo, UserRound } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'

export interface OutstandingTask {
  id: string
  title: string
  priority: 'NORMAL' | 'URGENT'
  dueAt: string | null
  branchName: string | null
  assigneeName: string | null
  /** True when it is on the outgoing person's own plate. */
  mine: boolean
}

/**
 * What is still not done, at the moment a shift changes hands
 * (correctionA.md §11).
 *
 * ── Why this belongs on the handover screen and not only on Tasks ─────────
 *
 * §11 lists outstanding tasks among what a handover must show, and the reason
 * is the handover is the only moment anybody reliably reads them. A task
 * assigned to somebody who is about to go home either gets said out loud now
 * or gets found on Monday. Putting the list where the outgoing and incoming
 * staff are already standing together is the whole intervention — it needs no
 * workflow of its own, and giving it one would be a second task system beside
 * the one §2 just finished.
 *
 * Read-only on purpose. Marking something done belongs on Things to do, where
 * the note and the record of who finished it live; a second Done button here
 * would be a second write path to the same row.
 */
export function OutstandingTasks({ tasks }: { tasks: OutstandingTask[] }) {
  if (tasks.length === 0) return null

  return (
    <SectionCard
      title="Still to do"
      description="Open at this location right now. Say these out loud before you hand over."
      actions={
        <Link
          href="/dashboard/tasks"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          Things to do <ArrowRight className="size-3.5" />
        </Link>
      }
    >
      <ul className="divide-y">
        {tasks.map((task) => (
          <li key={task.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
            <ListTodo className="size-4 shrink-0 text-muted-foreground" />
            <span className={task.priority === 'URGENT' ? 'font-medium' : ''}>{task.title}</span>

            {task.priority === 'URGENT' ? <Badge variant="destructive">urgent</Badge> : null}

            {/*
              Whose it is, and whether that is the person leaving. "Yours"
              rather than their own name: the outgoing cashier is reading this
              on their own screen, and seeing their name back is noise where
              seeing that it is theirs is the point.
            */}
            {task.assigneeName ? (
              <Badge variant={task.mine ? 'warning' : 'outline'}>
                <UserRound />
                {task.mine ? 'Yours' : task.assigneeName}
              </Badge>
            ) : (
              <Badge variant="secondary">anyone</Badge>
            )}

            <span className="ml-auto text-xs text-muted-foreground">
              {task.branchName ? `${task.branchName} · ` : ''}
              {task.dueAt ? (
                <>
                  due <LocalDateTime value={task.dueAt} />
                </>
              ) : (
                'no date'
              )}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}
