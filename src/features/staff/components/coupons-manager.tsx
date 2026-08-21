'use client'

import * as React from 'react'
import { Pencil, Plus, Ticket, Trash2 } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { formatBps, formatMoney, parseMoney, toMajor } from '@/lib/money'
import { deleteCoupon, saveCoupon } from '../actions'
import { callAction } from '@/lib/use-action'

export interface CouponRow {
  id: string
  code: string
  description: string | null
  type: 'PERCENT' | 'FIXED' | 'FREE_ITEM'
  value: number
  minOrderAmount: number
  maxDiscount: number | null
  usageLimit: number | null
  usedCount: number
  isActive: boolean
  startsAt: string | null
  endsAt: string | null
}

export function CouponsManager({
  coupons: initial,
  currency,
  locale,
}: {
  coupons: CouponRow[]
  currency: string
  locale: string
}) {
  const [coupons, setCoupons] = React.useState(initial)
  const [editing, setEditing] = React.useState<CouponRow | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  React.useEffect(() => setCoupons(initial), [initial])

  const describe = (coupon: CouponRow) =>
    coupon.type === 'PERCENT'
      ? `${formatBps(coupon.value)} off`
      : coupon.type === 'FIXED'
        ? `${formatMoney(coupon.value, currency, locale)} off`
        : 'Free item'

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await callAction(() => deleteCoupon(id))
    if (result.ok) {
      setCoupons((current) => current.filter((coupon) => coupon.id !== id))
      toast.success('Coupon deleted')
    } else {
      toast.error(result.error)
    }
  }

  return (
    <>
      <PageHeader
        title="Coupons"
        description="Discount codes guests can apply at checkout"
        actions={
          <Button
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus /> New coupon
          </Button>
        }
      />

      {coupons.length === 0 ? (
        <EmptyState
          icon={<Ticket />}
          title="No coupons yet"
          description="Create a code like WELCOME10 to reward your guests."
          action={
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus /> Create a coupon
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {coupons.map((coupon) => (
            <div key={coupon.id} className="rounded-xl border bg-card p-4 shadow-soft">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-mono text-lg font-bold tracking-wide">{coupon.code}</p>
                  <p className="text-sm text-muted-foreground">{describe(coupon)}</p>
                </div>
                <Badge variant={coupon.isActive ? 'success' : 'secondary'}>
                  {coupon.isActive ? 'Active' : 'Off'}
                </Badge>
              </div>

              {coupon.description ? (
                <p className="mt-2 text-xs text-muted-foreground">{coupon.description}</p>
              ) : null}

              <dl className="mt-3 space-y-1 border-t pt-3 text-xs text-muted-foreground">
                {coupon.minOrderAmount > 0 ? (
                  <div className="flex justify-between">
                    <dt>Min order</dt>
                    <dd>{formatMoney(coupon.minOrderAmount, currency, locale)}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between">
                  <dt>Used</dt>
                  <dd>
                    {coupon.usedCount}
                    {coupon.usageLimit ? ` / ${coupon.usageLimit}` : ''}
                  </dd>
                </div>
                {coupon.endsAt ? (
                  <div className="flex justify-between">
                    <dt>Expires</dt>
                    <dd>{new Date(coupon.endsAt).toLocaleDateString(locale)}</dd>
                  </div>
                ) : null}
              </dl>

              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setEditing(coupon)
                    setDialogOpen(true)
                  }}
                >
                  <Pencil /> Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteId(coupon.id)}
                  aria-label="Delete"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <CouponDialog open={dialogOpen} onOpenChange={setDialogOpen} coupon={editing} currency={currency} />

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete this coupon?"
        confirmLabel="Delete"
        destructive
        onConfirm={remove}
      />
    </>
  )
}

function CouponDialog({
  open,
  onOpenChange,
  coupon,
  currency,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  coupon: CouponRow | null
  currency: string
}) {
  const [form, setForm] = React.useState({
    code: '',
    description: '',
    type: 'PERCENT' as CouponRow['type'],
    value: '',
    minOrderAmount: '',
    maxDiscount: '',
    usageLimit: '',
    perCustomerLimit: '',
    endsAt: '',
    isActive: true,
  })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setForm({
      code: coupon?.code ?? '',
      description: coupon?.description ?? '',
      type: coupon?.type ?? 'PERCENT',
      value:
        coupon?.type === 'PERCENT'
          ? String((coupon?.value ?? 0) / 100)
          : coupon
            ? String(toMajor(coupon.value, currency))
            : '',
      minOrderAmount: coupon?.minOrderAmount ? String(toMajor(coupon.minOrderAmount, currency)) : '',
      maxDiscount: coupon?.maxDiscount ? String(toMajor(coupon.maxDiscount, currency)) : '',
      usageLimit: coupon?.usageLimit ? String(coupon.usageLimit) : '',
      perCustomerLimit: '',
      endsAt: coupon?.endsAt ? coupon.endsAt.slice(0, 10) : '',
      isActive: coupon?.isActive ?? true,
    })
  }, [open, coupon, currency])

  const save = async () => {
    setSaving(true)
    setError(null)
    const value =
      form.type === 'PERCENT' ? Math.round(Number(form.value) * 100) : parseMoney(form.value, currency)

    const result = await callAction(() => saveCoupon({
      id: coupon?.id,
      code: form.code,
      description: form.description,
      type: form.type,
      value,
      minOrderAmount: form.minOrderAmount ? parseMoney(form.minOrderAmount, currency) : 0,
      maxDiscount: form.maxDiscount ? parseMoney(form.maxDiscount, currency) : null,
      usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
      perCustomerLimit: form.perCustomerLimit ? Number(form.perCustomerLimit) : null,
      endsAt: form.endsAt || '',
      isActive: form.isActive,
    }))
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success('Coupon saved')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="default">
        <DialogHeader>
          <DialogTitle>{coupon ? 'Edit coupon' : 'New coupon'}</DialogTitle>
          <DialogDescription>Guests enter the code at checkout.</DialogDescription>
        </DialogHeader>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required>
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="WELCOME10"
              className="font-mono uppercase"
            />
          </Field>
          <Field label="Type">
            <Select value={form.type} onValueChange={(value) => setForm({ ...form, type: value as CouponRow['type'] })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PERCENT">Percentage off</SelectItem>
                <SelectItem value="FIXED">Fixed amount off</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={form.type === 'PERCENT' ? 'Percent (%)' : `Amount (${currency})`} required>
            <Input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </Field>
          <Field label="Min order" hint="Optional">
            <Input
              type="number"
              value={form.minOrderAmount}
              onChange={(e) => setForm({ ...form, minOrderAmount: e.target.value })}
            />
          </Field>
          {form.type === 'PERCENT' ? (
            <Field label="Max discount" hint="Cap for % coupons">
              <Input
                type="number"
                value={form.maxDiscount}
                onChange={(e) => setForm({ ...form, maxDiscount: e.target.value })}
              />
            </Field>
          ) : null}
          <Field label="Usage limit" hint="Total uses; blank = unlimited">
            <Input
              type="number"
              value={form.usageLimit}
              onChange={(e) => setForm({ ...form, usageLimit: e.target.value })}
            />
          </Field>
          <Field label="Expires on" hint="Optional">
            <Input type="date" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
          </Field>
        </div>

        <Field label="Description" hint="Shown to guests">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <Switch checked={form.isActive} onCheckedChange={(v) => setForm({ ...form, isActive: v })} />
          Active
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
