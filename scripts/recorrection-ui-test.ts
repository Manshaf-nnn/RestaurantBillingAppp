/**
 * recorrection.md §1, §3 and §4, in a browser.
 *
 * ── Why this needs a browser ────────────────────────────────────────────────
 *
 * The service tests pin every rule. What they cannot pin is the half that
 * only exists once React has mounted and CSS has applied:
 *
 *   - the task picker's list is portalled OUT of the dialog that opened it,
 *     and a Radix dialog locks scrolling on everything outside itself — so
 *     "does the wheel scroll the staff list" is a question about two
 *     libraries' event handling, and the first cut got it wrong (the list
 *     had rows nobody could reach);
 *   - "View details" on a pending row is a client component fetching through
 *     an action and rendering a dialog with its own Approve, and that the
 *     Approve in the dialog actually moves the transfer is a round trip;
 *   - the transfer form locks its destination from a prop the page computes
 *     from the session, which is only visible as rendered markup;
 *   - Make an Item is one flow across three client components — Create,
 *     the "made it already?" confirmation, and the Prepared Items detail —
 *     and whether Mark Done from each actually moves the stock is a round
 *     trip through all of them.
 *
 * Two people: an owner, and a manager confined to the branch that raised the
 * request. Each sees a different desk and a different list, and both views
 * are asserted.
 *
 * Usage:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/recorrection-ui-test.ts
 */
import { chromium, type Browser, type Page } from 'playwright'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { postMovement } from '../src/features/inventory/ledger'
import { requestApproval } from '../src/features/approvals/service'
import { startBatch } from '../src/features/production/service'
import { requestTransfer } from '../src/features/transfers/service'
import { ROLE_LABELS } from '../src/lib/rbac'

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

const seen = async (page: Page, text: string | RegExp) =>
  page.getByText(text).first().isVisible().catch(() => false)

/** Poll the database until the row reads as expected, or give up. */
async function eventually<T>(read: () => Promise<T>, want: (value: T) => boolean, ms = 10_000): Promise<T> {
  const until = Date.now() + ms
  let last = await read()
  while (!want(last) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250))
    last = await read()
  }
  return last
}

const stamp = Date.now().toString(36)
let restaurantId: string | null = null

/**
 * Teardown. The approve click writes an audit row, and audit rows are
 * append-only at the database — so when the hard delete is refused the tenant
 * is retired in place instead, the way the export test retires its staff.
 */
async function cleanup(id: string) {
  await prisma.session.deleteMany({ where: { id: { in: minted } } })
  await prisma.stockTransferLine.deleteMany({ where: { transfer: { restaurantId: id } } })
  await prisma.stockTransfer.deleteMany({ where: { restaurantId: id } })
  await prisma.approvalRequest.deleteMany({ where: { restaurantId: id } })
  await prisma.productionConsumption.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.productionOutput.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.wastageRecord.deleteMany({ where: { restaurantId: id } })
  await prisma.productionOrder.deleteMany({ where: { restaurantId: id } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId: id } } })
  await prisma.recipe.deleteMany({ where: { restaurantId: id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: id } })
  try {
    await prisma.restaurant.delete({ where: { id } })
  } catch {
    await prisma.user.updateMany({ where: { restaurantId: id }, data: { isActive: false, deletedAt: new Date() } })
    await prisma.restaurant.update({ where: { id }, data: { isActive: false } })
    console.log('  (fixture retired in place — audit rows keep it from being deleted)')
  }
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' })
    .then(() => true)
    .catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping. Start one with \`npx next start\` to run this.`)
    process.exit(0)
  }

  // ── fixture ───────────────────────────────────────────────────────────────
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Recorrection ${stamp}`,
      slug: `recorrection-${stamp}`,
      status: 'ACTIVE',
      isActive: true,
      // Not TRIAL: the dashboard layout bounces an expired trial to
      // /trial-ended, and every check below would pass while rendering nothing.
      plan: 'GROWTH',
    },
  })
  restaurantId = restaurant.id
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true },
  })
  const jaffna = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Jaffna', code: 'JAF' },
  })
  const mk = (name: string, role: 'OWNER' | 'MANAGER' | 'WAITER', branchId: string | null) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        email: `${name.toLowerCase().replace(/\W/g, '')}-${stamp}@test.local`,
        name, passwordHash: 'x', role, branchId,
      },
    })
  const owner = await mk('Owner', 'OWNER', null)
  const jay = await mk('Jay', 'MANAGER', jaffna.id)
  // Enough people that the picker's list is taller than its box (§4).
  for (let i = 1; i <= 18; i += 1) await mk(`Staff ${String(i).padStart(2, '0')}`, 'WAITER', kandy.id)

  const chicken = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Chicken ${stamp}`, unit: 'KG', branchId: kandy.id, costPerUnit: 1_200_00 },
  })
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: chicken.id, type: 'PURCHASE', quantity: 10,
      branchId: kandy.id, locationId: null, userId: owner.id,
    }),
  )
  // Jaffna pulls from Kandy; the request goes to Kandy's desk.
  const transfer = await requestTransfer({
    restaurantId: restaurant.id, fromBranchId: kandy.id, toBranchId: jaffna.id,
    lines: [{ itemId: chicken.id, quantity: 3 }], userId: jay.id,
  })
  const request = await requestApproval({
    restaurantId: restaurant.id, branchId: kandy.id, kind: 'STOCK_TRANSFER',
    entity: 'StockTransfer', entityId: transfer.id, reason: 'Weekend rush',
    payload: { toBranchId: jaffna.id, lines: 1 }, userId: jay.id,
  })

  const domain = new URL(BASE).hostname
  let browser: Browser | undefined
  try {
    try {
      browser = await chromium.launch()
    } catch (error) {
      if (/Executable doesn't exist|playwright install/i.test(String(error))) {
        console.log('No Playwright browser installed — skipping. Run `npx playwright install chromium`.')
        process.exit(0)
      }
      throw error
    }

    const as = async (user: typeof owner) => {
      const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
      await context.addCookies((await signIn(user)).map((c) => ({ ...c, domain, path: '/' })))
      return context.newPage()
    }
    const ownerPage = await as(owner)
    const jayPage = await as(jay)

    console.log('\n── 1. The destination watches its own request ──')
    {
      await jayPage.goto(`${BASE}/dashboard/approvals`, { waitUntil: 'networkidle' })
      check('the request Jaffna raised is on Jaffna\'s desk', await seen(jayPage, /Stock transfers \(1\)/))
      check('told what it is waiting for', await seen(jayPage, 'Waiting for Kandy to approve'))
      check('and offered no Approve — not theirs to decide', (await jayPage.getByRole('button', { name: 'Approve', exact: true }).count()) === 0)
      check('the lines are on the row', await seen(jayPage, `${chicken.name} · 3 kg`))
    }

    console.log('\n── 2. The form knows the requester\'s branch ──')
    {
      await jayPage.goto(`${BASE}/dashboard/transfers/new`, { waitUntil: 'networkidle' })
      const locked = jayPage.locator('#to[data-locked="true"]')
      check('TO is locked to their own branch', (await locked.count()) === 1 && /Jaffna/.test(await locked.innerText().catch(() => '')))
      check('FROM offers Kandy, which they cannot otherwise open', (await jayPage.locator('#from option', { hasText: 'Kandy' }).count()) === 1)
      check('and not Jaffna', (await jayPage.locator('#from option', { hasText: 'Jaffna' }).count()) === 0)
    }

    console.log('\n── 3. The list, from the destination ──')
    {
      await jayPage.goto(`${BASE}/dashboard/transfers`, { waitUntil: 'networkidle' })
      check('filed under Pending approval', await seen(jayPage, /Pending approval \(1\)/))
      check('waiting for Kandy', await seen(jayPage, 'Waiting for Kandy to approve'))
      check('no Pending dispatch section for the destination', !(await seen(jayPage, /Pending dispatch/)))
    }

    console.log('\n── 4. The task picker scrolls inside the dialog and shows role + location ──')
    {
      await ownerPage.goto(`${BASE}/dashboard/tasks`, { waitUntil: 'networkidle' })
      await ownerPage.getByRole('button', { name: /New instruction/ }).first().click()
      const dialog = ownerPage.locator('[role="dialog"]')
      await dialog.waitFor()
      await dialog.getByRole('combobox').filter({ hasText: 'Anyone at the location' }).click()
      const listbox = ownerPage.locator('[role="listbox"]')
      await listbox.waitFor()
      const count = await listbox.locator('[role="option"]').count()
      check('every member is listed', count >= 18, `${count} options`)
      check('with role and location', (await listbox.innerText()).includes(`${ROLE_LABELS.WAITER} — Kandy`))

      const overflow = await listbox.evaluate((el) => el.scrollHeight - el.clientHeight)
      check('the list is taller than its box, so scrolling matters', overflow > 0, `overflow ${overflow}px`)
      const box = await listbox.boundingBox()
      if (box) await ownerPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await ownerPage.mouse.wheel(0, 600)
      await ownerPage.waitForTimeout(250)
      const afterWheel = await listbox.evaluate((el) => el.scrollTop)
      check('the wheel scrolls it — through the dialog\'s scroll lock', afterWheel > 0, `scrollTop ${afterWheel}`)

      await listbox.evaluate((el) => { el.scrollTop = 0 })
      for (let i = 0; i < 15; i += 1) await ownerPage.keyboard.press('ArrowDown')
      await ownerPage.waitForTimeout(150)
      const afterKeys = await listbox.evaluate((el) => el.scrollTop)
      check('arrow keys keep the highlighted row in view', afterKeys > 0, `scrollTop ${afterKeys}`)

      await ownerPage.keyboard.press('Escape')
      await ownerPage.keyboard.press('Escape')
    }

    console.log('\n── 5. The desk: details from the pending row, approve from the dialog ──')
    {
      await ownerPage.goto(`${BASE}/dashboard/approvals`, { waitUntil: 'networkidle' })
      check('grouped under Stock transfers', await seen(ownerPage, /Stock transfers \(1\)/))
      check('the row carries the number', await seen(ownerPage, /TRF-\d+/))
      check('both ends', await seen(ownerPage, /Kandy\s*→\s*Jaffna/))
      check('and the lines', await seen(ownerPage, `${chicken.name} · 3 kg`))
      check('honest about what approving does', await seen(ownerPage, /reserves the stock at Kandy/))

      await ownerPage.getByRole('button', { name: 'View details' }).first().click()
      const dialog = ownerPage.locator('[role="dialog"]')
      await dialog.waitFor()
      const text = await dialog.innerText()
      check('the dialog shows the transfer\'s lines', text.includes(chicken.name) && /3 kg/.test(text))
      // Case-insensitive: the heading is styled `uppercase`, and innerText honours text-transform.
      check('and both ends by name', /Kandy\s*→\s*Jaffna/i.test(text))
      check('and offers a plain Approve', (await dialog.getByRole('button', { name: 'Approve', exact: true }).count()) === 1)

      await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined)

      const moved = await eventually(
        () => prisma.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } }),
        (t) => t.status === 'APPROVED',
      )
      check('approving from the dialog reserved the transfer', moved.status === 'APPROVED', moved.status)
      const decided = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })
      check('the request is decided', decided.status === 'APPROVED')
      check('and not marked forced — someone else\'s request, no rule broken', decided.forcedAt === null)
    }

    console.log('\n── 6. The list, from each end, after the decision ──')
    {
      await ownerPage.goto(`${BASE}/dashboard/transfers`, { waitUntil: 'networkidle' })
      check('the owner (at both ends) sees Pending dispatch', await seen(ownerPage, /Pending dispatch \(1\)/))
      check('waiting on them', await seen(ownerPage, 'Waiting on you to dispatch'))

      await jayPage.goto(`${BASE}/dashboard/transfers`, { waitUntil: 'networkidle' })
      check('Jaffna sees it under Pending receive', await seen(jayPage, /Pending receive \(1\)/))
      check('waiting for Kandy to send it', await seen(jayPage, /waiting for Kandy to dispatch/))
    }

    const mayo = `Mayo UI ${stamp}`

    console.log('\n── 7. Make an Item: one flow — create, then mark done from the confirmation ──')
    {
      await ownerPage.goto(`${BASE}/dashboard/production`, { waitUntil: 'networkidle' })
      check('the form names the location it is acting on', await seen(ownerPage, /Making at/))
      check('no "Make it now"', (await ownerPage.getByRole('button', { name: 'Make it now' }).count()) === 0)
      check('no location select on the form', (await ownerPage.getByText('Made at').count()) === 0)

      await ownerPage.getByRole('combobox').filter({ hasText: 'Choose a prepared item' }).click()
      await ownerPage.getByRole('option', { name: /New prepared item/ }).click()
      await ownerPage.getByPlaceholder('Mayonnaise, curry paste, dough…').fill(mayo)
      await ownerPage.getByLabel('Output — how much you are making').fill('900')
      // The label wraps the select, so its text is "Unit" plus every option's; scope by the label instead.
      await ownerPage.locator('label', { hasText: /^Unit/ }).locator('select').selectOption('GRAM')

      await ownerPage.getByRole('combobox').filter({ hasText: 'Choose a stock item' }).first().click()
      await ownerPage.getByPlaceholder('Search stock items…').fill(chicken.name)
      await ownerPage.getByRole('option', { name: chicken.name }).click()
      const ingredientRow = ownerPage
        .locator('div.grid')
        .filter({ has: ownerPage.getByRole('combobox').filter({ hasText: chicken.name }) })
        .last()
      await ingredientRow.getByPlaceholder('0').first().fill('2')

      const createButton = ownerPage.getByRole('button', { name: 'Create prepared item' })
      check('Create is enabled once the plan is complete', await createButton.isEnabled())
      await createButton.click()
      await ownerPage.getByText(/^Created PRD-/).waitFor({ timeout: 15_000 }).catch(() => undefined)
      check('Create confirms with the batch number', await seen(ownerPage, /^Created PRD-/))
      check('and offers Mark Done at once', await seen(ownerPage, 'Made it already?'))

      const item = await eventually(
        () => prisma.inventoryItem.findFirst({ where: { restaurantId: restaurant.id, name: mayo } }),
        (i) => i !== null,
      )
      check('the prepared item exists from Create', item?.isPrepared === true)
      const chickenBefore = await prisma.inventoryStock.findFirst({ where: { itemId: chicken.id, branchId: kandy.id } })
      check('and nothing has left stock', chickenBefore?.available === 10, String(chickenBefore?.available))

      await ownerPage.getByLabel(/Actually produced/).fill('850')
      check('a shortfall is named and asks why', await seen(ownerPage, /Short by 50/) && (await ownerPage.getByLabel('Why?').count()) === 1)
      await ownerPage.getByLabel('Why?').selectOption('PRODUCTION_LOSS')
      await ownerPage.getByLabel('In your words').fill('reduced on the hob')
      await ownerPage.getByRole('button', { name: 'Mark done' }).click()
      await ownerPage.getByText(/^Made — /).waitFor({ timeout: 15_000 }).catch(() => undefined)
      check('Mark Done reports what was made', await seen(ownerPage, new RegExp(`^Made — .*${mayo}`)))

      const order = await eventually(
        () => prisma.productionOrder.findFirst({ where: { restaurantId: restaurant.id, outputItemId: item?.id ?? '' }, orderBy: { createdAt: 'desc' } }),
        (o) => o?.status === 'COMPLETED',
      )
      check('the batch is completed, with the reason from the enum', order?.status === 'COMPLETED' && order.varianceReason === 'PRODUCTION_LOSS' && order.actualQty === 850)
      const chickenAfter = await prisma.inventoryStock.findFirst({ where: { itemId: chicken.id, branchId: kandy.id } })
      check('and the chicken left on Mark Done, not on Create', chickenAfter?.available === 8, String(chickenAfter?.available))
      const mayoStock = await prisma.inventoryStock.findFirst({ where: { itemId: item?.id ?? '', branchId: kandy.id } })
      check('the mayonnaise is on the shelf at the actual yield', mayoStock?.available === 850, String(mayoStock?.available))
    }

    console.log('\n── 8. Prepared Items: an in-progress row → detail → mark done ──')
    {
      const mayoItem = await prisma.inventoryItem.findFirstOrThrow({ where: { restaurantId: restaurant.id, name: mayo } })
      const second = await startBatch({
        restaurantId: restaurant.id, branchId: kandy.id, userId: owner.id, clientRequestId: `ui-${stamp}-second`,
        plan: { name: mayo, itemId: mayoItem.id, quantity: 500, unit: 'GRAM', ingredients: [{ itemId: chicken.id, quantity: 1, unit: 'KG' }] },
      })
      await ownerPage.goto(`${BASE}/dashboard/production`, { waitUntil: 'networkidle' })
      check('the count in progress is said above the tabs', await seen(ownerPage, /1 batch in progress/))
      await ownerPage.getByRole('tab', { name: /Prepared Items/ }).click()
      const row = ownerPage.locator('tr[data-state="in-progress"]')
      check('the item is a row in the in-progress state', (await row.count()) === 1 && (await row.first().innerText().catch(() => '')).includes(mayo))
      await row.first().getByRole('button', { name: /Mark done/ }).click()
      const dialog = ownerPage.locator('[role="dialog"]')
      await dialog.waitFor()
      const text = await dialog.innerText()
      check('the detail shows the batch waiting', /In progress/i.test(text) && text.includes(second.number))
      check('and how the item is made, costed', /How it is made/i.test(text) && text.includes(chicken.name))
      await dialog.getByLabel(/Actually produced/).fill('500')
      check('no reason asked when the figures match', (await dialog.getByLabel('Why?').count()) === 0)
      await dialog.getByRole('button', { name: 'Mark done' }).click()
      const done = await eventually(
        () => prisma.productionOrder.findUniqueOrThrow({ where: { id: second.id } }),
        (o) => o.status === 'COMPLETED',
      )
      check('marked done from the detail', done.status === 'COMPLETED' && done.actualQty === 500 && done.variance === 0)
    }
  } finally {
    await browser?.close()
  }
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
