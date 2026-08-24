import { NextResponse, type NextRequest } from 'next/server'

import { appUrl } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The old share-link entry point, kept only to forward.
 *
 * This route used to BE the login: it looked up the token, created a user
 * called "WAITER (shared link)" with no branch, and handed out a thirty-day
 * session on a GET. The URL was the credential, so anybody the message was
 * forwarded to was already inside, and the branchless account it made landed
 * on a screen that was empty for ever.
 *
 * All of that now lives at `/join/<token>`, which asks. A personal link takes
 * an email and code; a shared screen says out loud that it is one.
 *
 * The route survives because links get printed. A card taped to a kitchen wall
 * still points here, and forwarding it costs nothing and spares somebody a
 * dead URL. It grants nothing of its own — it only redirects, and `/join` does
 * every check.
 */
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get('token')
  if (!token) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 })
  }
  /*
   * `target` is deliberately dropped. It used to be an open-redirect waiting to
   * happen — the guard against `//evil.example` was added after the fact — and
   * where somebody lands is the link's business now, decided from its role
   * rather than from the query string.
   */
  return NextResponse.redirect(`${appUrl()}/join/${encodeURIComponent(token)}`)
}
