import { NextResponse } from 'next/server'

import { resolvePublicTenant } from '@/server/db/tenant'
import { enforceRateLimit } from '@/server/security/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Which restaurant does this hostname resolve to?
 *
 * ── Why verification is one HTTP call ───────────────────────────────────────
 *
 * Setting a custom domain involves four things being true at once: the DNS
 * record exists, it points here, Netlify knows the domain and has issued a
 * certificate, and our own resolver matches it to the right restaurant. Any of
 * them can be wrong, and checking them separately means four ways to get a
 * confusing half-answer.
 *
 * Asking the domain itself checks all four in one go. If
 * `https://nilaza.lk/api/public/whoami` comes back naming Nilaza, then DNS
 * resolves, TLS terminates, the request reached this deployment, and
 * `resolvePublicTenant` agreed. Nothing is left to assume.
 *
 * ── What it discloses ───────────────────────────────────────────────────────
 *
 * The name and slug of the restaurant a *public* menu URL on this host would
 * already show a guest — the same two facts on every QR code. It is rate
 * limited on the public-read bucket like the other guest endpoints, and returns
 * nothing at all when the host resolves to nobody.
 */
export async function GET() {
  await enforceRateLimit('publicRead')

  const restaurant = await resolvePublicTenant()
  if (!restaurant) {
    return NextResponse.json({ resolved: false }, { status: 404 })
  }

  return NextResponse.json({
    resolved: true,
    id: restaurant.id,
    slug: restaurant.slug,
    name: restaurant.name,
  })
}
