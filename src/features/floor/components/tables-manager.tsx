'use client'

import * as React from 'react'
import {
  ArrowRightLeft, Building2, ClipboardList, LayoutGrid, Pencil, Plus, Trash2, Users,
} from 'lucide-react'
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
  moveTable,
  saveTable,
  updateTableStatus,
} from '../actions'

import type { TableStatus } from '@prisma/client'
import { callAction } from '@/lib/use-action'

export interface ManagedTable {
  id: string
  number: string
  label: string | null
  area: string | null
  capacity: number
  status: TableStatus
  notes: string | null
  /** Which building this table stands in. Never null — the column is required. */
  branchId: string
  branchName: string
  openOrders: number
}

export interface TableBranch {
  id: string
  name: string
}

const STATUSES: TableStatus[] = ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'OUT_OF_SERVICE']

export function TablesManager({
  tables: initial,
  canManage,
  branches,
  selectedBranchId,
}: {
  tables: ManagedTable[]
  canManage: boolean
  /** Locations this user may put a table at. */
  branches: TableBranch[]
  /** What the top-bar switcher is showing. Null means "All locations". */
  selectedBranchId: string | null
}) {
  const [tables, setTables] = React.useState(initial)
  const [editing, setEditing] = React.useState<ManagedTable | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  const [moving, setMoving] = React.useState<ManagedTable | null>(null)

  /*
   * Whether to name the branch on each card.
   *
   * On "All locations" the list mixes branches, and Kandy's table 4 and
   * Colombo's table 4 rendered identically — same big number, no way to tell
   * them apart. With one location chosen every card would say the same thing,
   * so the label would be noise.
   */
  const showBranch = selectedBranchId === null && branches.length > 1

  React.useEffect(() => setTables(initial), [initial])

  const areas = groupBy(tables, (table) => table.area ?? 'Main')

  const changeStatus = async (table: ManagedTable, status: TableStatus) => {
    setTables((current) =>
      current.map((entry) => (entry.id === table.id ? { ...entry, status } : entry)),
    )
    const result = await callAction(() => updateTableStatus({ id: table.id, status }))
    if (!result.ok) {
      setTables(initial)
      toast.error(result.error)
    }
  }

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await callAction(() => deleteTable(id))
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

                    {showBranch ? (
                      <p className="mt-1 flex items-center gap-1 truncate text-xs font-medium text-primary">
                        <Building2 className="size-3 shrink-0" />
                        {table.branchName}
                      </p>
                    ) : null}

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
                          {branches.length > 1 ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="flex-1"
                              onClick={() => setMoving(table)}
                              aria-label={`Move table ${table.number} to another location`}
                              title="Move to another location"
                            >
                              <ArrowRightLeft />
                            </Button>
                          ) : null}
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

      <TableDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        table={editing}
        branches={branches}
        selectedBranchId={selectedBranchId}
      />
      <BulkDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        tables={tables}
        branches={branches}
        selectedBranchId={selectedBranchId}
      />
      <MoveDialog
        table={moving}
        branches={branches}
        onOpenChange={(open) => !open && setMoving(null)}
      />

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
  branches,
  selectedBranchId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  table: ManagedTable | null
  branches: TableBranch[]
  selectedBranchId: string | null
}) {
  const [form, setForm] = React.useState({ number: '', label: '', area: '', capacity: '4', notes: '' })
  /*
   * Which location the new table stands in.
   *
   * This field did not exist, and neither did anything behind it: the form sent
   * no branch, so `saveTable` fell through to the restaurant's DEFAULT branch
   * every time an owner used it. Adding a table while looking at Branch 01
   * created it at Main — where it either vanished from the filtered list or
   * collided with Main's existing number and reported "Table 1 already exists
   * at this location" against an empty floor plan.
   *
   * It opens on whatever the switcher is showing, so the ordinary path is one
   * fewer decision. On "All locations" there is no right default and the owner
   * is asked.
   */
  const [branchId, setBranchId] = React.useState('')
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
    setBranchId(
      table?.branchId ??
        selectedBranchId ??
        (branches.length === 1 ? branches[0].id : ''),
    )
  }, [open, table, selectedBranchId, branches])

  const save = async () => {
    if (!table && !branchId) {
      setError('Choose which location this table is at.')
      return
    }
    setSaving(true)
    const result = await callAction(() => saveTable({
      id: table?.id,
      branchId,
      number: form.number,
      label: form.label,
      area: form.area,
      capacity: Number(form.capacity),
      status: table?.status ?? 'AVAILABLE',
      notes: form.notes,
    }))
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

        {branches.length > 1 ? (
          <Field
            label="Location"
            required
            hint={table ? 'Use “Move” on the card to change this' : undefined}
          >
            <Select
              value={branchId}
              onValueChange={setBranchId}
              // Editing never moves a table between branches — that is what the
              // move button is for, and it checks for open orders first.
              disabled={Boolean(table)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a location" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

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
  tables,
  branches,
  selectedBranchId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tables: ManagedTable[]
  branches: TableBranch[]
  selectedBranchId: string | null
}) {
  const [branchId, setBranchId] = React.useState('')
  const [count, setCount] = React.useState('10')
  const [startFrom, setStartFrom] = React.useState('1')
  const [capacity, setCapacity] = React.useState('4')
  const [area, setArea] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setBranchId(selectedBranchId ?? (branches.length === 1 ? branches[0].id : ''))
  }, [open, selectedBranchId, branches])

  /*
   * Start numbering after what the TARGET branch already has.
   *
   * It used to count the rows on screen, which on "All locations" is every
   * branch's tables added together — so adding to an empty Branch 01 proposed
   * starting at 31 because Main had thirty. Numbers restart per branch, so the
   * only count that means anything is the destination's.
   */
  React.useEffect(() => {
    if (!open) return
    const here = branchId ? tables.filter((t) => t.branchId === branchId) : []
    setStartFrom(String(here.length + 1))
  }, [open, branchId, tables])

  const create = async () => {
    if (!branchId) {
      setError('Choose which location these tables are at.')
      return
    }
    setSaving(true)
    const result = await callAction(() => createTablesBulk({
      branchId,
      count: Number(count),
      startFrom: Number(startFrom),
      capacity: Number(capacity),
      area,
    }))
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

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {branches.length > 1 ? (
          <Field label="Location" required>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a location" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

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

/**
 * Move a table to another location.
 *
 * The counterpart to the rule that editing a table never changes its branch.
 * That rule exists because `saveTable` used to overwrite `branchId` with
 * whatever the editor's own branch resolved to, silently dragging a table —
 * and every order ever taken at it — into another building. Blocking the
 * accident left no way to correct one, and every table in this system was
 * created at the default branch, so correcting them is exactly what is needed.
 *
 * So: deliberate, one at a time, and refused by the server while the table has
 * an order that is not finished. A table with people sitting at it does not
 * move.
 */
function MoveDialog({
  table,
  branches,
  onOpenChange,
}: {
  table: ManagedTable | null
  branches: TableBranch[]
  onOpenChange: (open: boolean) => void
}) {
  const [target, setTarget] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    setTarget('')
    setError(null)
  }, [table])

  const elsewhere = branches.filter((b) => b.id !== table?.branchId)

  const move = async () => {
    if (!table || !target) return
    setSaving(true)
    const result = await callAction(() => moveTable({ id: table.id, branchId: target }))
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success(`Table ${table.number} moved`)
    onOpenChange(false)
  }

  return (
    <Dialog open={Boolean(table)} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Move table {table?.number}</DialogTitle>
          <DialogDescription>
            It keeps its number, its history and every order ever taken at it. Guests at the new
            location will reach it by scanning that location&rsquo;s QR code.
          </DialogDescription>
        </DialogHeader>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <p className="text-sm text-muted-foreground">
          Currently at <span className="font-medium text-foreground">{table?.branchName}</span>.
        </p>

        <Field label="Move to" required>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a location" />
            </SelectTrigger>
            <SelectContent>
              {elsewhere.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={move} loading={saving} disabled={!target}>
            Move table
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
