/**
 * Guard: a 'use server' module may only export async functions.
 *
 * Next turns every export of a `'use server'` file into a callable server
 * reference. Export anything else — a Zod schema, a constant, a class — and the
 * module throws on the first call into it:
 *
 *   Error: A "use server" file can only export async functions, found object.
 *
 * The failure is total and silent. Not one action in that file works, the
 * browser gets a bare digest, and nothing is written. Four features shipped
 * broken this way — locations, recipes, wastage and loyalty settings — each
 * exporting its Zod schema beside its actions. It survived because the schema
 * looked like tidy code, `tsc` is happy, `next build` is happy, and the
 * service-level tests never went through the action.
 *
 * `export type` and `export interface` are fine: types are erased before Next
 * sees the module.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/no-bad-server-exports.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(full)) out.push(full)
  }
  return out
}

const offences: string[] = []
let serverModules = 0
let exportedActions = 0

for (const file of walk('src')) {
  const src = readFileSync(file, 'utf8')
  if (!/^\s*['"]use server['"]/m.test(src)) continue
  serverModules += 1

  src.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('export ')) return

    // Types vanish at compile time, so they never become server references.
    if (/^export\s+(type|interface)\b/.test(trimmed)) return
    // `export default` of a function is equally fine.
    if (/^export\s+(async\s+)?function\b/.test(trimmed)) {
      if (!/^export\s+async\s+function\b/.test(trimmed)) {
        offences.push(
          `${file}:${i + 1}\n    ${trimmed}\n    → exported function must be async`,
        )
      } else {
        exportedActions += 1
      }
      return
    }
    // `export const foo = async (…) => …` is an async function too.
    if (/^export\s+const\s+\w+\s*(:[^=]+)?=\s*(async\s*\(|async\s+function)/.test(trimmed)) {
      exportedActions += 1
      return
    }

    offences.push(
      `${file}:${i + 1}\n    ${trimmed.slice(0, 100)}\n` +
      `    → only async functions may be exported from a 'use server' module`,
    )
  })
}

console.log(`'use server' modules:  ${serverModules}`)
console.log(`exported actions:      ${exportedActions}`)

if (offences.length > 0) {
  console.error(`\n✖ ${offences.length} illegal export(s) from a 'use server' module:\n`)
  for (const o of offences) console.error('  ' + o + '\n')
  console.error(
    'Every action in these files fails at runtime with a bare digest.\n' +
    'Move the value to a sibling module without the directive, or stop exporting it.',
  )
  process.exit(1)
}

console.log("\n✓ every 'use server' export is an async function")
