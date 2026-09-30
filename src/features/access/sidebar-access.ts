import type { UserRole } from '@prisma/client'

import { NAV_SECTIONS, reachableNavItems, type NavItem } from '@/features/dashboard/nav'
import {
  ROLE_HOME,
  ROLE_PERMISSIONS,
  landingFor,
  requiresOwnBranch,
  seesAllLocations,
  type PermissionSubject,
} from '@/lib/rbac'
import {
  FEATURES,
  REGISTERED_PERMISSIONS,
  allPermissionsOf,
  featureForRoute,
  levelOf,
  levelsFor,
  permissionsForLevel,
  primaryAction,
  type Feature,
} from './features'

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
 * What the builder has chosen.
 *
 * A map of href → level key says how much of each tab. A plain set says only
 * which tabs are on, which is what a tick meant before levels existed — so
 * every caller that predates them keeps its meaning without being touched,
 * and, more importantly, without silently acquiring a downgrade it never
 * asked for. See `permissionsForSelection`.
 */
export type Selection = ReadonlySet<string> | ReadonlyMap<string, string>

export function asLevels(selected: Selection): ReadonlyMap<string, string> {
  if (selected instanceof Map) return selected
  const out = new Map<string, string>()
  // `tick`, not `full`: a set says the tab is on and nothing about how much.
  for (const href of selected as ReadonlySet<string>) out.set(href, 'tick')
  return out
}

/** The feature a sidebar entry belongs to, where it has one. */
export function featureOf(entry: SidebarModule): Feature | undefined {
  return featureForRoute(entry.href)
}

/**
 * What this entry hands out at a given level.
 *
 * Four kinds of level, and the distinction between the first two is the whole
 * reason this reads carefully:
 *
 *   tick   what a tick meant before levels — the entry's own `grants`, wider
 *          than the feature for a shell like the POS whose tabs are gated one
 *          by one, and no claim about the feature's other actions
 *   full   a CHOICE of everything: `grants` plus every action the feature has
 *   open   reachability only, for a dependency pulled in by `requires`
 *   …      any level the feature declares, answered by the feature itself
 *
 * Everything but `tick` and `open` is answered by the FEATURE, so one place
 * decides what an amount of a feature means and the detailed grid, this
 * builder and the per-location grid cannot drift apart.
 */
export function grantsAtLevel(entry: SidebarModule, level: string): string[] {
  /*
   * `tick` is what a tick meant before levels: the entry's own grants, and no
   * statement about the feature's other actions. It is what a plain set of
   * hrefs resolves to, so every caller that predates levels — and every
   * template round-tripping through `modulesShownBy` — keeps its meaning.
   */
  if (level === 'tick' || level === '') return entry.grants
  /*
   * `full` is a CHOICE of full, so it means all of it: the entry's grants and
   * everything its feature can hand out. It must be the exact complement of
   * `everythingGrantable`, or choosing the top level would leave rights in
   * `off` that nothing granted back and the top level would quietly be less
   * than the one below it.
   */
  if (level === 'full') {
    const feature = featureOf(entry)
    return feature ? [...entry.grants, ...allPermissionsOf(feature)] : entry.grants
  }
  /*
   * `open` is the level a DEPENDENCY comes in at: exactly what shows the
   * entry, and no authority at all. `requires` exists so a ticked tab is not
   * a dead link, and pulling its dependency in at full rights would make a
   * tick grant more than its label says — POS would quietly confer every
   * power on Payment details rather than the ability to open it.
   */
  if (level === 'open') return [entry.permission]
  const feature = featureOf(entry)
  if (!feature) return entry.grants
  const granted = permissionsForLevel(feature, level)
  /*
   * A level that grants nothing would tick a tab the viewer cannot open, so
   * it falls back to what SHOWS the entry. `levelsFor` never offers such a
   * level; this is for a stored value that no longer matches its feature.
   */
  return granted.length > 0 ? granted : [entry.permission]
}

/** Everything this entry could grant at any level — what a downgrade drops. */
export function everythingGrantable(entry: SidebarModule): string[] {
  const feature = featureOf(entry)
  return [...entry.grants, ...(feature ? allPermissionsOf(feature) : [])]
}

/**
 * The levels this entry offers, weakest first, minus "off".
 *
 * "Off" is not offered as a level because the tick is already the off switch:
 * two ways to say the same thing on one row is how a screen teaches people
 * not to trust either.
 */
export function levelsOf(entry: SidebarModule): Array<{ key: string; label: string; hint: string }> {
  const feature = featureOf(entry)
  if (!feature) return [{ key: 'full', label: 'Full access', hint: 'Everything this tab can do.' }]

  /*
   * Levels that hand out exactly the same permissions are one level, and the
   * weakest wording wins. A feature with a single action would otherwise offer
   * "View only" and "Full access" as separate choices that do identically
   * nothing different — a control whose options are indistinguishable teaches
   * people the control is decorative.
   */
  /*
   * And a level that would not SHOW this entry is not a level of this entry.
   *
   * The POS shell belongs to a feature whose lowest level is "read" —
   * `payment.view`, the Payment details report's right — which opens nothing
   * at the till. A fresh tick starts at the weakest level on offer, so
   * ticking POS from scratch handed out `payment.view`, the sidebar's own
   * rule then hid the POS tab, and the box quietly unticked itself: the role
   * saved with Dashboard, Transfers and the till's dependencies, and its
   * people signed in to find no POS. "Based on POS" used to paper over it by
   * seeding every tab at full. So only levels whose grants would light the
   * tab — its `permission` or one of `anyOf` — are offered here.
   */
  const shows = new Set([entry.permission, ...entry.anyOf])
  const out: Array<{ key: string; label: string; hint: string }> = []
  const seen = new Set<string>()
  for (const level of levelsFor(feature)) {
    if (level.key === 'off') continue
    const granted = permissionsForLevel(feature, level.key)
    if (!granted.some((permission) => shows.has(permission))) continue
    const fingerprint = [...new Set(granted)].sort().join('|')
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push(level)
  }
  return out.length > 0 ? out : [{ key: 'full', label: 'Full access', hint: 'Everything this tab can do.' }]
}

/** Which level a saved role sits at for this entry, or `custom` if between. */
export function levelHeldBy(entry: SidebarModule, granted: ReadonlySet<string>): string {
  const feature = featureOf(entry)
  if (!feature) return 'full'
  return levelOf(feature, granted as Set<string>)
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
  selected: Selection,
  base: Iterable<string> = [],
  role?: string | null,
): string[] {
  const chosen = asLevels(selected)
  /*
   * ── Did the caller say how MUCH, or only whether? ───────────────────────
   *
   * A stated level is a statement about what the role does NOT get as well as
   * what it does, so lowering a tab has to take the rights above that level
   * away — including ones that arrived from a template in `base`.
   *
   * `tick` states nothing. It is what a tick meant before levels existed, it
   * is what a plain set of hrefs resolves to, and it is what a tab sits at
   * when a role was composed switch by switch in the detailed grid and lands
   * between two levels. Applying the downgrade to it would delete
   * `transfer.approve` from every Manager, and would quietly round somebody's
   * hand-built role to the nearest offered level. So the wide removal is per
   * ENTRY and only for a level that was actually chosen.
   */
  const on = new Set<string>()
  /*
   * Two removals, kept apart because they are rescuable on different terms.
   *
   * `offShown` is what SHOWS an unticked entry — its `permission` and `anyOf`.
   * This is the original rule and it is absolute: `order.create` is what shows
   * the POS, so unticking the POS removes it even though the Orders feature
   * also lists it as an action. Otherwise a tab could never be turned off
   * while a neighbour sharing its feature stayed on.
   *
   * `offWide` is the rest of a feature's actions, and is what makes a level a
   * level. It IS rescuable: a right two features sell survives while either
   * still sells it, so unticking Purchasing does not take `purchase.approve`
   * away from an approver whose Approvals tab offers it as "Decide".
   */
  const offShown = new Set<string>()
  const offWide = new Set<string>()
  for (const entry of SIDEBAR_MODULES) {
    const level = chosen.get(entry.href)
    if (level !== undefined) {
      for (const permission of grantsAtLevel(entry, level)) on.add(permission)
      // A stated level says what the role does NOT get, so it removes the
      // rest of its feature — including rights that arrived from a template.
      if (level !== 'tick') {
        for (const permission of everythingGrantable(entry)) offWide.add(permission)
      }
    } else if (edgeAllows(entry, role)) {
      offShown.add(entry.permission)
      for (const permission of entry.anyOf) offShown.add(permission)
      // Untick is the empty level, so it drops the same wide set.
      for (const permission of everythingGrantable(entry)) offWide.add(permission)
    }
  }

  /*
   * A tab at a STATED level justifies only what that level grants — which is
   * what makes a downgrade a downgrade: transfers at "Can request" does not
   * rescue `transfer.approve` from its own removal. A tab at `tick` states
   * nothing about its actions, so it justifies all of them.
   */
  for (const [href, level] of chosen) {
    const entry = BY_HREF.get(href)
    if (!entry) continue
    const justified = level === 'tick' ? everythingGrantable(entry) : grantsAtLevel(entry, level)
    for (const permission of justified) offWide.delete(permission)
  }

  const off = new Set<string>([...offShown, ...offWide])
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
 * Where this person lands after signing in.
 *
 * Somebody on their built-in role lands where it always has (`ROLE_HOME`).
 * Somebody on one of the restaurant's own roles lands on THEIR SIDEBAR:
 *
 *   1. the Dashboard tab, when the role has it;
 *   2. otherwise the first tab that stands on its own — not a station screen,
 *      and not one the station's own tick brought along (Delivery Desk,
 *      Invoices and Payment details all arrive with the POS);
 *   3. otherwise the station: the built-in's own home if it is one of the
 *      role's tabs, else the first station ticked.
 *
 * ── Why the built-in's home is the wrong answer for a custom role ───────────
 *
 * A custom role behaves like a built-in underneath, and a role whose tabs
 * include the POS behaves like POS — so its people were sent to
 * `/cashier/pos`, the full-screen till, the moment they signed in. The till
 * has no sidebar. An owner who built "POS tester" with Dashboard, Transfers
 * and POS ticked watched the person sign in and see nothing but the POS, and
 * concluded the other two tabs had not been granted. They had; the person
 * had been dropped into the one tab that hides the rest.
 *
 * The owner's model is the right one: the POS is a tab like Transfers or
 * Live floor, and a role is the tabs it was given. Step 2 is what makes a
 * till-only role still open on the till — its other tabs are the POS's own
 * baggage, not somewhere a cashier meant to start the day.
 */
export function homeFor(user: PermissionSubject): string {
  if (user.rolePermissions === null || user.rolePermissions === undefined) {
    return landingFor(user.role)
  }
  const items = reachableNavItems(user)
  if (items.length === 0) return landingFor(user.role)
  if (items.some((item) => item.href === '/dashboard')) return '/dashboard'

  const stations = items.filter((item) => item.roles)
  // Everything a ticked station drags in: its dependencies, and any tab whose
  // own permission is one the station's feature hands out at full.
  const carried = new Set<string>()
  for (const station of stations) {
    for (const dep of requiredHrefs(station.href)) carried.add(dep)
    const entry = BY_HREF.get(station.href)
    const handsOut = new Set(entry ? everythingGrantable(entry) : [])
    for (const item of items) {
      if (handsOut.has(item.permission) || (item.anyOf ?? []).some((p) => handsOut.has(p))) {
        carried.add(item.href)
      }
    }
  }
  const standalone = items.find((item) => !item.roles && !carried.has(item.href))
  if (standalone) return standalone.href

  const home = landingFor(user.role)
  const homePath = home.split('?')[0]
  if (stations.some((station) => station.href === homePath)) return home
  return stations[0]?.href ?? items[0].href
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
