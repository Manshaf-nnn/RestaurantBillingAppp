'use client'

import * as React from 'react'
import type { ReservationStatus } from '@prisma/client'
import { CalendarClock, MoreVertical, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'

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
import { Input, Textarea } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RESERVATION_STATUS_META } from '@/components/ui/status'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { deleteReservation, saveReservation } from '../actions'

const STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']

export interface ReservationRow {
  id: string
  customerName: string
  customerPhone: string
  partySize: number
  reservedAt: string
  tableNumber: string | null
  status: ReservationStatus
  notes: string | null
}

export function ReservationsManager({
  reservations: initial,
  tables,
  locale,
}: {
  reservations: ReservationRow[]
  tables: Array<{ id: string; number: string }>
  locale: string
}) {
  const [reservations, setReservations] = React.useState(initial)
  const [editing, setEditing] = React.useState<ReservationRow | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  React.useEffect(() => setReservations(initial), [initial])

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await deleteReservation(id)
    if (result.ok) {
      setReservations((current) => current.filter((r) => r.id !== id))
      toast.success('Reservation removed')
    } else {
      toast.error(result.error)
    }
  }

  const upcoming = reservations.filter((r) => new Date(r.reservedAt) >= new Date())

  return (
    <>
      <PageHeader
        title="Reservations"
        description={`${upcoming.length} upcoming`}
        actions={
          <Button
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus /> New reservation
          </Button>
        }
      />

      {reservations.length === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          title="No reservations"
          description="Take a booking to reserve a table for your guests."
          action={
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus /> Add a reservation
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Guest</TableHead>
                <TableHead>When</TableHead>
                <TableHead className="hidden sm:table-cell">Party</TableHead>
                <TableHead className="hidden md:table-cell">Table</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {reservations.map((reservation) => (
                <TableRow key={reservation.id}>
                  <TableCell>
                    <p className="font-medium">{reservation.customerName}</p>
                    <p className="text-xs text-muted-foreground">{reservation.customerPhone}</p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {new Date(reservation.reservedAt).toLocaleString(locale, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="flex items-center gap-1 text-sm">
                      <Users className="size-3.5 text-muted-foreground" /> {reservation.partySize}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {reservation.tableNumber ? `Table ${reservation.tableNumber}` : '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={RESERVATION_STATUS_META[reservation.status].variant}>
                      {RESERVATION_STATUS_META[reservation.status].label}
                    </Badge>
                  </TableCell>
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
                            setEditing(reservation)
                            setDialogOpen(true)
                          }}
                        >
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive onClick={() => setDeleteId(reservation.id)}>
                          <Trash2 /> Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ReservationDialog open={dialogOpen} onOpenChange={setDialogOpen} reservation={editing} tables={tables} />

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Remove this reservation?"
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </>
  )
}

function ReservationDialog({
  open,
  onOpenChange,
  reservation,
  tables,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  reservation: ReservationRow | null
  tables: Array<{ id: string; number: string }>
}) {
  const [form, setForm] = React.useState({
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    partySize: '2',
    reservedAt: '',
    durationMinutes: '90',
    tableId: '',
    status: 'PENDING' as ReservationStatus,
    notes: '',
  })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setForm({
      customerName: reservation?.customerName ?? '',
      customerPhone: reservation?.customerPhone ?? '',
      customerEmail: '',
      partySize: String(reservation?.partySize ?? 2),
      reservedAt: reservation ? reservation.reservedAt.slice(0, 16) : '',
      durationMinutes: '90',
      tableId: '',
      status: reservation?.status ?? 'PENDING',
      notes: reservation?.notes ?? '',
    })
  }, [open, reservation])

  const save = async () => {
    setSaving(true)
    const result = await saveReservation({ id: reservation?.id, ...form })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success('Reservation saved')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="default">
        <DialogHeader>
          <DialogTitle>{reservation ? 'Edit reservation' : 'New reservation'}</DialogTitle>
          <DialogDescription>Book a table for a guest.</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Guest name" required>
            <Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
          </Field>
          <Field label="Phone" required>
            <Input value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} />
          </Field>
          <Field label="Date & time" required>
            <Input
              type="datetime-local"
              value={form.reservedAt}
              onChange={(e) => setForm({ ...form, reservedAt: e.target.value })}
            />
          </Field>
          <Field label="Party size" required>
            <Input type="number" value={form.partySize} onChange={(e) => setForm({ ...form, partySize: e.target.value })} />
          </Field>
          {tables.length ? (
            <Field label="Table">
              <Select value={form.tableId} onValueChange={(value) => setForm({ ...form, tableId: value })}>
                <SelectTrigger>
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  {tables.map((table) => (
                    <SelectItem key={table.id} value={table.id}>
                      Table {table.number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field label="Status">
            <Select value={form.status} onValueChange={(value) => setForm({ ...form, status: value as ReservationStatus })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {RESERVATION_STATUS_META[status].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
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
