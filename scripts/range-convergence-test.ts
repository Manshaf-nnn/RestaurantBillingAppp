/**
 * One vocabulary for "which period", and every analytics page offers it.
 *
 * ── Why this is a static check ──────────────────────────────────────────────
 *
 * Two comments already in this codebase describe the problem correctionA.md §3
 * asks to fix, and both of them are warnings that went unheeded:
 *
 *   features/reports/range.ts — "There is a second `resolveRange` in
 *   features/analytics/queries.ts speaking lowercase presets… this one is
 *   canonical for anything new. **Do not add a third.**"
 *
 *   dashboard/components/period-picker.tsx — "There are already four
 *   conventions for this idea in the app — `?range=` in two different casings,
 *   `?days=<int>`, and this one."
 *
 * A convention nobody can violate is better than a comment asking them not to.
 * What follows is the comment turned into a failure: no third resolver, no
 * page inventing its own arithmetic, and a selector on every page that shows
 * figures for a period.
 *
 * The resolver's own behaviour — timezone boundaries, the custom-range cap —
 * belongs to the range module and is exercised through the pages that use it;
 * this file is about convergence, not about what "this month" means.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/range-convergence-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { RANGE_LABELS, describeRange, resolveRange } from '../src/features/reports/range'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

/** Source with comments removed, so prose about a convention cannot trip a rule. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

/**
 * The pages that show figures for a period and must let somebody choose it.
 *
 * Named rather than inferred. "Does this page show a period" is not decidable
 * from its source, and a rule that guesses would either nag about screens with
 * nothing to select or quietly miss the next one somebody adds. A list that has
 * to be edited is the honest shape, the same choice `no-unscoped-branch-pages`
 * makes.
 */
const MUST_OFFER_A_PERIOD = [
  'src/app/dashboard/page.tsx',
  'src/app/dashboard/analytics/page.tsx',
  'src/app/dashboard/insights/page.tsx',
  'src/app/dashboard/customers/analytics/page.tsx',
  'src/app/dashboard/reports/variance/page.tsx',
  'src/app/dashboard/reports/reconciliation/page.tsx',
]

/**
 * Screens that legitimately have no period picker, and why.
 *
 * An entry here is a decision, not an exemption to be handed out quietly.
 */
const NO_PERIOD_NEEDED: Record<string, string> = {
  'src/app/dashboard/reports/daily-close/page.tsx':
    'A close is one business day, chosen as a date. A range would not mean anything.',
}

function main() {
  console.log('\n── 1. There is one resolver, and it is the canonical one ──')
  {
    const resolvers = walk('src')
      .filter((file) => /export (async )?function resolveRange/.test(codeOnly(file)))
      .sort()

    /*
     * Two today: the canonical one, and the lowercase-preset one in
     * analytics/queries.ts that still serves the reports hub and the export
     * route. That is the state range.ts documents. What must not happen is a
     * third — which is exactly what adding a picker to four more pages invites,
     * because each one needs an answer to "what does last month mean".
     */
    check(
      'no third resolveRange was added',
      resolvers.length <= 2,
      resolvers.join('\n      '),
    )
    check(
      'the canonical one is still in features/reports/range.ts',
      resolvers.includes('src/features/reports/range.ts'),
      resolvers.join(', '),
    )
  }

  console.log('\n── 2. No page does its own date arithmetic ──')
  {
    /*
     * `Date.now() - n * 86_400_000` is the shape every one of these pages used
     * before it had a picker, and it is wrong in the same way each time: the
     * window starts at whatever time of day the page was opened, so "the last
     * 30 days" means something slightly different on every visit and no two
     * figures on the screen share a boundary.
     *
     * The rule is that exact shape and deliberately not "mentions a day in
     * milliseconds". Two legitimate uses look similar and must pass: measuring
     * how many days an ALREADY-RESOLVED range spans, which is
     * `range.to - range.from` and carries the resolver's boundaries with it;
     * and the dashboard's twenty-minute cutoff for orders still waiting, which
     * is about this minute and has nothing to do with a report period. The
     * first version of this check failed all three and was wrong three times.
     */
    const fromNow = /(?:Date\.now\(\)|new Date\(\)\.getTime\(\))\s*-\s*[^;\n]*86_?400_?000/
    const offenders = MUST_OFFER_A_PERIOD.filter((file) => fromNow.test(codeOnly(file)))
    check(
      'no analytics page starts its window at the current instant',
      offenders.length === 0,
      offenders.join(', '),
    )

    // And the positive half: the pages that measure a span do it from the
    // resolved range, so the boundaries are the resolver's.
    for (const file of ['src/app/dashboard/analytics/page.tsx', 'src/app/dashboard/reports/variance/page.tsx']) {
      const src = codeOnly(file)
      if (!/86_?400_?000/.test(src)) continue
      check(
        `${file.replace('src/app/dashboard/', '')} measures its span from the resolved range`,
        /range\.to\.getTime\(\)\s*-\s*range\.from\.getTime\(\)/.test(src),
      )
    }
  }

  console.log('\n── 3. Every page that shows a period lets you choose it ──')
  {
    for (const file of MUST_OFFER_A_PERIOD) {
      const src = codeOnly(file)
      const short = file.replace('src/app/dashboard/', '').replace('/page.tsx', '') || 'dashboard'
      check(`${short} renders the shared picker`, /<PeriodPicker/.test(src))
      check(`${short} resolves through the canonical helper`, /resolveRange\(/.test(src))
    }

    for (const [file, why] of Object.entries(NO_PERIOD_NEEDED)) {
      check(
        `${file.replace('src/app/dashboard/', '')} is exempt on purpose`,
        why.length > 20,
        'an exemption needs a reason',
      )
    }
  }

  console.log('\n── 4. The retired conventions still answer ──')
  {
    /*
     * `?days=` and `?range=` were in hand-built links on these pages for as
     * long as they have existed, which means they are in bookmarks. Dropping
     * them would turn somebody's saved report into a silent reset to the
     * default window — the worst kind of breakage, because it still renders.
     */
    const variance = codeOnly('src/app/dashboard/reports/variance/page.tsx')
    check("variance still reads the old ?days=", /str\('days'\)/.test(variance))

    const reconciliation = codeOnly('src/app/dashboard/reports/reconciliation/page.tsx')
    check("reconciliation still reads the old ?range=", /str\('range'\)/.test(reconciliation))

    /*
     * And changing location must not reset the period. The branch links on
     * reconciliation build their own href, so they have to carry it.
     */
    check(
      'and its location links carry the period forward',
      /q\.set\('preset', range\.preset\)/.test(reconciliation),
    )
  }

  console.log('\n── 5. The resolver answers the presets the picker offers ──')
  {
    const tz = 'Asia/Colombo'
    const now = new Date('2026-06-15T09:30:00Z')

    for (const preset of Object.keys(RANGE_LABELS)) {
      if (preset === 'CUSTOM') continue
      const range = resolveRange({ preset, timeZone: tz, now })
      check(
        `${preset} resolves to a real window`,
        range.from <= range.to && range.preset === preset,
        `${range.from.toISOString()} → ${range.to.toISOString()}`,
      )
    }

    // An unknown preset must land somewhere sane rather than throwing on a
    // page somebody reached from a stale link.
    const junk = resolveRange({ preset: 'LAST_FORTNIGHT', timeZone: tz, now })
    check('an unknown preset falls back rather than throwing', junk.from <= junk.to)

    const described = describeRange(resolveRange({ preset: 'TODAY', timeZone: tz, now }))
    check('and a range can always be named', described.length > 0, described)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
