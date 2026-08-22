/**
 * Guard: no client component may call a server action unprotected.
 *
 * A server action can fail in two different ways. `runAction` converts every
 * business failure into `{ok:false}`, which is what callers are written to
 * expect. But an action can also fail in *transport* — expired session, dropped
 * connection, serverless timeout, a deploy replacing the bundle mid-click — and
 * Next's action client rejects the promise instead. A handler shaped like
 *
 *     setBusy(true)
 *     const result = await someAction(payload)
 *     setBusy(false)
 *
 * skips the reset on a rejection, and since these buttons are `disabled={busy}`
 * they are left reading "Adding…" forever with no message. That defect shipped
 * in 29 components and cost several rounds of debugging, because the bug that
 * hung the button also destroyed the evidence of why.
 *
 * `callAction` / `useAction` make the promise always resolve. This asserts that
 * nothing goes around them, so the class cannot come back.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/no-raw-action-calls.ts
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

/** Names imported from an `actions` module — the real definition of "an action". */
function importedActionNames(src: string): Set<string> {
  const names = new Set<string>()
  const importRe = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(src))) {
    // A module whose path ends in `actions` — but not the helper that wraps
    // them, whose own name would otherwise match.
    if (!/(^|\/)actions$/.test(m[2])) continue
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  return names
}

const offences: string[] = []
let clientFiles = 0
let guardedCalls = 0

for (const file of walk('src')) {
  const src = readFileSync(file, 'utf8')
  if (!src.includes("'use client'")) continue
  clientFiles += 1

  const actions = importedActionNames(src)
  if (actions.size === 0) continue

  const lines = src.split('\n')
  lines.forEach((line, i) => {
    /*
     * An action that REDIRECTS cannot be wrapped.
     *
     * `redirect()` works by throwing a signal the framework catches, and
     * `callAction` converts every rejection into `{ ok: false }` — so wrapping
     * one would swallow the navigation and turn the call into a silent no-op.
     * That is the exact failure this guard exists to prevent, arrived at from
     * the other direction.
     *
     * The exemption is opt-in and has to be written on the line above, so it is
     * a decision somebody made rather than a hole anybody can fall into.
     */
    // Anywhere in the comment block immediately above, so the exemption can be
    // explained properly rather than crammed onto one line.
    if (lines.slice(Math.max(0, i - 6), i).some((prev) => prev.includes('action-redirects'))) return

    for (const name of actions) {
      // Only calls, and only where the result is actually awaited.
      const call = new RegExp(`\\bawait\\s+${name}\\s*\\(`)
      if (!call.test(line)) continue
      if (line.includes(`callAction(() => ${name}(`)) {
        guardedCalls += 1
        continue
      }
      offences.push(`${file}:${i + 1}\n    ${line.trim()}`)
    }
    // The wrapped form spans one line in practice; count it wherever it appears.
    for (const name of actions) {
      if (line.includes(`callAction(() => ${name}(`) && !new RegExp(`\\bawait\\s+${name}\\s*\\(`).test(line)) {
        guardedCalls += 1
      }
    }
  })
}

console.log(`client components scanned: ${clientFiles}`)
console.log(`guarded action calls:      ${guardedCalls}`)

if (offences.length > 0) {
  console.error(`\n✖ ${offences.length} unguarded server-action call(s):\n`)
  for (const o of offences) console.error('  ' + o + '\n')
  console.error('Wrap with callAction(() => …), or use the useAction() hook.')
  process.exit(1)
}

console.log('\n✓ every server-action call in a client component is guarded')
