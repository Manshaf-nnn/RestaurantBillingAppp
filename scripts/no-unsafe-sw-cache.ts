/**
 * The service worker must not cache anybody's money (production.md §6).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `public/sw.js` refuses to cache four things, and each refusal is load-bearing
 * in a way that is easy to undo by accident while "improving offline support":
 *
 *   /dashboard, /admin  — these render somebody's takings, staff list and
 *                         supplier balances. A cache with no TTL would replay
 *                         them to whoever picks the device up next, including
 *                         after that person has been signed out.
 *   /api                — the pulse token above all. A cached change-detector
 *                         is a screen that never updates again, which is the
 *                         precise opposite of what it is for.
 *   /order              — the guest ordering flow, where a stale menu means a
 *                         guest ordering a dish at last week's price.
 *   non-GET             — caching a mutation is meaningless at best and, for a
 *                         settle or a refund, a replay.
 *
 * The offline story here is deliberately read-only: nothing entered offline is
 * saved and `src/app/offline/page.tsx` says so. That honesty is only worth
 * anything while the cache stays this narrow, so it is checked rather than
 * trusted.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/no-unsafe-sw-cache.ts
 */
import { readFileSync } from 'node:fs'

const SW = 'public/sw.js'

/** Each rule, and the sentence explaining what breaks without it. */
const REQUIRED: Array<{ pattern: RegExp; rule: string; because: string }> = [
  {
    pattern: /\/dashboard/,
    rule: 'refuses to cache /dashboard',
    because: 'those pages render takings, staff and supplier balances',
  },
  {
    pattern: /\/admin/,
    rule: 'refuses to cache /admin',
    because: 'the platform console can see every tenant',
  },
  {
    pattern: /\/api/,
    rule: 'refuses to cache /api',
    because: 'a cached pulse token is a screen that never updates again',
  },
  {
    pattern: /\/order/,
    rule: 'refuses to cache /order',
    because: 'a stale menu prices a guest at last week’s prices',
  },
  {
    pattern: /method\s*!==\s*['"]GET['"]|method\s*!=\s*['"]GET['"]/,
    rule: 'refuses to cache anything but GET',
    because: 'caching a settle or a refund is a replay of it',
  },
]

function main() {
  let source: string
  try {
    source = readFileSync(SW, 'utf8')
  } catch {
    console.error(`\n✖ ${SW} is missing. The offline story depends on it.`)
    process.exit(1)
    return
  }

  const missing = REQUIRED.filter((rule) => !rule.pattern.test(source))

  console.log(`checked:  ${SW}`)
  console.log(`rules:    ${REQUIRED.length}`)

  if (missing.length > 0) {
    console.error(`\n✖ ${missing.length} cache refusal(s) are no longer in the service worker:\n`)
    for (const rule of missing) console.error(`  • ${rule.rule} — ${rule.because}`)
    console.error(
      '\nThis application has no offline write queue, deliberately (production.md §6),\n' +
        'and its offline page tells the user nothing they enter is saved. That is only\n' +
        'honest while the cache stays read-only and public. If you are widening it,\n' +
        'change the offline page to match — and think hard about the device that gets\n' +
        'picked up by the next person on shift.',
    )
    process.exit(1)
  }

  /*
   * The offline page must not promise a sync that does not exist. It used to,
   * and that promise was removed on purpose — a cashier who believes the till
   * will catch up later stops writing things down.
   */
  /*
   * Comments are stripped first, and that is not a detail. The page carries a
   * comment recording that it USED to promise "new data will sync the moment
   * you're back online" and why that was removed — exactly the history a future
   * reader needs, and exactly the phrase this check looks for. Matching against
   * the raw file would fail on the explanation of the fix.
   */
  const offline = readFileSync('src/app/offline/page.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  if (/will sync|syncs? when|queued|saved locally/i.test(offline)) {
    console.error(
      '\n✖ src/app/offline/page.tsx appears to promise that offline work is kept.\n' +
        '  There is no offline queue. Say what is true: nothing entered offline is saved.',
    )
    process.exit(1)
  }

  console.log('\n✓ the service worker caches nothing private, and the offline page is honest')
}

main()
