import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { ACTION_LABELS, FEATURES } from '@/features/access/features'
import {
  AccessEditor,
  type AccessFeature,
  type Override,
} from '@/features/staff/components/access-editor'
import {
  PERMISSIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  assignableRoles,
  can,
  permissionsFor,
  canActOnRole,
} from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { assertRecordBranch } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Effective access' }

/**
 * What one member of staff may actually do (staff.A.md §3, §8).
 *
 * ── Why this screen exists ──────────────────────────────────────────────────
 *
 * Three things decide somebody's access — the built-in preset, the restaurant's
 * own role, and any override set for them alone — and until now no screen
 * showed the result of combining them. An owner could read the role builder and
 * still not answer "so what can Nila do", which is the only question they were
 * ever asking.
 *
 * The three blocks are the spec's own words: role default permissions,
 * individual overrides, final effective access. The last is computed by calling
 * `permissionsFor`, the same function every guard in the application calls, so
 * what this page says and what the server will do cannot drift.
 *
 * ── Who may open it ─────────────────────────────────────────────────────────
 *
 * STAFF_MANAGE, plus the same four guards the edit actions use: the record's
 * own branch, the owner being untouchable, rank, and no editing yourself.
 * Somebody who fails the last three still sees the page read-only — knowing
 * what a colleague may do is a manager's ordinary business, and hiding it while
 * leaving the edit action guarded would be secrecy rather than security.
 */
export default async function StaffAccessPage({
  params,
}: {
  params: Promise<{ userId: string }>
}) {
  const { userId } = await params
  const admin = await requirePagePermission(PERMISSIONS.STAFF_MANAGE, '/dashboard/staff')

  const target = await prisma.user.findFirst({
    where: { id: userId, restaurantId: admin.restaurantId, deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      branchId: true,
      permissions: true,
      deniedPermissions: true,
      staffCode: true,
      branch: { select: { name: true } },
      branchAccess: { select: { branch: { select: { id: true, name: true } } } },
      staffRole: { select: { name: true, permissions: true, isActive: true } },
    },
  })
  if (!target) notFound()

  // A branch manager reads their own team and nobody else's — the same rule
  // the staff list itself applies.
  await assertRecordBranch(admin, target, 'staff member')

  /*
   * A switched-off role falls back to the preset, exactly as `permissionsFor`
   * does. Reading it any other way here would show an owner a list of
   * permissions the person does not actually have.
   */
  const savedRole = target.staffRole?.isActive ? target.staffRole : null
  const rolePermissions = savedRole?.permissions ?? null
  const base = new Set<string>(rolePermissions ?? ROLE_PERMISSIONS[target.role])

  const subject = {
    role: target.role,
    permissions: target.permissions,
    deniedPermissions: target.deniedPermissions,
    rolePermissions,
    availablePermissions: admin.availablePermissions,
  }
  const final = permissionsFor(subject)

  /*
   * An owner is not lockable, and the screen says so rather than offering
   * switches that `permissionsFor` short-circuits past.
   */
  const untouchable = target.role === 'OWNER' || target.role === 'SUPER_ADMIN'
  const canEdit =
    !untouchable && target.id !== admin.id && canActOnRole(admin.role, target.role)

  /*
   * Only what the platform operator has sold this restaurant. A switch for a
   * feature the tenant does not have would be a control that changes nothing —
   * `permissionsFor` intersects it away on every request.
   */
  const available =
    admin.availablePermissions.length > 0 ? new Set(admin.availablePermissions) : null

  const features: AccessFeature[] = FEATURES.map((feature) => ({
    key: feature.key,
    label: feature.label,
    group: feature.group,
    description: feature.description,
    actions: feature.actions
      .filter((action) => !available || available.has(action.permission))
      .map((action) => ({
        permission: action.permission,
        label: action.label ?? ACTION_LABELS[action.key],
        hint: action.hint,
        inherited: base.has(action.permission),
      })),
  })).filter((feature) => feature.actions.length > 0)

  const initial: Record<string, Override> = {}
  for (const key of target.permissions) initial[key] = 'allow'
  for (const key of target.deniedPermissions) initial[key] = 'deny'

  const roleSource = savedRole
    ? `the “${savedRole.name}” role`
    : `the built-in ${ROLE_LABELS[target.role]} role`

  const extraBranches = target.branchAccess.map((row) => row.branch)

  return (
    <>
      <PageHeader
        title={`${target.name}'s access`}
        description={`${ROLE_LABELS[target.role]}${target.staffCode ? ` · ${target.staffCode}` : ''} · ${target.email}`}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard/staff">
              <ArrowLeft /> Back to staff
            </Link>
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={target.isActive ? 'success' : 'secondary'}>
          {target.isActive ? 'Active' : 'Switched off'}
        </Badge>
        <span className="text-muted-foreground">Home location:</span>
        <Badge variant="secondary">{target.branch?.name ?? 'All locations'}</Badge>
        {extraBranches.length > 0 ? (
          <>
            <span className="text-muted-foreground">Also works at:</span>
            {extraBranches.map((branch) => (
              <Badge key={branch.id} variant="outline">{branch.name}</Badge>
            ))}
          </>
        ) : null}
      </div>

      {untouchable ? (
        <SectionCard
          title="This account cannot be restricted"
          description="An owner who could be denied a screen could be denied the screen that takes the denial back, and there is no way out of that without database access. The same applies to the platform operator."
        >
          <p className="text-sm text-muted-foreground">
            {target.name} holds every permission this restaurant has been given,{' '}
            {final.size} in total.
          </p>
        </SectionCard>
      ) : (
        <>
          {!canEdit ? (
            <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {target.id === admin.id
                ? 'This is your own account, so the switches are read-only — changing your own access is how somebody locks themselves out.'
                : `${target.name} outranks what you may edit, so this is read-only.`}
            </p>
          ) : null}
          <AccessEditor
            userId={target.id}
            userName={target.name}
            roleLabel={ROLE_LABELS[target.role]}
            roleSource={roleSource}
            features={features}
            initial={initial}
            canEdit={canEdit && can(admin, PERMISSIONS.STAFF_MANAGE)}
          />
        </>
      )}
    </>
  )
}
