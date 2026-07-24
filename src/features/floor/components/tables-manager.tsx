'use client'

import * as React from 'react'
import { ClipboardList, LayoutGrid, Pencil, Plus, Trash2, Users } from 'lucide-react'
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
import { TableStatusBadge, TABLE_STATUS_META } from '@/components/ui/status'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { cn, groupBy } from '@/lib/utils'
import {
  createTablesBulk,
  deleteTable,
  saveTable,
  updateTableStatus,
} from '../actions'

type TableStatus = 'AVAILABLE' | 'OCCUPIED' | 'RESERVED' | 'CLEANING' | 'OUT_OF_SERVICE'

export interface ManagedTable {
  id: string
  number: string
  label: string | null
  area: string | null
  capacity: number
  status: TableStatus
  notes: string | null
  openOrders: number
}

const STATUSES: TableStatus[] = ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'OUT_OF_SERVICE']

export function TablesManager({
  tables: initial,
  canManage,
}: {
  tables: ManagedTable[]
  canManage: boolean
}) {
  const [tables, setTables] = React.useState(initial)
  const [editing, setEditing] = React.useState<ManagedTable | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  React.useEffect(() => setTables(initial), [initial])

  const areas = groupBy(tables, (table) => table.area ?? 'Main')

  const changeStatus = async (table: ManagedTable, status: TableStatus) => {
    setTables((current) =>
      current.map((entry) => (entry.id === table.id ? { ...entry, status } : entry)),
    )
    const result = await updateTableStatus({ id: table.id, status })
    if (!result.ok) {
      setTables(initial)
      toast.error(result.error)
    }
  }

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await deleteTable(id)
    if (result.ok) {
      setTables((current) => current.filter((table) => table.id !== id))
      toast.success('Table deleted')
    } else {
      toast.error(result.error)
    }
  }

  const available = tables.filter((table) => table.status === 'AVAILABLE').length
  const occupied = tables.filter((table) => table.status === 'OCCUPIED').length

  return (
    <>
      <PageHeader
        title="Tables"
        description={`${tables.length} tables · ${available} available · ${occupied} occupied`}
        actions={
          canManage ? (
            <>
              <Button variant="outline" onClick={() => setBulkOpen(true)}>
                <LayoutGrid /> Bulk add
              </Button>
              <Button
                onClick={() => {
                  setEditing(null)
                  setDialogOpen(true)
                }}
              >
                <Plus /> Add table
              </Button>
            </>
          ) : null
        }
      />

      {tables.length === 0 ? (
        <EmptyState
          icon={<ClipboardList />}
          title="No tables yet"
          description="Add tables so guests can enter their table number after scanning the QR code."
          action={
            canManage ? (
              <Button onClick={() => setBulkOpen(true)}>
                <LayoutGrid /> Bulk add tables
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="space-y-6">
          {Object.entries(areas).map(([area, areaTables]) => (
            <section key={area}>
              <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{area}</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                {areaTables.map((table) => (
                  <div
                    key={table.id}
                    className={cn(
                      'group relative rounded-xl border bg-card p-4 shadow-soft transition-colors',
                      table.status === 'OCCUPIED' && 'border-primary/40 bg-primary/5',
                      table.status === 'CLEANING' && 'border-warning/40 bg-warning/5',
                      table.status === 'OUT_OF_SERVICE' && 'opacity-60',
                    )}
                  >
                    <div className="flex items-start justify-between">
                      <span className="text-2xl font-bold leading-none">{table.number}</span>
                      <span
                        className={cn('size-2.5 rounded-full', TABLE_STATUS_META[table.status].dot)}
                      />
                    </div>

                    {table.label ? (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{table.label}</p>
                    ) : null}

                    <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                      <Users className="size-3" /> {table.capacity}
                      {table.openOrders > 0 ? (
                        <Badge variant="warning" size="sm" className="ml-auto">
                          {table.openOrders} open
                        </Badge>
                      ) : null}
                    </p>

                    {canManage ? (
                      <div className="mt-3 space-y-2">
                        <Select
                          value={table.status}
                          onValueChange={(value) => changeStatus(table, value as TableStatus)}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUSES.map((status) => (
                              <SelectItem key={status} value={status}>
                                {TABLE_STATUS_META[status].label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="flex-1"
                            onClick={() => {
                              setEditing(table)
                              setDialogOpen(true)
                            }}
                            aria-label="Edit"
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="flex-1 text-muted-foreground hover:text-destructive"
                            onClick={() => setDeleteId(table.id)}
                            aria-label="Delete"
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2">
                        <TableStatusBadge status={table.status} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <TableDialog open={dialogOpen} onOpenChange={setDialogOpen} table={editing} />
      <BulkDialog open={bulkOpen} onOpenChange={setBulkOpen} existingCount={tables.length} />

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete this table?"
        description="Tables with open orders cannot be deleted."
        confirmLabel="Delete"
        destructive
        onConfirm={remove}
      />
    </>
  )
}

function TableDialog({
  open,
  onOpenChange,
  table,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  table: ManagedTable | null
}) {
  const [form, setForm] = React.useState({ number: '', label: '', area: '', capacity: '4', notes: '' })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setForm({
      number: table?.number ?? '',
      label: table?.label ?? '',
      area: table?.area ?? '',
      capacity: String(table?.capacity ?? 4),
      notes: table?.notes ?? '',
    })
  }, [open, table])

  const save = async () => {
    setSaving(true)
    const result = await saveTable({
      id: table?.id,
      number: form.number,
      label: form.label,
      area: form.area,
      capacity: Number(form.capacity),
      status: table?.status ?? 'AVAILABLE',
      notes: form.notes,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success('Table saved')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{table ? `Edit table ${table.number}` : 'New table'}</DialogTitle>
          <DialogDescription>Guests type this number after scanning the QR code.</DialogDescription>
        </DialogHeader>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Number" required>
            <Input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} placeholder="12" />
          </Field>
          <Field label="Seats" required>
            <Input
              type="number"
              value={form.capacity}
              onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Label" hint="Optional">
          <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Window seat" />
        </Field>
        <Field label="Area" hint="e.g. Main, Terrace, Bar">
          <Input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} placeholder="Main" />
        </Field>

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

function BulkDialog({
  open,
  onOpenChange,
  existingCount,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingCount: number
}) {
  const [count, setCount] = React.useState('10')
  const [startFrom, setStartFrom] = React.useState(String(existingCount + 1))
  const [capacity, setCapacity] = React.useState('4')
  const [area, setArea] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open) setStartFrom(String(existingCount + 1))
  }, [open, existingCount])

  const create = async () => {
    setSaving(true)
    const result = await createTablesBulk({
      count: Number(count),
      startFrom: Number(startFrom),
      capacity: Number(capacity),
      area,
    })
    setSaving(false)
    if (result.ok) {
      toast.success(`${result.data.created} tables created`)
      onOpenChange(false)
    } else {
      toast.error(result.error)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Bulk add tables</DialogTitle>
          <DialogDescription>Create a run of numbered tables in one go.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          <Field label="How many">
            <Input type="number" value={count} onChange={(e) => setCount(e.target.value)} />
          </Field>
          <Field label="Start from">
            <Input type="number" value={startFrom} onChange={(e) => setStartFrom(e.target.value)} />
          </Field>
          <Field label="Seats each">
            <Input type="number" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          </Field>
          <Field label="Area">
            <Input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Main" />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={create} loading={saving}>
            Create tables
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
