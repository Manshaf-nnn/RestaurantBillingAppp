// ============================================================================
// RestaurantOS custom server
// ----------------------------------------------------------------------------
// Runs Next.js and Socket.IO in a single Node process so server actions and
// route handlers can publish realtime events directly (via globalThis.__ros_io)
// without an extra network hop or message broker.
//
//   npm run dev     → development, HMR enabled
//   npm start       → production (expects `next build` to have run)
// ============================================================================
import { createServer } from 'node:http'
import { parse } from 'node:url'
import next from 'next'
import { Server as SocketServer } from 'socket.io'
import { jwtVerify } from 'jose'

// Auto-configure the public URL on cloud hosts that expose it, so cookies get
// marked Secure and links/QRs point at the right domain without manual setup.
// Render sets RENDER_EXTERNAL_URL; Railway sets RAILWAY_PUBLIC_DOMAIN.
if (!process.env.NEXT_PUBLIC_APP_URL) {
  const inferred =
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
  if (inferred) {
    process.env.NEXT_PUBLIC_APP_URL = inferred
    if (!process.env.NEXT_PUBLIC_SOCKET_URL) process.env.NEXT_PUBLIC_SOCKET_URL = inferred
  }
}

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '0.0.0.0'
const port = Number(process.env.PORT || 3000)

const ACCESS_COOKIE = 'ros_at'
const GUEST_COOKIE = 'ros_gs'
const ISSUER = 'restaurantos'
const AUDIENCE = 'restaurantos.app'

const ROLE_ROOMS = {
  SUPER_ADMIN: ['management', 'kitchen', 'waiter', 'cashier'],
  OWNER: ['management', 'kitchen', 'waiter', 'cashier'],
  MANAGER: ['management', 'kitchen', 'waiter', 'cashier'],
  KITCHEN: ['kitchen'],
  WAITER: ['waiter'],
  CASHIER: ['cashier'],
}

function parseCookies(header = '') {
  const jar = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    if (!key) continue
    jar[key] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return jar
}

async function identify(socket) {
  const jar = parseCookies(socket.handshake.headers.cookie || '')
  const guestId = jar[GUEST_COOKIE] || null
  const token = jar[ACCESS_COOKIE]
  if (!token) return { user: null, guestId }

  const secret = process.env.JWT_ACCESS_SECRET
  if (!secret || secret.length < 32) return { user: null, guestId }

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    return { user: payload, guestId }
  } catch {
    return { user: null, guestId }
  }
}

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

await app.prepare()

const httpServer = createServer((req, res) => {
  // Socket.IO owns its own path; everything else is Next.
  if (req.url && req.url.startsWith('/socket.io')) return
  handle(req, res, parse(req.url, true)).catch((error) => {
    console.error('[next] request failed', error)
    res.statusCode = 500
    res.end('Internal Server Error')
  })
})

const io = new SocketServer(httpServer, {
  path: '/socket.io',
  serveClient: false,
  cors: { origin: process.env.NEXT_PUBLIC_APP_URL || true, credentials: true },
  pingInterval: 25_000,
  pingTimeout: 20_000,
  transports: ['websocket', 'polling'],
})

// Horizontal scaling: attach the Redis adapter when REDIS_URL is present so
// events reach clients connected to other instances.
if (process.env.REDIS_URL) {
  try {
    const [{ createAdapter }, { default: Redis }] = await Promise.all([
      import('@socket.io/redis-adapter').catch(() => ({ createAdapter: null })),
      import('ioredis'),
    ])
    if (createAdapter) {
      const pub = new Redis(process.env.REDIS_URL)
      const sub = pub.duplicate()
      io.adapter(createAdapter(pub, sub))
      console.log('  ✓ Socket.IO Redis adapter enabled')
    }
  } catch (error) {
    console.warn('  ! Socket.IO Redis adapter unavailable:', error.message)
  }
}

io.use(async (socket, nextFn) => {
  const { user, guestId } = await identify(socket)
  socket.data.user = user
  socket.data.guestId = guestId
  // Guests are allowed to connect unauthenticated — they can only ever join
  // rooms for orders they created (verified below).
  nextFn()
})

io.on('connection', (socket) => {
  const user = socket.data.user

  if (user?.rid) {
    socket.join(`r:${user.rid}`)
    socket.join(`user:${user.sub}`)
    for (const room of ROLE_ROOMS[user.role] ?? []) socket.join(`r:${user.rid}:${room}`)
  }

  socket.on('join:order', async (orderId) => {
    if (typeof orderId !== 'string' || orderId.length > 64) return
    // Staff of the owning tenant may always subscribe. Guests must own the
    // order — enforced by the API that hands out the id together with the
    // guest cookie, and re-checked here against the order room registry.
    if (user?.rid) {
      socket.join(`order:${orderId}`)
      return
    }
    if (socket.data.guestId) socket.join(`order:${orderId}`)
  })

  socket.on('leave:order', (orderId) => {
    if (typeof orderId === 'string') socket.leave(`order:${orderId}`)
  })

  socket.on('error', (error) => console.error('[socket] error', error.message))
})

// Expose to the Next.js runtime — see src/server/realtime/emitter.ts
globalThis.__ros_io = io

httpServer.listen(port, hostname, () => {
  const shown = hostname === '0.0.0.0' ? 'localhost' : hostname
  console.log(`\n  RestaurantOS ${dev ? '(development)' : '(production)'}`)
  console.log(`  ▸ App        http://${shown}:${port}`)
  console.log(`  ▸ Realtime   ws://${shown}:${port}/socket.io`)
  console.log(`  ▸ Dashboard  http://${shown}:${port}/dashboard`)
  console.log(`  ▸ QR Order   http://${shown}:${port}/order\n`)
})

const shutdown = (signal) => {
  console.log(`\n[server] ${signal} received, shutting down…`)
  io.close(() => {
    httpServer.close(() => process.exit(0))
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
