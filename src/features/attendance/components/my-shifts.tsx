import 'server-only'

import { SectionCard } from '@/features/dashboard/components/page-header'
import { LocalDateTime } from '@/components/local-time'
import { effectiveShift } from '../service'
import { prisma } from '@/server/db/prisma'

/**
 * Your own hours.
 *
 * ── Why it is here and not on the branch page ───────────────────────────────
 *
 * The branch staff screen is guarded on `staff.view`, which a cashier and a
 * waiter do not hold — and should not, since it lists everybody. But their own
 * hours are theirs, and the whole point of recording attendance from a sign-in
 * is that the person signing in can check it.
 *
 * So the rule here is identity, not authority: this reads `user.id` and nothing
 * else can be asked for. There is no permission to grant, and none to forget to
 * revoke.
 */
export async function MyShifts({ userId }: { userId: string }) {
  const shifts = await prisma.staffShift.findMany({
    where: { userId },
    orderBy: { clockInAt: 'desc' },
    take: 14,
    include: { branch: { select: { name: true } } },
  })

  if (shifts.length === 0) {
    return (
      <SectionCard title="My shifts" description="Recorded from when you sign in.">
        <p className="py-6 text-center text-sm text-muted-foreground">
          Nothing recorded yet. Signing in starts a shift; it ends at the last
          thing you do.
        </p>
      </SectionCard>
    )
  }

  const now = new Date()
  const rows = shifts.map((shift) => ({
    shift,
    eff: effectiveShift(shift, now),
  }))
  const total = rows.reduce((sum, r) => (r.eff.idleOnly ? sum : sum + r.eff.minutes), 0)

  return (
    <SectionCard
      title="My shifts"
      description="Your last fourteen. A shift starts when you sign in and ends at the last thing you did."
      actions={
        <span className="text-sm tabular-nums text-muted-foreground">
          {Math.floor(total / 60)}h {total % 60}m
        </span>
      }
    >
      <ul className="divide-y divide-border">
        {rows.map(({ shift, eff }) => (
          <li key={shift.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
            <span className="font-medium">{shift.branch.name}</span>
            <span className="text-muted-foreground">
              <LocalDateTime value={eff.startedAt.toISOString()} />
              {' → '}
              {eff.endedAt ? (
                <LocalDateTime value={eff.endedAt.toISOString()} />
              ) : (
                'still working'
              )}
            </span>
            <span className="ml-auto tabular-nums">
              {eff.idleOnly ? (
                <span className="text-xs text-muted-foreground">signed in, no activity</span>
              ) : (
                `${Math.floor(eff.minutes / 60)}h ${eff.minutes % 60}m`
              )}
            </span>
            {eff.corrected ? (
              <span
                className="w-full text-xs text-muted-foreground"
                title={shift.adjustReason ?? undefined}
              >
                Corrected by a manager
                {shift.adjustReason ? ` — ${shift.adjustReason}` : ''}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        If any of these look wrong, ask your manager — they can correct them, and
        what was originally recorded is kept either way.
      </p>
    </SectionCard>
  )
}
