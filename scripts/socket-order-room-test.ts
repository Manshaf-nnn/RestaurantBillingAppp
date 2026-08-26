/**
 * You may only listen to an order you own.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * `join:order` in `server.mjs` used to be two lines: staff of *any* tenant were
 * admitted, and so was any visitor, because the guest cookie is self-issued on
 * first page load. The comment beside it claimed the room was "re-checked
 * against the order room registry" and no such check existed. Knowing an
 * order's cuid was enough to receive its live updates — the customer's name and
 * phone, every line item, the total.
 *
 * That is cross-TENANT, not merely cross-branch, and it is the one thing the
 * branch audit turned up that was worse than the branch problem itself.
 *
 * ── Why it needs its own script ─────────────────────────────────────────────
 *
 * Every other check in this suite speaks HTTP. This one has to speak
 * websocket, because the hole is in the socket handshake and nothing else
 * reaches it. It runs only against the custom server (`npm start` /
 * `node server.mjs`) — Netlify serves the app without one, which is why
 * production is not exposed, and also why this cannot be folded into the
 * page-render pass.
 *
 *   node server.mjs &
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/socket-order-room-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { io as connect, type Socket } from 'socket.io-client'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'

/*
 * Defaults to the port `npm start` uses.
 *
 * This said 3210 while five of its sibling runtime suites said 3000, so a
 * server left running on the other port meant this file quietly tested a build
 * from hours ago — passing, against code that no longer existed. One port, or
 * pass BASE_URL.
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const GUEST_COOKIE = 'ros_gs'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Open a socket carrying these cookies, and wait for it to connect. */
function open(cookie: string): Promise<Socket> {
  const socket = connect(BASE, {
    path: '/socket.io',
    transports: ['websocket'],
    extraHeaders: { cookie },
    reconnection: false,
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not connect')), 8_000)
    socket.on('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.on('connect_error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * Ask to join an order's room, then see whether anything from it arrives.
 *
 * There is no "join refused" reply to listen for — the server simply does not
 * add the socket to the room — so the observable behaviour is whether the next
 * broadcast reaches us. The caller emits one after this resolves.
 */
async function joinsAndHears(socket: Socket, orderId: string, emit: () => Promise<void>) {
  socket.emit('join:order', orderId)
  // Let the server's async ownership lookup finish before anything is sent.
  await new Promise((r) => setTimeout(r, 400))

  let heard = false
  socket.on('order:updated', () => { heard = true })
  socket.on('order:status', () => { heard = true })

  await emit()
  await new Promise((r) => setTimeout(r, 700))
  return heard
}

/** Action ids as Next emits them into the client bundle. */
function actionIds(): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.js')) {
        const src = readFileSync(full, 'utf8')
        const re = /createServerReference\)\("([0-9a-f]{40,42})"[^)]*?,"([A-Za-z0-9_$]+)"\)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(src))) if (!found.has(m[2])) found.set(m[2], m[1])
      }
    }
  }
  try {
    walk('.next/static/chunks')
  } catch {
    // no build
  }
  return found
}

async function signInAs(user: {
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
    sub: user.id, rid: user.restaurantId, role: user.role,
    name: user.name, email: user.email, sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
}

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping.`)
    process.exit(0)
  }

  // The custom server is what carries Socket.IO. Next's own `next start` does
  // not, so a missing endpoint here is a configuration fact, not a failure.
  const hasSocket = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`)
    .then((r) => r.ok)
    .catch(() => false)
  if (!hasSocket) {
    console.log('This server has no Socket.IO endpoint (plain `next start`) — skipping.')
    console.log('Run `node server.mjs` to exercise the websocket guard.')
    process.exit(0)
  }

  const stamp = Date.now().toString(36)

  // Two restaurants, so "staff of another tenant" is a real thing to test.
  const mine = await prisma.restaurant.create({
    data: { name: `Sock A ${stamp}`, slug: `sock-a-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const theirs = await prisma.restaurant.create({
    data: { name: `Sock B ${stamp}`, slug: `sock-b-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const myBranch = await prisma.branch.create({
    data: { restaurantId: mine.id, name: 'Main', code: `SA${stamp.slice(-3).toUpperCase()}`, isDefault: true },
  })
  await prisma.branch.create({
    data: { restaurantId: theirs.id, name: 'Main', code: `SB${stamp.slice(-3).toUpperCase()}`, isDefault: true },
  })

  const owner = await prisma.user.create({
    data: {
      restaurantId: theirs.id, role: 'OWNER', name: 'Other owner',
      email: `other-${stamp}@sock.test`, passwordHash: 'x', emailVerifiedAt: new Date(),
    },
  })

  const guestSession = generateToken(18)
  const order = await prisma.order.create({
    data: {
      restaurantId: mine.id,
      branchId: myBranch.id,
      orderNumber: `SOCK-${stamp}`,
      customerName: 'Someone else',
      customerPhone: '0770000000',
      guestSessionId: guestSession,
      grandTotal: 12_345,
    },
  })

  /*
   * The broadcast has to happen INSIDE the server process.
   *
   * The first version of this called `realtime.orderStatus` from here, which
   * imports the emitter into the TEST process — where `globalThis.__ros_io` is
   * unset, so nothing was ever sent. Both "attacker cannot hear it" checks
   * passed for the wrong reason: nobody could hear anything. A test that cannot
   * fail is worse than no test, because it reads as coverage.
   *
   * So it drives a real status change over HTTP, as a real member of the
   * owning restaurant's staff, and the server emits as it would in service.
   */
  const staff = await prisma.user.create({
    data: {
      restaurantId: mine.id, branchId: myBranch.id, role: 'MANAGER',
      name: 'Own manager', email: `own-${stamp}@sock.test`,
      passwordHash: 'x', emailVerifiedAt: new Date(),
    },
  })
  const staffCookie = await signInAs(staff)
  const updateId = actionIds().get('updateOrderStatus')
  if (!updateId) {
    console.error('updateOrderStatus not found in the client bundle — run `npx next build`.')
    process.exit(1)
  }

  let nextStatus = 'ACCEPTED'
  const bump = async () => {
    await fetch(`${BASE}/dashboard/orders`, {
      method: 'POST',
      headers: {
        cookie: staffCookie,
        'Next-Action': updateId,
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: JSON.stringify([{ orderId: order.id, status: nextStatus }]),
      redirect: 'manual',
    }).catch(() => {})
    // Each call must be a real transition, so the next one moves it on again.
    nextStatus = nextStatus === 'ACCEPTED' ? 'PREPARING' : 'READY'
  }

  const sockets: Socket[] = []

  console.log('\n── a stranger with their own guest cookie ──')

  const strangerCookie = `${GUEST_COOKIE}=${generateToken(18)}`
  const stranger = await open(strangerCookie)
  sockets.push(stranger)
  check(
    'cannot hear an order they did not place',
    !(await joinsAndHears(stranger, order.id, bump)),
    'knowing the id was enough to watch somebody else’s order',
  )

  console.log('\n── staff of a DIFFERENT restaurant ──')

  const outsider = await open(await signInAs(owner))
  sockets.push(outsider)
  check(
    'cannot hear another tenant’s order',
    !(await joinsAndHears(outsider, order.id, bump)),
    'an owner of another restaurant was watching this one’s orders',
  )

  console.log('\n── the guest who actually placed it ──')

  const rightful = await open(`${GUEST_COOKIE}=${guestSession}`)
  sockets.push(rightful)
  check(
    'still hears their own order',
    await joinsAndHears(rightful, order.id, bump),
    'the fix locked out the person it is for',
  )

  for (const socket of sockets) socket.close()

  await prisma.session.deleteMany({ where: { user: { restaurantId: { in: [mine.id, theirs.id] } } } })
  await prisma.order.deleteMany({ where: { restaurantId: { in: [mine.id, theirs.id] } } })
  await prisma.user.deleteMany({ where: { restaurantId: { in: [mine.id, theirs.id] } } })
  await prisma.branch.deleteMany({ where: { restaurantId: { in: [mine.id, theirs.id] } } })
  await prisma.restaurant.deleteMany({ where: { id: { in: [mine.id, theirs.id] } } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
