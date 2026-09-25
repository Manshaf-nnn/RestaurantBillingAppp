'use client'

import * as React from 'react'
import { Check, ChevronDown, Copy, Link as LinkIcon, Plus, ShieldCheck, Trash2, Users } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/primitives'
import { callAction } from '@/lib/use-action'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import {
  ACTION_LABELS,
  FEATURES,
  FEATURE_GROUPS,
  primaryAction,
  type Feature,
} from '../features'
import { createRole, deleteRole, duplicateRole, setRoleActive, updateRole } from '../actions'
import { roleSignInLink } from '../link-actions'
import { CopyLink } from '@/features/staff/components/copy-link'

export interface RoleRow {
  id: string
  name: string
  description: string | null
  preset: string
  presetLabel: string
  branchId: string | null
  branchName: string | null
  permissions: string[]
  isActive: boolean
  memberCount: number
  /** The role's own sign-in link, when it has one (sidebar.md — role links). */
  signInUrl: string | null
}

export interface PresetOption {
  value: string
  label: string
  /** What the built-in grants, so "copy a template" can show its size. */
  permissions: string[]
  /** True when this preset must be pinned to one location. */
  needsBranch: boolean
}

/**
 * Creating and editing roles.
 *
 * ── The grid is the point ───────────────────────────────────────────────────
 *
 * Rolelogic asks that the owner *see all available system features* while
 * building a role, then switch each one, and each action within it, on or off.
 * So the grid renders the whole registry — every feature, always — rather than
 * only what the role currently has. A list that showed only what was already
 * granted would make it impossible to discover what else exists, which is the
 * one thing this screen is for.
 *
 * ── Turning a feature off turns its actions off ─────────────────────────────
 *
 * A feature switch is the primary action; the rest are its detail. Switching
 * the feature off clears them all, because leaving `purchase.approve` set on a
 * role that cannot open purchasing is a right nobody can see and nobody can
 * find later. Switching an action on switches the feature on, for the same
 * reason in reverse — an action without its view is a permission that grants a
 * button on a page you cannot reach.
 */
export function RoleBuilder({
  roles,
  presets,
  locations,
  canAssignAllLocations,
  grantable,
}: {
  roles: RoleRow[]
  presets: PresetOption[]
  locations: Array<{ id: string; name: string }>
  canAssignAllLocations: boolean
  /**
   * What the signed-in person may hand out.
   *
   * The server refuses anything beyond it regardless — `assertNoEscalation` —
   * but a switch that always fails is worse than one that is not offered, so
   * the grid greys them out and says why.
   */
  grantable: string[]
}) {
  const [editing, setEditing] = React.useState<RoleRow | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [copying, setCopying] = React.useState<RoleRow | 'preset' | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const router = useRouter()

  const grantableSet = React.useMemo(() => new Set(grantable), [grantable])

  async function toggleActive(role: RoleRow) {
    setBusy(role.id)
    await callAction(() => setRoleActive({ id: role.id, isActive: !role.isActive }))
    setBusy(null)
  }

  /*
   * For roles that existed before links did. New roles are minted one at
   * creation, so this button is only ever seen on older rows.
   */
  async function makeLink(role: RoleRow) {
    setBusy(role.id)
    const result = await callAction(() => roleSignInLink({ staffRoleId: role.id }))
    setBusy(null)
    if (result.ok) {
      await navigator.clipboard.writeText(result.data.url).catch(() => undefined)
      toast.success('Sign-in link created and copied')
      router.refresh()
    } else {
      toast.error(result.error)
    }
  }

  async function remove(role: RoleRow) {
    if (
      !window.confirm(
        role.memberCount > 0
          ? `Remove “${role.name}”? ${role.memberCount} ${
              role.memberCount === 1 ? 'person goes' : 'people go'
            } back to their default access.`
          : `Remove “${role.name}”?`,
      )
    ) {
      return
    }
    setBusy(role.id)
    await callAction(() => deleteRole({ id: role.id }))
    setBusy(null)
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button onClick={() => setCreating(true)}>
          <Plus /> Create role
        </Button>
        <Button variant="outline" onClick={() => setCopying('preset')}>
          <Copy /> Start from a template
        </Button>
      </div>

      {roles.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="No custom roles yet"
          description="Everyone is on their built-in role. Create one to give somebody a workspace with only the features their job needs."
          action={
            <Button onClick={() => setCopying('preset')}>
              <Copy /> Start from a template
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {roles.map((role) => (
            <li
              key={role.id}
              className="rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium">{role.name}</p>
                    {!role.isActive ? <Badge variant="secondary">Switched off</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Based on {role.presetLabel} · {role.branchName ?? 'All locations'}
                  </p>
                  {role.description ? (
                    <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
                      {role.description}
                    </p>
                  ) : null}
                  <p className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Users className="size-3.5" />
                      {role.memberCount} {role.memberCount === 1 ? 'person' : 'people'}
                    </span>
                    <span>{countFeatures(role.permissions)} features on</span>
                    {/*
                      Both numbers, because they answer different questions
                      (staff.A.md §8). "Features on" is what the person will
                      see in the sidebar; "permissions" is what the role
                      actually grants, and the two differ whenever a feature is
                      on with only some of its actions.
                    */}
                    <span>
                      {role.permissions.length}{' '}
                      {role.permissions.length === 1 ? 'permission' : 'permissions'}
                    </span>
                  </p>
                </div>
              </div>

              {/*
                The link everybody on this role signs in with.
                Shown on the card because this is where somebody is thinking
                about the role — it used to live on a different screen, which
                is why most roles never got one.
              */}
              {role.isActive ? (
                <div className="mt-3 rounded-lg border border-border bg-muted/30 p-2.5">
                  {role.signInUrl ? (
                    <>
                      <p className="mb-1.5 text-xs text-muted-foreground">
                        Sign-in link · anybody on this role uses their own email and code
                      </p>
                      <CopyLink url={role.signInUrl} />
                    </>
                  ) : (
                    <>
                      <p className="mb-1.5 text-xs text-muted-foreground">
                        No sign-in link yet. One link serves everybody on this role.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === role.id}
                        onClick={() => makeLink(role)}
                      >
                        <LinkIcon /> Create sign-in link
                      </Button>
                    </>
                  )}
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(role)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCopying(role)}>
                  <Copy /> Duplicate
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === role.id}
                  onClick={() => toggleActive(role)}
                >
                  {role.isActive ? 'Switch off' : 'Switch on'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy === role.id}
                  onClick={() => remove(role)}
                >
                  <Trash2 /> Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating || editing ? (
        <RoleDialog
          role={editing}
          presets={presets}
          locations={locations}
          canAssignAllLocations={canAssignAllLocations}
          grantable={grantableSet}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      ) : null}

      {copying ? (
        <DuplicateDialog
          source={copying}
          presets={presets}
          onClose={() => setCopying(null)}
        />
      ) : null}
    </>
  )
}

/** How many features a permission list actually opens. */
function countFeatures(permissions: string[]): number {
  const set = new Set(permissions)
  return FEATURES.filter((f) => {
    const primary = primaryAction(f)
    return primary ? set.has(primary.permission) : false
  }).length
}

function RoleDialog({
  role,
  presets,
  locations,
  canAssignAllLocations,
  grantable,
  onClose,
}: {
  role: RoleRow | null
  presets: PresetOption[]
  locations: Array<{ id: string; name: string }>
  canAssignAllLocations: boolean
  grantable: Set<string>
  onClose: () => void
}) {
  const [name, setName] = React.useState(role?.name ?? '')
  const [description, setDescription] = React.useState(role?.description ?? '')
  /*
   * Empty for a NEW role — "start from scratch".
   *
   * It defaulted to the first preset in the list, which was Administrator, and
   * choosing one did nothing at all: the toggles stayed at 0 of 58 whatever was
   * picked. So the field looked like it seeded the role and did not, which is
   * the worst of both — an owner ticked 58 switches by hand under a box that
   * said the role was "based on Administrator".
   *
   * Now it is a real choice. Pick one and its permissions are filled in as a
   * starting point; leave it blank and the role is yours to build. An existing
   * role keeps whatever it was based on.
   */
  const [preset, setPreset] = React.useState(role?.preset ?? '')
  const [branchId, setBranchId] = React.useState(role?.branchId ?? '')
  const [granted, setGranted] = React.useState<Set<string>>(
    () => new Set(role?.permissions ?? []),
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const chosenPreset = presets.find((p) => p.value === preset)
  const mustHaveBranch = chosenPreset?.needsBranch ?? false

  // A preset that cannot use "all locations" gets pinned to one the moment it
  // is chosen, rather than failing on submit with a message about a field the
  // owner has not looked at yet.
  React.useEffect(() => {
    if (mustHaveBranch && !branchId && locations[0]) setBranchId(locations[0].id)
  }, [mustHaveBranch, branchId, locations])

  /**
   * Apply a preset's permissions as a starting point.
   *
   * Only ever on an explicit change of the dropdown, never in an effect: a
   * `useEffect` on `preset` would re-seed — and so wipe — an owner's own edits
   * every time anything else in the dialog re-rendered. Choosing is an action,
   * so it is handled where the action happens.
   *
   * Narrowed to what this admin may actually grant. An owner cannot hand out a
   * permission they do not hold themselves, and seeding one would build a role
   * that fails to save with an error pointing at a switch they never touched.
   *
   * Clearing the dropdown clears the seeded set too, which is what "start from
   * scratch" has to mean if it means anything.
   */
  function choosePreset(value: string) {
    setPreset(value)
    const chosen = presets.find((p) => p.value === value)
    setGranted(new Set((chosen?.permissions ?? []).filter((p) => grantable.has(p))))
  }

  function setPermission(permission: string, on: boolean) {
    setGranted((prev) => {
      const next = new Set(prev)
      if (on) next.add(permission)
      else next.delete(permission)
      return next
    })
  }

  function toggleFeature(feature: Feature, on: boolean) {
    setGranted((prev) => {
      const next = new Set(prev)
      const primary = primaryAction(feature)
      if (on) {
        if (primary && grantable.has(primary.permission)) next.add(primary.permission)
      } else {
        // Clearing the detail too — see the header note.
        for (const action of feature.actions) next.delete(action.permission)
      }
      return next
    })
  }

  async function save() {
    setBusy(true)
    setError(null)
    const payload = {
      name,
      description,
      preset,
      branchId: branchId || null,
      permissions: [...granted],
    }
    const result = role
      ? await callAction(() => updateRole({ ...payload, id: role.id, isActive: role.isActive }))
      : await callAction(() => createRole(payload))
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error)
  }

  const enabledCount = countFeatures([...granted])

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{role ? `Edit ${role.name}` : 'Create a role'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="role-name">Role name</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Stock Controller"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-preset">Based on</Label>
              <select
                id="role-preset"
                value={preset}
                onChange={(e) => choosePreset(e.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">Start from scratch</option>
                {presets.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {preset
                  ? 'Fills in what that role can normally do, and decides where they land after signing in. Change any switch below.'
                  : 'Optional. Pick one to start from what that role can normally do — or leave it and switch on only what you need.'}
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="role-branch">Location</Label>
              <select
                id="role-branch"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                {canAssignAllLocations && !mustHaveBranch ? (
                  <option value="">All locations</option>
                ) : null}
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              {mustHaveBranch ? (
                <p className="text-xs text-muted-foreground">
                  This kind of role works one site — without a location their screens would be
                  empty.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-desc">Description</Label>
              <Input
                id="role-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Runs the stock room at Branch 02"
              />
            </div>
          </div>

          <div className="rounded-xl border border-border">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <p className="text-sm font-medium">Features</p>
                <p className="text-xs text-muted-foreground">
                  {enabledCount} of {FEATURES.length} switched on
                </p>
              </div>
            </div>

            <div className="divide-y">
              {FEATURE_GROUPS.map((group) => {
                const inGroup = FEATURES.filter((f) => f.group === group)
                if (inGroup.length === 0) return null
                return (
                  <div key={group} className="px-4 py-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group}
                    </p>
                    <ul className="space-y-1">
                      {inGroup.map((feature) => (
                        <FeatureRow
                          key={feature.key}
                          feature={feature}
                          granted={granted}
                          grantable={grantable}
                          onToggleFeature={toggleFeature}
                          onSetPermission={setPermission}
                        />
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || name.trim().length < 2}>
            {busy ? 'Saving…' : role ? 'Save changes' : 'Create role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FeatureRow({
  feature,
  granted,
  grantable,
  onToggleFeature,
  onSetPermission,
}: {
  feature: Feature
  granted: Set<string>
  grantable: Set<string>
  onToggleFeature: (feature: Feature, on: boolean) => void
  onSetPermission: (permission: string, on: boolean) => void
}) {
  const [open, setOpen] = React.useState(false)
  const primary = primaryAction(feature)
  const on = primary ? granted.has(primary.permission) : false
  const canGrant = primary ? grantable.has(primary.permission) : false
  // Only worth expanding when there is something to expand into.
  const extras = feature.actions.filter((a) => a !== primary)

  return (
    <li className="rounded-lg">
      <div className="flex items-center gap-3 py-1.5">
        <Switch
          checked={on}
          disabled={!canGrant}
          onCheckedChange={(next: boolean) => onToggleFeature(feature, next)}
        />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => extras.length > 0 && setOpen((v) => !v)}
        >
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{feature.label}</span>
            {extras.length > 0 ? (
              <ChevronDown
                className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
                  open ? 'rotate-180' : ''
                }`}
              />
            ) : null}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {canGrant ? feature.description : 'You do not have this yourself, so you cannot grant it'}
          </span>
        </button>
        {on && extras.length > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {extras.filter((a) => granted.has(a.permission)).length}/{extras.length}
          </span>
        ) : null}
      </div>

      {open && extras.length > 0 ? (
        <ul className="mb-2 ml-11 space-y-1.5 border-l pl-3">
          {extras.map((action) => {
            const allowed = grantable.has(action.permission)
            return (
              <li key={action.permission} className="flex items-start gap-2.5">
                <Switch
                  checked={granted.has(action.permission)}
                  disabled={!on || !allowed}
                  onCheckedChange={(next: boolean) => {
                    onSetPermission(action.permission, next)
                    // An action without its view is a button on a page they
                    // cannot open, so switching one on opens the feature.
                    if (next && primary && !granted.has(primary.permission)) {
                      onSetPermission(primary.permission, true)
                    }
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-sm">
                    {action.label ?? ACTION_LABELS[action.key]}
                  </span>
                  {action.hint ? (
                    <span className="block text-xs text-muted-foreground">{action.hint}</span>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}

function DuplicateDialog({
  source,
  presets,
  onClose,
}: {
  source: RoleRow | 'preset'
  presets: PresetOption[]
  onClose: () => void
}) {
  const fromRole = source !== 'preset'
  const [name, setName] = React.useState(fromRole ? `${source.name} copy` : '')
  const [sourcePreset, setSourcePreset] = React.useState(presets[0]?.value ?? 'WAITER')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function go() {
    setBusy(true)
    setError(null)
    const result = await callAction(() =>
      duplicateRole(
        fromRole ? { sourceRoleId: source.id, name } : { sourcePreset, name },
      ),
    )
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error)
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{fromRole ? `Duplicate ${source.name}` : 'Start from a template'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {!fromRole ? (
            <div className="space-y-1.5">
              <Label htmlFor="dup-preset">Template</Label>
              <select
                id="dup-preset"
                value={sourcePreset}
                onChange={(e) => setSourcePreset(e.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                {presets.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label} — {countFeatures(p.permissions)} features
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                A starting point you can edit. Anything the template holds that you do not is
                left out.
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="dup-name">New role name</Label>
            <Input
              id="dup-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Stock Controller"
              autoFocus
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={go} disabled={busy || name.trim().length < 2}>
            {busy ? 'Copying…' : <><Check /> Create</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
