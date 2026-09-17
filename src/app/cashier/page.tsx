import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * The till lives inside the POS now (abc.md §8): `/cashier/pos?tab=cashier`.
 *
 * This URL is on bookmarks, in the app shortcut and in old links, so it keeps
 * working as a redirect — carrying the branch the till chose and the
 * takeaway mode the sidebar's link sends. Nothing is read here; the shell
 * does the guarding, the gating and the loading for whichever tab it shows.
 */
export default async function CashierRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && key !== 'tab') next.set(key, value)
  }
  next.set('tab', 'cashier')
  redirect(`/cashier/pos?${next.toString()}`)
}
