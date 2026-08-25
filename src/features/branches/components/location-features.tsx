'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { FeatureLevelGrid } from '@/features/access/components/feature-levels'
import { callAction } from '@/lib/use-action'
import { setLocationFeaturesAction } from '../actions'

/**
 * What this location's manager can do.
 *
 * ── Why it lives on the location and not only under Roles & access ──────────
 *
 * Setting up a new site and deciding what its manager may touch is one thought,
 * and it was two screens: create the location, then go to Roles & access, build
 * a role, remember to pin it to the branch you just made, then go to Staff and
 * assign it. Three chances to stop half way, and the commonest outcome was a
 * manager left on the built-in defaults nobody chose.
 *
 * What it writes is an ordinary role, pinned to this branch. Opening it under
 * Roles & access afterwards shows the same thing, action by action.
 */
export function LocationFeatures({
  branchId,
  branchName,
  managerName,
  initialPermissions,
  grantable,
  roleName,
}: {
  branchId: string
  branchName: string
  /** Null when nobody manages this location yet — the grid still saves. */
  managerName: string | null
  initialPermissions: string[]
  /** What the person filling this in holds themselves. */
  grantable: string[]
  /** The existing role's name, when there is one. */
  roleName: string | null
}) {
  const router = useRouter()
  const [granted, setGranted] = React.useState(() => new Set(initialPermissions))
  const [saving, setSaving] = React.useState(false)
  const grantableSet = React.useMemo(() => new Set(grantable), [grantable])

  const dirty =
    granted.size !== initialPermissions.length ||
    initialPermissions.some((p) => !granted.has(p))

  const save = async () => {
    setSaving(true)
    const result = await callAction(() =>
      setLocationFeaturesAction({ branchId, permissions: [...granted] }),
    )
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      result.data.assigned
        ? `Saved. ${managerName ?? 'The manager'} has these from their next click.`
        : 'Saved. It applies to whoever manages this location.',
    )
    router.refresh()
  }

  return (
    <SectionCard
      title="What the manager can do"
      description={
        managerName
          ? `${managerName} manages ${branchName}. These are the features they get.`
          : `Nobody manages ${branchName} yet — set this now and it applies to whoever does.`
      }
      actions={
        dirty ? (
          <Button size="sm" onClick={save} loading={saving}>
            Save
          </Button>
        ) : null
      }
    >
      <FeatureLevelGrid
        granted={granted}
        grantable={grantableSet}
        onChange={setGranted}
        disabled={saving}
      />

      <p className="mt-4 text-xs text-muted-foreground">
        {roleName ? (
          <>
            Saved as the role <strong>{roleName}</strong>, pinned to this location. Open it under{' '}
            <Link href="/dashboard/roles" className="underline underline-offset-2">
              Roles &amp; access
            </Link>{' '}
            to set individual actions.
          </>
        ) : (
          <>
            Saving creates a role for this location. You can refine it action by action under{' '}
            <Link href="/dashboard/roles" className="underline underline-offset-2">
              Roles &amp; access
            </Link>
            .
          </>
        )}
      </p>
    </SectionCard>
  )
}
