/**
 * No bare locale dates (bugfix.md D15).
 *
 * `toLocaleDateString()` and friends format in whatever timezone the PROCESS
 * runs in: UTC on the server, and on a shared tablet whatever the tablet was
 * set to at the factory. Rendered on the server and again in the browser,
 * the two disagree for most of the world and React throws the tree away
 * (hydration mismatch); rendered once, it is simply the wrong clock — a
 * bank statement line one day early, a ticket time five and a half hours out.
 *
 * Two tools exist and are the only two allowed: `src/lib/datetime.ts`, which
 * formats in the zone it is GIVEN, and `<LocalDateTime>`, which defers to the
 * browser on mount and says so. Every other site names its zone through one
 * of them. This guard reads the source, comments stripped, and refuses the
 * rest.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/no-bare-locale-dates.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Files that are allowed to touch the raw API, and why. */
const ALLOWED: Record<string, string> = {
  'src/lib/datetime.ts': 'The one formatter, with the zone it was given.',
  'src/components/local-time.tsx': 'Defers to the browser on purpose — the viewer’s own clock, decided on mount.',
  'src/components/ops-shell.tsx': 'The station clock in the shell header: the device’s own time, deliberately, so it matches the wall clock beside it.',
  'src/features/analytics/queries.ts': 'Chart labels pass `labelFormat`, which carries timeZone: tz for every unit — the zone is chosen, one line up.',
}

const PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\.toLocaleDateString\(/, why: 'a calendar date formatted in the process’s zone' },
  { re: /\.toLocaleTimeString\(/, why: 'a clock time formatted in the process’s zone' },
  { re: /new Date\([^)]*\)\.toLocaleString\(/, why: 'a Date formatted in the process’s zone' },
  {
    re: /\b(createdAt|updatedAt|placedAt|paidAt|closedAt|openedAt|issuedAt|requestedAt|lastUsedAt|lastSeenAt|date)\.toLocaleString\(/,
    why: 'a date column formatted in the process’s zone',
  },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

function stripComments(source: string): string {
  // Block comments become the same number of blank lines, so a reported line
  // number is the line in the file, not the line in the stripped text.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .replace(/^\s*\/\/.*$/gm, '')
}

function main() {
  const files = walk('src')
  const offenders: string[] = []

  for (const file of files) {
    if (file in ALLOWED) continue
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      // A call that names its zone on the same line has made the choice.
      if (/timeZone\s*:/.test(line)) return
      for (const { re, why } of PATTERNS) {
        if (re.test(line)) {
          offenders.push(`  ${file}:${index + 1} — ${why}\n      ${line.trim().slice(0, 110)}`)
          break
        }
      }
    })
  }

  console.log(`checked:  ${files.length} files`)
  console.log(`allowed:  ${Object.keys(ALLOWED).length} (${Object.keys(ALLOWED).join(', ')})`)

  if (offenders.length > 0) {
    console.error(`\n✖ ${offenders.length} bare locale date(s):\n`)
    for (const line of offenders) console.error(line)
    console.error(
      '\nUse formatDate / formatDateTime / formatTime from @/lib/datetime with the\n' +
        'restaurant’s timezone, or <LocalDateTime> from @/components/local-time when the\n' +
        'viewer’s own clock is genuinely what is wanted. A date-only value (a statement\n' +
        'line, a business date) is stored at UTC midnight: format it with timeZone: "UTC".',
    )
    process.exit(1)
  }

  console.log('\n✓ every date is formatted in a zone somebody chose')
}

main()
