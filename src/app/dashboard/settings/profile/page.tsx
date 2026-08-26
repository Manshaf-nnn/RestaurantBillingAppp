import type { Metadata } from 'next'

import { ProfileView } from '@/features/settings/components/profile-view'
import { MyShifts } from '@/features/attendance/components/my-shifts'
import { listSessions } from '@/features/auth/actions'
import { requirePageUser } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'My profile' }

export default async function ProfilePage() {
  const user = await requirePageUser('/dashboard/settings/profile')
  const [record, sessions] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { name: true, email: true, phone: true },
    }),
    listSessions(),
  ])

  return (
    <>
      <ProfileView
        profile={record}
        sessions={sessions.map((session) => ({
          id: session.id,
          userAgent: session.userAgent,
          ipAddress: session.ipAddress,
          lastUsedAt: session.lastUsedAt.toISOString(),
          current: session.current,
        }))}
      />
      {/*
        Your own hours, on your own page. Identity, not permission — a cashier
        does not hold `staff.view` and should not, but their attendance is
        theirs to check.
      */}
      <div className="mt-5">
        <MyShifts userId={user.id} />
      </div>
    </>
  )
}
