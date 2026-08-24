import type { Metadata } from 'next'

import { AutoRefresh } from '@/components/auto-refresh'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { SystemFeedback } from '@/features/feedback/components/guest-feedback'
import { getFeedbackOverview } from '@/features/feedback/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Feedback' }

const FACE: Record<number, string> = { 1: '😞', 2: '😐', 3: '🙂', 4: '😍' }
const LABEL: Record<number, string> = { 1: 'Bad', 2: 'Okay', 3: 'Good', 4: 'Great' }

export default async function FeedbackPage() {
  const user = await requirePagePermission(PERMISSIONS.FEEDBACK_VIEW, '/dashboard/feedback')
  const data = await getFeedbackOverview(user.restaurantId)

  return (
    <>
      <AutoRefresh intervalMs={15000} />
      <PageHeader
        title="Feedback"
        description="Quick, anonymous guest feedback — no personal details, so guests actually leave it."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Responses" value={data.total.toLocaleString()} />
        <StatCard label="Happy guests" value={`${data.happyPct}%`} />
        <StatCard label="Average" value={data.total ? `${data.average.toFixed(1)} / 4` : '—'} />
      </div>

      <div className="mt-4">
        <SystemFeedback title="How was the system?" subtitle="Quick owner feedback for the platform" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <SectionCard title="How guests feel">
            {data.total === 0 ? (
              <EmptyState
                className="border-dashed py-8"
                title="No feedback yet"
                description="Guests can rate their visit from the order screen — it appears here."
              />
            ) : (
              <ul className="space-y-3">
                {[4, 3, 2, 1].map((r) => {
                  const count = data.counts[r as 1 | 2 | 3 | 4]
                  const pct = data.total ? Math.round((count / data.total) * 100) : 0
                  return (
                    <li key={r} className="flex items-center gap-3">
                      <span className="w-16 text-sm">
                        {FACE[r]} <span className="text-muted-foreground">{LABEL[r]}</span>
                      </span>
                      <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      <span className="w-10 text-right text-sm font-semibold tabular-nums">{count}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </SectionCard>
        </div>

        <div className="lg:col-span-3">
          <SectionCard title="Recent comments">
            {data.recent.length === 0 ? (
              <EmptyState
                className="border-dashed py-8"
                title="No comments yet"
                description="When guests leave a note with their rating, you'll see it here."
              />
            ) : (
              <ul className="divide-y">
                {data.recent.map((f) => (
                  <li key={f.id} className="flex items-start gap-3 py-2.5">
                    <span className="text-xl">{FACE[f.rating] ?? '💬'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{f.comment}</p>
                      <p className="text-xs text-muted-foreground">
                        {f.tableNumber ? `Table ${f.tableNumber} · ` : ''}
                        {new Date(f.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    </>
  )
}
