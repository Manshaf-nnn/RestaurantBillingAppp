'use client'

import * as React from 'react'
import type { RestaurantStatus } from '@prisma/client'
import {
  Building2,
  Check,
  CircleSlash,
  Clock,
  ExternalLink,
  Play,
  Search,
  Store,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge, type BadgeProps } from '@/components/ui/badge'
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
import { Field } from '@/components/ui/label'
import { Input, Textarea } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatCard } from '@/features/dashboard/components/page-header'
import type { PlatformFeedbackItem, PlatformRestaurant, PlatformStats } from '../queries'
import { callAction } from '@/lib/use-action'
import {
  approveRestaurant,
  reactivateRestaurant,
  rejectRestaurant,
  suspendRestaurant,
} from '../actions'

const STATUS_META: Record<RestaurantStatus, { label: string; variant: NonNullable<BadgeProps['variant']> }> = {
  PENDING: { label: 'Pending', variant: 'warning' },
  ACTIVE: { label: 'Active', variant: 'success' },
  SUSPENDED: { label: 'Suspended', variant: 'destructive' },
  REJECTED: { label: 'Rejected', variant: 'secondary' },
}

const FILTERS: Array<{ key: 'ALL' | RestaurantStatus; label: string }> = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'SUSPENDED', label: 'Suspended' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'ALL', label: 'All' },
]

export function PlatformConsole({
  restaurants: initial,
  stats,
  recentFeedback,
  appUrl,
}: {
  restaurants: PlatformRestaurant[]
  stats: PlatformStats
  recentFeedback: PlatformFeedbackItem[]
  appUrl: string
}) {
  const [restaurants, setRestaurants] = React.useState(initial)
  const [filter, setFilter] = React.useState<'ALL' | RestaurantStatus>(
    stats.pending > 0 ? 'PENDING' : 'ACTIVE',
  )
  const [search, setSearch] = React.useState('')
  const [rejectFor, setRejectFor] = React.useState<PlatformRestaurant | null>(null)
  const [suspendFor, setSuspendFor] = React.useState<PlatformRestaurant | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  React.useEffect(() => setRestaurants(initial), [initial])

  const patch = (id: string, status: RestaurantStatus) =>
    setRestaurants((current) => current.map((r) => (r.id === id ? { ...r, status } : r)))

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    return restaurants.filter((restaurant) => {
      if (filter !== 'ALL' && restaurant.status !== filter) return false
      if (!query) return true
      return (
        restaurant.name.toLowerCase().includes(query) ||
        restaurant.ownerEmail?.toLowerCase().includes(query) ||
        restaurant.ownerName?.toLowerCase().includes(query) ||
        restaurant.slug.includes(query)
      )
    })
  }, [restaurants, filter, search])

  const trialExpired = (restaurant: PlatformRestaurant) =>
    restaurant.plan === 'TRIAL' && restaurant.trialEndsAt !== null && new Date(restaurant.trialEndsAt).getTime() < Date.now()

  const approve = async (restaurant: PlatformRestaurant) => {
    setBusyId(restaurant.id)
    const result = await callAction(() => approveRestaurant({ restaurantId: restaurant.id }))
    setBusyId(null)
    if (result.ok) {
      patch(restaurant.id, 'ACTIVE')
      toast.success(`${restaurant.name} approved`)
    } else toast.error(result.error)
  }

  const reactivate = async (restaurant: PlatformRestaurant) => {
    setBusyId(restaurant.id)
    const result = await callAction(() => reactivateRestaurant({ restaurantId: restaurant.id }))
    setBusyId(null)
    if (result.ok) {
      patch(restaurant.id, 'ACTIVE')
      toast.success(`${restaurant.name} reactivated`)
    } else toast.error(result.error)
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Restaurants" value={stats.total} icon={<Store />} />
        <StatCard label="Pending approval" value={stats.pending} icon={<Clock />} tone={stats.pending ? 'warning' : 'default'} />
        <StatCard label="Active" value={stats.active} icon={<Check />} tone="success" />
        <StatCard label="Total orders" value={stats.totalOrders} icon={<Users />} tone="primary" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={filter} onValueChange={(value) => setFilter(value as typeof filter)}>
          <TabsList>
            {FILTERS.map((entry) => (
              <TabsTrigger key={entry.key} value={entry.key}>
                {entry.label}
                {entry.key === 'PENDING' && stats.pending > 0 ? (
                  <Badge variant="warning" size="sm">
                    {stats.pending}
                  </Badge>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search restaurants or owners…"
          startIcon={<Search />}
          className="max-w-xs"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title={filter === 'PENDING' ? 'No pending registrations' : 'Nothing here'}
          description={
            filter === 'PENDING'
              ? 'New restaurant sign-ups will appear here for your approval.'
              : 'No restaurants match this filter.'
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {filtered.map((restaurant) => (
            <article key={restaurant.id} className="rounded-xl border bg-card p-5 shadow-soft">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-base font-semibold">{restaurant.name}</h3>
                    <Badge variant={STATUS_META[restaurant.status].variant}>
                      {STATUS_META[restaurant.status].label}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    /{restaurant.slug} · {restaurant.currency}
                    {restaurant.city ? ` · ${restaurant.city}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(restaurant.createdAt).toLocaleDateString()}
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Owner</dt>
                  <dd className="truncate font-medium">{restaurant.ownerName ?? '—'}</dd>
                  <dd className="truncate text-xs text-muted-foreground">{restaurant.ownerEmail}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Activity</dt>
                  <dd className="font-medium">{restaurant.staffCount} staff</dd>
                  <dd className="text-xs text-muted-foreground">{restaurant.orderCount} orders</dd>
                </div>
              </dl>

              {restaurant.rejectionReason ? (
                <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Rejected: {restaurant.rejectionReason}
                </p>
              ) : null}

              {trialExpired(restaurant) ? (
                <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
                  Trial expired — access is blocked until admin reactivates it.
                </p>
              ) : null}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {restaurant.status === 'PENDING' ? (
                  <>
                    <Button size="sm" loading={busyId === restaurant.id} onClick={() => approve(restaurant)}>
                      <Check /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      onClick={() => setRejectFor(restaurant)}
                    >
                      <X /> Reject
                    </Button>
                  </>
                ) : null}

                {restaurant.status === 'ACTIVE' ? (
                  <>
                    <Button size="sm" variant="outline" asChild>
                      <a href={`${appUrl}/order?r=${restaurant.slug}`} target="_blank" rel="noreferrer">
                        <ExternalLink /> Guest menu
                      </a>
                    </Button>
                    {trialExpired(restaurant) ? (
                      <Button size="sm" loading={busyId === restaurant.id} onClick={() => reactivate(restaurant)}>
                        <Play /> Reactivate
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      onClick={() => setSuspendFor(restaurant)}
                    >
                      <CircleSlash /> Suspend
                    </Button>
                  </>
                ) : null}

                {restaurant.status === 'SUSPENDED' || restaurant.status === 'REJECTED' ? (
                  <Button size="sm" loading={busyId === restaurant.id} onClick={() => reactivate(restaurant)}>
                    <Play /> {restaurant.status === 'REJECTED' ? 'Approve now' : 'Reactivate'}
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="rounded-xl border bg-card p-5 shadow-soft">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">Recent feedback</h3>
          <span className="text-xs text-muted-foreground">{recentFeedback.length} items</span>
        </div>

        {recentFeedback.length === 0 ? (
          <p className="text-sm text-muted-foreground">No guest or owner feedback has been submitted yet.</p>
        ) : (
          <ul className="space-y-3">
            {recentFeedback.map((entry) => (
              <li key={entry.id} className="rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{entry.restaurantName}</p>
                    <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                      {entry.category === 'SYSTEM' ? 'System' : 'Food'}
                    </p>
                  </div>
                  <span className="text-lg">{['😞', '😐', '🙂', '😍'][entry.rating - 1] ?? '💬'}</span>
                </div>
                <p className="mt-2 text-sm text-foreground">{entry.comment || 'No extra note provided.'}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleDateString()} · /{entry.restaurantSlug}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <RejectDialog
        restaurant={rejectFor}
        onClose={() => setRejectFor(null)}
        onDone={(id) => patch(id, 'REJECTED')}
      />

      <ConfirmDialog
        open={Boolean(suspendFor)}
        onOpenChange={(open) => !open && setSuspendFor(null)}
        title={`Suspend ${suspendFor?.name}?`}
        description="The restaurant is disabled immediately and all its staff are signed out. Guests can no longer order. You can reactivate it any time."
        confirmLabel="Suspend"
        destructive
        onConfirm={async () => {
          if (!suspendFor) return
          const result = await callAction(() => suspendRestaurant({ restaurantId: suspendFor.id }))
          if (result.ok) {
            patch(suspendFor.id, 'SUSPENDED')
            toast.success('Restaurant suspended')
          } else toast.error(result.error)
          setSuspendFor(null)
        }}
      />
    </div>
  )
}

function RejectDialog({
  restaurant,
  onClose,
  onDone,
}: {
  restaurant: PlatformRestaurant | null
  onClose: () => void
  onDone: (id: string) => void
}) {
  const [reason, setReason] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (restaurant) setReason('')
  }, [restaurant])

  const submit = async () => {
    if (!restaurant) return
    setSaving(true)
    const result = await callAction(() => rejectRestaurant({ restaurantId: restaurant.id, reason }))
    setSaving(false)
    if (result.ok) {
      onDone(restaurant.id)
      toast.success('Registration rejected')
      onClose()
    } else toast.error(result.error)
  }

  return (
    <Dialog open={Boolean(restaurant)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Reject {restaurant?.name}?</DialogTitle>
          <DialogDescription>The owner will see this reason on their pending screen.</DialogDescription>
        </DialogHeader>
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why is this being rejected?" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} loading={saving} disabled={reason.trim().length < 3}>
            Reject registration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
