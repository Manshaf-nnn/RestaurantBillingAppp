'use client'

import { LocalDateTime } from '@/components/local-time'
import * as React from 'react'
import Link from 'next/link'
import type { ReservationStatus } from '@prisma/client'
import { BarChart3, CalendarClock, CalendarX2, Eye, MoreVertical, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { SendSmsButton } from '@/features/sms/components/send-sms-button'
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
import { cancelReservationAction, deleteReservation, saveReservation } from '../actions'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'

const STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']

/** Grace periods offered for a no-show. Enforced every quarter hour, so finer is not honest. */
const NO_SHOW_CHOICES = [15, 20, 30, 45, 60, 90, 120]

/** A ready-to-send nudge for a guest who has not arrived yet. */
function reminderText(booking: ReservationRow, tableNumber: string): string {
  const first = booking.customerName.trim().split(/\s+/)[0] ?? ''
  const at = new Date(booking.reservedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const grace = booking.noShowAfterMinutes
    ? ` We can hold table ${tableNumber} until ${new Date(new Date(booking.reservedAt).getTime() + booking.noShowAfterMinutes * 60_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
    : ''
  return `Hi ${first}, your table for ${booking.partySize} was booked for ${at}. Are you still coming?${grace}`
}
/** A booking in one of these still holds its table, so it can be cancelled. */
const CANCELLABLE: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'SEATED']

export interface ReservationRow {
  id: string
  customerName: string
  customerPhone: string
  customerEmail: string | null
  partySize: number
  reservedAt: string
  /** ISO. Start + duration (abc.md §4). */
  endsAt: string
  durationMinutes: number
  tableId: string | null
  tableNumber: string | null
  branchName: string | null
  status: ReservationStatus
  notes: string | null
  createdAt: string
  cancelledAt: string | null
  cancelReason: string | null
  cancelledByName: string | null
  /** Cancels itself if the party is this many minutes late. Null: never. */
  noShowAfterMinutes: number | null
}

/** A table that is spoken for right now, and by whom. */
export interface ReservedTable {
  tableId: string
  number: string
  capacity: number
  branchName: string | null
  reservationId: string
  customerName: string
  partySize: number
  reservedAt: string
  endsAt: string
}

export function ReservationsManager({
  reservations: initial,
  heldBookings = [],
  reservedTables,
  tableCount,
  tables,
  locale,
}: {
  reservations: ReservationRow[]
  /**
   * The bookings behind held tables that fall outside the listed range. Not
   * shown in the list; they are what the cards' buttons act on.
   */
  heldBookings?: ReservationRow[]
  /** Tables held by a booking at this moment (aO.md §2), in table order. */
  reservedTables: ReservedTable[]
  /** How many active tables this person can see, for "3 of 12". */
  tableCount: number
  tables: Array<{ id: string; number: string; capacity: number; branchName?: string | null }>
  locale: string
}) {
  const [reservations, setReservations] = React.useState(initial)
  const [editing, setEditing] = React.useState<ReservationRow | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [viewing, setViewing] = React.useState<ReservationRow | null>(null)
  const [cancelling, setCancelling] = React.useState<ReservationRow | null>(null)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  React.useEffect(() => setReservations(initial), [initial])

  const byId = React.useMemo(
    () => new Map([...heldBookings, ...reservations].map((r) => [r.id, r])),
    [heldBookings, reservations],
  )

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await callAction(() => deleteReservation(id))
    if (result.ok) {
      setReservations((current) => current.filter((r) => r.id !== id))
      toast.success('Reservation removed')
    } else {
      toast.error(result.error)
    }
  }

  const upcoming = reservations.filter((r) => new Date(r.reservedAt) >= new Date() && CANCELLABLE.includes(r.status))
  const showBranch = new Set(reservations.map((r) => r.branchName)).size > 1

  return (
    <>
      <PageHeader
        title="Reservations"
        description={`${upcoming.length} upcoming · ${reservedTables.length} of ${tableCount} table${tableCount === 1 ? '' : 's'} under reservation now`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href="/dashboard/reports/reservations">
                <BarChart3 /> Report
              </Link>
            </Button>
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus /> New reservation
            </Button>
          </div>
        }
      />

      {/*
        The floor's view of the diary: which tables are spoken for right now
        and by whom — what a host at the door needs before seating a walk-in.
        Same rule the tables screen uses (`reservationsHolding`), so the two
        never disagree about a table.
      */}
      <section className="mb-4 rounded-xl border bg-card p-4 shadow-soft">
        <header className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Tables under reservation now</h2>
          <span className="text-xs text-muted-foreground">
            {reservedTables.length === 0 ? 'None held at the moment' : `${reservedTables.length} held`}
          </span>
        </header>
        {reservedTables.length === 0 ? (
          <p className="text-sm text-muted-foreground">No table is held by a booking right now. Every active table is free to seat.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {reservedTables.map((held) => {
              const booking = byId.get(held.reservationId)
              return (
                <li key={held.tableId} className="rounded-lg border border-warning/40 bg-warning/5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        Table {held.number}
                        {held.branchName ? <span className="ml-1 text-xs font-normal text-muted-foreground">{held.branchName}</span> : null}
                      </p>
                      <p className="truncate text-sm">
                        {held.customerName} · <Users className="inline size-3.5 text-muted-foreground" /> {held.partySize}
                        <span className="text-muted-foreground"> of {held.capacity}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <LocalDateTime value={held.reservedAt} locale={locale} options={{ dateStyle: 'medium', timeStyle: 'short' }} />
                        {' – '}
                        <LocalDateTime value={held.endsAt} locale={locale} options={{ timeStyle: 'short' }} />
                      </p>
                    </div>
                    <Badge variant="warning">Reserved</Badge>
                  </div>
                  {booking?.noShowAfterMinutes ? (
                    <p className="mt-1 text-xs text-warning">
                      Cancels itself at{' '}
                      <LocalDateTime
                        value={new Date(new Date(booking.reservedAt).getTime() + booking.noShowAfterMinutes * 60_000).toISOString()}
                        locale={locale}
                        options={{ timeStyle: 'short' }}
                      />{' '}
                      if they have not arrived
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => booking && setViewing(booking)} disabled={!booking}>
                      <Eye /> Details
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => booking && setCancelling(booking)} disabled={!booking}>
                      <CalendarX2 /> Cancel
                    </Button>
                    {booking?.customerPhone ? (
                      <SendSmsButton
                        entity="Reservation"
                        entityId={booking.id}
                        to={booking.customerPhone}
                        name={booking.customerName}
                        size="sm"
                        variant="ghost"
                        defaultText={reminderText(booking, held.number)}
                      />
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

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
                <TableRow key={reservation.id} className={cn(reservation.status === 'CANCELLED' && 'opacity-60')}>
                  <TableCell>
                    <button type="button" className="text-left font-medium hover:underline" onClick={() => setViewing(reservation)}>
                      {reservation.customerName}
                    </button>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      {reservation.customerPhone}
                      {reservation.customerPhone ? (
                        <SendSmsButton
                          entity="Reservation"
                          entityId={reservation.id}
                          to={reservation.customerPhone}
                          name={reservation.customerName}
                          size="sm"
                          variant="ghost"
                          iconOnly
                        />
                      ) : null}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    <LocalDateTime value={reservation.reservedAt} locale={locale} options={{ dateStyle: 'medium', timeStyle: 'short' }} />
                    <span className="text-muted-foreground">
                      {' – '}
                      <LocalDateTime value={reservation.endsAt} locale={locale} options={{ timeStyle: 'short' }} />
                      {` · ${reservation.durationMinutes} min`}
                    </span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="flex items-center gap-1 text-sm">
                      <Users className="size-3.5 text-muted-foreground" /> {reservation.partySize}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {reservation.tableNumber ? `Table ${reservation.tableNumber}` : '—'}
                    {showBranch && reservation.branchName ? <span className="ml-1 text-xs text-muted-foreground">{reservation.branchName}</span> : null}
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
                        <DropdownMenuItem onClick={() => setViewing(reservation)}>
                          <Eye /> Details
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(reservation)
                            setDialogOpen(true)
                          }}
                        >
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        {CANCELLABLE.includes(reservation.status) ? (
                          <DropdownMenuItem onClick={() => setCancelling(reservation)}>
                            <CalendarX2 /> Cancel booking
                          </DropdownMenuItem>
                        ) : null}
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

      <DetailsDialog
        reservation={viewing}
        locale={locale}
        onClose={() => setViewing(null)}
        onCancel={(row) => {
          setViewing(null)
          setCancelling(row)
        }}
        onEdit={(row) => {
          setViewing(null)
          setEditing(row)
          setDialogOpen(true)
        }}
      />

      <CancelDialog
        reservation={cancelling}
        onClose={() => setCancelling(null)}
        onCancelled={(id, reason, by) => {
          setReservations((current) =>
            current.map((r) => (r.id === id ? { ...r, status: 'CANCELLED', cancelledAt: new Date().toISOString(), cancelReason: reason, cancelledByName: by } : r)),
          )
          setCancelling(null)
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Remove this reservation?"
        description="This erases the booking from the diary and the report. To keep the record, cancel it instead."
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </>
  )
}

function DetailsDialog({
  reservation,
  locale,
  onClose,
  onCancel,
  onEdit,
}: {
  reservation: ReservationRow | null
  locale: string
  onClose: () => void
  onCancel: (row: ReservationRow) => void
  onEdit: (row: ReservationRow) => void
}) {
  if (!reservation) return null
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  )
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {reservation.customerName}
            <Badge className="ml-2 align-middle" variant={RESERVATION_STATUS_META[reservation.status].variant}>
              {RESERVATION_STATUS_META[reservation.status].label}
            </Badge>
          </DialogTitle>
          <DialogDescription>Booking details</DialogDescription>
        </DialogHeader>
        <dl>
          {row('Phone', reservation.customerPhone || '—')}
          {reservation.customerEmail ? row('Email', reservation.customerEmail) : null}
          {row('Party', `${reservation.partySize} guest${reservation.partySize === 1 ? '' : 's'}`)}
          {row(
            'When',
            <>
              <LocalDateTime value={reservation.reservedAt} locale={locale} options={{ dateStyle: 'medium', timeStyle: 'short' }} />
              {' – '}
              <LocalDateTime value={reservation.endsAt} locale={locale} options={{ timeStyle: 'short' }} />
            </>,
          )}
          {row('Held for', `${reservation.durationMinutes} minutes`)}
          {row(
            'Auto-cancel',
            reservation.noShowAfterMinutes
              ? `If not arrived ${reservation.noShowAfterMinutes} minutes after the booking time`
              : 'Off — the host decides',
          )}
          {row('Table', reservation.tableNumber ? `Table ${reservation.tableNumber}${reservation.branchName ? ` · ${reservation.branchName}` : ''}` : 'Not assigned')}
          {reservation.notes ? row('Notes', reservation.notes) : null}
          {row('Taken', <LocalDateTime value={reservation.createdAt} locale={locale} options={{ dateStyle: 'medium', timeStyle: 'short' }} />)}
          {reservation.status === 'CANCELLED'
            ? row(
                'Cancelled',
                <>
                  {reservation.cancelledAt ? <LocalDateTime value={reservation.cancelledAt} locale={locale} options={{ dateStyle: 'medium', timeStyle: 'short' }} /> : '—'}
                  {reservation.cancelledByName ? ` by ${reservation.cancelledByName}` : ''}
                  {reservation.cancelReason ? <span className="block text-muted-foreground">“{reservation.cancelReason}”</span> : null}
                </>,
              )
            : null}
        </dl>
        <DialogFooter>
          <Button variant="outline" onClick={() => onEdit(reservation)}>
            <Pencil /> Edit
          </Button>
          {CANCELLABLE.includes(reservation.status) ? (
            <Button variant="destructive" onClick={() => onCancel(reservation)}>
              <CalendarX2 /> Cancel booking
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CancelDialog({
  reservation,
  onClose,
  onCancelled,
}: {
  reservation: ReservationRow | null
  onClose: () => void
  onCancelled: (id: string, reason: string, by: string | null) => void
}) {
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    setReason('')
    setError(null)
  }, [reservation?.id])
  if (!reservation) return null

  const submit = async () => {
    setBusy(true)
    setError(null)
    const result = await callAction(() => cancelReservationAction({ id: reservation.id, reason }))
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success(`${reservation.customerName}'s booking cancelled${reservation.tableNumber ? ` — Table ${reservation.tableNumber} is free` : ''}`)
    onCancelled(reservation.id, reason.trim(), null)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel {reservation.customerName}&apos;s booking?</DialogTitle>
          <DialogDescription>
            {reservation.tableNumber ? `Table ${reservation.tableNumber} is released straight away. ` : ''}
            The booking stays in the diary as cancelled, with the reason, so the report can count it.
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Field label="Reason" required hint="Guest called to cancel, no-answer on confirmation, double booking…">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} autoFocus />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Keep booking
          </Button>
          <Button variant="destructive" onClick={submit} loading={busy} disabled={reason.trim().length < 2}>
            Cancel booking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  tables: Array<{ id: string; number: string; capacity: number; branchName?: string | null }>
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
    noShowAfterMinutes: '',
  })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setForm({
      customerName: reservation?.customerName ?? '',
      customerPhone: reservation?.customerPhone ?? '',
      customerEmail: reservation?.customerEmail ?? '',
      partySize: String(reservation?.partySize ?? 2),
      reservedAt: reservation ? reservation.reservedAt.slice(0, 16) : '',
      // Editing keeps what was booked (abc.md §4). These were hard-coded to
      // 90 and blank, so every edit silently reset the duration and dropped
      // the table.
      durationMinutes: String(reservation?.durationMinutes ?? 90),
      tableId: reservation?.tableId ?? '',
      status: reservation?.status ?? 'PENDING',
      notes: reservation?.notes ?? '',
      noShowAfterMinutes: reservation?.noShowAfterMinutes ? String(reservation.noShowAfterMinutes) : '',
    })
  }, [open, reservation])

  const save = async () => {
    setSaving(true)
    const result = await callAction(() => saveReservation({ id: reservation?.id, ...form }))
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
          <DialogDescription>Book a table for a guest. The table reads Reserved from the moment it is saved until the booking ends or the party sits down; two bookings cannot hold one table at once.</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Guest name" required>
            <Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
          </Field>
          <Field label="Phone" required>
            <Input value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.customerEmail} onChange={(e) => setForm({ ...form, customerEmail: e.target.value })} />
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
          <Field label="Duration" hint="Minutes the table is held (30–360)">
            <Input
              type="number"
              min={30}
              max={360}
              step={15}
              value={form.durationMinutes}
              onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
            />
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
                      Table {table.number} · seats {table.capacity}
                      {table.branchName ? ` · ${table.branchName}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field
            label="Cancel if not arrived within"
            hint="After the booking time. Frees the table by itself — text them first from the card."
          >
            <Select
              value={form.noShowAfterMinutes || 'never'}
              onValueChange={(value) => setForm({ ...form, noShowAfterMinutes: value === 'never' ? '' : value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Never — the host decides</SelectItem>
                {NO_SHOW_CHOICES.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
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
