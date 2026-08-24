import type { Metadata } from 'next'

import { LinksManager } from '@/features/access/components/links-manager'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Share links' }

/**
 * Access links, with a guard on the page itself.
 *
 * This was a bare `'use client'` component with no server guard of any kind.
 * The sidebar hid it behind `staff.manage`, so it looked protected — but the
 * sidebar is decoration, and anybody who typed the URL got the screen that
 * mints staff sign-in links. Its API checked the permission, which meant the
 * page rendered, listed nothing, and handed a 403 on the first click: hidden
 * enough to look deliberate, open enough to be a hole.
 *
 * The interactive part moved to `LinksManager` unchanged. It is rebuilt in
 * phase 3 — branch, staff, mode and the owner controls — and this file is what
 * makes it refusable in the meantime.
 */
export default async function ShareLinksPage() {
  await requirePagePermission(PERMISSIONS.STAFF_MANAGE, '/dashboard/links')
  return <LinksManager />
}
