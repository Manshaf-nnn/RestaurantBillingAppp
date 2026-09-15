/**
 * The sidebar works on a desk, a tablet and a phone (sidebar.md §8, §5).
 *
 * ── Why this needs a browser ────────────────────────────────────────────────
 *
 * Everything else about this feature is testable without one, and is tested
 * without one. What is not is the half that only exists once CSS has been
 * applied: the desktop rail is `hidden lg:flex` and the drawer is `lg:hidden`,
 * so "does the right navigation exist at this width" is a question about
 * computed styles. Both surfaces render from the same `SidebarNav`, which means
 * the markup is identical in the HTML and a string check would pass at every
 * width while the phone showed nothing at all.
 *
 * The collapse assertion is here for a related reason: the width comes from a
 * cookie read on the server, precisely so the rail is correct in the first
 * painted frame. Measuring it after a reload is the only way to know that the
 * cookie round trip actually works rather than the browser quietly falling back
 * to the expanded default.
 *
 * Playwright is already a devDependency (see `scripts/screenshot-preview.mjs`),
 * so this costs no new dependency. It self-skips without a server, which is how
 * `verify-all` reports the runtime tier as SKIPPED.
 *
 * Usage:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/sidebar-responsive-test.ts
 */
import { chromium, type Browser, type Page } from 'playwright'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { SIDEBAR_COOKIE } from '../src/features/dashboard/sidebar-preference'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

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

const minted: string[] = []

/** The same session mint `page-render-test` uses — a real row and a real JWT. */
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

/** Is this element on screen at all, as CSS rather than as markup? */
async function visible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().isVisible()
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' })
    .then(() => true)
    .catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\` to run this.`)
    process.exit(0)
  }

  /*
   * An owner of a live, in-trial tenant, for the reason page-render-test
   * records: anyone else is redirected to /trial-ended and every assertion
   * below would pass against a page with no sidebar on it.
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
  })
  if (!user) {
    console.error('No owner of an active, in-trial restaurant in this database.')
    process.exit(1)
  }

  const cookies = await signIn(user)
  const domain = new URL(BASE).hostname

  let browser: Browser | undefined
  try {
    /*
     * Playwright is a devDependency, but its browser binaries are a separate
     * ~150MB download that `npm install` does not make. Treated as a skip
     * rather than a failure, for the same reason a missing server is: a check
     * nobody can run is a check that gets deleted, and a red `npm run verify`
     * on a fresh clone teaches people to ignore the red.
     */
    try {
      browser = await chromium.launch()
    } catch (error) {
      if (/Executable doesn't exist|playwright install/i.test(String(error))) {
        console.log('No Playwright browser installed — skipping. Run `npx playwright install chromium`.')
        process.exit(0)
      }
      throw error
    }

    const context = await browser.newContext()
    await context.addCookies(
      cookies.map((cookie) => ({ ...cookie, domain, path: '/' })),
    )
    const page = await context.newPage()

    const SIDEBAR = 'aside'
    const HAMBURGER = 'button[aria-label="Open navigation"]'
    const SEARCH = 'input[aria-label="Search the menu"]'
    /*
     * Scoped, and it has to be. The desktop rail stays in the DOM at every
     * width — `hidden lg:flex` only takes it off screen — so an unscoped
     * `text=Favorites` finds the hidden one first and reports the drawer as
     * empty while it is sitting open on top of it.
     */
    const DRAWER = '[role="dialog"]'

    console.log('\n── 1. Desktop: the rail is the navigation ──')
    {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })

      check('the sidebar is on screen at 1440px', await visible(page, SIDEBAR))
      check('the hamburger is not', !(await visible(page, HAMBURGER)))
      check(
        'Favorites has a place in it',
        await page.locator(`${SIDEBAR} >> text=Favorites`).first().isVisible(),
      )
      check('so does the menu search', await page.locator(`${SIDEBAR} >> ${SEARCH}`).first().isVisible())
    }

    console.log('\n── 2. Collapse survives a reload, server-side (§5) ──')
    {
      const expanded = await page.locator(SIDEBAR).first().boundingBox()

      await page.locator('button[aria-label="Collapse the sidebar"]').click()
      await page.waitForTimeout(400) // the width transition
      const collapsed = await page.locator(SIDEBAR).first().boundingBox()
      check(
        'collapsing narrows the rail',
        !!expanded && !!collapsed && collapsed.width < expanded.width,
        `${expanded?.width} → ${collapsed?.width}`,
      )

      const saved = (await context.cookies()).find((c) => c.name === SIDEBAR_COOKIE)
      check('and is written where the server can read it', saved?.value === 'collapsed', String(saved?.value))

      /*
       * The point of the cookie: after a reload the rail is ALREADY narrow,
       * with no snap from 256px. Measuring immediately after
       * `domcontentloaded` — before React has had a chance to correct
       * anything — is what makes this a test of the server-rendered width
       * rather than of the client state.
       */
      await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
      const afterReload = await page.locator(SIDEBAR).first().boundingBox()
      check(
        'and the reloaded page renders narrow with no flash',
        !!afterReload && !!collapsed && Math.abs(afterReload.width - collapsed.width) < 8,
        `${afterReload?.width} vs ${collapsed?.width}`,
      )

      await page.locator('button[aria-label="Expand the sidebar"]').click()
      await page.waitForTimeout(400)
    }

    console.log('\n── 3. Tablet and phone: the drawer is the navigation (§8) ──')
    {
      for (const [label, width] of [
        ['tablet', 768],
        ['phone', 390],
      ] as const) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })

        check(`the rail is out of the way at ${width}px (${label})`, !(await visible(page, SIDEBAR)))
        check(`the hamburger is there instead (${label})`, await visible(page, HAMBURGER))

        await page.locator(HAMBURGER).click()
        await page.locator(DRAWER).first().waitFor({ state: 'visible', timeout: 5_000 })

        const drawer = page.locator(DRAWER).first()
        check(
          `and the drawer carries Favorites (${label})`,
          await drawer.locator('text=Favorites').first().isVisible(),
        )
        check(
          `and the menu search (${label})`,
          await drawer.locator(SEARCH).first().isVisible(),
        )
        check(
          `and the full menu below it (${label})`,
          await drawer.locator('a:has-text("Settings")').first().isVisible(),
        )
      }
    }

    console.log('\n── 4. The sidebar search narrows the menu (§4) ──')
    {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })

      const rail = page.locator(SIDEBAR).first()
      await rail.locator(SEARCH).fill('wastage')
      await page.waitForTimeout(200)

      check('a match is shown', await rail.locator('a:has-text("Wastage")').first().isVisible())
      check(
        'and everything else is gone',
        (await rail.locator('a:has-text("Close month")').count()) === 0,
      )
    }
  } finally {
    await browser?.close()
    if (minted.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: minted } } })
    }
  }
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
