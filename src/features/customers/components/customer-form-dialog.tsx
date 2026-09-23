'use client'

import * as React from 'react'
import { Search, UserPlus } from 'lucide-react'
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
import { Input, Textarea } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { Switch } from '@/components/ui/primitives'
import { callAction } from '@/lib/use-action'
import { findCustomerAction, saveCustomerAction } from '../actions'

/**
 * The ONE customer form (pro.A.md §6).
 *
 * Used by the CRM, the POS order column and the cashier's bill panel, so the
 * fields, the validation and the duplicate rule are the same wherever somebody
 * adds a guest. A second copy of this form is how two screens end up
 * disagreeing about whether an email is required.
 *
 * ── Phone first, and the phone answers the question ─────────────────────────
 *
 * The number is asked for before anything else, and looked up as soon as it is
 * long enough. If somebody already has it their name appears and the form
 * offers to use them — because the common case at a counter is a regular whose
 * number is already on file, and typing their name again creates a second
 * record or, worse, renames the first.
 *
 * Everything except the phone is optional. A cashier with a queue types a
 * number and moves on; the details get filled in by whoever has time.
 */

export interface CustomerFormValue {
  id: string
  name: string
  phone: string
  loyaltyPoints: number
}

export interface CustomerFormSeed {
  id?: string
  name?: string
  phone?: string
  email?: string | null
  notes?: string | null
  address?: string | null
  categoryId?: string | null
  birthday?: string | null
  anniversary?: string | null
  isBlocked?: boolean
}

export function CustomerFormDialog({
  open,
  onOpenChange,
  seed,
  categories,
  /** Shown when editing an existing record; hidden at a till. */
  allowBlock = false,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefill — a phone already typed at the till, or the record being edited. */
  seed?: CustomerFormSeed | null
  categories: Array<{ id: string; name: string }>
  allowBlock?: boolean
  onSaved?: (customer: CustomerFormValue & { created: boolean }) => void
}) {
  const editing = Boolean(seed?.id)
  const [form, setForm] = React.useState({
    name: '', phone: '', email: '', notes: '',
    address: '', categoryId: '', birthday: '', anniversary: '',
    isBlocked: false,
  })
  const [existing, setExisting] = React.useState<CustomerFormValue | null>(null)
  const [looking, setLooking] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setExisting(null)
    setForm({
      name: seed?.name ?? '',
      phone: seed?.phone ?? '',
      email: seed?.email ?? '',
      notes: seed?.notes ?? '',
      address: seed?.address ?? '',
      categoryId: seed?.categoryId ?? '',
      birthday: seed?.birthday ? seed.birthday.slice(0, 10) : '',
      anniversary: seed?.anniversary ? seed.anniversary.slice(0, 10) : '',
      isBlocked: seed?.isBlocked ?? false,
    })
  }, [open, seed])

  /*
   * Who has this number? Debounced, and never while editing an existing
   * record — there the number belongs to the person on screen already, and
   * "somebody already has this" would be telling them about themselves.
   */
  React.useEffect(() => {
    if (!open || editing) return
    const phone = form.phone.trim()
    if (phone.length < 7) {
      setExisting(null)
      return
    }
    let live = true
    setLooking(true)
    const timer = setTimeout(() => {
      void callAction(() => findCustomerAction({ phone })).then((result) => {
        if (!live) return
        setLooking(false)
        if (result.ok) setExisting(result.data.customer)
      })
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, editing, form.phone])

  const useExisting = () => {
    if (!existing) return
    onSaved?.({ ...existing, created: false })
    onOpenChange(false)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    const result = await callAction(() =>
      saveCustomerAction({
        id: seed?.id,
        phone: form.phone,
        name: form.name,
        email: form.email,
        notes: form.notes,
        address: form.address,
        categoryId: form.categoryId,
        birthday: form.birthday,
        anniversary: form.anniversary,
        ...(allowBlock ? { isBlocked: form.isBlocked } : {}),
      }),
    )
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success(result.data.created ? `${result.data.name} added` : 'Customer saved')
    onSaved?.({
      id: result.data.id,
      name: result.data.name,
      phone: form.phone.trim(),
      loyaltyPoints: existing?.loyaltyPoints ?? 0,
      created: result.data.created,
    })
    onOpenChange(false)
  }

  const valid = form.phone.trim().length >= 7

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit customer' : 'Add customer'}</DialogTitle>
          <DialogDescription>
            Only the phone number is needed. Customers are matched by it, so the same person
            is one record however they order.
          </DialogDescription>
        </DialogHeader>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Phone number" required>
              <Input
                autoFocus={!editing}
                inputMode="tel"
                placeholder="07X XXX XXXX"
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
              />
            </Field>
            {/*
              The answer to "is this somebody we know" appears as it is typed,
              before any other field is filled in — which is the whole reason
              the phone is first.
            */}
            {!editing && looking ? (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Search className="size-3" /> Looking…
              </p>
            ) : null}
            {!editing && existing ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                <Badge variant="success" size="sm">{existing.name}</Badge>
                {existing.loyaltyPoints > 0 ? (
                  <span className="text-muted-foreground">
                    {existing.loyaltyPoints.toLocaleString()} points
                  </span>
                ) : null}
                <span className="text-muted-foreground">already has this number.</span>
                <Button size="sm" variant="outline" className="ml-auto" onClick={useExisting}>
                  Use them
                </Button>
              </div>
            ) : null}
          </div>

          <div className="sm:col-span-2">
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Optional"
              />
            </Field>
          </div>

          {categories.length > 0 ? (
            <Field label="Category">
              <select
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                value={form.categoryId}
                onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
              >
                <option value="">No category</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </Field>
          ) : null}

          <Field label="Email">
            <Input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </Field>

          <Field label="Date of birth">
            <Input
              type="date"
              value={form.birthday}
              onChange={(event) => setForm({ ...form, birthday: event.target.value })}
            />
          </Field>

          <Field label="Anniversary">
            <Input
              type="date"
              value={form.anniversary}
              onChange={(event) => setForm({ ...form, anniversary: event.target.value })}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Address">
              <Input
                value={form.address}
                onChange={(event) => setForm({ ...form, address: event.target.value })}
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field label="Notes">
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
              />
            </Field>
          </div>

          {allowBlock ? (
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch
                checked={form.isBlocked}
                onCheckedChange={(v) => setForm({ ...form, isBlocked: v })}
              />
              Block this customer from ordering
            </label>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!valid || saving}>
            <UserPlus /> {editing ? 'Save' : 'Add customer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
