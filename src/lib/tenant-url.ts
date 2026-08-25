import 'server-only'
import { headers } from 'next/headers'

import { appUrl } from './env'

/**
 * Which origin a link should carry.
 *
 * ── Why `appUrl()` alone is not enough any more ─────────────────────────────
 *
 * `appUrl()` is one value for the whole deployment — `NEXT_PUBLIC_APP_URL`, or
 * Netlify's `URL`. That was right while every restaurant lived at the same
 * address. It stops being right the moment one of them has its own: an owner
 * on `nilaza.lk` printing table codes would get codes pointing at
 * `tableflow.markui.lk`, and a password-reset email would land them on a host
 * where their cookie does not exist, because cookies here are host-only.
 *
 * So there are two questions, and they have different answers:
 *
 *   requestOrigin()   where is this person RIGHT NOW?
 *   tenantOrigin()    where does this restaurant live?
 *
 * ── requestOrigin, for anything rendered in front of somebody ───────────────
 *
 * Reads the Host header of the actual request. An owner looking at their own
 * domain prints QR codes carrying it; the same owner on the shared address
 * prints the shared one. It cannot be stale, because it is not configuration —
 * it is the connection the browser made.
 *
 * `manager-credentials.tsx` reached the same conclusion from the client side
 * and said so: "behind Netlify's proxy `appUrl()` is an env var that can lag a
 * domain change, and a sign-in link that points at the wrong hostname is worse
 * than no link."
 *
 * ── tenantOrigin, for anything sent later ──────────────────────────────────
 *
 * An email is composed in a background path where there is no request to read,
 * and it may be opened days afterwards. It has to name the restaurant's own
 * home, which is what the verified domain records.
 */

/** `https://` unless the host is plainly local. */
function schemeFor(host: string): string {
  return host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'
}

/**
 * The origin this request actually arrived on.
 *
 * Falls back to `appUrl()` outside a request scope — a background job, a build
 * — where there is no host to read.
 */
export async function requestOrigin(): Promise<string> {
  try {
    const store = await headers()
    /*
     * `x-forwarded-host` first, the same precedence as `requestHost` in
     * `server/db/tenant.ts`. Behind a proxy — Netlify included — `host` is
     * whatever the proxy used internally, and only the forwarded header carries
     * what the visitor typed. `host` remains the fallback for local
     * development and any un-proxied deployment.
     */
    const host = store.get('x-forwarded-host') ?? store.get('host')
    if (!host) return appUrl()
    const proto = store.get('x-forwarded-proto') ?? schemeFor(host)
    return `${proto}://${host}`.replace(/\/$/, '')
  } catch {
    // `headers()` throws outside a request. Not an error — just no host.
    return appUrl()
  }
}

/**
 * Where this restaurant lives.
 *
 * Their verified domain when they have one, the platform address otherwise.
 * Unverified deliberately falls back: a domain nobody has proved answers is not
 * somewhere to send a guest with a bill in their hand.
 */
export function tenantOrigin(
  restaurant: { customDomain?: string | null; customDomainVerifiedAt?: Date | null } | null,
): string {
  if (!restaurant?.customDomain || !restaurant.customDomainVerifiedAt) return appUrl()
  return `https://${restaurant.customDomain}`
}

/**
 * The origin to print on something the guest keeps.
 *
 * Prefers where the person is standing, because that is what they are looking
 * at and what they expect to see on the paper. Falls back to the restaurant's
 * own home when the request tells us nothing.
 */
export async function printableOrigin(
  restaurant: { customDomain?: string | null; customDomainVerifiedAt?: Date | null } | null,
): Promise<string> {
  const fromRequest = await requestOrigin()
  return fromRequest === appUrl() ? tenantOrigin(restaurant) : fromRequest
}

/** The DNS record an owner has to add, and what to point it at. */
export function dnsInstructions(domain: string, platformHost: string) {
  const apex = domain.split('.').length <= 2
  return {
    /*
     * An apex domain cannot legally be a CNAME, so most registrars offer
     * ALIAS/ANAME instead — and the ones that do not need an A record to
     * Netlify's load balancer.
     */
    type: apex ? 'ALIAS (or ANAME)' : 'CNAME',
    name: apex ? '@' : domain.split('.')[0],
    value: platformHost,
    note: apex
      ? 'If your registrar has no ALIAS or ANAME record, use an A record pointing at 75.2.60.5 (Netlify’s load balancer), or point a subdomain such as order.' + domain + ' instead.'
      : null,
  }
}
