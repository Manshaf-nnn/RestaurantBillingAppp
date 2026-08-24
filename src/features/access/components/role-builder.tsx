'use client'

import * as React from 'react'
import { Check, ChevronDown, Copy, Plus, ShieldCheck, Trash2, Users } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/primitives'
import { callAction } from '@/lib/use-action'

import {
  ACTION_LABELS,
  FEATURES,
  FEATURE_GROUPS,
  primaryAction,
  type Feature,
} from '../features'
import { createRole, deleteRole, duplicateRole, setRoleActive, updateRole } from '../actions'

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

  const grantableSet = React.useMemo(() => new Set(grantable), [grantable])

  async function toggleActive(role: RoleRow) {
    setBusy(role.id)
    await callAction(() => setRoleActive({ id: role.id, isActive: !role.isActive }))
    setBusy(null)
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
                  </p>
                </div>
              </div>

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
  const [preset, setPreset] = React.useState(role?.preset ?? presets[0]?.value ?? 'WAITER')
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
                onChange={(e) => setPreset(e.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                {presets.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Decides where they land after signing in, and whether they are tied to one
                location.
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
