import type { Metadata } from 'next'

import { Badge } from '@/components/ui/badge'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { ensureStaffCodes } from '@/features/staff/codes'
import { appUrl } from '@/lib/env'
import { landingFor, PERMISSIONS, ROLE_LABELS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { CopyLink } from '@/features/staff/components/copy-link'
import { StaffCodeCell } from '@/features/staff/components/staff-code-cell'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Staff codes' }

/**
 * Each member of staff, their code, and their personal sign-in link.
 *
 * The link carries the code so the sign-in page can name who it is expecting.
 * It is a convenience, not a credential — the code identifies, the password
 * authenticates. Anyone opening someone else's link still has to know that
 * person's password, which is why the code can safely be printed on a docket
 * or stuck to the side of a till.
 */
export default async function StaffCodesPage() {
  const user = await requirePagePermission(PERMISSIONS.STAFF_VIEW, '/dashboard/staff/codes')

  // Anyone hired before codes existed gets one on first view.
  await ensureStaffCodes(user.restaurantId)

  const staff = await prisma.user.findMany({
    where: { restaurantId: user.restaurantId, deletedAt: null, isActive: true },
    select: {
      id: true, name: true, email: true, role: true, staffCode: true, signInCode: true,
      // The custom role's name, so a printed card is not labelled with a role
      // the person no longer effectively has.
      staffRole: { select: { name: true, isActive: true } },
      _count: { select: { servedOrders: true } },
    },
    orderBy: [{ role: 'asc' }, { staffCode: 'asc' }],
  })

  const base = appUrl()

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
                const link = `${base}/login?email=${encodeURIComponent(s.email)}&name=${encodeURIComponent(s.name.split(' ')[0])}&next=${encodeURIComponent(home)}`
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
                      <StaffCodeCell userId={s.id} code={s.signInCode} />
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
