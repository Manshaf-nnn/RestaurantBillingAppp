/**
 * Guard: a server component may not pass a function to a client component.
 *
 * React encodes the server tree into a Flight payload before it reaches the
 * browser, and a function cannot be encoded. The serializer throws
 *
 *   Functions cannot be passed directly to Client Components unless you
 *   explicitly expose it by marking it with "use server".
 *
 * and the page dies. This shipped in five pages — Reports and Customer insights —
 * where `ReportTable` took `format?: (row) => string` as a prop.
 *
 * It was expensive to find, because every ordinary signal said the code was
 * fine. `npx next build` passes, since the affected pages are `force-dynamic`
 * and never prerendered. `/api/health/pages` reported every loader green,
 * because the throw happens AFTER the loader returns, while React encodes the
 * tree — a loader check is structurally incapable of seeing it. And the error
 * digest never changed across deploys, because the message is built from the
 * prop's key names and the stack contains no application frames at all, only
 * fixed lines inside node_modules. Nothing about the app could move it.
 *
 * A static check is the only cheap signal, so here it is.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/no-function-props.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(full)) out.push(full)
  }
  return out
}

const ALL = walk('src')

/** Files that carry the 'use client' directive — the far side of the boundary. */
const CLIENT_MODULES = new Set(
  ALL.filter((f) => /^\s*['"]use client['"]/m.test(readFileSync(f, 'utf8'))).map((f) => resolve(f)),
)

/** Resolve an import specifier to a file on disk, if it is one of ours. */
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = resolve('src', spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else return null

  for (const candidate of [
    `${base}.tsx`, `${base}.ts`,
    join(base, 'index.tsx'), join(base, 'index.ts'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return resolve(candidate)
    } catch {
      // keep trying
    }
  }
  return null
}

/** Names this file imports from a 'use client' module. */
function clientComponentsImportedBy(file: string, src: string): Set<string> {
  const names = new Set<string>()
  const re = /import\s+(?:(\w+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const target = resolveImport(file, m[3])
    if (!target || !CLIENT_MODULES.has(target)) continue
    if (m[1]) names.add(m[1])
    for (const raw of (m[2] ?? '').split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  return names
}

const offences: string[] = []
let serverFiles = 0
let checkedElements = 0

for (const file of ALL) {
  const src = readFileSync(file, 'utf8')
  if (/^\s*['"]use client['"]/m.test(src)) continue

  const clientNames = clientComponentsImportedBy(file, src)
  if (clientNames.size === 0) continue
  serverFiles += 1

  for (const name of clientNames) {
    // Each JSX use of that client component, from `<Name` to its closing `>`.
    const open = new RegExp(`<${name}(\\s|\\n)`, 'g')
    let m: RegExpExecArray | null
    while ((m = open.exec(src))) {
      let depth = 0
      let i = m.index
      for (; i < src.length; i += 1) {
        const ch = src[i]
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
        else if (ch === '>' && depth === 0) break
      }
      const props = src.slice(m.index, i)
      checkedElements += 1

      // `prop={(a) => ...}` / `prop={function ...}` directly, or nested inside an
      // object or array prop such as columns={[{ format: (r) => ... }]}.
      const arrow = /(\w+)\s*[:=]\s*\{?\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/g
      const fn = /(\w+)\s*[:=]\s*\{?\s*(?:async\s+)?function\b/g

      for (const re of [arrow, fn]) {
        let p: RegExpExecArray | null
        while ((p = re.exec(props))) {
          const line = src.slice(0, m.index + p.index).split('\n').length
          offences.push(
            `${file}:${line}\n    <${name} …> receives a function as "${p[1]}"\n` +
            `    ${props.slice(Math.max(0, p.index - 20), p.index + 60).replace(/\s+/g, ' ').trim()}`,
          )
        }
      }
    }
  }
}

console.log(`client modules:                 ${CLIENT_MODULES.size}`)
console.log(`server files using one:         ${serverFiles}`)
console.log(`client elements checked:        ${checkedElements}`)

if (offences.length > 0) {
  console.error(`\n✖ ${offences.length} function prop(s) crossing into a client component:\n`)
  for (const o of offences) console.error('  ' + o + '\n')
  console.error(
    'React cannot serialize a function across the server/client boundary; the page\n' +
    'will throw at render. Pass a serializable descriptor instead and do the work\n' +
    'inside the client component.',
  )
  process.exit(1)
}

console.log('\n✓ no functions cross the server/client boundary')
