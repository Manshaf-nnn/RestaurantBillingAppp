'use client'

import * as React from 'react'
import { Mail, Phone, Pencil, Plus, Trash2, Truck } from 'lucide-react'
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
import { EmptyState } from '@/components/ui/feedback'
import { Field } from '@/components/ui/label'
import { Input, Textarea } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { deleteSupplier, saveSupplier } from '../actions'

export interface SupplierRow {
  id: string
  name: string
  contactName: string | null
  phone: string | null
  email: string | null
  address: string | null
  notes: string | null
  itemCount: number
}

export function SuppliersManager({ suppliers: initial }: { suppliers: SupplierRow[] }) {
  const [suppliers, setSuppliers] = React.useState(initial)
  const [editing, setEditing] = React.useState<SupplierRow | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  React.useEffect(() => setSuppliers(initial), [initial])

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await deleteSupplier(id)
    if (result.ok) {
      setSuppliers((current) => current.filter((supplier) => supplier.id !== id))
      toast.success('Supplier removed')
    } else {
      toast.error(result.error)
    }
  }

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Vendors you buy stock from"
        actions={
          <Button
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus /> Add supplier
          </Button>
        }
      />

      {suppliers.length === 0 ? (
        <EmptyState
          icon={<Truck />}
          title="No suppliers yet"
          description="Add suppliers to record purchases and link them to inventory items."
          action={
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus /> Add your first supplier
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {suppliers.map((supplier) => (
            <div key={supplier.id} className="rounded-xl border bg-card p-4 shadow-soft">
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <p className="font-semibold">{supplier.name}</p>
                  {supplier.contactName ? (
                    <p className="text-xs text-muted-foreground">{supplier.contactName}</p>
                  ) : null}
                </div>
                <Badge variant="secondary">{supplier.itemCount} items</Badge>
              </div>

              <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
                {supplier.phone ? (
                  <p className="flex items-center gap-1.5">
                    <Phone className="size-3" /> {supplier.phone}
                  </p>
                ) : null}
                {supplier.email ? (
                  <p className="flex items-center gap-1.5">
                    <Mail className="size-3" /> {supplier.email}
                  </p>
                ) : null}
              </dl>

              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setEditing(supplier)
                    setDialogOpen(true)
                  }}
                >
                  <Pencil /> Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteId(supplier.id)}
                  aria-label="Delete"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <SupplierDialog open={dialogOpen} onOpenChange={setDialogOpen} supplier={editing} />

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Remove this supplier?"
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </>
  )
}

function SupplierDialog({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  supplier: SupplierRow | null
}) {
  const [form, setForm] = React.useState({
    name: '',
    contactName: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
  })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setForm({
      name: supplier?.name ?? '',
      contactName: supplier?.contactName ?? '',
      phone: supplier?.phone ?? '',
      email: supplier?.email ?? '',
      address: supplier?.address ?? '',
      notes: supplier?.notes ?? '',
    })
  }, [open, supplier])

  const save = async () => {
    setSaving(true)
    const result = await saveSupplier({ id: supplier?.id, isActive: true, ...form })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success('Supplier saved')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="default">
        <DialogHeader>
          <DialogTitle>{supplier ? 'Edit supplier' : 'New supplier'}</DialogTitle>
          <DialogDescription>Contact details for your stock vendor.</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Contact person">
            <Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Email" className="sm:col-span-2">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} rows={2} />
          </Field>
        </div>
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
