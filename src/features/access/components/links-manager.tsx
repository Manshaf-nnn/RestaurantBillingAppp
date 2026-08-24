'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Copy, KeyRound, Link2, Monitor, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { callAction } from '@/lib/use-action'

import {
  createAccessLink,
  regenerateAccessLink,
  regenerateLinkCode,
  revokeAccessLink,
  setAccessLinkActive,
} from '../link-actions'

export interface LinkRow {
  id: string
  label: string | null
  mode: 'PERSONAL' | 'SHARED_DEVICE'
  role: string
  roleLabel: string
  staffRoleName: string | null
  branchName: string | null
  userName: string | null
  userEmail: string | null
  signInCode: string | null
  url: string
  isActive: boolean
  expiresAt: string | null
  expired: boolean
  lastUsedAt: string | null
  useCount: number
}

export interface LinkOption {
  id: string
  name: string
}

const NONE = '__none__'

/**
 * Access links.
 *
 * Replaces 87 lines of unstyled markup with an `alert()`, a role dropdown
 * hard-coded to three roles, and no branch anywhere — which is why the
 * accounts it created landed on empty screens.
 *
 * Everything Rolelogic §5 asks a record to carry is a column here: role,
 * branch, staff name, login email, code, status, created and last used. Last
 * used matters more than it looks — it is how an owner tells a link nobody has
 * opened from one a kitchen depends on, before revoking the wrong one.
 */
export function LinksManager({
  links,
  roles,
  customRoles,
  locations,
  staff,
}: {
  links: LinkRow[]
  roles: Array<{ value: string; label: string; needsBranch: boolean }>
  customRoles: LinkOption[]
  locations: LinkOption[]
  staff: Array<{ id: string; name: string; email: string }>
}) {
  const [creating, setCreating] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Link copied')
    } catch {
      // Clipboard access is refused on an insecure origin and in some
      // embedded browsers. Saying so beats a silent no-op.
      toast.error('Could not copy — select the link and copy it by hand')
    }
  }

  async function regenerate(row: LinkRow) {
    if (!window.confirm('Issue a new link? The current one stops working immediately.')) return
    setBusy(row.id)
    const result = await callAction(() => regenerateAccessLink({ id: row.id }))
    setBusy(null)
    if (result.ok) {
      await copy(result.data.url)
      toast.success('New link issued and copied')
    }
  }

  async function newCode(row: LinkRow) {
    if (!window.confirm('Issue a new sign-in code? Their old code stops working.')) return
    setBusy(row.id)
    const result = await callAction(() => regenerateLinkCode({ id: row.id }))
    setBusy(null)
    if (result.ok) toast.success(`New code: ${result.data.signInCode}`)
  }

  async function toggle(row: LinkRow) {
    setBusy(row.id)
    await callAction(() => setAccessLinkActive({ id: row.id, isActive: !row.isActive }))
    setBusy(null)
  }

  async function revoke(row: LinkRow) {
    if (!window.confirm('Revoke this link for good? This cannot be undone.')) return
    setBusy(row.id)
    await callAction(() => revokeAccessLink({ id: row.id }))
    setBusy(null)
  }

  return (
    <>
      <div className="mb-5">
        <Button onClick={() => setCreating(true)}>
          <Plus /> Create link
        </Button>
      </div>

      {links.length === 0 ? (
        <EmptyState
          icon={<Link2 />}
          title="No access links yet"
          description="Create one to give somebody a way into their workspace — a personal login for a member of staff, or a shared screen for the kitchen."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus /> Create link
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Link</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="hidden lg:table-cell">Sign in with</TableHead>
                <TableHead className="hidden md:table-cell">Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex items-start gap-2">
                      {row.mode === 'PERSONAL' ? (
                        <UserRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {row.label ?? row.userName ?? `${row.roleLabel} link`}
                        </p>
                        <button
                          type="button"
                          onClick={() => copy(row.url)}
                          className="max-w-[24ch] truncate text-xs text-primary hover:underline"
                          title={row.url}
                        >
                          {row.url.replace(/^https?:\/\//, '')}
                        </button>
                      </div>
                    </div>
                  </TableCell>

                  <TableCell className="text-sm">
                    {row.staffRoleName ?? row.roleLabel}
                    {row.staffRoleName ? (
                      <span className="block text-xs text-muted-foreground">
                        based on {row.roleLabel}
                      </span>
                    ) : null}
                  </TableCell>

                  <TableCell className="text-sm">
                    {row.branchName ?? <span className="text-muted-foreground">All locations</span>}
                  </TableCell>

                  <TableCell className="hidden lg:table-cell text-sm">
                    {row.mode === 'PERSONAL' ? (
                      <>
                        <span className="block truncate text-xs">{row.userEmail}</span>
                        {row.signInCode ? (
                          <code className="text-xs font-mono tracking-wider">{row.signInCode}</code>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        No code — the link signs in
                      </span>
                    )}
                  </TableCell>

                  <TableCell className="hidden md:table-cell text-sm">
                    {row.lastUsedAt ? (
                      <>
                        {new Date(row.lastUsedAt).toLocaleDateString()}
                        <span className="block text-xs text-muted-foreground">
                          {row.useCount} {row.useCount === 1 ? 'time' : 'times'}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">Never opened</span>
                    )}
                  </TableCell>

                  <TableCell>
                    {!row.isActive ? (
                      <Badge variant="secondary">Disabled</Badge>
                    ) : row.expired ? (
                      <Badge variant="warning">Expired</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="icon-sm" variant="ghost" title="Copy link" onClick={() => copy(row.url)}>
                        <Copy />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Issue a new link"
                        disabled={busy === row.id}
                        onClick={() => regenerate(row)}
                      >
                        <RefreshCw />
                      </Button>
                      {row.mode === 'PERSONAL' ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          title="Issue a new sign-in code"
                          disabled={busy === row.id}
                          onClick={() => newCode(row)}
                        >
                          <KeyRound />
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === row.id}
                        onClick={() => toggle(row)}
                      >
                        {row.isActive ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive"
                        title="Revoke for good"
                        disabled={busy === row.id}
                        onClick={() => revoke(row)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {creating ? (
        <CreateDialog
          roles={roles}
          customRoles={customRoles}
          locations={locations}
          staff={staff}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  )
}

function CreateDialog({
  roles,
  customRoles,
  locations,
  staff,
  onClose,
}: {
  roles: Array<{ value: string; label: string; needsBranch: boolean }>
  customRoles: LinkOption[]
  locations: LinkOption[]
  staff: Array<{ id: string; name: string; email: string }>
  onClose: () => void
}) {
  const [mode, setMode] = React.useState<'PERSONAL' | 'SHARED_DEVICE'>('PERSONAL')
  const [role, setRole] = React.useState(roles[0]?.value ?? 'WAITER')
  const [staffRoleId, setStaffRoleId] = React.useState(NONE)
  const [branchId, setBranchId] = React.useState(locations[0]?.id ?? NONE)
  const [userId, setUserId] = React.useState(staff[0]?.id ?? '')
  const [label, setLabel] = React.useState('')
  const [days, setDays] = React.useState(30)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [made, setMade] = React.useState<{ url: string; signInCode: string | null } | null>(null)

  const chosenRole = roles.find((r) => r.value === role)

  async function create() {
    setBusy(true)
    setError(null)
    const result = await callAction(() =>
      createAccessLink({
        mode,
        role,
        staffRoleId: staffRoleId === NONE ? null : staffRoleId,
        branchId: branchId === NONE ? null : branchId,
        userId: mode === 'PERSONAL' ? userId : null,
        label,
        days,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setMade({ url: result.data.url, signInCode: result.data.signInCode })
  }

  /*
   * The result stays on screen rather than closing.
   *
   * A personal link's code is shown once here and then only in the table; an
   * owner who creates a link and has the dialog vanish has to go looking for
   * the two things they came for. So the dialog turns into the handover.
   */
  if (made) {
    return (
      <Dialog open onOpenChange={() => onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Link ready</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Send them this link">
              <Input readOnly value={made.url} onFocus={(e) => e.currentTarget.select()} />
            </Field>
            {made.signInCode ? (
              <Field label="And this code">
                <Input
                  readOnly
                  value={made.signInCode}
                  className="font-mono tracking-wider"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </Field>
            ) : (
              <p className="text-sm text-muted-foreground">
                This is a shared screen — opening the link signs the device in, so keep it off
                personal phones.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(made.url).catch(() => undefined)
                toast.success('Link copied')
                onClose()
              }}
            >
              <Copy /> Copy and close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create an access link</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <ModeCard
              icon={<UserRound className="size-4" />}
              title="Personal login"
              body="They enter their email and code. The link on its own does nothing."
              selected={mode === 'PERSONAL'}
              onSelect={() => setMode('PERSONAL')}
            />
            <ModeCard
              icon={<Monitor className="size-4" />}
              title="Shared screen"
              body="Opening it signs the device in. For a kitchen tablet that reboots."
              selected={mode === 'SHARED_DEVICE'}
              onSelect={() => setMode('SHARED_DEVICE')}
            />
          </div>

          {mode === 'PERSONAL' ? (
            <Field label="Who is it for" required>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a member of staff" />
                </SelectTrigger>
                <SelectContent>
                  {staff.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name} — {person.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <Field label="Name this screen">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Kitchen tablet"
              />
            </Field>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role" required>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Location">
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {!chosenRole?.needsBranch ? (
                    <SelectItem value={NONE}>All locations</SelectItem>
                  ) : null}
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          {customRoles.length > 0 ? (
            <Field label="Custom access">
              <Select value={staffRoleId} onValueChange={setStaffRoleId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Default for the role above</SelectItem>
                  {customRoles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          <Field label="Expires after">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                max={365}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">
                {days === 0 ? 'never expires' : days === 1 ? 'day' : 'days'}
              </span>
            </div>
            {days === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Right for a screen on a wall — an expiring kitchen link fails at dinner service.
              </p>
            ) : null}
          </Field>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={create}
            disabled={busy || (mode === 'PERSONAL' && !userId)}
          >
            {busy ? 'Creating…' : 'Create link'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ModeCard({
  icon,
  title,
  body,
  selected,
  onSelect,
}: {
  icon: React.ReactNode
  title: string
  body: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-xl border p-3 text-left transition-colors ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </span>
      <span className="mt-1 block text-xs text-muted-foreground">{body}</span>
    </button>
  )
}
