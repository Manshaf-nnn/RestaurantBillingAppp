import type { UserRole } from '@prisma/client'

import { NAV_SECTIONS, type NavItem } from '@/features/dashboard/nav'
import { ROLE_HOME, ROLE_PERMISSIONS, requiresOwnBranch, seesAllLocations } from '@/lib/rbac'

import { FEATURES, REGISTERED_PERMISSIONS, primaryAction } from './features'

/**
 * The sidebar, read as a list of modules an owner can hand out.
 *
 * ── Why this file, and why it is pure ───────────────────────────────────────
 *
 * Create Role asks one question — "which sidebar tabs does this job get" —
 * and the answer has to be computed identically in three places: the dialog
 * that ticks the boxes, the Server Action that refuses a list the dialog
 * could not have produced, and the tests that pin both. So the arithmetic
 * lives here, imports nothing that is server- or client-only, and everything
 * else calls it. There is no second list of modules: `SIDEBAR_MODULES` is
 * `NAV_SECTIONS` flattened, and a tab that is not in the sidebar cannot be
 * offered here.
 *
 * ── The three facts a module carries ────────────────────────────────────────
 *
 *   permission  what the sidebar checks to show the entry — the same field
 *               `visibleSections` reads, so a ticked box and a visible tab
 *               cannot disagree
 *   grants      what ticking it switches on; `[permission]` unless the entry
 *               says otherwise (the POS shell does)
 *   requires    other entries it cannot work without; ticked for you, locked
 *               while this one is on, and closed over again on the server
 */
export interface SidebarModule {
  href: string
  label: string
  section: string
  permission: string
  /** Further permissions any ONE of which also shows the entry. */
  anyOf: string[]
  grants: string[]
  /** Direct declarations only — `requiredHrefs` walks them transitively. */
  requires: string[]
  /** Roles the edge lets through, or null when the entry is open to everyone. */
  roles: string[] | null
}

function toModule(section: string, item: NavItem): SidebarModule {
  return {
    href: item.href,
    label: item.label,
    section,
    permission: item.permission,
    anyOf: item.anyOf ?? [],
    grants: item.grants ?? [item.permission],
    requires: item.requires ?? [],
    roles: item.roles ?? null,
  }
}

/** Every sidebar entry, in sidebar order. Always all of them — see the dialog. */
export const SIDEBAR_MODULES: SidebarModule[] = NAV_SECTIONS.flatMap((section) =>
  section.items.map((item) => toModule(section.title, item)),
)

const BY_HREF = new Map(SIDEBAR_MODULES.map((entry) => [entry.href, entry]))

export function sidebarModule(href: string): SidebarModule | undefined {
  return BY_HREF.get(href)
}

/** Everything this entry needs, transitively, each once, nearest first. */
export function requiredHrefs(href: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([href])
  const walk = (from: string) => {
    for (const dep of BY_HREF.get(from)?.requires ?? []) {
      if (seen.has(dep)) continue
      seen.add(dep)
      out.push(dep)
      walk(dep)
    }
  }
  walk(href)
  return out
}

/**
 * May a role built on this preset reach the entry at all?
 *
 * The same test `visibleSections` applies. No role given means "do not ask",
 * which is what the builder needs while a role is still being composed.
 */
export function edgeAllows(entry: SidebarModule, role?: string | null): boolean {
  return !entry.roles || !role || entry.roles.includes(role)
}

/**
 * The entries a permission set shows.
 *
 * The sidebar's own rule — `permission` or any of `anyOf`, and the edge lets
 * the role in — applied to a raw set rather than to a session, so the builder
 * can ask it about a role that does not exist yet.
 */
export function modulesShownBy(
  permissions: ReadonlySet<string>,
  role?: string | null,
): SidebarModule[] {
  return SIDEBAR_MODULES.filter(
    (entry) =>
      (permissions.has(entry.permission) || entry.anyOf.some((p) => permissions.has(p))) &&
      edgeAllows(entry, role),
  )
}

/**
 * The ticked entries plus everything they require.
 *
 * An entry the role's edge gate would refuse is dropped rather than closed
 * over: a Kitchen-based role that somehow lists POS must not acquire Payment
 * details on the strength of a tab it can never open.
 */
export function closeSelection(hrefs: Iterable<string>, role?: string | null): Set<string> {
  const out = new Set<string>()
  for (const href of hrefs) {
    const entry = BY_HREF.get(href)
    if (!entry || !edgeAllows(entry, role)) continue
    out.add(href)
    for (const dep of requiredHrefs(href)) out.add(dep)
  }
  return out
}

/** Which of the SHOWN entries hold this one in place — for "required by POS". */
export function requiredBy(href: string, shown: Iterable<SidebarModule>): SidebarModule[] {
  const holders: SidebarModule[] = []
  for (const entry of shown) {
    if (entry.href !== href && requiredHrefs(entry.href).includes(href)) holders.push(entry)
  }
  return holders
}

/**
 * An earlier entry that opens on the very same permission, if any.
 *
 * Stock, Stock ledger and Units & categories are all `inventory.view`, so
 * they cannot be ticked apart. The dialog says so beside the later ones
 * instead of letting a box appear to do something on its own.
 */
export function accessTwin(href: string): SidebarModule | null {
  const entry = BY_HREF.get(href)
  if (!entry) return null
  for (const other of SIDEBAR_MODULES) {
    if (other.href === href) return null
    if (other.permission === entry.permission) return other
  }
  return null
}

/**
 * The permission list for a set of ticked entries, on top of a starting list.
 *
 * `base` is what "Based on" seeded — a template's full list, including the
 * action-level rights no tab stands for (refund, approve, cost edit). Those
 * survive as long as the module selling them is still on.
 *
 * An unticked entry loses exactly what SHOWS it — its `permission` and
 * `anyOf` — never the wider `grants`, which may be rights other screens use:
 * a manager who unticks POS still changes order status from Orders. And an
 * entry the role's edge gate hides is not "unticked", it is not applicable:
 * a Waiter template holds `order.create` for the waiter station, the edge
 * hides POS from waiters, and treating POS as unticked would take the
 * waiter's orders away.
 *
 * Then the detailed builder's own rule: turning a feature off turns its
 * actions off. A permission that no reachable feature still sells is dropped
 * — except one that some other reachable feature sells too, so
 * `accounting.close`, sold by two features, does not vanish because one went.
 *
 * What a ticked entry grants is added last and unconditionally, so a tab can
 * never be ticked and absent.
 */
export function permissionsForSelection(
  selected: ReadonlySet<string>,
  base: Iterable<string> = [],
  role?: string | null,
): string[] {
  const on = new Set<string>()
  const off = new Set<string>()
  for (const entry of SIDEBAR_MODULES) {
    if (selected.has(entry.href)) {
      for (const permission of entry.grants) on.add(permission)
    } else if (edgeAllows(entry, role)) {
      off.add(entry.permission)
      for (const permission of entry.anyOf) off.add(permission)
    }
  }
  for (const permission of on) off.delete(permission)

  const result = new Set<string>()
  for (const permission of base) if (!off.has(permission)) result.add(permission)
  for (const permission of on) result.add(permission)

  const reachable = new Set<string>()
  for (const feature of FEATURES) {
    const primary = primaryAction(feature)
    if (primary && result.has(primary.permission)) {
      for (const action of feature.actions) reachable.add(action.permission)
    }
  }
  for (const permission of [...result]) {
    if (REGISTERED_PERMISSIONS.has(permission) && !reachable.has(permission)) result.delete(permission)
  }
  for (const permission of on) result.add(permission)

  return [...result]
}

/**
 * Close a permission list over the sidebar's dependencies.
 *
 * The server-side half. Whatever the client sent, if the list shows an entry
 * then it also carries what that entry requires — so "POS on, Payment details
 * off" is not a state a saved role can be in. Repeated to a fixpoint because
 * a dependency's own grants may show a further entry with requirements of
 * its own. Honours the role's edge gate for the same reason `closeSelection`
 * does.
 */
export function withRequiredPermissions(
  permissions: Iterable<string>,
  role?: string | null,
): string[] {
  const set = new Set(permissions)
  let changed = true
  while (changed) {
    changed = false
    for (const entry of modulesShownBy(set, role)) {
      for (const dep of requiredHrefs(entry.href)) {
        for (const permission of BY_HREF.get(dep)?.grants ?? []) {
          if (!set.has(permission)) {
            set.add(permission)
            changed = true
          }
        }
      }
    }
  }
  return [...set]
}

/**
 * The built-in a "start from scratch" role is based on.
 *
 * ── Why this is inferred and not merely "the smallest" ──────────────────────
 *
 * A custom role's permission list REPLACES its preset's, so the preset is not
 * about power. It decides three other things: where the person lands, what
 * the edge middleware lets them reach, and whether they are confined to one
 * site. "Least privileged" answered none of those — it produced Kitchen for
 * every from-scratch role, and a Kitchen-based role with POS ticked was a tab
 * that bounced to /forbidden on every click.
 *
 * So, from what was ticked:
 *
 *   1. only presets the edge lets into every gated entry that is on
 *   2. when a location was chosen, only presets that are actually confined
 *      by it — a purchasing manager pinned to Kandy still sees every site,
 *      and a form that says Kandy must not build that
 *   3. prefer a preset whose landing page is one of the tabs that are on,
 *      then the most confined kind of preset, then the fewest permissions
 *
 * `blockedBy` names the gated entries when nothing satisfies (1), so the
 * refusal can say "untick one of these" rather than "no".
 */
export function inferPreset(
  permissions: Iterable<string>,
  candidates: UserRole[],
  branchId?: string | null,
): { preset: UserRole | null; blockedBy: SidebarModule[] } {
  const set = new Set(permissions)
  const gated = modulesShownBy(set, null).filter((entry) => entry.roles)

  const compatible = candidates.filter((preset) =>
    gated.every((entry) => entry.roles!.includes(preset)),
  )
  if (compatible.length === 0) return { preset: null, blockedBy: gated }

  const confined = branchId
    ? compatible.filter((preset) => !seesAllLocations(preset, branchId))
    : compatible
  const pool = confined.length > 0 ? confined : compatible

  const landsOnATab = (preset: UserRole) => {
    const home = ROLE_HOME[preset].split('?')[0]
    return modulesShownBy(set, preset).some((entry) => entry.href === home)
  }
  const ranked = pool
    .map((preset, index) => ({ preset, index }))
    .sort((a, b) => {
      const landing = Number(landsOnATab(b.preset)) - Number(landsOnATab(a.preset))
      if (landing !== 0) return landing
      const confinement = Number(requiresOwnBranch(b.preset)) - Number(requiresOwnBranch(a.preset))
      if (confinement !== 0) return confinement
      const size = ROLE_PERMISSIONS[a.preset].length - ROLE_PERMISSIONS[b.preset].length
      if (size !== 0) return size
      return a.index - b.index
    })

  return { preset: ranked[0].preset, blockedBy: [] }
}
