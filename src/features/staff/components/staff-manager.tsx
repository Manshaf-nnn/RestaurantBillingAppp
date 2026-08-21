'use client'

import * as React from 'react'
import type { UserRole } from '@prisma/client'
import { Copy, KeyRound, MoreVertical, Pencil, ShieldCheck, Trash2, UserPlus } from 'lucide-react'
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
}

export function StaffManager({
  staff: initial,
  assignableRoles,
  canManage,
  currentUserId,
}: {
  staff: StaffMember[]
  assignableRoles: UserRole[]
  canManage: boolean
  currentUserId: string
}) {
  const [staff, setStaff] = React.useState(initial)
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

      {staff.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} title="No staff yet" description="Invite your team to give them access." />
      ) : (
        <div className="rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden md:table-cell">Contact</TableHead>
                <TableHead className="hidden lg:table-cell">Last active</TableHead>
                <TableHead>Status</TableHead>
                {canManage ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.map((member) => (
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

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} roles={assignableRoles} />
      <EditDialog
        member={editing}
        roles={assignableRoles}
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

function InviteDialog({
  open,
  onOpenChange,
  roles,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roles: UserRole[]
}) {
  const [form, setForm] = React.useState({ name: '', email: '', phone: '', role: roles[0] ?? 'WAITER' })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [credentials, setCredentials] = React.useState<{ password: string; emailed: boolean } | null>(null)

  React.useEffect(() => {
    if (open) {
      setForm({ name: '', email: '', phone: '', role: roles[0] ?? 'WAITER' })
      setError(null)
      setCredentials(null)
    }
  }, [open, roles])

  const invite = async () => {
    setSaving(true)
    setError(null)
    const result = await callAction(() => inviteStaff(form))
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
  onClose,
}: {
  member: StaffMember | null
  roles: UserRole[]
  onClose: () => void
}) {
  const [form, setForm] = React.useState({ name: '', phone: '', role: 'WAITER' as UserRole, isActive: true })
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (member) {
      setForm({
        name: member.name,
        phone: member.phone ?? '',
        role: member.role,
        isActive: member.isActive,
      })
      setError(null)
    }
  }, [member])

  const save = async () => {
    if (!member) return
    setSaving(true)
    const result = await callAction(() => updateStaff({ id: member.id, ...form }))
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
