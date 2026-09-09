import { NextResponse, type NextRequest } from 'next/server'

import { normaliseHost } from '@/server/db/tenant'
import { prisma } from '@/server/db/prisma'
import { enforceRateLimit } from '@/server/security/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * "Do we serve this hostname?" — asked by the TLS terminator, not by a browser.
 *
 * A reverse proxy in front of a multi-tenant app has to obtain a certificate
 * for a domain nobody told it about in advance: a restaurant points
 * `menu.copperspoon.lk` at us and expects HTTPS to work. Caddy's on-demand TLS
 * does exactly that — it issues the certificate the first time the hostname is
 * requested — but it must ask somebody first, or anyone who aims a DNS record
 * at our IP can burn through the certificate authority's rate limits on our
 * account, and we would happily serve TLS for domains that are nothing to do
 * with us.
 *
 * So: this endpoint is the guest list.
 *
 * ── Why it cannot just call `resolvePublicTenant` ───────────────────────────
 *
 * `/api/public/whoami` answers only for domains whose `customDomainVerifiedAt`
 * is set, and rightly so: resolving on an unverified row would let a half-built
 * record aim a hostname at somebody else's menu. But verification works by
 * fetching `https://<domain>/api/public/whoami`, which needs a certificate,
 * which needs this endpoint to say yes — and it would not, because the domain
 * is not verified yet. The two would wait for each other for ever.
 *
 * The way out is to notice they are answering different questions. Verification
 * asks "may this domain speak for this restaurant?" and must stay strict. This
 * asks only "did somebody in our admin type this hostname?", which is enough to
 * refuse the open internet while still letting a newly-configured domain get
 * far enough to prove itself.
 *
 * Answers 200 to allow and 404 to refuse — the shape Caddy's `ask` expects.
 */
export async function GET(request: NextRequest) {
  await enforceRateLimit('publicRead')

  // Caddy sends the hostname it is being asked to serve as ?domain=
  const asked = normaliseHost(request.nextUrl.searchParams.get('domain'))
  if (!asked) return NextResponse.json({ allowed: false }, { status: 404 })

  /*
   * Our own hostnames always pass. The platform domain is served whatever the
   * database says, or a misconfigured tenant row could take the dashboard
   * offline — the one host that must never depend on tenant data.
   */
  const own = new Set(
    [process.env.NEXT_PUBLIC_APP_URL, process.env.PLATFORM_HOST]
      .map((value) => {
        if (!value) return null
        try {
          return normaliseHost(value.includes('://') ? new URL(value).host : value)
        } catch {
          return null
        }
      })
      .filter((value): value is string => Boolean(value)),
  )
  if (own.has(asked)) return NextResponse.json({ allowed: true })

  /*
   * A tenant hostname counts as ours the moment it is on a restaurant record —
   * verified or not, for the reason above. Suspended and deleted tenants are
   * excluded: a certificate we renew for ever for a restaurant that left is
   * work nobody asked for.
   */
  const restaurant = await prisma.restaurant.findFirst({
    where: { customDomain: asked, isActive: true },
    select: { id: true },
  })

  return restaurant
    ? NextResponse.json({ allowed: true })
    : NextResponse.json({ allowed: false }, { status: 404 })
}
