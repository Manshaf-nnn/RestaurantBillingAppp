/**
 * What the live stream does when the connection is not perfect.
 *
 * ── Why this exists next to socket-order-room-test ──────────────────────────
 *
 * That suite asks who is ALLOWED into an order's room: a stranger is refused,
 * another tenant's staff is refused, the guest who placed it is admitted.
 * Those are the security questions and they were the urgent ones.
 *
 * This asks the reliability questions, which nothing covered: what happens
 * when the socket drops. Restaurant wifi drops constantly — a phone walks
 * behind the cold room, a router reboots between services, a tablet sleeps —
 * so "the connection was interrupted" is the normal case, not the edge.
 *
 * The property that matters is the one the client depends on: **a websocket
 * is a notification channel, never the source of truth.** A client that
 * missed an event while disconnected must be able to ask the server what is
 * true now and carry on. This checks both halves — that the stream resumes,
 * and that the authoritative state is there to resynchronise from — and it
 * checks the thing that makes the second half necessary: a reconnected socket
 * is NOT silently still in its old room.
 *
 * Usage:
 *   node server.mjs &          # `next start` serves no Socket.IO
 *   BASE_URL=http://localhost:3210 npx tsx --tsconfig tsconfig.test.json scripts/socket-resilience-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { io as connect, type Socket } from 'socket.io-client'

import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'

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
 * Count each event SEPARATELY, not together.
 *
 * A status change deliberately emits two different things: `order:updated`
 * ("this order changed, re-read it") and `order:status` ("its status is now
 * X"). Summing them reports 2 for a single change and reads as a duplicate
 * delivery — which is what the first version of this suite did, failing
 * seven assertions on behaviour that was entirely correct. The question
 * "was anything delivered twice" is per event name.
 */
function listen(socket: Socket) {
  const counts = { updated: 0, status: 0 }
  socket.on('order:updated', () => { counts.updated += 1 })
  socket.on('order:status', () => { counts.status += 1 })
  return {
    /** How many times the MOST-delivered single event arrived. */
    most: () => Math.max(counts.updated, counts.status),
    /** How many distinct notifications arrived at all. */
    any: () => counts.updated + counts.status,
    detail: () => `updated=${counts.updated} status=${counts.status}`,
  }
}

function actionIds(): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.js')) {
        const src = readFileSync(full, 'utf8')
        for (const m of src.matchAll(/\(0,[\w$.]+\)\("([0-9a-f]{40,})",\s*"(\w+)"\)/g)) {
          found.set(m[2], m[1])
        }
        for (const m of src.matchAll(/createServerReference\)\("([0-9a-f]{40,})"[^)]*?,\s*"(\w+)"\)/g)) {
          found.set(m[2], m[1])
        }
      }
    }
  }
  walk(join(__dirname, '..', '.next', 'static'))
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
    data: { userId: user.id, refreshTokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + 86_400_000) },
  })
  const access = await signAccessToken({
    sub: user.id, rid: user.restaurantId, role: user.role,
    name: user.name, email: user.email, sid: session.id,
  } as Parameters<typeof signAccessToken>[0])
  return `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`
}

const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const reachable = await fetch(BASE, { redirect: 'manual' }).then(() => true).catch(() => false)
  if (!reachable) {
    console.log(`No server at ${BASE} — skipping.`)
    process.exit(0)
  }
  const hasSocket = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`).then((r) => r.ok).catch(() => false)
  if (!hasSocket) {
    console.log('This server has no Socket.IO endpoint (plain `next start`) — skipping.')
    console.log('Run `node server.mjs` to exercise the live stream.')
    process.exit(0)
  }

  const stamp = Date.now().toString(36)
  const shop = await prisma.restaurant.create({
    data: { name: `Resil ${stamp}`, slug: `resil-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const sockets: Socket[] = []

  try {
    const branch = await prisma.branch.create({
      data: { restaurantId: shop.id, name: 'Main', code: `RS${stamp.slice(-3).toUpperCase()}`, isDefault: true },
    })
    const staff = await prisma.user.create({
      data: {
        restaurantId: shop.id, branchId: branch.id, role: 'MANAGER',
        name: 'Manager', email: `resil-${stamp}@sock.test`,
        passwordHash: 'x', emailVerifiedAt: new Date(),
      },
    })
    const staffCookie = await signInAs(staff)
    const updateId = actionIds().get('updateOrderStatus')
    if (!updateId) {
      console.error('updateOrderStatus not found in the client bundle — run `npx next build`.')
      process.exit(1)
    }

    /** A fresh order, so every phase can start from the same transition. */
    let seq = 0
    const newOrder = async () => {
      seq += 1
      const guestSession = generateToken(18)
      const order = await prisma.order.create({
        data: {
          restaurantId: shop.id,
          branchId: branch.id,
          orderNumber: `RSL-${stamp}-${seq}`,
          customerName: 'Guest',
          customerPhone: '0770000001',
          guestSessionId: guestSession,
          grandTotal: 10_000,
        },
      })
      return { order, cookie: `${GUEST_COOKIE}=${guestSession}` }
    }

    /** Move an order on, from inside the server, as staff would. */
    const bump = async (orderId: string, status: string) => {
      await fetch(`${BASE}/dashboard/orders`, {
        method: 'POST',
        headers: {
          cookie: staffCookie,
          'Next-Action': updateId,
          'Content-Type': 'text/plain;charset=UTF-8',
        },
        body: JSON.stringify([{ orderId, status }]),
        redirect: 'manual',
      }).catch(() => {})
      await settle()
    }

    console.log('\n── 1. A dropped connection, then a reconnection ──')
    {
      const { order, cookie } = await newOrder()
      const first = await open(cookie)
      sockets.push(first)
      const heard = listen(first)
      first.emit('join:order', order.id)
      await settle(400)

      await bump(order.id, 'ACCEPTED')
      check('the guest hears the first change', heard.most() === 1, heard.detail())
      const before = heard.any()

      first.disconnect()
      await settle(300)
      await bump(order.id, 'PREPARING')
      check('nothing arrives while disconnected', heard.any() === before, heard.detail())

      const second = await open(cookie)
      sockets.push(second)
      const again = listen(second)
      second.emit('join:order', order.id)
      await settle(400)
      await bump(order.id, 'READY')
      check('a reconnected socket that rejoins hears again', again.most() === 1, again.detail())
    }

    console.log('\n── 2. Reconnecting without rejoining hears nothing ──')
    {
      /*
       * The point of the whole suite. A socket is a new socket after a drop —
       * it is not silently still in the room it was in — so a client that
       * reconnects and assumes it will keep receiving will sit there quietly
       * missing everything. That is precisely why the client must resync from
       * the server rather than treat the stream as the source of truth.
       */
      const { order, cookie } = await newOrder()
      const first = await open(cookie)
      sockets.push(first)
      first.emit('join:order', order.id)
      await settle(400)
      first.disconnect()
      await settle(300)

      const second = await open(cookie)
      sockets.push(second)
      const silent = listen(second)
      // Deliberately NO join:order here.
      await bump(order.id, 'ACCEPTED')
      check('a reconnected socket is not still in its old room', silent.any() === 0, silent.detail())

      // And the authoritative state is there to catch up from.
      const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
      check('the server still knows the truth to resync from', fresh.status === 'ACCEPTED', fresh.status)
    }

    console.log('\n── 3. Reconnecting repeatedly ──')
    {
      const { order, cookie } = await newOrder()
      const statuses = ['ACCEPTED', 'PREPARING', 'READY']
      let delivered = 0
      for (const status of statuses) {
        const socket = await open(cookie)
        sockets.push(socket)
        const heard = listen(socket)
        socket.emit('join:order', order.id)
        await settle(400)
        await bump(order.id, status)
        delivered += heard.most()
        socket.disconnect()
        await settle(200)
      }
      check('three reconnect cycles each deliver their event', delivered === 3, `${delivered}/3`)
    }

    console.log('\n── 4. One event is delivered once, to each device ──')
    {
      const { order, cookie } = await newOrder()
      const phone = await open(cookie)
      const tablet = await open(cookie)
      sockets.push(phone, tablet)
      const onPhone = listen(phone)
      const onTablet = listen(tablet)
      phone.emit('join:order', order.id)
      tablet.emit('join:order', order.id)
      await settle(400)

      await bump(order.id, 'ACCEPTED')
      check('the phone hears it once, not twice', onPhone.most() === 1, onPhone.detail())
      check('and so does the tablet', onTablet.most() === 1, onTablet.detail())
    }

    console.log('\n── 5. Joining the same room twice does not double the stream ──')
    {
      /*
       * A client that re-emits `join:order` on every render — an easy mistake
       * with an effect that has the wrong dependencies — must not end up
       * receiving each event once per join. Duplicated tickets on a kitchen
       * display is the visible form of that bug.
       */
      const { order, cookie } = await newOrder()
      const socket = await open(cookie)
      sockets.push(socket)
      const heard = listen(socket)
      socket.emit('join:order', order.id)
      socket.emit('join:order', order.id)
      socket.emit('join:order', order.id)
      await settle(500)

      await bump(order.id, 'ACCEPTED')
      check('three joins still deliver one of each event', heard.most() === 1, heard.detail())
    }

    console.log('\n── 6. A socket that never joined hears nothing ──')
    {
      const { order } = await newOrder()
      const stranger = await open(`${GUEST_COOKIE}=${generateToken(18)}`)
      sockets.push(stranger)
      const heard = listen(stranger)
      await settle(300)
      await bump(order.id, 'ACCEPTED')
      check('an unjoined socket receives nothing', heard.any() === 0, heard.detail())
    }
  } finally {
    for (const socket of sockets) socket.disconnect()
    await prisma.session.deleteMany({ where: { user: { restaurantId: shop.id } } })
    await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: shop.id } } })
    await prisma.order.deleteMany({ where: { restaurantId: shop.id } })
    await prisma.auditLog.deleteMany({ where: { restaurantId: shop.id } })
    await prisma.user.deleteMany({ where: { restaurantId: shop.id } })
    await prisma.branch.deleteMany({ where: { restaurantId: shop.id } })
    await prisma.restaurant.deleteMany({ where: { id: shop.id } })
    await prisma.$disconnect()
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect().catch(() => undefined)
  process.exit(1)
})
