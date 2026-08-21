'use client'

import * as React from 'react'
import type { UserRole } from '@prisma/client'
import { Copy, KeyRound, MoreVertical, Pencil, Search, ShieldCheck, Trash2, UserPlus } from 'lucide-react'
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
import { Switch } from '@/components/ui/primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Avatar, AvatarFallback } from '@/components/ui/primitives'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RoleBadge } from '@/components/ui/status'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert } from '@/components/ui/feedback'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { initials } from '@/lib/utils'
import { ROLE_LABELS } from '@/lib/rbac'
import { useRouter } from 'next/navigation'

import { useAction } from '@/lib/use-action'
import { inviteStaff, removeStaff, setStaffPassword, updateStaff } from '../actions'
import { callAction } from '@/lib/use-action'

export interface StaffMember {
  id: string
  name: string
  email: string
  phone: string | null
  role: UserRole
  isActive: boolean
  lastLoginAt: string | null
  /** null means every location — see ALL_LOCATIONS below. */
  branchId: string | null
  branchName: string | null
}

export interface StaffLocation {
  id: string
  name: string
  isActive: boolean
}

/*
 * The sentinel for "every location".
 *
 * Radix's Select refuses an empty string as an item value — it reserves that
 * for "nothing chosen" and clears the trigger — so the null case needs a value
 * of its own, converted back on the way to the server. It is not merely "no
 * location set": a manager with no branch is a group manager who sees the whole
 * chain, and that is the choice being made here.
 */
const ALL_LOCATIONS = '__all__'

export function StaffManager({
  staff: initial,
  assignableRoles,
  locations,
  canManage,
  currentUserId,
}: {
  staff: StaffMember[]
  assignableRoles: UserRole[]
  locations: StaffLocation[]
  canManage: boolean
  currentUserId: string
}) {
  const [staff, setStaff] = React.useState(initial)
  /*
   * Filtered in the browser, not the URL. A restaurant's staff list is tens of
   * rows and entirely on screen already, so a round trip per keystroke would
   * cost more than the filter saves — unlike orders or the audit log, which are
   * paged and must be searched in the query.
   */
  const [search, setSearch] = React.useState('')
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<StaffMember | null>(null)
  const [passwordFor, setPasswordFor] = React.useState<StaffMember | null>(null)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  React.useEffect(() => setStaff(initial), [initial])

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await callAction(() => removeStaff(id))
    if (result.ok) {
      setStaff((current) => current.filter((member) => member.id !== id))
      toast.success('Staff member removed')
    } else {
      toast.error(result.error)
    }
  }

  const visible = React.useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return staff
    return staff.filter((member) =>
      [
        member.name,
        member.email,
        member.phone,
        ROLE_LABELS[member.role],
        member.branchName,
      ].some((field) => field?.toLowerCase().includes(term)),
    )
  }, [staff, search])

  return (
    <>
      <PageHeader
        title="Staff"
        description={`${staff.filter((member) => member.isActive).length} active team members`}
        actions={
          canManage ? (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus /> Add staff
            </Button>
          ) : null
        }
      />

      <div className="mb-4 max-w-sm">
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Name, email, phone, code or role…"
          aria-label="Search staff"
          startIcon={<Search className="size-4" />}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title={search ? `Nobody matches “${search}”` : 'No staff yet'}
          description={
            search
              ? 'Try part of a name, an email, a phone number or a staff code.'
              : 'Invite your team to give them access.'
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Works at</TableHead>
                <TableHead className="hidden md:table-cell">Contact</TableHead>
                <TableHead className="hidden lg:table-cell">Last active</TableHead>
                <TableHead>Status</TableHead>
                {canManage ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="size-9">
                        <AvatarFallback>{initials(member.name)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="font-medium">
                          {member.name}
                          {member.id === currentUserId ? (
                            <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <RoleBadge role={member.role} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {member.branchName ?? (
                      <span className="text-muted-foreground">All locations</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    {member.phone ?? '—'}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                    {member.lastLoginAt
                      ? new Date(member.lastLoginAt).toLocaleDateString()
                      : 'Never'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={member.isActive ? 'success' : 'secondary'}>
                      {member.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  {canManage ? (
                    <TableCell>
                      {member.role !== 'OWNER' && member.id !== currentUserId ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label="Actions">
                              <MoreVertical />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditing(member)}>
                              <Pencil /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setPasswordFor(member)}>
                              <KeyRound /> Set password
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive onClick={() => setDeleteId(member.id)}>
                              <Trash2 /> Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        roles={assignableRoles}
        locations={locations}
      />
      <EditDialog
        member={editing}
        roles={assignableRoles}
        locations={locations}
        onClose={() => setEditing(null)}
      />
      <PasswordDialog member={passwordFor} onClose={() => setPasswordFor(null)} />

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Remove this staff member?"
        description="They will lose access immediately. Their past activity is preserved."
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </>
  )
}

/**
 * Where this person works.
 *
 * "All locations" is spelled out rather than left as a blank option because it
 * is a real decision, not an omission: someone with no location sees every
 * site's figures, which is what a group manager should do and what a site
 * manager should not.
 */
function WorksAtField({
  value,
  onChange,
  locations,
}: {
  value: string
  onChange: (value: string) => void
  locations: StaffLocation[]
}) {
  return (
    <Field
      label="Works at"
      hint="All locations means they see every site. Pick one to confine them to it."
    >
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_LOCATIONS}>All locations</SelectItem>
          {locations.map((location) => (
            <SelectItem key={location.id} value={location.id}>
              {location.name}
              {location.isActive ? '' : ' (switched off)'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function InviteDialog({
  open,
  onOpenChange,
  roles,
  locations,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roles: UserRole[]
  locations: StaffLocation[]
}) {
  const [form, setForm] = React.useState({
    name: '', email: '', phone: '', role: roles[0] ?? 'WAITER', branchId: ALL_LOCATIONS,
  })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [credentials, setCredentials] = React.useState<{ password: string; emailed: boolean } | null>(null)

  React.useEffect(() => {
    if (open) {
      setForm({
        name: '', email: '', phone: '', role: roles[0] ?? 'WAITER', branchId: ALL_LOCATIONS,
      })
      setError(null)
      setCredentials(null)
    }
  }, [open, roles])

  const invite = async () => {
    setSaving(true)
    setError(null)
    const result = await callAction(() =>
      inviteStaff({ ...form, branchId: form.branchId === ALL_LOCATIONS ? null : form.branchId }),
    )
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setCredentials({ password: result.data.temporaryPassword, emailed: result.data.emailed })
    toast.success('Staff member added')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add a staff member</DialogTitle>
          <DialogDescription>They receive a temporary password to sign in and change.</DialogDescription>
        </DialogHeader>

        {credentials ? (
          <div className="space-y-3">
            <Alert variant="success" title="Account created">
              {credentials.emailed
                ? 'An invite email with sign-in details has been sent.'
                : 'Email is not configured — share these details securely.'}
            </Alert>
            <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <span className="font-mono">{credentials.password}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  void navigator.clipboard.writeText(credentials.password)
                  toast.success('Copied')
                }}
                aria-label="Copy password"
              >
                <Copy />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Field label="Name" required>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Email" required>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
            <Field label="Role" required>
              <Select value={form.role} onValueChange={(value) => setForm({ ...form, role: value as UserRole })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <WorksAtField
              value={form.branchId}
              onChange={(branchId) => setForm({ ...form, branchId })}
              locations={locations}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={invite} loading={saving}>
                Add member
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function EditDialog({
  member,
  roles,
  locations,
  onClose,
}: {
  member: StaffMember | null
  roles: UserRole[]
  locations: StaffLocation[]
  onClose: () => void
}) {
  const [form, setForm] = React.useState({
    name: '', phone: '', role: 'WAITER' as UserRole, isActive: true, branchId: ALL_LOCATIONS,
  })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (member) {
      setForm({
        name: member.name,
        phone: member.phone ?? '',
        role: member.role,
        isActive: member.isActive,
        branchId: member.branchId ?? ALL_LOCATIONS,
      })
      setError(null)
    }
  }, [member])

  const save = async () => {
    if (!member) return
    setSaving(true)
    const result = await callAction(() =>
      updateStaff({
        id: member.id,
        ...form,
        branchId: form.branchId === ALL_LOCATIONS ? null : form.branchId,
      }),
    )
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toast.success('Staff member updated')
    onClose()
  }

  return (
    <Dialog open={Boolean(member)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Edit {member?.name}</DialogTitle>
          <DialogDescription>Update their role and access.</DialogDescription>
        </DialogHeader>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Field label="Name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Role" required>
          <Select value={form.role} onValueChange={(value) => setForm({ ...form, role: value as UserRole })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((role) => (
                <SelectItem key={role} value={role}>
                  {ROLE_LABELS[role]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <WorksAtField
          value={form.branchId}
          onChange={(branchId) => setForm({ ...form, branchId })}
          locations={locations}
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={form.isActive} onCheckedChange={(v) => setForm({ ...form, isActive: v })} />
          Active — can sign in
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
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

/**
 * The owner setting someone's password by hand.
 *
 * For the member of staff who would rather have something they can remember
 * than a printed code. Doing so clears their sign-in code, because a card
 * showing a code that is no longer the password is worse than no card.
 *
 * The same strength rules apply as anywhere else — this route must not become
 * the weak one, since the generated codes it replaces are eight random
 * characters.
 */
function PasswordDialog({
  member,
  onClose,
}: {
  member: StaffMember | null
  onClose: () => void
}) {
  const router = useRouter()
  const { busy, run } = useAction()
  const [password, setPassword] = React.useState('')
  const [fieldError, setFieldError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setPassword('')
    setFieldError(null)
  }, [member])

  const submit = () =>
    run(() => setStaffPassword({ userId: member!.id, password }), {
      success: `Password updated for ${member?.name}`,
      onFail: (result) => {
        setFieldError(result.fieldErrors?.password?.[0] ?? result.error)
      },
      onDone: () => {
        onClose()
        router.refresh()
      },
    })

  return (
    <Dialog open={Boolean(member)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set a password for {member?.name}</DialogTitle>
          <DialogDescription>
            They sign in with <strong>{member?.email}</strong>. This replaces their sign-in code,
            and signs them out of any device they are already using.
          </DialogDescription>
        </DialogHeader>

        <Field label="New password" htmlFor="staff-password" required error={fieldError ?? undefined}>
          <Input
            id="staff-password"
            type="text"
            autoComplete="off"
            placeholder="At least 8 characters, with a capital and a number"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setFieldError(null)
            }}
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          Shown as you type so you can read it out to them.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy || password.length < 8}>
            {busy ? 'Saving…' : 'Set password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
