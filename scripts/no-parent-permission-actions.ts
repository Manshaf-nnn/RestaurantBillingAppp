/**
 * Actions ask for the permission their feature sells, not its parent
 * (bugfix.md S10).
 *
 * Some permissions were SPLIT from a parent — `tasks.view` from
 * `dashboard.view`, `handover.view` from `order.view` — so that a role can
 * hold the parent with the child switched off. The page guards honour that;
 * `no-unguarded-feature-pages` proves it. Three action files did not: they
 * still asked for the PARENT, so a custom role with the dashboard on and
 * tasks off could not open /dashboard/tasks and could still create, complete
 * and withdraw tasks. The feature switch was a menu entry.
 *
 * This walks each split: the feature that sells the child, the pages on its
 * routes, the feature modules those pages import — and refuses any actions
 * file among them that names the parent permission.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/no-parent-permission-actions.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { FEATURES } from '../src/features/access/features'
import { PERMISSIONS } from '../src/lib/rbac'

/**
 * Modules every page imports for chrome and shared helpers, whose own
 * actions legitimately use the broad permission.
 */
const SHARED: Record<string, string> = {
  dashboard: 'Its own actions are the dashboard’s and answer to dashboard.view by right',
  access: 'Navigation and feature-access helpers, not the page’s feature',
  customers: 'suggestCustomersByPhone is the till’s lookup, sold as customer.view by the Customers feature and used from several pages',
}

function main() {
  const rbac = readFileSync('src/lib/rbac.ts', 'utf8')
  const splits = [...rbac.matchAll(/\[PERMISSIONS\.(\w+), PERMISSIONS\.(\w+)\]/g)].map((m) => ({
    childKey: m[1],
    parentKey: m[2],
  }))

  const violations: string[] = []
  let checked = 0

  for (const { childKey, parentKey } of splits) {
    const child = (PERMISSIONS as Record<string, string>)[childKey]
    const feature = FEATURES.find((f) => f.actions.some((a) => a.permission === child))
    if (!feature) continue

    const dirs = new Set<string>()
    for (const route of feature.routes) {
      const page = join('src/app', route, 'page.tsx')
      if (!existsSync(page)) continue
      const source = readFileSync(page, 'utf8')
      for (const m of source.matchAll(/@\/features\/([\w-]+)\//g)) dirs.add(m[1])
    }

    /*
     * A module the PARENT's own feature also imports is that feature's module,
     * not this one's: /dashboard/customers/analytics imports @/features/customers,
     * whose actions rightly ask for customer.view — the Customers feature sells
     * it. Only modules exclusive to the child's pages are held to the child.
     */
    const parent = (PERMISSIONS as Record<string, string>)[parentKey]
    const parentDirs = new Set<string>()
    for (const owner of FEATURES.filter((f) => f.actions.some((a) => a.permission === parent))) {
      for (const route of owner.routes) {
        const page = join('src/app', route, 'page.tsx')
        if (!existsSync(page)) continue
        for (const m of readFileSync(page, 'utf8').matchAll(/@\/features\/([\w-]+)\//g)) parentDirs.add(m[1])
      }
    }

    for (const dir of dirs) {
      if (dir in SHARED || parentDirs.has(dir)) continue
      const folder = join('src/features', dir)
      if (!existsSync(folder)) continue
      for (const file of readdirSync(folder).filter((f) => /^actions.*\.ts$/.test(f))) {
        checked += 1
        const source = readFileSync(join(folder, file), 'utf8')
        if (source.includes(`PERMISSIONS.${parentKey})`)) {
          violations.push(
            `  src/features/${dir}/${file}\n    asks for ${parentKey}, but "${feature.label}" sells ${childKey} (split from it)`,
          )
        }
      }
    }
  }

  console.log(`splits:   ${splits.length}`)
  console.log(`actions:  ${checked} file(s) checked`)

  if (violations.length > 0) {
    console.error(`\n✖ ${violations.length} action file(s) ask for a parent permission their feature does not sell:\n`)
    for (const line of violations) console.error(line)
    console.error(
      '\nThe page guard and the action must ask the same question, or a custom role with the\n' +
        'feature switched off is refused the screen and still allowed the action behind it.',
    )
    process.exit(1)
  }

  console.log('\n✓ every action asks for the permission its feature sells')
}

main()
