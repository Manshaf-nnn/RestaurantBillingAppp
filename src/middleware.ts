import { NextResponse, type NextRequest } from 'next/server'

import {
  ACCESS_COOKIE,
  ADMIN_ACCESS_COOKIE,
  ADMIN_REFRESH_COOKIE,
  REFRESH_COOKIE,
  verifyAccessToken,
} from '@/server/auth/jwt'

/**
 * Edge middleware.
 *
 *  1. Cross-origin write protection for the REST API (defence in depth on top
 *     of SameSite cookies — Server Actions get this from Next.js natively).
 *  2. Route protection: verifies the access JWT, and transparently refreshes it
 *     via /api/auth/refresh when it has expired but a valid session remains.
 *  3. Role gating for the operational dashboards.
 */

// Staff / restaurant routes (guarded by the STAFF session). The /admin area has
// its own separate session and is handled explicitly below.
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/kitchen',
  '/waiter',
  '/cashier',
  '/onboarding',
  '/pending-approval',
  '/trial-ended',
] as const

/*
 * The coarse gate at the edge. Fine-grained rights live in `rbac.ts` and are
 * enforced per page; this list only answers "may this role open this area at
 * all".
 *
 * The back-office roles were missing from `/dashboard` entirely. ADMIN,
 * INVENTORY_MANAGER, PURCHASING_MANAGER, WAREHOUSE_STAFF and ACCOUNTANT all
 * have full permission sets in `rbac.ts`, and `ROLE_HOME` sends each of them to
 * a dashboard page — which this line then bounced to /forbidden. Every one of
 * them could sign in and reach nothing. The permission model was built for
 * them; the edge gate was never told.
 *
 * Anything not listed here is unrestricted at the edge, so a new role must be
 * added deliberately rather than inheriting access by omission.
 */
const ROLE_ALLOWED: Record<string, string[]> = {
  '/kitchen': ['OWNER', 'MANAGER', 'ADMIN', 'KITCHEN'],
  '/waiter': ['OWNER', 'MANAGER', 'ADMIN', 'WAITER'],
  '/cashier': ['OWNER', 'MANAGER', 'ADMIN', 'CASHIER'],
  '/dashboard': [
    'OWNER',
    'MANAGER',
    'ADMIN',
    'CASHIER',
    'KITCHEN',
    'WAITER',
    'INVENTORY_MANAGER',
    'PURCHASING_MANAGER',
    'WAREHOUSE_STAFF',
    'ACCOUNTANT',
  ],
}

const AUTH_PAGES = ['/login', '/register', '/forgot-password', '/reset-password']

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Public API routes that guests must reach without a session. */
const PUBLIC_API = [
  '/api/auth/',
  '/api/public/',
  '/api/health',
  '/api/docs',
  // Menu photos, logos and covers. Guests are anonymous, and short-circuiting
  // here also skips two JWT verifications per image on every page of the menu.
  '/api/media/',
  // The change detector every station polls. It authenticates itself, and this
  // is now the hottest route in the app — skip the duplicate work here.
  '/api/pulse',
]

function isProtected(pathname: string) {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

function roleAllowed(pathname: string, role: string) {
  const entry = Object.entries(ROLE_ALLOWED).find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
  return entry ? entry[1].includes(role) : true
}

const TENANT_COOKIE = 'ros_r'
/*
 * The branch a QR code points at, remembered for the sitting.
 *
 * It has to be a cookie and not just a query param: a guest moves from the
 * landing screen to the menu to the cart, and only the first of those carries
 * what the QR encoded. Kept in step with BRANCH_COOKIE in
 * features/branches/public-branch.ts — duplicated here because middleware runs
 * on the edge and cannot import a `server-only` module.
 */
const BRANCH_COOKIE = 'ros_b'

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  // ── 0. pin the QR-ordering session to a restaurant ────────────────────────
  // `/order?r=<slug>` is what a shared-domain QR code encodes. Persist the slug
  // so every later navigation inside the guest app stays on that tenant.
  if (pathname.startsWith('/order')) {
    /*
     * The canonical guest link now carries both in the PATH:
     *
     *     /order/<restaurant-slug>/<branch-code>[/menu|/cart]
     *
     * The pages below read them from `params` and treat that as the truth. The
     * cookies are still written, for two reasons: the outer `/order/layout.tsx`
     * resolves the tenant before the `[slug]` segment is visible to it, and the
     * order-tracking pages sit outside the branch tree. They are a convenience
     * now, not the carrier — which is the whole point of the change. A branch
     * that only ever lived in a cookie is a branch that gets lost, and a lost
     * branch used to silently become Main.
     *
     * `?r=` and `?b=` are still read so older printed cards keep working.
     */
    const segments = pathname.split('/').filter(Boolean) // ['order', slug?, branch?, …]
    const fromPath = segments[0] === 'order' ? segments.slice(1) : []
    const reserved = new Set(['track', 'bill', 'menu', 'cart'])
    const pathSlug = fromPath[0] && !reserved.has(fromPath[0]) ? fromPath[0] : null
    const pathBranch = pathSlug ? fromPath[1] ?? null : null

    const slug = pathSlug ?? request.nextUrl.searchParams.get('r')
    const branch = pathBranch ?? request.nextUrl.searchParams.get('b')
    const validSlug = Boolean(slug && /^[a-z0-9-]{1,60}$/i.test(slug))
    const validBranch = Boolean(branch && /^[A-Za-z0-9-]{1,12}$/.test(branch))

    if (validSlug || validBranch) {
      const response = NextResponse.next()
      const cookie = { path: '/', sameSite: 'lax' as const, maxAge: 60 * 60 * 12 }

      if (validSlug) response.cookies.set(TENANT_COOKIE, slug!.toLowerCase(), cookie)
      // Which branch's menu, prices and tables the guest sees from here on.
      if (validBranch) response.cookies.set(BRANCH_COOKIE, branch!.toUpperCase(), cookie)

      return response
    }
    return NextResponse.next()
  }

  // ── 1. cross-origin write protection ──────────────────────────────────────
  // Compare the Origin's host to the request Host header (what the browser
  // actually connected to). This is proxy-safe: behind an HTTPS reverse proxy
  // the protocol on `nextUrl.origin` can be http while the browser Origin is
  // https, which would otherwise reject every legitimate write.
  if (pathname.startsWith('/api') && !SAFE_METHODS.has(request.method)) {
    const requestOrigin = request.headers.get('origin')
    const host = request.headers.get('host')
    if (requestOrigin) {
      let originHost: string | null = null
      try {
        originHost = new URL(requestOrigin).host
      } catch {
        originHost = null
      }
      if (!originHost || (host && originHost !== host)) {
        return NextResponse.json(
          { error: 'Cross-origin request rejected', code: 'CSRF' },
          { status: 403 },
        )
      }
    }
  }

  if (pathname.startsWith('/api') && PUBLIC_API.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next()
  }

  // Read BOTH possible sessions — admin and staff live in separate cookies, so
  // a platform admin and a restaurant owner can be signed in at the same time.
  const staffToken = request.cookies.get(ACCESS_COOKIE)?.value
  const staffClaims = staffToken ? await verifyAccessToken(staffToken) : null
  const adminToken = request.cookies.get(ADMIN_ACCESS_COOKIE)?.value
  const adminClaims = adminToken ? await verifyAccessToken(adminToken) : null

  const isAdminLogin = pathname === '/admin/login'
  const isAdminArea = pathname === '/admin' || pathname.startsWith('/admin/')

  /*
   * A Server Action is a POST carrying a `Next-Action` header, and the client
   * will only accept an RSC Flight payload in reply. Anything else is fatal in
   * one of two ways, and this app has now shipped both:
   *
   *   A redirect — a 307 preserves the method and the header, the browser
   *   replays the POST against a route whose bundle has no such action id, and
   *   the reply is HTML. Next cannot parse HTML as Flight, so the action promise
   *   stays pending forever: a button stuck on "Adding…" with no error.
   *
   *   A JSON body — server-action-reducer.js checks for `text/x-component` and
   *   throws on anything else, so the promise REJECTS instead of resolving. Same
   *   stuck button, because the callers were not catching it.
   *
   * So middleware must not answer a Server Action at all. It lets them through
   * and lets the Node-side guards decide: `requirePermission` throws, `runAction`
   * turns that into `{ok:false}`, and that IS a Flight payload the client can
   * read. Authorisation is unaffected — those guards were always the authority
   * here, and every action calls one.
   *
   * Computed before the admin and auth-page branches below, because those return
   * redirects too. The previous version declared it after them, so /admin/* and
   * /login kept the original hang.
   */
  const isServerAction = request.method === 'POST' && request.headers.has('next-action')

  if (isServerAction) return NextResponse.next()

  // ── 2. admin login page ───────────────────────────────────────────────────
  if (isAdminLogin) {
    if (adminClaims) return NextResponse.redirect(new URL('/admin', request.url))
    return NextResponse.next()
  }

  // ── 3. admin area (separate admin session) ────────────────────────────────
  if (isAdminArea) {
    if (!adminClaims) {
      if (request.cookies.has(ADMIN_REFRESH_COOKIE)) {
        const refreshUrl = new URL('/api/auth/refresh', request.url)
        refreshUrl.searchParams.set('scope', 'admin')
        refreshUrl.searchParams.set('next', `${pathname}${search}`)
        return NextResponse.redirect(refreshUrl)
      }
      const loginUrl = new URL('/admin/login', request.url)
      loginUrl.searchParams.set('next', `${pathname}${search}`)
      return NextResponse.redirect(loginUrl)
    }
    if (adminClaims.role !== 'SUPER_ADMIN') {
      return NextResponse.redirect(new URL('/admin/login', request.url))
    }
    return NextResponse.next()
  }

  // ── 4. staff auth screens: signed-in staff skip them ──────────────────────
  if (AUTH_PAGES.includes(pathname)) {
    if (staffClaims) return NextResponse.redirect(new URL('/dashboard', request.url))
    return NextResponse.next()
  }

  if (!isProtected(pathname)) return NextResponse.next()

  // ── 5. staff protected routes ─────────────────────────────────────────────
  // Server Actions already returned above; everything from here is a navigation.
  if (!staffClaims) {
    if (request.cookies.has(REFRESH_COOKIE)) {
      const refreshUrl = new URL('/api/auth/refresh', request.url)
      refreshUrl.searchParams.set('next', `${pathname}${search}`)
      return NextResponse.redirect(refreshUrl)
    }
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', `${pathname}${search}`)
    return NextResponse.redirect(loginUrl)
  }

  if (!roleAllowed(pathname, String(staffClaims.role))) {
    return NextResponse.redirect(new URL('/forbidden', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static assets.
     */
    '/((?!_next/static|_next/image|favicon.ico|icons/|sounds/|manifest.webmanifest|sw.js|uploads/|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)',
  ],
}
