import type { Metadata } from 'next'
import type { UserRole } from '@prisma/client'

import { Badge } from '@/components/ui/badge'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { ensureStaffCodes } from '@/features/staff/codes'
import { landingFor, PERMISSIONS, ROLE_LABELS, visibleBranchIds, canActOnRole } from '@/lib/rbac'
import { printableOrigin } from '@/lib/tenant-url'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { CopyLink } from '@/features/staff/components/copy-link'
import { StaffCodeCell } from '@/features/staff/components/staff-code-cell'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Staff codes' }

/**
 * Each member of staff, their code, and their personal sign-in link.
 *
 * ── The sign-in code IS the password ────────────────────────────────────────
 *
 * `issueSignInCode` writes the same value into `signInCode` and, hashed, into
 * `passwordHash`; the ordinary login verifies against that hash. So this
 * page prints credentials, and it used to print every one in the restaurant
 * to anybody holding STAFF_VIEW, with no branch filter. A branch manager
 * could read the admin's code and sign in as the admin.
 *
 * Three rules now, each borrowed from a sibling: the list is narrowed by
 * `visibleBranchIds` exactly as `/dashboard/staff` is; a code is shown only
 * for a role the viewer could reset (`assignableRoles`, the same rank check
 * `credentialTarget` applies to "New code"); and the page asks for
 * STAFF_MANAGE, because reading a credential is the same power as issuing it.
 */
export default async function StaffCodesPage() {
  const user = await requirePagePermission(PERMISSIONS.STAFF_MANAGE, '/dashboard/staff/codes')

  // Anyone hired before codes existed gets one on first view.
  await ensureStaffCodes(user.restaurantId)

  const reach = visibleBranchIds(user)
  // A row that still says CASHIER is a person at a till, not a role to
  // withhold — see `canActOnRole` (staff.A.md §10).
  const canReveal = (role: UserRole) => canActOnRole(user.role, role)

  const staff = await prisma.user.findMany({
    where: {
      restaurantId: user.restaurantId,
      deletedAt: null,
      isActive: true,
      ...(reach ? { branchId: { in: reach } } : {}),
    },
    select: {
      id: true, name: true, email: true, role: true, staffCode: true, signInCode: true,
      // The custom role's name, so a printed card is not labelled with a role
      // the person no longer effectively has.
      staffRole: { select: { name: true, isActive: true } },
      _count: { select: { servedOrders: true } },
    },
    orderBy: [{ role: 'asc' }, { staffCode: 'asc' }],
  })

  /*
   * The link's host is where the owner is standing — the restaurant's own
   * domain when they are on it, the platform's otherwise — not the configured
   * app URL. That value is fixed into the build, and a build made without it
   * printed `http://localhost:3000/login?…` on every card: a link that opened
   * nothing, so the email it carried never reached the sign-in box.
   */
  const restaurant = await requireRestaurant(user.restaurantId)
  const base = await printableOrigin(restaurant)

  return (
    <>
      <PageHeader
        title="Staff codes"
        description="Every person has a short code and their own sign-in link. Orders they take are credited to that code."
      />

      <SectionCard
        title="Team"
        description="Hand each person their card: the email they sign in with and their sign-in code. The W- code is only their ID on dockets and reports."
      >
        <div className="-mx-2 overflow-x-auto px-2">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">ID</th>
                <th className="pb-2 pr-3 font-medium">Name &amp; sign-in email</th>
                <th className="pb-2 pr-3 font-medium">Sign-in code</th>
                <th className="pb-2 pr-3 font-medium">Role</th>
                <th className="pb-2 pr-3 text-right font-medium">Served</th>
                <th className="pb-2 font-medium">Their link</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {staff.map((s) => {
                /*
                 * The shared table, not a fourth copy. This was a ternary chain
                 * that knew about three roles and sent the other eight to
                 * /dashboard — wrong for every back-office role, which each have
                 * their own landing screen.
                 */
                const home = landingFor(s.role)
                /*
                 * The link carries their own email, not their staff code. It used
                 * to carry the code and look the email up through a public
                 * endpoint — and since codes run W-0001 upward, anyone could walk
                 * them and harvest every email in the restaurant.
                 */
                /*
                 * `switch=1`: always show the sign-in form, even in a browser
                 * where somebody is already signed in. Without it the edge
                 * sends a signed-in visitor straight to the dashboard, so an
                 * owner checking a card's link on their own machine — or a
                 * cashier opening it on the shared till — never saw the form
                 * with the email filled in.
                 */
                const link = `${base}/login?email=${encodeURIComponent(s.email)}&name=${encodeURIComponent(s.name.split(' ')[0])}&next=${encodeURIComponent(home)}&switch=1`
                return (
                  <tr key={s.id}>
                    <td className="py-2.5 pr-3">
                      <Badge variant="secondary">{s.staffCode ?? '—'}</Badge>
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="font-medium">{s.name}</span>
                      <span className="block text-xs text-muted-foreground">{s.email}</span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <StaffCodeCell userId={s.id} code={canReveal(s.role) ? s.signInCode : null} />
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground">
                      {s.staffRole?.isActive ? (
                        <>
                          <span className="text-foreground">{s.staffRole.name}</span>
                          <span className="block text-xs">based on {ROLE_LABELS[s.role]}</span>
                        </>
                      ) : (
                        ROLE_LABELS[s.role]
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{s._count.servedOrders}</td>
                    <td className="py-2.5">
                      <CopyLink url={link} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="How this works">
        <ul className="list-inside list-disc space-y-1.5 text-sm text-muted-foreground">
          <li>Send each person their link — or print it as a QR code beside the till.</li>
          <li>It opens the sign-in page with their email already filled in; they type their sign-in code.</li>
          <li>
            The sign-in code <em>is</em> their password. Lost the card? Press
            <strong> New code</strong> — the old one stops working straight away.
          </li>
          <li>Every order they take is credited to them, and shows under <strong>Reports → Sales → By employee</strong>.</li>
          <li>
            A cashier ringing up someone else&apos;s table can change &quot;Served by&quot; on the order
            screen, so the right person still gets the credit.
          </li>
        </ul>
      </SectionCard>
    </>
  )
}
