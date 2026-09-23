import type { NextRequest } from 'next/server'

/**
 * Where the visitor actually is (pro.A.md §18).
 *
 * ── The bug this exists to kill ─────────────────────────────────────────────
 *
 * `request.url` is NOT the URL the browser asked for. Next builds it from the
 * hostname the server process was started with, which in every container
 * deployment is the bind address:
 *
 *     server.mjs:  next({ hostname: process.env.HOSTNAME || '0.0.0.0' })
 *       ↓
 *     next-server: initURL = `${proto}://${fetchHostname}:${port}${req.url}`
 *       ↓
 *     NextRequest.url === 'https://0.0.0.0:3000/dashboard'
 *
 * So `NextResponse.redirect(new URL('/login', request.url))` sent a real
 * visitor to `https://0.0.0.0:3000/login`. Their cookies are host-only, so the
 * session went with the hostname and they had to retype the address and sign in
 * again. It showed up on refresh because a document navigation with an expired
 * fifteen-minute access token is the one path that redirects.
 *
 * The correct host is on the request all along — nginx sends it — it was simply
 * not being read. This reads it, with the same precedence `requestOrigin` in
 * `tenant-url.ts` already uses for QR codes: the forwarded header first,
 * because behind a proxy `host` is whatever the proxy used internally.
 *
 * `server.mjs` is fixed too, so `request.url` is right as well. Both, because
 * either alone would leave the other deployment target broken, and neither
 * costs anything.
 */

/** `https://` unless the host is plainly local. */
function schemeFor(host: string): string {
  return host.startsWith('localhost') || host.startsWith('127.') || host.startsWith('0.0.0.0')
    ? 'http'
    : 'https'
}

/**
 * A host is only trustworthy if it looks like one. A header is attacker-
 * controlled in principle, and an open redirect built out of `Host:` is a
 * real attack — but the alternative here is a URL that is definitely wrong,
 * so this validates rather than refuses.
 */
function usableHost(value: string | null): string | null {
  if (!value) return null
  const host = value.split(',')[0]!.trim()
  if (!host || host.length > 255) return null
  if (!/^[a-zA-Z0-9.:_-]+$/.test(host)) return null
  // A bind address is not a place anybody can navigate to.
  if (host.startsWith('0.0.0.0')) return null
  return host
}

/** The origin this request arrived on, or null when no usable host was sent. */
export function requestOriginFrom(request: NextRequest): string | null {
  const host =
    usableHost(request.headers.get('x-forwarded-host')) ?? usableHost(request.headers.get('host'))
  if (!host) return null
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || schemeFor(host)
  return `${proto}://${host}`
}

/**
 * Build an absolute URL for a redirect, on the host the visitor is using.
 *
 * Falls back to `request.url` only when no usable host header was sent, which
 * is not a case any browser produces.
 */
export function requestUrl(request: NextRequest, path: string): URL {
  const origin = requestOriginFrom(request)
  return new URL(path, origin ?? request.url)
}
