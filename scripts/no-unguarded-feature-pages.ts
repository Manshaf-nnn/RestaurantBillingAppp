/**
 * Every dashboard page must be refusable.
 *
 * ── The bug class ───────────────────────────────────────────────────────────
 *
 * An owner switches a feature off for a role. The sidebar item disappears.
 * The person types the URL and the page opens anyway.
 *
 * That is not hypothetical — it was true of two pages when this was written:
 *
 *   /dashboard/links     a 'use client' page with NO server guard at all. The
 *                        sidebar hid it behind `staff.manage`; the page itself
 *                        asked for nothing, so every dashboard role could open
 *                        it and mint an access link.
 *   /dashboard/purchases/receive
 *                        guarded `purchase.view` while the sidebar hid it
 *                        behind `purchase.receive` — hidden from a role that
 *                        could still reach it.
 *
 * Both type-check. Both render. Neither shows up in any test that asks whether
 * the *sidebar* is right, because the sidebar was right — it was the page that
 * was not. Rolelogic §8 states the rule plainly: a disabled feature must not be
 * reachable by direct URL, not merely absent from the menu.
 *
 * ── What this proves, and what it does not ──────────────────────────────────
 *
 * Three things, in order of how easy each is to get wrong:
 *
 *   1. the page CALLS a permission guard at all
 *   2. the permission it names is one the role builder can switch — a guard on
 *      a permission absent from `FEATURES` is a page no owner can deny, which
 *      is the same hole wearing a uniform
 *   3. that permission BELONGS to the feature owning the route — so the menu
 *      entry and the door ask the same question
 *
 * The third was added after the split that gave the six reports their own
 * permissions: the sidebar moved, fourteen page guards did not, and every
 * report was hidden-but-reachable for an hour. A check that only ran when
 * somebody remembered to run it would not have caught that; this one fails the
 * build.
 *
 * It does NOT prove the queries on the page are branch-scoped, nor that the
 * feature/route mapping in the registry is the one a human would choose — only
 * that the code agrees with whatever the registry says. Those are
 * `role-permissions-test.ts` and `branch-isolation-test.ts`, in the same way
 * `no-unscoped-branch-pages.ts` defers its second half to them.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/no-unguarded-feature-pages.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { REGISTERED_PERMISSIONS, featureForRoute } from '../src/features/access/features'

/**
 * Pages that legitimately guard on identity rather than on a feature.
 *
 * The bar is deliberately high: "every signed-in member of staff may see this,
 * whatever their role" — which is true of a help page and of your own profile,
 * and of almost nothing else. A page here can never be switched off for a
 * role, so anything that shows business data does not belong on this list.
 */
const IDENTITY_ONLY: Record<string, string> = {
  'dashboard/help': 'How to use the app. Denying it helps nobody.',
  'dashboard/settings/profile': 'Your own name, password and sessions — not the restaurant’s.',
}

const ROOT = 'src/app'

/** Every page.tsx under a directory, as a route-ish key. */
function pages(dir: string, prefix = ''): Array<{ key: string; file: string }> {
  const found: Array<{ key: string; file: string }> = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // Route groups — (console) — are not part of the path.
      const next = entry.startsWith('(') ? prefix : prefix ? `${prefix}/${entry}` : entry
      found.push(...pages(full, next))
    } else if (entry === 'page.tsx') {
      found.push({ key: prefix, file: full })
    }
  }
  return found
}

/**
 * The permissions a page guards itself with.
 *
 * Matches `PERMISSIONS.X` inside a `requirePagePermission(` or
 * `requirePageAnyPermission([...])` call. Deliberately a regex and not the
 * TypeScript compiler — every other guard in `scripts/` is a text scan, and a
 * page that hides its guard behind indirection this cannot see is a page
 * nobody should be writing.
 */
function guardedPermissions(src: string, permissionValues: Map<string, string>): string[] | null {
  const call = /requirePage(?:Any)?Permission\s*\(([\s\S]{0,400}?)\)/g
  const found: string[] = []
  let hit: RegExpExecArray | null
  let sawGuard = false

  while ((hit = call.exec(src)) !== null) {
    sawGuard = true
    const args = hit[1]
    for (const name of args.matchAll(/PERMISSIONS\.([A-Z0-9_]+)/g)) {
      const value = permissionValues.get(name[1])
      if (value) found.push(value)
    }
  }
  return sawGuard ? found : null
}

/** `PERMISSIONS` as NAME → 'value', read from the source so it cannot drift. */
function permissionMap(): Map<string, string> {
  const src = readFileSync('src/lib/rbac.ts', 'utf8')
  const body = src.slice(src.indexOf('export const PERMISSIONS'), src.indexOf('} as const'))
  const map = new Map<string, string>()
  for (const line of body.matchAll(/([A-Z0-9_]+):\s*'([^']+)'/g)) {
    map.set(line[1], line[2])
  }
  return map
}

function main() {
  const permissionValues = permissionMap()
  const all = pages(join(ROOT, 'dashboard'), 'dashboard')

  const unguarded: string[] = []
  const unregistered: string[] = []
  const mismatched: string[] = []
  const stale: string[] = []
  let guarded = 0

  for (const { key, file } of all) {
    const src = readFileSync(file, 'utf8')
    const perms = guardedPermissions(src, permissionValues)

    if (perms === null) {
      if (key in IDENTITY_ONLY) continue
      unguarded.push(`  ${file}\n    route: /${key}`)
      continue
    }

    guarded += 1

    /*
     * A guard naming a permission the registry has never heard of cannot be
     * switched off by anybody, so the page is undeniable in practice. That is
     * the same hole as having no guard, only harder to see.
     */
    const orphans = perms.filter((p) => !REGISTERED_PERMISSIONS.has(p))
    if (orphans.length > 0) {
      unregistered.push(`  ${file}\n    route: /${key}\n    not in FEATURES: ${orphans.join(', ')}`)
      continue
    }

    /*
     * ── And it has to be the RIGHT permission ─────────────────────────────
     *
     * Registered is not enough. `/dashboard/reports/profit` guarded
     * `report.view` while the sidebar hid it behind `report.profit`: both are
     * real, both are switchable, and switching Gross profit off removed the
     * menu entry while the URL kept working. Every report was like it, and the
     * hole was introduced by the very change that split the permissions —
     * which is the argument for checking it here rather than remembering.
     *
     * So the permission a page guards must belong to the feature that owns its
     * route. Anything else is a page whose menu entry and whose door disagree.
     */
    const feature = featureForRoute(`/${key}`)
    if (!feature) {
      unregistered.push(`  ${file}\n    route: /${key}\n    no feature claims this route`)
      continue
    }
    const owned = new Set(feature.actions.map((a) => a.permission as string))
    const foreign = perms.filter((p) => !owned.has(p))
    if (foreign.length > 0) {
      mismatched.push(
        `  ${file}\n    route: /${key}\n` +
        `    guards:  ${foreign.join(', ')}\n` +
        `    but "${feature.label}" owns: ${[...owned].join(', ')}`,
      )
    }
  }

  // An exemption that stopped being true is a comment that lies.
  for (const key of Object.keys(IDENTITY_ONLY)) {
    const match = all.find((p) => p.key === key)
    if (!match) {
      stale.push(`  ${key} — no such page any more`)
    } else if (guardedPermissions(readFileSync(match.file, 'utf8'), permissionValues) !== null) {
      stale.push(`  ${key} — now guards a permission; drop the exemption`)
    }
  }

  console.log(`dashboard pages:      ${all.length}`)
  console.log(`permission-guarded:   ${guarded}`)
  console.log(`identity-only:        ${Object.keys(IDENTITY_ONLY).length}`)
  console.log(`registered features:  ${REGISTERED_PERMISSIONS.size} permissions`)

  if (stale.length > 0) {
    console.log('\nExemptions that no longer match the code:')
    console.log(stale.join('\n'))
  }

  if (unguarded.length > 0) {
    console.error(`\n✖ ${unguarded.length} dashboard page(s) with no permission guard:\n`)
    console.error(unguarded.join('\n\n'))
    console.error(
      '\nEvery dashboard page must call `requirePagePermission(PERMISSIONS.X, path)`\n' +
      '(or `requirePageAnyPermission`), so switching the feature off actually\n' +
      'refuses the URL rather than only hiding the menu entry. A page that is\n' +
      'genuinely for every signed-in member of staff goes in IDENTITY_ONLY in\n' +
      `${__filename.split('/').pop()} with the reason.`,
    )
    process.exit(1)
  }

  if (unregistered.length > 0) {
    console.error(`\n✖ ${unregistered.length} page(s) guard a permission no role can switch:\n`)
    console.error(unregistered.join('\n\n'))
    console.error(
      '\nAdd the permission to the feature that owns this route in\n' +
      'src/features/access/features.ts. Until it is there, the role builder\n' +
      'cannot show it and no owner can deny this page.',
    )
    process.exit(1)
  }

  if (mismatched.length > 0) {
    console.error(`\n✖ ${mismatched.length} page(s) guard a permission their feature does not own:\n`)
    console.error(mismatched.join('\n\n'))
    console.error(
      '\nThe sidebar and the URL must ask the same question. Point the page at one\n' +
      'of its own feature\'s permissions, or move the route onto the feature that\n' +
      'really owns it in src/features/access/features.ts.',
    )
    process.exit(1)
  }

  if (stale.length > 0) {
    console.error('\n✖ stale exemptions — fix the list above')
    process.exit(1)
  }

  console.log('\n✓ every dashboard page is guarded by a switchable permission')
}

main()
