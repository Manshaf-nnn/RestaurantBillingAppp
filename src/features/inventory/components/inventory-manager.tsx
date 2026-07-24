'use client'

import * as React from 'react'
import type { StockUnit } from '@prisma/client'
import { AlertTriangle, MoreVertical, Package, Pencil, Plus, Search, Trash2, TrendingDown, TrendingUp } from 'lucide-react'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { formatMoney, parseMoney, toMajor } from '@/lib/money'
import { cn } from '@/lib/utils'
import { deleteInventoryItem, recordStockMovement, saveInventoryItem } from '../actions'

const UNITS: StockUnit[] = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN']

export interface InventoryRow {
  id: string
  name: string
  category: string | null
  unit: StockUnit
  quantity: number
  reorderLevel: number
  costPerUnit: number
  supplierName: string | null
  expiryDate: string | null
}

export function InventoryManager({
  items: initial,
  suppliers,
  currency,
  locale,
  canManage,
}: {
  items: InventoryRow[]
  suppliers: Array<{ id: string; name: string }>
  currency: string
  locale: string
  canManage: boolean
}) {
  const [items, setItems] = React.useState(initial)
  const [search, setSearch] = React.useState('')
  const [editing, setEditing] = React.useState<InventoryRow | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [movementFor, setMovementFor] = React.useState<InventoryRow | null>(null)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  React.useEffect(() => setItems(initial), [initial])

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return items
    return items.filter(
      (item) => item.name.toLowerCase().includes(query) || item.category?.toLowerCase().includes(query),
    )
  }, [items, search])

  const lowStock = items.filter((item) => item.quantity <= item.reorderLevel)
  const stockValue = items.reduce((sum, item) => sum + Math.round(item.quantity * item.costPerUnit), 0)
  const expiringSoon = items.filter(
    (item) => item.expiryDate && new Date(item.expiryDate).getTime() < Date.now() + 7 * 86_400_000,
  )

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await deleteInventoryItem(id)
    if (result.ok) {
      setItems((current) => current.filter((item) => item.id !== id))
      toast.success('Item removed')
    } else {
      toast.error(result.error)
    }
  }

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Track stock, get low-stock alerts, watch expiries"
        actions={
          canManage ? (
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus /> Add item
            </Button>
          ) : null
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Items tracked" value={items.length} icon={<Package />} />
        <StatCard label="Stock value" value={formatMoney(stockValue, currency, locale)} icon={<TrendingUp />} tone="primary" />
        <StatCard label="Low stock" value={lowStock.length} icon={<TrendingDown />} tone={lowStock.length ? 'warning' : 'default'} />
        <StatCard label="Expiring soon" value={expiringSoon.length} icon={<AlertTriangle />} tone={expiringSoon.length ? 'destructive' : 'default'} />
      </div>

      <div className="mb-4">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search items…"
          startIcon={<Search />}
          className="max-w-sm"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Package />}
          title="No inventory items"
          description="Add ingredients and supplies to track stock and get low-stock alerts."
          action={
            canManage ? (
              <Button
                onClick={() => {
                  setEditing(null)
                  setDialogOpen(true)
                }}
              >
                <Plus /> Add your first item
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>In stock</TableHead>
                <TableHead className="hidden md:table-cell">Reorder at</TableHead>
                <TableHead className="hidden lg:table-cell">Cost / unit</TableHead>
                <TableHead className="hidden lg:table-cell">Supplier</TableHead>
                {canManage ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => {
                const low = item.quantity <= item.reorderLevel
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <p className="font-medium">{item.name}</p>
                      {item.category ? (
                        <p className="text-xs text-muted-foreground">{item.category}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className={cn('font-semibold tabular-nums', low && 'text-destructive')}>
                        {item.quantity} {item.unit.toLowerCase()}
                      </span>
                      {low ? (
                        <Badge variant="warning" size="sm" className="ml-2">
                          Low
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {item.reorderLevel} {item.unit.toLowerCase()}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {formatMoney(item.costPerUnit, currency, locale)}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {item.supplierName ?? '—'}
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
                            <DropdownMenuItem onClick={() => setMovementFor(item)}>
                              <TrendingUp /> Stock in/out
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setEditing(item)
                                setDialogOpen(true)
                              }}
                            >
                              <Pencil /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive onClick={() => setDeleteId(item.id)}>
                              <Trash2 /> Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ItemDialog open={dialogOpen} onOpenChange={setDialogOpen} item={editing} suppliers={suppliers} currency={currency} />
      <MovementDialog item={movementFor} onClose={() => setMovementFor(null)} />

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Remove this item?"
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </>
  )
}

function ItemDialog({
  open,
  onOpenChange,
  item,
  suppliers,
  currency,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: InventoryRow | null
  suppliers: Array<{ id: string; name: string }>
  currency: string
}) {
  const [form, setForm] = React.useState({
    name: '',
    category: '',
    unit: 'PIECE' as StockUnit,
    quantity: '0',
    reorderLevel: '0',
    costPerUnit: '',
    supplierId: '',
    expiryDate: '',
  })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setForm({
      name: item?.name ?? '',
      category: item?.category ?? '',
      unit: item?.unit ?? 'PIECE',
      quantity: String(item?.quantity ?? 0),
      reorderLevel: String(item?.reorderLevel ?? 0),
      costPerUnit: item ? String(toMajor(item.costPerUnit, currency)) : '',
      supplierId: '',
      expiryDate: item?.expiryDate ? item.expiryDate.slice(0, 10) : '',
    })
  }, [open, item, currency])

  const save = async () => {
    setSaving(true)
    const result = await saveInventoryItem({
      id: item?.id,
      name: form.name,
      category: form.category,
      unit: form.unit,
      quantity: Number(form.quantity),
      reorderLevel: Number(form.reorderLevel),
      costPerUnit: form.costPerUnit ? parseMoney(form.costPerUnit, currency) : 0,
      supplierId: form.supplierId,
      expiryDate: form.expiryDate,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success('Item saved')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="default">
        <DialogHeader>
          <DialogTitle>{item ? 'Edit item' : 'New inventory item'}</DialogTitle>
          <DialogDescription>Set a reorder level to get low-stock alerts.</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Mozzarella" />
          </Field>
          <Field label="Category">
            <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Dairy" />
          </Field>
          <Field label="Unit">
            <Select value={form.unit} onValueChange={(value) => setForm({ ...form, unit: value as StockUnit })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNITS.map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {unit.toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Quantity in stock">
            <Input type="number" step="any" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </Field>
          <Field label="Reorder level">
            <Input type="number" step="any" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />
          </Field>
          <Field label={`Cost per unit (${currency})`}>
            <Input type="number" value={form.costPerUnit} onChange={(e) => setForm({ ...form, costPerUnit: e.target.value })} />
          </Field>
          <Field label="Expiry date">
            <Input type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
          </Field>
          {suppliers.length ? (
            <Field label="Supplier" className="sm:col-span-2">
              <Select value={form.supplierId} onValueChange={(value) => setForm({ ...form, supplierId: value })}>
                <SelectTrigger>
                  <SelectValue placeholder="None" />
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

function MovementDialog({ item, onClose }: { item: InventoryRow | null; onClose: () => void }) {
  const [type, setType] = React.useState<'PURCHASE' | 'WASTE' | 'ADJUSTMENT' | 'EXPIRY'>('PURCHASE')
  const [quantity, setQuantity] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (item) {
      setType('PURCHASE')
      setQuantity('')
      setReason('')
    }
  }, [item])

  const save = async () => {
    if (!item) return
    setSaving(true)
    const result = await recordStockMovement({
      itemId: item.id,
      type,
      quantity: Number(quantity),
      reason,
    })
    setSaving(false)
    if (result.ok) {
      toast.success(`New quantity: ${result.data.quantity}`)
      onClose()
    } else {
      toast.error(result.error)
    }
  }

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Stock movement — {item?.name}</DialogTitle>
          <DialogDescription>Currently {item?.quantity} {item?.unit.toLowerCase()} in stock.</DialogDescription>
        </DialogHeader>
        <Field label="Type">
          <Select value={type} onValueChange={(value) => setType(value as typeof type)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PURCHASE">Stock in (purchase)</SelectItem>
              <SelectItem value="WASTE">Waste</SelectItem>
              <SelectItem value="EXPIRY">Expired</SelectItem>
              <SelectItem value="ADJUSTMENT">Adjustment (+/−)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Quantity" hint={type === 'ADJUSTMENT' ? 'Use a negative number to reduce' : undefined}>
          <Input type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
