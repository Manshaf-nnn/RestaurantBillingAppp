'use client'

import * as React from 'react'
import { Check, ChevronDown, Copy, Link as LinkIcon, Plus, ShieldCheck, Trash2, Users, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox, Switch } from '@/components/ui/primitives'
import { callAction } from '@/lib/use-action'
import { requiresOwnBranch } from '@/lib/rbac'
import type { UserRole } from '@prisma/client'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import {
  ACTION_LABELS,
  FEATURES,
  FEATURE_GROUPS,
  primaryAction,
  type Feature,
} from '../features'
import {
  SIDEBAR_MODULES,
  accessTwin,
  closeSelection,
  edgeAllows,
  inferPreset,
  modulesShownBy,
  permissionsForSelection,
  requiredBy,
  type SidebarModule,
} from '../sidebar-access'
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

/** Somebody who can be put on a role as it is created. */
export interface StaffOption {
  id: string
  name: string
  /** Their custom role's name, or the built-in's label. */
  roleLabel: string
  branchId: string | null
  branchName: string | null
}

/**
 * Creating and editing roles.
 *
 * ── Two dialogs, on purpose ─────────────────────────────────────────────────
 *
 * Create is the simple one: a name, something to start from, the sidebar
 * tabs the job gets, and optionally who is on it and where. Every tab is
 * always listed — the sidebar is the source of truth, and "Based on" only
 * decides which boxes start ticked — and a tab that needs another ticks it
 * for you and keeps it ticked (`sidebar-access.ts`).
 *
 * Edit keeps the detailed grid: every feature and every action within it,
 * because a role that exists is tuned one switch at a time. The grid renders
 * the whole registry for the same reason the create dialog lists every tab —
 * a list that showed only what was already granted would make it impossible
 * to discover what else exists.
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
  staff,
  canAssignAllLocations,
  grantable,
}: {
  roles: RoleRow[]
  presets: PresetOption[]
  locations: Array<{ id: string; name: string }>
  staff: StaffOption[]
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
  const [copying, setCopying] = React.useState<RoleRow | null>(null)
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
      </div>

      {roles.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="No custom roles yet"
          description="Everyone is on their built-in role. Create one to give somebody a workspace with only the features their job needs."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus /> Create role
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

      {creating ? (
        <CreateRoleDialog
          roles={roles}
          presets={presets}
          locations={locations}
          staff={staff}
          canAssignAllLocations={canAssignAllLocations}
          grantable={grantableSet}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {editing ? (
        <RoleDialog
          role={editing}
          presets={presets}
          locations={locations}
          canAssignAllLocations={canAssignAllLocations}
          grantable={grantableSet}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {copying ? <DuplicateDialog source={copying} onClose={() => setCopying(null)} /> : null}
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

const SCRATCH = ''
const SELECT_CLASS = 'h-10 w-full rounded-lg border border-input bg-background px-3 text-sm'

/**
 * The simple Create Role dialog.
 *
 * ── How a set of ticked boxes becomes a permission list ─────────────────────
 *
 * `explicit` is what the owner ticked (seeded from "Based on"). Closing it
 * over each tab's requirements gives `selected`; `permissionsForSelection`
 * turns that into the list, keeping whatever the template gave that no tab
 * stands for as long as its feature is still on. What the boxes DISPLAY is
 * derived back from that list with the sidebar's own rule, so a box is
 * ticked if and only if the tab would appear — three tabs on one permission
 * light up together, a required tab is ticked and locked, and a tab the base
 * role's edge gate refuses stays off however hard it is clicked.
 *
 * The preset for "start from scratch" is inferred from the same list with
 * the same function the server uses, so the location field can insist on a
 * site exactly when the server would.
 */
function CreateRoleDialog({
  roles,
  presets,
  locations,
  staff,
  canAssignAllLocations,
  grantable,
  onClose,
}: {
  roles: RoleRow[]
  presets: PresetOption[]
  locations: Array<{ id: string; name: string }>
  staff: StaffOption[]
  canAssignAllLocations: boolean
  grantable: Set<string>
  onClose: () => void
}) {
  const [name, setName] = React.useState('')
  const [baseKey, setBaseKey] = React.useState(SCRATCH)
  const [basePreset, setBasePreset] = React.useState('')
  const [base, setBase] = React.useState<string[]>([])
  const [explicit, setExplicit] = React.useState<Set<string>>(() => new Set())
  const [branchId, setBranchId] = React.useState('')
  const [assignments, setAssignments] = React.useState<Array<{ userId: string; branchId: string }>>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const activeRoles = React.useMemo(() => roles.filter((role) => role.isActive), [roles])
  const candidates = React.useMemo(() => presets.map((p) => p.value as UserRole), [presets])

  /*
   * Resolved in one pass, because the parts lean on each other: the preset
   * decides which tabs the edge lets through, and which tabs are on decides
   * the preset. A first closure without the edge settles the preset; the
   * second, with it, settles the list.
   */
  const view = React.useMemo(() => {
    const first = permissionsForSelection(closeSelection(explicit, basePreset || null), base, basePreset || null)
    const inferred = basePreset
      ? { preset: basePreset as UserRole, blockedBy: [] as SidebarModule[] }
      : inferPreset(first, candidates, branchId || null)
    const preset = inferred.preset
    const selected = closeSelection(explicit, preset)
    const permissions = permissionsForSelection(selected, base, preset).filter((p) => grantable.has(p))
    const held = new Set(permissions)
    const shown = modulesShownBy(held, preset)
    return { preset, blockedBy: inferred.blockedBy, permissions, held, shown }
  }, [explicit, base, basePreset, branchId, candidates, grantable])

  const shownHrefs = React.useMemo(() => new Set(view.shown.map((m) => m.href)), [view.shown])
  const presetLabel = presets.find((p) => p.value === view.preset)?.label ?? null
  const mustHaveBranch = view.preset ? requiresOwnBranch(view.preset) : false

  // A preset that cannot use "all locations" gets pinned to one the moment it
  // is settled, rather than failing on submit about a field nobody looked at.
  React.useEffect(() => {
    if (mustHaveBranch && !branchId && locations[0]) setBranchId(locations[0].id)
  }, [mustHaveBranch, branchId, locations])

  /**
   * Apply a starting point. Only ever on an explicit change of the dropdown,
   * never in an effect — an effect would re-seed, and so wipe, the owner's
   * own ticks every time anything else re-rendered.
   */
  function chooseBase(key: string) {
    setBaseKey(key)
    let permissions: string[] = []
    let preset = ''
    if (key.startsWith('preset:')) {
      const chosen = presets.find((p) => `preset:${p.value}` === key)
      permissions = chosen?.permissions ?? []
      preset = chosen?.value ?? ''
    } else if (key.startsWith('role:')) {
      const chosen = activeRoles.find((r) => `role:${r.id}` === key)
      permissions = chosen?.permissions ?? []
      preset = chosen?.preset ?? ''
      if (chosen?.branchId) setBranchId(chosen.branchId)
    }
    const seed = permissions.filter((p) => grantable.has(p))
    setBase(seed)
    setBasePreset(preset)
    setExplicit(new Set(modulesShownBy(new Set(seed), preset || null).map((m) => m.href)))
  }

  function toggle(entry: SidebarModule, on: boolean) {
    setExplicit((prev) => {
      const next = new Set(prev)
      if (on) {
        next.add(entry.href)
        return next
      }
      // Tabs on one permission come off together — there is nothing to keep.
      const shared = new Set(entry.grants)
      for (const other of SIDEBAR_MODULES) {
        if (other.grants.some((p) => shared.has(p))) next.delete(other.href)
      }
      return next
    })
  }

  const unassigned = staff.filter((member) => !assignments.some((row) => row.userId === member.id))
  const roleBranchName = branchId ? locations.find((l) => l.id === branchId)?.name ?? null : null

  /** A person a site-scoped role would blind: no home site anywhere. */
  function needsLocation(row: { userId: string; branchId: string }): boolean {
    if (!mustHaveBranch || branchId) return false
    const member = staff.find((m) => m.id === row.userId)
    return !row.branchId && !member?.branchId
  }
  const blockedByLocation = assignments.some(needsLocation)

  async function save() {
    setBusy(true)
    setError(null)
    const result = await callAction(() =>
      createRole({
        name,
        description: '',
        preset: basePreset,
        branchId: branchId || null,
        permissions: view.permissions,
        assignments: assignments.map((row) => ({ userId: row.userId, branchId: row.branchId || null })),
      }),
    )
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error)
  }

  const sections = React.useMemo(() => {
    const out: Array<{ title: string; modules: SidebarModule[] }> = []
    for (const entry of SIDEBAR_MODULES) {
      const last = out[out.length - 1]
      if (last && last.title === entry.section) last.modules.push(entry)
      else out.push({ title: entry.section, modules: [entry] })
    }
    return out
  }, [])

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create a role</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-role-name">Role name</Label>
              <Input
                id="new-role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Stock Controller"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-role-base">Based on</Label>
              <select
                id="new-role-base"
                value={baseKey}
                onChange={(e) => chooseBase(e.target.value)}
                className={SELECT_CLASS}
              >
                <option value={SCRATCH}>Start from scratch</option>
                <optgroup label="Built-in roles">
                  {presets.map((p) => (
                    <option key={p.value} value={`preset:${p.value}`}>
                      {p.label}
                    </option>
                  ))}
                </optgroup>
                {activeRoles.length > 0 ? (
                  <optgroup label="Your roles">
                    {activeRoles.map((r) => (
                      <option key={r.id} value={`role:${r.id}`}>
                        {r.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <p className="text-xs text-muted-foreground">
                {baseKey === SCRATCH
                  ? presetLabel
                    ? `A starting point only. They will sign in as a ${presetLabel.toLowerCase()}.`
                    : 'A starting point only. Tick the tabs below.'
                  : 'A starting point only. Every tab stays available below.'}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-border">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <p className="text-sm font-medium">Sidebar access</p>
                <p className="text-xs text-muted-foreground">
                  {view.shown.length} of {SIDEBAR_MODULES.length} tabs
                </p>
              </div>
            </div>

            <div className="divide-y">
              {sections.map((section) => (
                <div key={section.title} className="px-4 py-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.title}
                  </p>
                  <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    {section.modules.map((entry) => {
                      const checked = shownHrefs.has(entry.href)
                      const holders = checked ? requiredBy(entry.href, view.shown) : []
                      /*
                       * Shown on somebody else's account: the entry's own
                       * permission is off, but one of `anyOf` is held by a
                       * ticked tab — the POS shell, whose drawer tab is the
                       * Cash drawer's. It cannot be unticked while that is so,
                       * and the box says which tab keeps it there.
                       */
                      const carriers =
                        checked && !view.held.has(entry.permission)
                          ? view.shown.filter(
                              (other) => other.href !== entry.href && other.grants.some((p) => entry.anyOf.includes(p)),
                            )
                          : []
                      const canGrant = grantable.has(entry.permission)
                      const reachable = edgeAllows(entry, view.preset)
                      const twin = accessTwin(entry.href)
                      const disabled = !canGrant || !reachable || holders.length > 0 || carriers.length > 0
                      const note = !canGrant
                        ? 'You do not have this yourself'
                        : !reachable && presetLabel
                          ? `Not open to roles based on ${presetLabel}`
                          : holders.length > 0
                            ? `Required by ${holders.map((h) => h.label).join(', ')}`
                            : carriers.length > 0
                              ? `Shown with ${carriers.map((c) => c.label).join(', ')}`
                              : twin
                                ? `Same access as ${twin.label}`
                                : null
                      const id = `tab-${entry.href.replace(/[^a-z0-9]+/gi, '-')}`
                      return (
                        <li key={entry.href} className="flex items-start gap-2.5 py-1">
                          <Checkbox
                            id={id}
                            checked={checked}
                            disabled={disabled}
                            onCheckedChange={(next) => toggle(entry, next === true)}
                            className="mt-0.5"
                          />
                          <label htmlFor={id} className="min-w-0 cursor-pointer select-none">
                            <span className="block truncate text-sm">{entry.label}</span>
                            {note ? (
                              <span className="block truncate text-xs text-muted-foreground">{note}</span>
                            ) : null}
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {view.blockedBy.length > 0 ? (
            <p className="text-sm text-destructive">
              Nothing you can assign opens {view.blockedBy.map((m) => m.label).join(' and ')} together.
              Untick one of them.
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-role-branch">Location</Label>
              <select
                id="new-role-branch"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className={SELECT_CLASS}
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
              <p className="text-xs text-muted-foreground">
                {mustHaveBranch
                  ? 'This kind of role works one site — without a location their screens would be empty.'
                  : 'Where people on this role can operate. Optional: leave it and each person keeps their own.'}
              </p>
            </div>
          </div>

          {staff.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="new-role-staff">Assign staff</Label>
              {assignments.length > 0 ? (
                <ul className="divide-y rounded-lg border border-border">
                  {assignments.map((row) => {
                    const member = staff.find((m) => m.id === row.userId)
                    if (!member) return null
                    const missing = needsLocation(row)
                    return (
                      <li key={row.userId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{member.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            Currently {member.roleLabel}
                            {member.branchName ? ` · ${member.branchName}` : ''}
                          </p>
                        </div>
                        {roleBranchName ? (
                          <span className="text-xs text-muted-foreground">{roleBranchName}</span>
                        ) : (
                          <select
                            aria-label={`Location for ${member.name}`}
                            value={row.branchId}
                            onChange={(e) =>
                              setAssignments((prev) =>
                                prev.map((r) =>
                                  r.userId === row.userId ? { ...r, branchId: e.target.value } : r,
                                ),
                              )
                            }
                            className={`h-9 rounded-lg border bg-background px-2 text-sm ${
                              missing ? 'border-destructive' : 'border-input'
                            }`}
                          >
                            <option value="">
                              {member.branchName ? `${member.branchName} (current)` : 'Choose a location'}
                            </option>
                            {locations.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${member.name}`}
                          onClick={() =>
                            setAssignments((prev) => prev.filter((r) => r.userId !== row.userId))
                          }
                        >
                          <X />
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
              {unassigned.length > 0 ? (
                <select
                  id="new-role-staff"
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return
                    setAssignments((prev) => [...prev, { userId: e.target.value, branchId: '' }])
                  }}
                  className={SELECT_CLASS}
                >
                  <option value="">Add a person…</option>
                  {unassigned.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name} · {member.roleLabel}
                      {member.branchName ? ` · ${member.branchName}` : ''}
                    </option>
                  ))}
                </select>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {blockedByLocation
                  ? 'Choose a location for everyone marked — this role works one site.'
                  : 'Optional. Everyone on the role shares its access; the location is where they work.'}
              </p>
            </div>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={busy || name.trim().length < 2 || view.blockedBy.length > 0 || blockedByLocation}
          >
            {busy ? 'Creating…' : 'Create role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RoleDialog({
  role,
  presets,
  locations,
  canAssignAllLocations,
  grantable,
  onClose,
}: {
  role: RoleRow
  presets: PresetOption[]
  locations: Array<{ id: string; name: string }>
  canAssignAllLocations: boolean
  grantable: Set<string>
  onClose: () => void
}) {
  const [name, setName] = React.useState(role.name)
  const [description, setDescription] = React.useState(role.description ?? '')
  const [preset, setPreset] = React.useState(role.preset)
  const [branchId, setBranchId] = React.useState(role.branchId ?? '')
  const [granted, setGranted] = React.useState<Set<string>>(() => new Set(role.permissions))
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
    const result = await callAction(() =>
      updateRole({
        name,
        description,
        preset,
        branchId: branchId || null,
        permissions: [...granted],
        id: role.id,
        isActive: role.isActive,
      }),
    )
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error)
  }

  const enabledCount = countFeatures([...granted])

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {role.name}</DialogTitle>
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
                className={SELECT_CLASS}
              >
                {presets.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Fills in what that role can normally do, and decides where they land after signing
                in. Change any switch below.
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
                className={SELECT_CLASS}
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
            {busy ? 'Saving…' : 'Save changes'}
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

/** An exact copy of an existing role under a new name. Templates live in Create. */
function DuplicateDialog({ source, onClose }: { source: RoleRow; onClose: () => void }) {
  const [name, setName] = React.useState(`${source.name} copy`)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function go() {
    setBusy(true)
    setError(null)
    const result = await callAction(() => duplicateRole({ sourceRoleId: source.id, name }))
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error)
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Duplicate {source.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
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
