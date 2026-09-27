/**
 * Open every dashboard page in a real browser and fail on what the console says.
 *
 * ── Why this exists, next to page-render-test ───────────────────────────────
 *
 * `page-render-test` fetches the same list of pages and asserts the server
 * returned 200 without the error boundary's text. That proves the SERVER
 * rendered. It cannot prove the page then works, because it never runs any
 * JavaScript: a hydration mismatch, an effect that throws, a client component
 * reading a field the server did not send, a chart library handed a null — all
 * of them return a perfectly good 200 with the right HTML in it, and all of
 * them leave the page broken in front of the person using it.
 *
 * Those failures are visible in exactly one place: the browser console. So
 * this loads each page in Chromium, listens to `console` and `pageerror`, and
 * fails on anything that lands there. It is the only check in the suite that
 * would catch a page that renders and then dies.
 *
 * It also records failed network requests, because a 500 from a route handler
 * fired by an effect is invisible to every other check: the page still shows,
 * just with nothing in the panel that needed the data.
 *
 * ── Why it can skip ─────────────────────────────────────────────────────────
 *
 * Playwright is a devDependency but its browser binaries are a separate
 * download. No browser means SKIPPED rather than failed, which is how
 * `verify-all` reports the runtime tier — the same contract the other two
 * browser suites use.
 *
 * Usage:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/browser-console-test.ts
 */
import type { Browser, ConsoleMessage } from 'playwright'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { PAGES } from './dashboard-pages'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

/**
 * Console noise that is not a defect, each with a reason.
 *
 * A new entry needs a reason that survives being read out loud. "It was noisy"
 * is not one — the point of this file is that console output is a signal, and
 * an allowlist that grows on convenience turns it back into noise.
 */
const IGNORE: Array<{ re: RegExp; why: string }> = [
  {
    re: /Download the React DevTools/i,
    why: 'React\'s own development banner, not the page\'s output',
  },
  {
    re: /\[Fast Refresh\]/i,
    why: 'the dev server\'s reload chatter; absent from a production build anyway',
  },
  {
    re: /favicon\.ico/i,
    why: 'a missing favicon is a cosmetic 404 that no page depends on',
  },
  {
    re: /WebSocket connection to .* failed/i,
    why:
      'this suite runs against a plain `next start`, which serves no Socket.IO ' +
      'endpoint, so the client\'s reconnect attempt is expected here and says ' +
      'nothing about production. The websocket itself — including who is allowed ' +
      'into an order\'s room — is covered by socket-order-room-test against ' +
      'server.mjs, which does serve it.',
  },
]

/** Requests whose failure says nothing about the page. */
const IGNORE_REQUEST: Array<{ re: RegExp; why: string }> = [
  { re: /favicon\.ico/i, why: 'cosmetic' },
  {
    re: /\/api\/(socket|socket\.io)/i,
    why: 'a plain `next start` serves no websocket; socket-order-room-test covers that path against server.mjs',
  },
]

const minted: string[] = []

async function signIn(user: {
  id: string
  restaurantId: string | null
  role: string
  name: string | null
  email: string
}) {
  const refresh = generateToken()
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  const access = await signAccessToken({
    sub: user.id,
    rid: user.restaurantId,
    role: user.role,
    name: user.name,
    email: user.email,
    sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  minted.push(session.id)
  return [
    { name: ACCESS_COOKIE, value: access },
    { name: REFRESH_COOKIE, value: refresh },
  ]
}

type Problem = { page: string; kind: string; detail: string }

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\` to run this.`)
    process.exit(0)
  }

  /*
   * The same fixture rule page-render-test states: the tenant must be active
   * and inside its trial, or every page redirects and a clean sweep reports
   * having tested nothing.
   */
  const user = await prisma.user.findFirst({
    where: {
      role: 'OWNER',
      isActive: true,
      deletedAt: null,
      restaurant: {
        status: 'ACTIVE',
        isActive: true,
        OR: [
          { plan: { not: 'TRIAL' } },
          { trialEndsAt: null },
          { trialEndsAt: { gt: new Date() } },
        ],
      },
    },
    include: { restaurant: { select: { name: true } } },
  })
  if (!user?.restaurant) {
    console.error('No owner of an active, in-trial restaurant in this database.')
    process.exit(1)
  }

  let browser: Browser | undefined
  const problems: Problem[] = []
  let swept = 0

  try {
    const { chromium } = await import('playwright')
    try {
      browser = await chromium.launch()
    } catch (error) {
      if (/Executable doesn't exist|playwright install/i.test(String(error))) {
        console.log('No Playwright browser installed — skipping. Run `npx playwright install chromium`.')
        process.exit(0)
      }
      throw error
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const domain = new URL(BASE).hostname
    context.addCookies((await signIn(user)).map((c) => ({ ...c, domain, path: '/' })))

    const page = await context.newPage()
    console.log(`owner ${user.email} · ${user.restaurant.name}\n`)

    let current = ''

    const note = (kind: string, detail: string) => {
      problems.push({ page: current, kind, detail: detail.slice(0, 300).replace(/\s+/g, ' ') })
    }

    page.on('console', (message: ConsoleMessage) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return
      const text = message.text()
      if (IGNORE.some((entry) => entry.re.test(text))) return
      // Warnings are reported only when React calls them a hydration or a key
      // problem: those are defects wearing a warning's clothes.
      if (message.type() === 'warning' && !/hydrat|unique "key"|validateDOMNesting|Each child/i.test(text)) return
      note(message.type() === 'error' ? 'console.error' : 'react warning', text)
    })

    page.on('pageerror', (error: Error) => {
      note('uncaught', `${error.name}: ${error.message}`)
    })

    page.on('response', (response) => {
      if (response.status() < 400) return
      const url = response.url()
      if (IGNORE_REQUEST.some((entry) => entry.re.test(url))) return
      note(`http ${response.status()}`, url.replace(BASE, ''))
    })

    for (const path of PAGES) {
      current = path
      const before = problems.length
      try {
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 45_000 })
        // Effects and lazy panels land after the network settles.
        await page.waitForTimeout(600)
      } catch (error) {
        note('navigation', String(error))
      }
      swept += 1
      const found = problems.length - before
      console.log(`  ${found === 0 ? '✓' : '✗'} ${path}${found ? ` — ${found} problem(s)` : ''}`)
    }
  } finally {
    await browser?.close()
    await prisma.session.deleteMany({ where: { id: { in: minted } } })
    await prisma.$disconnect()
  }

  /*
   * `verify-all` tallies a suite by matching "N passed, M failed" in its
   * output, and falls back to counting the whole suite as ONE check when it
   * finds no such line. Without this, sweeping eighty-four pages in a browser
   * contributed 1 to the gate's total — the run was real, but its weight in
   * the number everyone reads was not.
   */
  const clean = swept - new Set(problems.map((problem) => problem.page)).size
  console.log(`\nswept: ${swept} pages in a real browser`)
  console.log(`\n${clean} passed, ${swept - clean} failed`)

  if (problems.length > 0) {
    console.log(`\n✖ ${problems.length} console/network problem(s):\n`)
    for (const problem of problems) {
      console.log(`  ${problem.page}`)
      console.log(`    [${problem.kind}] ${problem.detail}`)
    }
    console.log(
      '\nA page that returns 200 and then throws in the browser is broken for the\n' +
      'person using it. Fix the cause, or add an IGNORE entry with a reason that\n' +
      'survives being read out loud.',
    )
    process.exit(1)
  }

  console.log('\n✓ every page loaded with a silent console')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
