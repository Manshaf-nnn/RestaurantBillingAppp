'use client'

import * as React from 'react'
import { Plus, ScrollText, Trash2 } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { formatMoney, parseMoney } from '@/lib/money'
import { createPurchase } from '../actions'

export interface PurchaseRow {
  id: string
  number: string
  supplierName: string | null
  total: number
  status: string
  receivedAt: string | null
  itemCount: number
}

export function PurchasesManager({
  purchases: initial,
  suppliers,
  items,
  currency,
  locale,
}: {
  purchases: PurchaseRow[]
  suppliers: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string; unit: string; costPerUnit: number }>
  currency: string
  locale: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <PageHeader
        title="Purchases"
        description="Record stock deliveries — inventory updates automatically"
        actions={
          items.length ? (
            <Button onClick={() => setOpen(true)}>
              <Plus /> New purchase
            </Button>
          ) : null
        }
      />

      {initial.length === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title="No purchases yet"
          description={
            items.length
              ? 'Record a purchase to add stock and keep costs up to date.'
              : 'Add inventory items first, then record purchases against them.'
          }
          action={
            items.length ? (
              <Button onClick={() => setOpen(true)}>
                <Plus /> Record a purchase
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Purchase</TableHead>
                <TableHead className="hidden sm:table-cell">Supplier</TableHead>
                <TableHead className="hidden md:table-cell">Items</TableHead>
                <TableHead className="hidden lg:table-cell">Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.map((purchase) => (
                <TableRow key={purchase.id}>
                  <TableCell className="font-semibold">{purchase.number}</TableCell>
                  <TableCell className="hidden sm:table-cell">{purchase.supplierName ?? '—'}</TableCell>
                  <TableCell className="hidden md:table-cell">{purchase.itemCount}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {purchase.receivedAt ? new Date(purchase.receivedAt).toLocaleDateString(locale) : '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="success">{purchase.status.toLowerCase()}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatMoney(purchase.total, currency, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <PurchaseDialog
        open={open}
        onOpenChange={setOpen}
        suppliers={suppliers}
        items={items}
        currency={currency}
        locale={locale}
      />
    </>
  )
}

interface Line {
  itemId: string
  quantity: string
  unitCost: string
}

function PurchaseDialog({
  open,
  onOpenChange,
  suppliers,
  items,
  currency,
  locale,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  suppliers: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string; unit: string; costPerUnit: number }>
  currency: string
  locale: string
}) {
  const [supplierId, setSupplierId] = React.useState('')
  const [lines, setLines] = React.useState<Line[]>([])
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setSupplierId('')
      setLines([{ itemId: '', quantity: '1', unitCost: '' }])
    }
  }, [open])

  const total = lines.reduce(
    (sum, line) => sum + Math.round(Number(line.quantity || 0) * parseMoney(line.unitCost || '0', currency)),
    0,
  )

  const save = async () => {
    setSaving(true)
    const result = await createPurchase({
      supplierId,
      items: lines
        .filter((line) => line.itemId && Number(line.quantity) > 0)
        .map((line) => ({
          itemId: line.itemId,
          quantity: Number(line.quantity),
          unitCost: parseMoney(line.unitCost || '0', currency),
        })),
    })
    setSaving(false)
    if (result.ok) {
      toast.success(`Purchase ${result.data.number} recorded`)
      onOpenChange(false)
    } else {
      toast.error(result.error)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>New purchase</DialogTitle>
          <DialogDescription>Stock is added and costs updated when you save.</DialogDescription>
        </DialogHeader>

        {suppliers.length ? (
          <Field label="Supplier">
            <Select value={supplierId} onValueChange={setSupplierId}>
              <SelectTrigger>
                <SelectValue placeholder="Optional" />
              </SelectTrigger>
              <SelectContent>
                {suppliers.map((supplier) => (
                  <SelectItem key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        <div className="space-y-2">
          {lines.map((line, index) => (
            <div key={index} className="flex items-end gap-2">
              <Field label={index === 0 ? 'Item' : ''} className="flex-1">
                <Select
                  value={line.itemId}
                  onValueChange={(value) => {
                    const item = items.find((entry) => entry.id === value)
                    setLines((current) =>
                      current.map((entry, i) =>
                        i === index
                          ? {
                              ...entry,
                              itemId: value,
                              unitCost: item ? String(item.costPerUnit / 100) : entry.unitCost,
                            }
                          : entry,
                      ),
                    )
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose item" />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={index === 0 ? 'Qty' : ''} className="w-24">
                <Input
                  type="number"
                  step="any"
                  value={line.quantity}
                  onChange={(e) =>
                    setLines((current) =>
                      current.map((entry, i) => (i === index ? { ...entry, quantity: e.target.value } : entry)),
                    )
                  }
                />
              </Field>
              <Field label={index === 0 ? 'Unit cost' : ''} className="w-28">
                <Input
                  type="number"
                  value={line.unitCost}
                  onChange={(e) =>
                    setLines((current) =>
                      current.map((entry, i) => (i === index ? { ...entry, unitCost: e.target.value } : entry)),
                    )
                  }
                />
              </Field>
              <Button
                variant="ghost"
                size="icon-sm"
                className="mb-1"
                onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                aria-label="Remove line"
              >
                <Trash2 className="text-muted-foreground" />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLines((current) => [...current, { itemId: '', quantity: '1', unitCost: '' }])}
          >
            <Plus /> Add line
          </Button>
        </div>

        <div className="flex items-center justify-between border-t pt-3 text-sm font-semibold">
          <span>Total</span>
          <span>{formatMoney(total, currency, locale)}</span>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Record purchase
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
