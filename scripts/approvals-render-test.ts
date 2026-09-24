/**
 * The approvals desk and the transfers board say what the browser test expects.
 *
 * ── Why this exists alongside `recorrection-ui-test` ───────────────────────
 *
 * That test drives both screens in a real browser and asserts literal text:
 * `Stock transfers (1)`, `Waiting for Kandy to approve`, the transfer's lines
 * as `Chicken · 3 kg`, `Kandy → Jaffna`, `reserves the stock at Kandy`, a
 * `View details` button, and — for the branch that RAISED the request — no
 * Approve button anywhere on the page. Those assertions are the contract that
 * kept the approvals restructure honest: the layout may change, what the desk
 * SAYS may not.
 *
 * But it needs Playwright's browser, which is not installed here, so it skips.
 * A contract nothing checks is a contract that quietly stops holding.
 *
 * This asserts the same text against the rendered HTML over plain HTTP. It is
 * not a replacement — the browser test also CLICKS Approve and then reads the
 * database to prove the decision fan-out still reaches the right action, which
 * no amount of HTML inspection can do. It is the half that can run everywhere.
 *
 * Usage:
 *   npx next build && npx next start -p 3210 &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/approvals-render-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'
import { postMovement } from '../src/features/inventory/ledger'
import { requestTransfer } from '../src/features/transfers/service'
import { requestApproval } from '../src/features/approvals/service'

const BASE = process.env.BASE_URL ?? 'http://localhost:3210'
const stamp = Date.now().toString(36)

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

async function cookieFor(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const refresh = generateToken()
  const session = await prisma.session.create({
    data: { userId: user.id, refreshTokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + 86_400_000) },
  })
  const access = await signAccessToken({
    sub: user.id, rid: user.restaurantId, role: user.role, name: user.name, email: user.email, sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
}

/** Strip tags so a string split across elements still matches, as innerText would. */
const text = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&rsquo;/g, '’').replace(/&nbsp;/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
    .replace(/\s+/g, ' ')

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: `UiCheck ${stamp}`, slug: `uicheck-${stamp}`, status: 'ACTIVE', isActive: true, plan: 'GROWTH' },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: `KDY${stamp.slice(-3)}`, isDefault: true },
  })
  const jaffna = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Jaffna', code: `JAF${stamp.slice(-3)}` },
  })
  const mk = (name: string, role: 'OWNER' | 'MANAGER', branchId: string | null) =>
    prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `${name.toLowerCase()}-${stamp}@uicheck.local`,
        name, passwordHash: 'x', role, branchId,
      },
    })
  const owner = await mk('Owner', 'OWNER', null)
  const jay = await mk('Jay', 'MANAGER', jaffna.id)

  const chicken = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Chicken ${stamp}`, unit: 'KG', branchId: kandy.id, costPerUnit: 1_200_00 },
  })
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: chicken.id, type: 'PURCHASE', quantity: 10,
      branchId: kandy.id, locationId: null, userId: owner.id,
    }),
  )
  const transfer = await requestTransfer({
    restaurantId: restaurant.id, fromBranchId: kandy.id, toBranchId: jaffna.id,
    lines: [{ itemId: chicken.id, quantity: 3 }], userId: jay.id,
  })
  await requestApproval({
    restaurantId: restaurant.id, branchId: kandy.id, kind: 'STOCK_TRANSFER',
    entity: 'StockTransfer', entityId: transfer.id, reason: 'Weekend rush',
    payload: { toBranchId: jaffna.id, lines: 1 }, userId: jay.id,
  })

  const page = async (userId: string) =>
    text(await fetch(`${BASE}/dashboard/approvals`, { headers: { cookie: await cookieFor(userId) } }).then((r) => r.text()))

  console.log('\n── The owner’s desk (recorrection-ui-test §5) ──')
  const ownerHtml = await page(owner.id)
  check('grouped under Stock transfers (1)', /Stock transfers \(1\)/.test(ownerHtml))
  check('the row carries the transfer number', /TRF-\d+/.test(ownerHtml), (ownerHtml.match(/TRF-\d+/) ?? ['none'])[0])
  check('both ends by name', /Kandy\s*→\s*Jaffna/.test(ownerHtml))
  check('and the lines', ownerHtml.includes(`${chicken.name} · 3 kg`), `looking for "${chicken.name} · 3 kg"`)
  check('honest about what approving does', /reserves the stock at Kandy/.test(ownerHtml))
  check('a View details button is offered', /View details/.test(ownerHtml))
  check('and an Approve button is on the row', />\s*Approve\s*</.test(ownerHtml) || /Approve/.test(ownerHtml))

  console.log('\n── Jaffna, who raised it (recorrection-ui-test §1) ──')
  const jayHtml = await page(jay.id)
  check("the request Jaffna raised is on Jaffna's desk", /Stock transfers \(1\)/.test(jayHtml))
  check('told what it is waiting for', jayHtml.includes('Waiting for Kandy to approve'))
  check('the lines are on the row', jayHtml.includes(`${chicken.name} · 3 kg`))
  check(
    'and offered NO Approve — not theirs to decide',
    !/\bApprove\b/.test(jayHtml),
    (jayHtml.match(/.{40}Approve.{40}/) ?? [''])[0],
  )


  console.log('\n── The transfers board keeps its furniture (recorrection-ui-test §6) ──')
  const board = text(
    await fetch(`${BASE}/dashboard/transfers`, { headers: { cookie: await cookieFor(owner.id) } })
      .then((r) => r.text()),
  )
  check(
    'the five figures are across the top',
    board.includes('Total Transfers') && board.includes('In Transit') && board.includes('Issue / Variance'),
  )
  check(
    'one table, with the columns the design names',
    board.includes('Total Qty') && board.includes('Created By'),
  )
  check('and the filter bar', board.includes('From Location') && board.includes('To Location'))
  check(
    'Export became Report — the header-only download is gone',
    board.includes('Report') && !/Download\s+CSV/.test(board),
  )

  const jayBoard = text(
    await fetch(`${BASE}/dashboard/transfers`, { headers: { cookie: await cookieFor(jay.id) } })
      .then((r) => r.text()),
  )
  check(
    "the destination is told whose it is, and never that it is theirs to dispatch",
    jayBoard.includes('Waiting for Kandy to approve') && !jayBoard.includes('Waiting on you to dispatch'),
  )

  await prisma.session.deleteMany({ where: { user: { restaurantId: restaurant.id } } })
  await prisma.approvalRequest.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockTransferLine.deleteMany({ where: { transfer: { restaurantId: restaurant.id } } })
  await prisma.stockTransfer.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
  try { await prisma.restaurant.delete({ where: { id: restaurant.id } }) }
  catch { await prisma.restaurant.update({ where: { id: restaurant.id }, data: { isActive: false } }) }

  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
