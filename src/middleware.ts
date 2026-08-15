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

const ROLE_ALLOWED: Record<string, string[]> = {
  '/kitchen': ['OWNER', 'MANAGER', 'KITCHEN'],
  '/waiter': ['OWNER', 'MANAGER', 'WAITER'],
  '/cashier': ['OWNER', 'MANAGER', 'CASHIER'],
  '/dashboard': ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN', 'WAITER'],
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

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  // ── 0. pin the QR-ordering session to a restaurant ────────────────────────
  // `/order?r=<slug>` is what a shared-domain QR code encodes. Persist the slug
  // so every later navigation inside the guest app stays on that tenant.
  if (pathname.startsWith('/order')) {
    const slug = request.nextUrl.searchParams.get('r')
    if (slug && /^[a-z0-9-]{1,60}$/i.test(slug)) {
      const response = NextResponse.next()
      response.cookies.set(TENANT_COOKIE, slug.toLowerCase(), {
        path: '/',
        sameSite: 'lax',
        maxAge: 60 * 60 * 12,
      })
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
