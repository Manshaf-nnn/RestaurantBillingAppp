import type { Metadata } from 'next'

import { QrPoster } from '@/features/settings/components/qr-poster'
import { orderableBranches } from '@/features/branches/public-branch'
import { toQrDataUrl } from '@/features/payments/service'
import { appUrl } from '@/lib/env'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'QR codes' }

/**
 * The codes guests scan.
 *
 * There used to be exactly one, encoding `/order?r=<slug>`, and the guest typed
 * their table number on the landing screen. That was fine for a single
 * restaurant and wrong the moment there were two: scanning the code taped to a
 * table in Kandy showed the group's menu at the group's prices, and the order
 * it produced belonged to no branch at all.
 *
 * Now there is one code per branch, and one per table within it. A table code
 * fixes both facts at once — which branch, which table — so the order reaches
 * the right kitchen and the bill reaches the right table without anybody
 * typing anything.
 *
 * The branch is carried as its **code**, not its id: already unique per
 * restaurant, short enough to print, and it does not put a database identifier
 * on a laminated card that will be photographed.
 */
export default async function QrPage() {
  const user = await requirePagePermission(PERMISSIONS.SETTINGS_VIEW, '/dashboard/qr')
  const restaurant = await requireRestaurant(user.restaurantId)

  const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })
  const branches = (await orderableBranches(user.restaurantId)).filter(
    (branch) => allowed === null || allowed.includes(branch.id),
  )

  const base = `${appUrl()}/order?r=${restaurant.slug}`

  /*
   * Every code rendered server-side, because `toQrDataUrl` is a server helper
   * and a data URL crosses the RSC boundary as a plain string. A branch with
   * forty tables is forty small PNGs — fine to generate, and it means the print
   * sheet needs no client-side QR library at all.
   */
  const sheets = await Promise.all(
    branches.map(async (branch) => {
      const branchUrl = `${base}&b=${branch.code}`
      return {
        id: branch.id,
        name: branch.name,
        code: branch.code,
        isDefault: branch.isDefault,
        url: branchUrl,
        qr: await toQrDataUrl(branchUrl),
        tables: await Promise.all(
          branch.tables.map(async (table) => {
            const url = `${branchUrl}&t=${encodeURIComponent(table.number)}`
            return {
              id: table.id,
              number: table.number,
              label: table.label,
              url,
              qr: await toQrDataUrl(url),
            }
          }),
        ),
      }
    }),
  )

  /*
   * The branch-less code is offered only when there is nowhere else it could
   * mean.
   *
   * `/order?r=<slug>` carries no `b=`, so it resolves to the restaurant's
   * DEFAULT branch. For the single-site restaurant that most of these are, that
   * is exactly right and nothing changes. For a chain it is a code that files
   * every scan against Main however far from Main the table is — and once it is
   * printed there is nothing about it to say so. Each branch's own sheet below
   * is the answer, and it always was; this stops the ambiguous one being
   * printed alongside it.
   */
  const singleSite = sheets.length < 2

  return (
    <QrPoster
      restaurantName={restaurant.name}
      branches={sheets}
      orderUrl={singleSite ? base : null}
      qrDataUrl={singleSite ? await toQrDataUrl(base) : null}
    />
  )
}
