'use client'

import * as React from 'react'
import type { RestaurantStatus } from '@prisma/client'
import {
  Building2,
  Check,
  CircleSlash,
  Clock,
  ExternalLink,
  Globe,
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
  setCustomDomain,
  verifyCustomDomain,
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
  packages = [],
}: {
  restaurants: PlatformRestaurant[]
  stats: PlatformStats
  recentFeedback: PlatformFeedbackItem[]
  appUrl: string
  /** Sellable bundles, offered at the moment of approval. */
  packages?: Array<{ id: string; name: string; featureKeys: string[] }>
}) {
  const [restaurants, setRestaurants] = React.useState(initial)
  const [filter, setFilter] = React.useState<'ALL' | RestaurantStatus>(
    stats.pending > 0 ? 'PENDING' : 'ACTIVE',
  )
  const [search, setSearch] = React.useState('')
  const [rejectFor, setRejectFor] = React.useState<PlatformRestaurant | null>(null)
  const [suspendFor, setSuspendFor] = React.useState<PlatformRestaurant | null>(null)
  const [domainFor, setDomainFor] = React.useState<PlatformRestaurant | null>(null)
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

  /*
   * Approving is also where what they have bought is decided.
   *
   * `pkg` undefined means no package was chosen, which sends no feature list at
   * all — and an empty list reads as unrestricted. So the plain Approve button
   * behaves exactly as it always did, and choosing a package is the deliberate
   * act.
   */
  const approve = async (
    restaurant: PlatformRestaurant,
    pkg?: { id: string; featureKeys: string[] },
  ) => {
    setBusyId(restaurant.id)
    const result = await callAction(() =>
      approveRestaurant({
        restaurantId: restaurant.id,
        ...(pkg ? { featureKeys: pkg.featureKeys, packageId: pkg.id } : {}),
      }),
    )
    setBusyId(null)
    if (result.ok) {
      patch(restaurant.id, 'ACTIVE')
      toast.success(
          pkg ? `${restaurant.name} approved on its package` : `${restaurant.name} approved`,
      )
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
                  {/*
                    Their own address, and whether it actually answers. An
                    unverified domain is stored but resolves nothing, so saying
                    "waiting for DNS" is the difference between "I typed it
                    wrong" and "I have not added it in Netlify yet".
                  */}
                  {restaurant.customDomain ? (
                    <p className="mt-1 flex items-center gap-1.5 text-xs">
                      <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">{restaurant.customDomain}</span>
                      {restaurant.customDomainVerified ? (
                        <Badge variant="success">live</Badge>
                      ) : (
                        <Badge variant="warning">waiting for DNS</Badge>
                      )}
                    </p>
                  ) : null}
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
                      <Check /> Approve with everything
                    </Button>
                    {/*
                      One button per package rather than a dialog. There are
                      rarely more than three, and the decision is "which plan
                      did they buy" — a question better answered by reading the
                      options than by opening something to find them.
                    */}
                    {packages.map((pkg) => (
                      <Button
                        key={pkg.id}
                        size="sm"
                        variant="outline"
                        loading={busyId === restaurant.id}
                        onClick={() => approve(restaurant, pkg)}
                      >
                        Approve on {pkg.name}
                      </Button>
                    ))}
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
                    <Button size="sm" variant="outline" onClick={() => setDomainFor(restaurant)}>
                      <Globe /> {restaurant.customDomain ? 'Domain' : 'Set domain'}
                    </Button>
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

      {domainFor ? (
        <DomainDialog
          restaurant={domainFor}
          platformHost={new URL(appUrl).host}
          onClose={() => setDomainFor(null)}
        />
      ) : null}

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

/**
 * Setting up a restaurant's own address.
 *
 * Three states, and the dialog says which one you are in rather than making you
 * infer it: no domain, saved but not answering yet, and live. The DNS record is
 * shown as something to copy and send, because that is the actual next action —
 * the operator cannot add it themselves, and the client cannot be expected to
 * know what a CNAME is without being told exactly what to type.
 *
 * Check is a real request to the domain, not a database read. That is the whole
 * point: it proves DNS, TLS, Netlify and our own resolver at once, and reports
 * whichever of them is not ready yet.
 */
function DomainDialog({
  restaurant,
  platformHost,
  onClose,
}: {
  restaurant: PlatformRestaurant
  platformHost: string
  onClose: () => void
}) {
  const [domain, setDomain] = React.useState(restaurant.customDomain ?? '')
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null)

  const saved = restaurant.customDomain
  const dns = saved ? dnsRecordFor(saved, platformHost) : null

  const save = async () => {
    setBusy(true)
    setResult(null)
    const outcome = await callAction(() =>
      setCustomDomain({ restaurantId: restaurant.id, domain }),
    )
    setBusy(false)
    if (!outcome.ok) {
      setResult({ ok: false, message: outcome.error })
      return
    }
    toast.success(outcome.data.domain ? 'Domain saved' : 'Domain removed')
    onClose()
  }

  const check = async () => {
    setBusy(true)
    setResult(null)
    const outcome = await callAction(() => verifyCustomDomain({ restaurantId: restaurant.id }))
    setBusy(false)
    if (!outcome.ok) {
      setResult({ ok: false, message: outcome.error })
      return
    }
    setResult({ ok: outcome.data.verified, message: outcome.data.detail })
    if (outcome.data.verified) toast.success('Domain is live')
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{restaurant.name} · own domain</DialogTitle>
          <DialogDescription>
            Diners see this address instead of the platform one. The shared address keeps working
            either way, so printed QR codes never stop.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Domain">
            <Input
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="nilaza.lk"
              autoFocus
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Leave it empty to remove. Pasting a full URL is fine.
            </p>
          </Field>

          {dns ? (
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-xs font-medium">Send them this DNS record</p>
              <table className="mt-2 w-full text-xs">
                <tbody>
                  <tr>
                    <td className="py-0.5 pr-3 text-muted-foreground">Type</td>
                    <td className="font-mono">{dns.type}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5 pr-3 text-muted-foreground">Name</td>
                    <td className="font-mono">{dns.name}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5 pr-3 text-muted-foreground">Points to</td>
                    <td className="font-mono">{dns.value}</td>
                  </tr>
                </tbody>
              </table>
              {dns.note ? (
                <p className="mt-2 text-xs text-muted-foreground">{dns.note}</p>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">
                Then add <span className="font-mono">{saved}</span> in Netlify → Domain management →
                Add a domain alias. Netlify issues the certificate.
              </p>
            </div>
          ) : null}

          {result ? (
            <p className={`text-sm ${result.ok ? 'text-success' : 'text-destructive'}`}>
              {result.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {saved && saved === domain.trim().toLowerCase() ? (
            <Button variant="outline" onClick={check} loading={busy}>
              Check
            </Button>
          ) : null}
          <Button onClick={save} loading={busy}>
            {domain.trim() ? 'Save' : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The record to hand the client.
 *
 * An apex domain cannot legally be a CNAME, so registrars offer ALIAS/ANAME
 * instead — and the ones that do not need an A record. Saying which case they
 * are in saves a round of "my registrar will not accept that".
 */
function dnsRecordFor(domain: string, platformHost: string) {
  const apex = domain.split('.').length <= 2
  return {
    type: apex ? 'ALIAS or ANAME' : 'CNAME',
    name: apex ? '@' : domain.split('.')[0],
    value: platformHost,
    note: apex
      ? 'If their registrar offers neither, use an A record pointing at 75.2.60.5, or give them a subdomain such as order.' +
        domain +
        ' instead.'
      : null,
  }
}
