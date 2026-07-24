'use client'

import * as React from 'react'
import { Gift, MoreVertical, Pencil, Plus, Search, UserRound } from 'lucide-react'
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
import { Input, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/primitives'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { adjustLoyalty, saveCustomer } from '../actions'

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
}

export function CustomersManager({
  customers: initial,
  currency,
  locale,
  canManage,
}: {
  customers: CustomerRow[]
  currency: string
  locale: string
  canManage: boolean
}) {
  const [customers, setCustomers] = React.useState(initial)
  const [search, setSearch] = React.useState('')
  const [editing, setEditing] = React.useState<CustomerRow | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [loyaltyFor, setLoyaltyFor] = React.useState<CustomerRow | null>(null)

  React.useEffect(() => setCustomers(initial), [initial])

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return customers
    return customers.filter(
      (customer) =>
        customer.name.toLowerCase().includes(query) ||
        customer.phone.includes(query) ||
        customer.email?.toLowerCase().includes(query),
    )
  }, [customers, search])

  return (
    <>
      <PageHeader
        title="Customers"
        description={`${customers.length} guests`}
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

      <div className="mb-4">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, phone or email…"
          startIcon={<Search />}
          className="max-w-sm"
        />
      </div>

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
                {canManage ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell>
                    <p className="font-medium">
                      {customer.name}
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
                    {customer.lastOrderAt ? new Date(customer.lastOrderAt).toLocaleDateString(locale) : '—'}
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

      <CustomerDialog open={dialogOpen} onOpenChange={setDialogOpen} customer={editing} />
      <LoyaltyDialog customer={loyaltyFor} onClose={() => setLoyaltyFor(null)} />
    </>
  )
}

function CustomerDialog({
  open,
  onOpenChange,
  customer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  customer: CustomerRow | null
}) {
  const [form, setForm] = React.useState({ name: '', phone: '', email: '', notes: '', isBlocked: false })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setForm({
      name: customer?.name ?? '',
      phone: customer?.phone ?? '',
      email: customer?.email ?? '',
      notes: customer?.notes ?? '',
      isBlocked: customer?.isBlocked ?? false,
    })
  }, [open, customer])

  const save = async () => {
    setSaving(true)
    const result = await saveCustomer({ id: customer?.id, ...form })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success('Customer saved')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{customer ? 'Edit customer' : 'New customer'}</DialogTitle>
          <DialogDescription>Customers are matched by phone number.</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Field label="Name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Phone" required>
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={form.isBlocked} onCheckedChange={(v) => setForm({ ...form, isBlocked: v })} />
          Block this customer from ordering
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    const result = await adjustLoyalty({ customerId: customer.id, points: Number(points), reason })
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
