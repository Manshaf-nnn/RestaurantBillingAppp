import type { Metadata } from 'next'
import { MapPin, ShieldCheck } from 'lucide-react'

import { JoinForm } from '@/features/access/components/join-form'
import { resolveLink } from '@/features/access/links'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Sign in' }

/**
 * Where an access link lands.
 *
 * ── Why this is a page and not a redirect ───────────────────────────────────
 *
 * It used to be `GET /api/invite/accept?token=…`, which signed the visitor in
 * and bounced them onward in one hop. That is the right shape for exactly one
 * case — a screen on a wall — and the wrong one for a person, because it makes
 * the URL itself the credential: anybody the message is forwarded to is
 * already inside.
 *
 * A page can ask. A personal link shows whose it is, which location it leads
 * to, and takes an email and a code, so the link alone is worth nothing.
 *
 * ── One refusal for every failure ───────────────────────────────────────────
 *
 * Expired, revoked, never existed, or belongs to a suspended restaurant — all
 * the same screen. Distinguishing them tells somebody working through guessed
 * tokens which guess was closest, and tells the person who was legitimately
 * sent it nothing they can act on.
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const link = await resolveLink(token).catch(() => null)

  if (!link) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <ShieldCheck className="size-7" />
          </span>
          <h1 className="text-xl font-semibold">This link is not valid any more</h1>
          <p className="text-sm text-muted-foreground">
            It may have expired or been withdrawn. Ask whoever sent it for a new one.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-5 py-12">
      <header className="text-center">
        <h1 className="text-2xl font-semibold">{link.restaurantName}</h1>
        <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="size-4" />
            {link.staffRoleName ?? link.roleLabel}
          </span>
          {link.branchName ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-4" />
                {link.branchName}
              </span>
            </>
          ) : null}
        </p>
      </header>

      <JoinForm
        token={link.token}
        mode={link.mode}
        /*
         * Prefilled, not trusted. The action re-reads the link and checks the
         * email against the account it points at, so this is a convenience for
         * somebody standing at a till and nothing more.
         */
        email={link.userEmail}
      />
    </main>
  )
}
