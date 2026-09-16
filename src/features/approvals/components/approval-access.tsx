'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, UserRound, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { ItemPicker } from '@/components/ui/item-picker'
import { callAction } from '@/lib/use-action'
import { setApprovalAccessAction } from '../actions'

export interface ApprovalAccessRow {
  /** Empty string is the restaurant-wide queue. */
  branchId: string
  branchName: string
  approvers: Array<{ id: string; name: string }>
}

/**
 * Who may sign off requests, per location (correctionA.md §9).
 *
 * ── An empty list is not "nobody" ──────────────────────────────────────────
 *
 * The screen says so, in as many words, because the opposite reading is the
 * dangerous one: an owner who believes an empty list locks the queue will
 * leave it empty and think they have configured something. Empty means the
 * permission alone decides, which is how every restaurant works before
 * anybody opens this card, and it is what keeps turning the feature on from
 * being an outage.
 *
 * ── Names, not a permission per branch ─────────────────────────────────────
 *
 * This is routing, not authority: `approvals.view` still says who may work
 * the queue at all, and the server refuses to add anybody who does not hold
 * it — a location whose approver list names people who cannot open the queue
 * is a location whose requests nobody can clear, and it would look like a bug
 * in approvals rather than a mistake made here.
 */
export function ApprovalAccess({
  rows,
  staff,
}: {
  rows: ApprovalAccessRow[]
  /** Everybody who can open the queue — the server checks this again. */
  staff: Array<{ id: string; name: string; roleLabel: string; branchName: string | null }>
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState<Record<string, string>>({})

  const save = async (row: ApprovalAccessRow, approverIds: string[]) => {
    setBusy(row.branchId)
    const result = await callAction(() =>
      setApprovalAccessAction({ branchId: row.branchId, approverIds }),
    )
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Approvers saved')
    router.refresh()
  }

  return (
    <SectionCard
      title="Who may approve"
      description="Pick the people whose decision counts at each location. Leave a location empty and anyone who can open this screen may decide there."
    >
      <ul className="divide-y">
        {rows.map((row) => {
          const ids = row.approvers.map((a) => a.id)
          const candidates = staff.filter((s) => !ids.includes(s.id))
          return (
            <li key={row.branchId || '__all__'} className="py-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.branchName}</span>
                {row.approvers.length === 0 ? (
                  <Badge variant="secondary">anyone with access</Badge>
                ) : (
                  <Badge variant="success">
                    {row.approvers.length} named
                  </Badge>
                )}
              </div>

              {row.approvers.length > 0 ? (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {row.approvers.map((person) => (
                    <span
                      key={person.id}
                      className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2 pr-1 text-xs"
                    >
                      <UserRound className="size-3" />
                      {person.name}
                      <button
                        type="button"
                        disabled={busy === row.branchId}
                        aria-label={`Remove ${person.name} as an approver for ${row.branchName}`}
                        onClick={() => save(row, ids.filter((id) => id !== person.id))}
                        className="rounded-full p-0.5 hover:bg-muted"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-56 flex-1">
                  <ItemPicker
                    options={candidates.map((s) => ({
                      value: s.id,
                      label: s.name,
                      // Name, role, location (recorrection.md §4) — one convention for every people picker.
                      hint: `${s.roleLabel} — ${s.branchName ?? 'no location set'}`,
                    }))}
                    value={adding[row.branchId] ?? ''}
                    onChange={(v) => setAdding((c) => ({ ...c, [row.branchId]: v }))}
                    placeholder="Add an approver…"
                    searchPlaceholder="Search staff…"
                    emptyMessage="Everybody who can open this screen is already named."
                    disabled={busy === row.branchId || candidates.length === 0}
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === row.branchId || !adding[row.branchId]}
                  onClick={() => {
                    const pick = adding[row.branchId]
                    if (!pick) return
                    setAdding((c) => ({ ...c, [row.branchId]: '' }))
                    void save(row, [...ids, pick])
                  }}
                >
                  <Check /> Add
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </SectionCard>
  )
}
