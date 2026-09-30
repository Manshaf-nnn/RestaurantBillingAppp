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
  levelsOf,
  levelHeldBy,
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
                    {role.branchName ? `Pinned to ${role.branchName}` : 'Any location'}
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
          presets={presets}
          locations={locations}
          staff={staff}
          grantable={grantableSet}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {editing ? (
        <RoleDialog
          role={editing}
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
const EVERYTHING = 'preset:ADMIN'
const SELECT_CLASS = 'h-10 w-full rounded-lg border border-input bg-background px-3 text-sm'

/**
 * The simple Create Role dialog.
 *
 * ── How a set of ticked boxes becomes a permission list ─────────────────────
 *
 * `explicit` is what the owner ticked. Closing it over each tab's
 * requirements gives `selected`; `permissionsForSelection` turns that into
 * the list, keeping whatever the seed gave that no tab stands for as long as
 * its feature is still on. What the boxes DISPLAY is derived back from that
 * list with the sidebar's own rule, so a box is ticked if and only if the
 * tab would appear — three tabs on one permission light up together, and a
 * required tab is ticked and locked.
 *
 * ── There is no "based on" any more ─────────────────────────────────────────
 *
 * The built-in a role behaves like (`StaffRole.preset`) still exists — it
 * decides where its people land, what the edge lets them reach and whether
 * they are tied to a site — but it is INFERRED from the tabs, here with the
 * same function the server uses, and never chosen. The owner's model is
 * simpler and right: an administrator has everything; any other role is its
 * sidebar tabs. Offering "Based on POS / Kitchen / Manager" made a person's
 * built-in role a thing to pick, and then the staff form showed it again as
 * a locked "POS" nobody had asked for. The one starting point kept is
 * "Administrator": every tab on, for a role that is "everything except…".
 *
 * Nor does a role pin a location. Each person on it works where their own
 * record says; the assignment list below asks per person when the tabs
 * chosen need a home site.
 */
function CreateRoleDialog({
  presets,
  locations,
  staff,
  grantable,
  onClose,
}: {
  presets: PresetOption[]
  locations: Array<{ id: string; name: string }>
  staff: StaffOption[]
  grantable: Set<string>
  onClose: () => void
}) {
  const [name, setName] = React.useState('')
  const [baseKey, setBaseKey] = React.useState(SCRATCH)
  const [base, setBase] = React.useState<string[]>([])
  /**
   * The tabs ticked, and how much of each.
   *
   * A map rather than a set: ticking a tab is now two decisions — whether the
   * role gets it at all, and how much of it. Absent means unticked; the value
   * is a level key from `levelsOf(entry)`, defaulting to `full` so a plain
   * tick means what it always meant.
   */
  const [explicit, setExplicit] = React.useState<Map<string, string>>(() => new Map())
  const [assignments, setAssignments] = React.useState<Array<{ userId: string; branchId: string }>>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const candidates = React.useMemo(() => presets.map((p) => p.value as UserRole), [presets])
  /** The one starting point on offer, when this admin may hand it out at all. */
  const everything = React.useMemo(() => presets.find((p) => p.value === 'ADMIN') ?? null, [presets])

  /*
   * Resolved in one pass, because the parts lean on each other: the preset
   * decides which tabs the edge lets through, and which tabs are on decides
   * the preset. A first closure without the edge settles the preset; the
   * second, with it, settles the list.
   */
  const view = React.useMemo(() => {
    const withDeps = (role: string | null) => {
      const out = new Map<string, string>()
      // Dependencies come in at `open` — enough to reach the tab, no authority.
      for (const href of closeSelection(explicit.keys(), role)) out.set(href, 'open')
      for (const [href, level] of explicit) if (out.has(href)) out.set(href, level)
      return out
    }
    const first = permissionsForSelection(withDeps(null), base, null)
    const inferred = inferPreset(first, candidates, null)
    const preset = inferred.preset
    const selected = withDeps(preset)
    const permissions = permissionsForSelection(selected, base, preset).filter((p) => grantable.has(p))
    const held = new Set(permissions)
    const shown = modulesShownBy(held, preset)
    return { preset, blockedBy: inferred.blockedBy, permissions, held, shown }
  }, [explicit, base, candidates, grantable])

  const shownHrefs = React.useMemo(() => new Set(view.shown.map((m) => m.href)), [view.shown])
  const mustHaveBranch = view.preset ? requiresOwnBranch(view.preset) : false

  /**
   * Apply a starting point. Only ever on an explicit change of the dropdown,
   * never in an effect — an effect would re-seed, and so wipe, the owner's
   * own ticks every time anything else re-rendered.
   *
   * "Administrator" seeds the TABS, not the built-in: the role's preset is
   * still inferred from whatever is left ticked, so unticking half the tabs
   * from an administrator start does not produce administrators with half
   * the tabs — it produces a role whose people see every location and
   * bypass payment-account assignment, which is what ADMIN means elsewhere.
   */
  function chooseBase(key: string) {
    setBaseKey(key)
    const seed = key === EVERYTHING ? (everything?.permissions ?? []).filter((p) => grantable.has(p)) : []
    setBase(seed)
    const held = new Set(seed)
    /*
     * Read the seed back into levels rather than assuming full: a template
     * that can request transfers but not approve them must arrive on "Can
     * request", or opening the dialog would silently promote it.
     */
    setExplicit(
      new Map(
        modulesShownBy(held, null).map((m) => {
          const level = levelHeldBy(m, held)
          return [m.href, level === 'custom' || level === 'off' ? 'full' : level]
        }),
      ),
    )
  }

  /**
   * Whether ticking this tab could be accommodated by SOME built-in.
   *
   * `edgeAllows` asks about the preset settled so far, which is the wrong
   * question for a box that is off: with only POS ticked the preset is POS,
   * and the Kitchen tab is not open to POS — but tick it and the preset
   * becomes one that opens both. A box is only greyed out when no built-in
   * this admin can hand out opens the combination.
   */
  function couldOpen(entry: SidebarModule): boolean {
    if (edgeAllows(entry, view.preset)) return true
    return inferPreset([...view.permissions, ...entry.grants], candidates, null).preset !== null
  }

  function toggle(entry: SidebarModule, on: boolean) {
    setExplicit((prev) => {
      const next = new Map(prev)
      if (on) {
        // Ticked at full unless this tab offers less; then the weakest, so a
        // tick never hands out more than the owner has looked at.
        const levels = levelsOf(entry)
        next.set(entry.href, levels.length > 1 ? levels[0].key : 'full')
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

  /** Change how much of a ticked tab the role gets. */
  function setLevel(entry: SidebarModule, level: string) {
    setExplicit((prev) => new Map(prev).set(entry.href, level))
  }

  const unassigned = staff.filter((member) => !assignments.some((row) => row.userId === member.id))

  /** A person a site-scoped role would blind: no home site anywhere. */
  function needsLocation(row: { userId: string; branchId: string }): boolean {
    if (!mustHaveBranch) return false
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
        // Inferred from the tabs on the server, with the same function.
        preset: '',
        branchId: null,
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
            {everything ? (
              <div className="space-y-1.5">
                <Label htmlFor="new-role-base">Based on</Label>
                <select
                  id="new-role-base"
                  value={baseKey}
                  onChange={(e) => chooseBase(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value={SCRATCH}>Nothing — tick the tabs below</option>
                  <option value={EVERYTHING}>{everything.label} — every tab on</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  {baseKey === EVERYTHING
                    ? 'A starting point only. Untick whatever this role should not see.'
                    : 'A starting point only. Tick the tabs this role should see.'}
                </p>
              </div>
            ) : null}
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
                      const reachable = checked || couldOpen(entry)
                      const twin = accessTwin(entry.href)
                      const disabled = !canGrant || !reachable || holders.length > 0 || carriers.length > 0
                      const note = !canGrant
                        ? 'You do not have this yourself'
                        : !reachable
                          ? 'Cannot go with the tabs already ticked'
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
                          <div className="min-w-0 flex-1">
                            <label htmlFor={id} className="min-w-0 cursor-pointer select-none">
                              <span className="block truncate text-sm">{entry.label}</span>
                              {note ? (
                                <span className="block truncate text-xs text-muted-foreground">{note}</span>
                              ) : null}
                            </label>
                            {/*
                              How much of this tab, for tabs where that is a real
                              question. Only when ticked, and only when there is
                              more than one answer — a picker with one option is
                              a control that teaches people it does nothing.

                              The hint under it says what the level does NOT
                              include, which is the half an owner is actually
                              deciding: "can raise a transfer request, cannot
                              approve one — not even their own".
                            */}
                            {checked && !disabled ? (
                              <TabLevel
                                entry={entry}
                                value={explicit.get(entry.href) ?? 'full'}
                                onChange={(level) => setLevel(entry, level)}
                              />
                            ) : null}
                          </div>
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
                  ? 'Choose a location for everyone marked — with these tabs the role works at one place.'
                  : 'Optional. Everyone on the role shares its access; the location is where each person works.'}
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
  locations,
  canAssignAllLocations,
  grantable,
  onClose,
}: {
  role: RoleRow
  locations: Array<{ id: string; name: string }>
  canAssignAllLocations: boolean
  grantable: Set<string>
  onClose: () => void
}) {
  const [name, setName] = React.useState(role.name)
  const [description, setDescription] = React.useState(role.description ?? '')
  /*
   * Only for a role that already pins a location — the ones made before
   * roles stopped doing that, and the per-location manager roles the
   * Locations screen keeps. New roles pin nothing, so the field is not
   * offered; an old one shows it so the pin can be changed or lifted.
   */
  const [branchId, setBranchId] = React.useState(role.branchId ?? '')
  const [granted, setGranted] = React.useState<Set<string>>(() => new Set(role.permissions))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

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
        // Worked out from the switches on the server, never chosen here.
        preset: '',
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
              <Label htmlFor="role-desc">Description</Label>
              <Input
                id="role-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Runs the stock room at Branch 02"
              />
            </div>
          </div>

          {role.branchId ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="role-branch">Location</Label>
                <select
                  id="role-branch"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {canAssignAllLocations ? (
                    <option value="">Any location — each person keeps their own</option>
                  ) : null}
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  This role is pinned to one location, so everyone put on it is moved there.
                  Choose “Any location” to let each person work where their own record says.
                </p>
              </div>
            </div>
          ) : null}

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

/**
 * How much of one tab a role gets.
 *
 * ── Why this is here at all ─────────────────────────────────────────────────
 *
 * A tick used to be all-or-nothing, and for most tabs that is the whole truth:
 * either the role reads the menu or it does not. It is not the truth for the
 * tabs where the useful job sits in the middle. A storeman raises a transfer
 * request; his manager approves it. Ticking "Stock transfers" for the storeman
 * used to hand him the approval too, which is the one thing the split exists
 * to prevent — a request nobody else has to agree to is not a request.
 *
 * So the levels come from the FEATURE's own actions (`levelsFor`), not from a
 * list kept here, and the same vocabulary answers the detailed grid on this
 * screen and the per-location grid on Locations. Three places deciding what a
 * tick means would be three places to disagree.
 *
 * The hint is the point of the control. "Can request" tells an owner what the
 * role does; "Cannot approve one — not even their own" tells them what they
 * are buying, which is the half they came to decide.
 */
function TabLevel({
  entry,
  value,
  onChange,
}: {
  entry: SidebarModule
  value: string
  onChange: (level: string) => void
}) {
  const levels = levelsOf(entry)
  // One answer is not a question. Most tabs land here and show nothing.
  if (levels.length < 2) return null

  const current = levels.find((l) => l.key === value)
  const id = `level-${entry.href.replace(/[^a-z0-9]+/gi, '-')}`

  return (
    <div className="mt-1.5">
      <label htmlFor={id} className="sr-only">
        How much of {entry.label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full max-w-[16rem] rounded-md border border-input bg-background px-2 text-xs"
      >
        {levels.map((level) => (
          <option key={level.key} value={level.key}>
            {level.label}
          </option>
        ))}
      </select>
      {current ? (
        <p className="mt-1 text-xs leading-snug text-muted-foreground">{current.hint}</p>
      ) : null}
    </div>
  )
}
