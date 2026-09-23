'use client'

import { LocalDateTime } from '@/components/local-time'
import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Eye, Gift, MoreVertical, Pencil, Percent, Plus, Trash2, UserRound } from 'lucide-react'
import { toast } from 'sonner'

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/feedback'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/primitives'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { adjustLoyalty } from '../actions'
import { SearchBox } from '@/components/search-box'
import {
  createCustomerCampaignAction,
  removeCustomerCategoryAction,
  saveCustomerCategoryAction,
  setCustomerCategoryActiveAction,
} from '@/features/customers/actions'
import { CustomerFormDialog } from '@/features/customers/components/customer-form-dialog'
import { callAction } from '@/lib/use-action'

export interface CustomerRow {
  id: string
  name: string
  phone: string
  email: string | null
  notes: string | null
  loyaltyPoints: number
  totalSpent: number
  totalOrders: number
  lastOrderAt: string | null
  isBlocked: boolean
  /** The fields pro.A.md §1 and §2 ask for. All optional. */
  address?: string | null
  categoryId?: string | null
  categoryName?: string | null
  birthday?: string | null
  anniversary?: string | null
}

export function CustomersManager({
  customers: initial,
  categories = [],
  categoryRows = [],
  total,
  page = 1,
  pages = 1,
  canDiscountGroup = false,
  currency,
  locale,
  canManage,
}: {
  customers: CustomerRow[]
  /** The categories the owner has defined (pro.A.md §1). Active ones only. */
  categories?: Array<{ id: string; name: string }>
  /** Every category, retired ones included, for the manager below. */
  categoryRows?: CategoryRow[]
  /** How many customers the current filter reaches, across every page. */
  total?: number
  page?: number
  pages?: number
  /** Whether this person may aim an offer at the filtered group (§4). */
  canDiscountGroup?: boolean
  currency: string
  locale: string
  canManage: boolean
}) {
  const router = useRouter()
  const [customers, setCustomers] = React.useState(initial)
  const [editing, setEditing] = React.useState<CustomerRow | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [loyaltyFor, setLoyaltyFor] = React.useState<CustomerRow | null>(null)

  React.useEffect(() => setCustomers(initial), [initial])

  /*
   * No client-side filtering (pro.A.md §3, §26). The list arrives already
   * narrowed by the database, so the filter reaches every customer rather
   * than the first five hundred, and a phone number nobody is allowed to see
   * is never sent to the browser to be hidden again.
   */
  const filtered = customers

  return (
    <>
      {canManage ? <CategoryManager rows={categoryRows} /> : null}
      <PageHeader
        title="Customers"
        description={
          total === undefined
            ? `${customers.length} guests`
            : `${total.toLocaleString()} guest${total === 1 ? '' : 's'}${
                pages > 1 ? ` · page ${page} of ${pages}` : ''
              }`
        }
        actions={
          canManage ? (
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus /> Add customer
            </Button>
          ) : null
        }
      />

      <CustomerFilters
        categories={categories}
        currency={currency}
        reaches={total ?? customers.length}
        canDiscountGroup={canDiscountGroup}
      />

      {filtered.length === 0 ? (
        <EmptyState icon={<UserRound />} title="No customers" description="Guests are saved automatically when they order." />
      ) : (
        <div className="rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="hidden sm:table-cell">Orders</TableHead>
                <TableHead className="hidden md:table-cell">Total spent</TableHead>
                <TableHead>Points</TableHead>
                <TableHead className="hidden lg:table-cell">Last order</TableHead>
                <TableHead className="w-32" />
                {canManage ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell>
                    {/*
                      The name opens the profile (pro.A.md §2). The page has
                      existed all along and nothing linked to it, so the only
                      way to read somebody's history was to know the URL.
                    */}
                    <p className="font-medium">
                      <Link
                        href={`/dashboard/customers/${customer.id}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {customer.name}
                      </Link>
                      {customer.categoryName ? (
                        <Badge variant="secondary" size="sm" className="ml-2">
                          {customer.categoryName}
                        </Badge>
                      ) : null}
                      {customer.isBlocked ? (
                        <Badge variant="destructive" size="sm" className="ml-2">
                          Blocked
                        </Badge>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{customer.phone}</p>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{customer.totalOrders}</TableCell>
                  <TableCell className="hidden font-medium md:table-cell">
                    {formatMoney(customer.totalSpent, currency, locale)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="warning">{customer.loyaltyPoints} pts</Badge>
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                    {customer.lastOrderAt ? <LocalDateTime value={customer.lastOrderAt} locale={locale} options={{ dateStyle: 'medium' }} /> : '—'}
                  </TableCell>
                  {/*
                    A button that says what it does (pro.A.md §2). The name is
                    a link too, but a link in a table is easy to miss, and
                    reading a customer is not an edit — so this is here for
                    everybody with `customer.view`, not only for managers.
                  */}
                  <TableCell>
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/dashboard/customers/${customer.id}`}>
                        <Eye /> View details
                      </Link>
                    </Button>
                  </TableCell>
                  {canManage ? (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="Actions">
                            <MoreVertical />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditing(customer)
                              setDialogOpen(true)
                            }}
                          >
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setLoyaltyFor(customer)}>
                            <Gift /> Adjust points
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {pages > 1 ? (
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          <span className="flex gap-2">
            <PageLink page={page - 1} disabled={page <= 1}>Previous</PageLink>
            <PageLink page={page + 1} disabled={page >= pages}>Next</PageLink>
          </span>
        </div>
      ) : null}

      {/*
        The SAME form the till uses (pro.A.md §6) — one component, so the
        fields, the validation and the duplicate-phone rule cannot differ
        between the back office and the counter.
      */}
      <CustomerFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        seed={editing ? {
          id: editing.id,
          name: editing.name,
          phone: editing.phone,
          email: editing.email,
          notes: editing.notes,
          address: editing.address ?? null,
          categoryId: editing.categoryId ?? null,
          birthday: editing.birthday ?? null,
          anniversary: editing.anniversary ?? null,
          isBlocked: editing.isBlocked,
        } : null}
        categories={categories}
        allowBlock
        onSaved={() => router.refresh()}
      />
      <LoyaltyDialog customer={loyaltyFor} onClose={() => setLoyaltyFor(null)} />
    </>
  )
}



/**
 * Narrow the customer list, then offer the group something (pro.A.md §3, §4).
 *
 * ── The filter is in the URL ────────────────────────────────────────────────
 *
 * So it can be bookmarked, shared with whoever is running the promotion, and —
 * the part that matters — read by the SERVER, which is what actually narrows
 * the query. A filter that lives in React state can only ever hide rows that
 * were already downloaded.
 *
 * ── And the discount uses the same filter ───────────────────────────────────
 *
 * "Discount this group" saves the very filter on screen onto a coupon. The
 * count beside the button and the people the offer reaches are one query, so
 * they cannot disagree.
 */

/** One step through the list, keeping every filter that is already on. */
function PageLink({
  page,
  disabled,
  children,
}: {
  page: number
  disabled: boolean
  children: React.ReactNode
}) {
  const router = useRouter()
  const params = useSearchParams()
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => {
        const next = new URLSearchParams(params.toString())
        if (page <= 1) next.delete('page')
        else next.set('page', String(page))
        router.replace(`?${next.toString()}`)
      }}
    >
      {children}
    </Button>
  )
}

function CustomerFilters({
  categories,
  currency,
  reaches,
  canDiscountGroup,
}: {
  categories: Array<{ id: string; name: string }>
  currency: string
  reaches: number
  canDiscountGroup: boolean
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [campaignOpen, setCampaignOpen] = React.useState(false)

  const value = (key: string) => params.get(key) ?? ''
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [key, v] of Object.entries(patch)) {
      if (v) next.set(key, v)
      else next.delete(key)
    }
    // Any change to the filter starts again at the first page.
    next.delete('page')
    router.replace(`?${next.toString()}`)
  }
  const active = ['q', 'category', 'kind', 'minVisits', 'minSpent', 'notSeenForDays', 'minPoints'].some(
    (key) => value(key),
  )
  const select = 'h-9 rounded-lg border border-input bg-background px-2 text-sm'

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-end gap-2" data-testid="customer-filters">
        <SearchBox
          placeholder="Name, phone or email…"
          paramName="q"
          defaultValue={value('q')}
          className="w-full sm:w-56"
        />
        {categories.length > 0 ? (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="cf-category">Category</label>
            <select id="cf-category" className={select} value={value('category')} onChange={(e) => set({ category: e.target.value })}>
              <option value="">Any category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="cf-kind">Who</label>
          <select id="cf-kind" className={select} value={value('kind')} onChange={(e) => set({ kind: e.target.value })}>
            <option value="">Everybody</option>
            <option value="new">New (1 visit)</option>
            <option value="returning">Returning (2+)</option>
            <option value="repeat">Repeat (3+)</option>
            <option value="regular">Regular (5+, seen recently)</option>
            <option value="lapsed">Lapsed (2+, away 45 days)</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="cf-visits">Visits at least</label>
          <Input
            id="cf-visits"
            type="number"
            className="h-9 w-28"
            defaultValue={value('minVisits')}
            onBlur={(e) => set({ minVisits: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="cf-spent">Spent at least ({currency})</label>
          <Input
            id="cf-spent"
            type="number"
            className="h-9 w-32"
            defaultValue={value('minSpent')}
            onBlur={(e) => set({ minSpent: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="cf-away">Away for (days)</label>
          <Input
            id="cf-away"
            type="number"
            className="h-9 w-28"
            defaultValue={value('notSeenForDays')}
            onBlur={(e) => set({ notSeenForDays: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="cf-points">Points at least</label>
          <Input
            id="cf-points"
            type="number"
            className="h-9 w-28"
            defaultValue={value('minPoints')}
            onBlur={(e) => set({ minPoints: e.target.value })}
          />
        </div>
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => set({ q: '', category: '', kind: '', minVisits: '', minSpent: '', notSeenForDays: '', minPoints: '' })}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {canDiscountGroup ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <Percent className="size-4 text-muted-foreground" />
          <span>
            This filter reaches <strong>{reaches.toLocaleString()}</strong> customer
            {reaches === 1 ? '' : 's'}.
          </span>
          <Button size="sm" className="ml-auto" disabled={reaches === 0} onClick={() => setCampaignOpen(true)}>
            Give them an offer
          </Button>
        </div>
      ) : null}

      <CampaignDialog
        open={campaignOpen}
        onOpenChange={setCampaignOpen}
        currency={currency}
        reaches={reaches}
      />
    </div>
  )
}

/**
 * Turn the filter on screen into an offer (pro.A.md §4).
 *
 * It creates a coupon with the segment saved on it, so every rule the discount
 * engine already enforces applies — and it can only ever affect future orders.
 * Nothing here touches a bill that has already been issued.
 */
function CampaignDialog({
  open,
  onOpenChange,
  currency,
  reaches,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currency: string
  reaches: number
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [form, setForm] = React.useState({
    code: '',
    description: '',
    type: 'PERCENT' as 'PERCENT' | 'FIXED',
    value: '',
    minOrderAmount: '',
    maxDiscount: '',
    startsAt: '',
    endsAt: '',
    perCustomerLimit: '1',
  })
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setForm((current) => ({ ...current, code: '', value: '' }))
  }, [open])

  const save = async () => {
    setBusy(true)
    const segment: Record<string, string> = {}
    for (const [key, param] of [
      ['q', 'q'], ['categoryId', 'category'], ['kind', 'kind'],
      ['minVisits', 'minVisits'], ['notSeenForDays', 'notSeenForDays'], ['minPoints', 'minPoints'],
    ] as const) {
      const v = params.get(param)
      if (v) segment[key] = v
    }
    // Spend is typed in major units on the filter bar and stored in minor.
    const spent = params.get('minSpent')
    if (spent) segment.minSpent = String(Math.round(Number(spent) * 100))

    const result = await callAction(() =>
      createCustomerCampaignAction({
        code: form.code,
        description: form.description,
        type: form.type,
        // Percent is basis points, so 10% is 1000 — the same unit the engine
        // already stores and `applyBps` already reads.
        value: form.type === 'PERCENT' ? Math.round(Number(form.value) * 100) : Math.round(Number(form.value) * 100),
        minOrderAmount: form.minOrderAmount ? Math.round(Number(form.minOrderAmount) * 100) : 0,
        maxDiscount: form.maxDiscount ? Math.round(Number(form.maxDiscount) * 100) : null,
        startsAt: form.startsAt,
        endsAt: form.endsAt,
        perCustomerLimit: form.perCustomerLimit ? Number(form.perCustomerLimit) : null,
        segment,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${result.data.code} created for ${result.data.reaches} customers`)
    onOpenChange(false)
    router.refresh()
  }

  const valid = form.code.trim().length >= 3 && Number(form.value) > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>An offer for these {reaches.toLocaleString()} customers</DialogTitle>
          <DialogDescription>
            It becomes a coupon they can use on future orders. Guests outside the group are
            refused it automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" required>
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="REGULARS10"
            />
          </Field>
          <Field label="Type">
            <select
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as 'PERCENT' | 'FIXED' })}
            >
              <option value="PERCENT">Percent off</option>
              <option value="FIXED">Fixed amount off</option>
            </select>
          </Field>
          <Field label={form.type === 'PERCENT' ? 'Percent off' : `Amount off (${currency})`} required>
            <Input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </Field>
          <Field label={`Minimum order (${currency})`}>
            <Input type="number" value={form.minOrderAmount} onChange={(e) => setForm({ ...form, minOrderAmount: e.target.value })} />
          </Field>
          {form.type === 'PERCENT' ? (
            <Field label={`Most it can take off (${currency})`}>
              <Input type="number" value={form.maxDiscount} onChange={(e) => setForm({ ...form, maxDiscount: e.target.value })} />
            </Field>
          ) : null}
          <Field label="Uses per customer" hint="Blank = unlimited">
            <Input type="number" value={form.perCustomerLimit} onChange={(e) => setForm({ ...form, perCustomerLimit: e.target.value })} />
          </Field>
          <Field label="Starts on">
            <Input type="date" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          </Field>
          <Field label="Ends on">
            <Input type="date" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description">
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Thanks for coming back" />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!valid || busy}>Create offer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface CategoryRow {
  id: string
  name: string
  colour: string | null
  isActive: boolean
  /** How many people are in it — a category with members is retired, not deleted. */
  customers: number
}

/**
 * The owner's own customer categories (pro.A.md §1).
 *
 * Student, VIP, Corporate, Tourist — or whatever this restaurant actually
 * calls its people. Deliberately not a fixed list in the code: the five-value
 * enum that was here before could not be added to by anybody who runs a
 * restaurant, which is exactly the thing the spec says not to do.
 *
 * A category somebody is in is never deleted, only switched off. Their history
 * says they were a Student; deleting the row would quietly rewrite that into
 * nothing.
 */
function CategoryManager({ rows }: { rows: CategoryRow[] }) {
  const router = useRouter()
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)

  const add = async () => {
    if (name.trim().length < 2) return
    setBusy('new')
    const result = await callAction(() => saveCustomerCategoryAction({ name }))
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${name.trim()} added`)
    setName('')
    router.refresh()
  }

  const toggle = async (row: CategoryRow) => {
    setBusy(row.id)
    const result = await callAction(() =>
      setCustomerCategoryActiveAction({ id: row.id, isActive: !row.isActive }),
    )
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    router.refresh()
  }

  const remove = async (row: CategoryRow) => {
    setBusy(row.id)
    const result = await callAction(() => removeCustomerCategoryAction({ id: row.id }))
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      result.data.deleted
        ? `${row.name} deleted`
        : `${row.name} retired — ${result.data.customers} customer${result.data.customers === 1 ? '' : 's'} keep it`,
    )
    router.refresh()
  }

  return (
    <SectionCard
      title="Customer categories"
      description="Your own labels — Student, VIP, Corporate, anything. Optional on every customer."
    >
      <div className="mb-3 flex gap-2">
        <Input
          value={name}
          placeholder="New category, e.g. Student"
          onChange={(event) => setName(event.target.value.slice(0, 40))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add()
          }}
        />
        <Button disabled={busy !== null || name.trim().length < 2} loading={busy === 'new'} onClick={add}>
          <Plus /> Add
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None yet. Categories let you find the students who have not been in for a month, and offer them something.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <span className="font-medium">{row.name}</span>
              {!row.isActive ? <Badge variant="secondary" size="sm">Retired</Badge> : null}
              <span className="text-xs text-muted-foreground">
                {row.customers} customer{row.customers === 1 ? '' : 's'}
              </span>
              <span className="ml-auto flex items-center gap-2">
                <Switch
                  checked={row.isActive}
                  disabled={busy === row.id}
                  onCheckedChange={() => toggle(row)}
                  aria-label={`${row.name} in use`}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${row.name}`}
                  disabled={busy === row.id}
                  onClick={() => remove(row)}
                >
                  <Trash2 />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

function LoyaltyDialog({ customer, onClose }: { customer: CustomerRow | null; onClose: () => void }) {
  const [points, setPoints] = React.useState('0')
  const [reason, setReason] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (customer) {
      setPoints('0')
      setReason('')
    }
  }, [customer])

  const save = async () => {
    if (!customer) return
    setSaving(true)
    const result = await callAction(() => adjustLoyalty({ customerId: customer.id, points: Number(points), reason }))
    setSaving(false)
    if (result.ok) {
      toast.success(`Balance is now ${result.data.points} points`)
      onClose()
    } else {
      toast.error(result.error)
    }
  }

  return (
    <Dialog open={Boolean(customer)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Adjust loyalty points</DialogTitle>
          <DialogDescription>
            {customer?.name} currently has {customer?.loyaltyPoints} points. Use a negative number to deduct.
          </DialogDescription>
        </DialogHeader>
        <Field label="Points to add/remove">
          <Input type="number" value={points} onChange={(e) => setPoints(e.target.value)} />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Goodwill, correction…" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
