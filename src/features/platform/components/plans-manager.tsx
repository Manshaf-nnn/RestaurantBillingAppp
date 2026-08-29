'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, Package, Pencil, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/primitives'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import {
  deletePackageAction,
  savePackageAction,
  setRestaurantFeaturesAction,
} from '../feature-actions'

interface FeatureRow {
  key: string
  label: string
  group: string
  description: string
}

interface PackageRow {
  id: string
  name: string
  description: string | null
  featureKeys: string[]
  restaurantCount: number
}

interface RestaurantRow {
  id: string
  name: string
  slug: string
  status: string
  enabledFeatures: string[]
  packageId: string | null
}

/**
 * Selling features.
 *
 * ── Two things share one grid ───────────────────────────────────────────────
 *
 * A package and a restaurant's own list are the same shape — a set of feature
 * keys — so they use the same picker. The only difference is what the Save
 * button writes to.
 *
 * ── An empty list is "everything" ───────────────────────────────────────────
 *
 * Not "nothing". Selling a restaurant zero features is meaningless, while "we
 * have not scoped this one" is the ordinary case and is what every existing
 * customer is in. The screen says so out loud, because a row reading "no
 * features" would otherwise look alarming.
 */
export function PlansManager({
  groups,
  features,
  packages,
  restaurants,
}: {
  groups: string[]
  features: FeatureRow[]
  packages: PackageRow[]
  restaurants: RestaurantRow[]
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  // ── package editor ────────────────────────────────────────────────────────
  const [editingPackage, setEditingPackage] = React.useState<string | null>(null)
  const [packageOpen, setPackageOpen] = React.useState(false)
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [keys, setKeys] = React.useState<string[]>([])

  // ── per-restaurant editor ─────────────────────────────────────────────────
  const [editingRestaurant, setEditingRestaurant] = React.useState<RestaurantRow | null>(null)
  const [restaurantKeys, setRestaurantKeys] = React.useState<string[]>([])

  const resetPackage = () => {
    setEditingPackage(null)
    setPackageOpen(false)
    setName('')
    setDescription('')
    setKeys([])
  }

  const loadPackage = (pkg: PackageRow) => {
    setEditingPackage(pkg.id)
    setName(pkg.name)
    setDescription(pkg.description ?? '')
    setKeys(pkg.featureKeys)
    setPackageOpen(true)
  }

  const savePackage = async () => {
    if (name.trim().length < 2) {
      toast.error('Name the package')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      savePackageAction({
        packageId: editingPackage ?? undefined,
        name,
        description,
        featureKeys: keys,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(editingPackage ? 'Package updated' : 'Package created')
    resetPackage()
    router.refresh()
  }

  const removePackage = async (pkg: PackageRow) => {
    setBusy(true)
    const result = await callAction(() => deletePackageAction({ packageId: pkg.id }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Package removed — restaurants on it keep what they had')
    router.refresh()
  }

  const saveRestaurant = async (packageId?: string | null) => {
    if (!editingRestaurant) return
    setBusy(true)
    const result = await callAction(() =>
      setRestaurantFeaturesAction({
        restaurantId: editingRestaurant.id,
        featureKeys: restaurantKeys,
        packageId: packageId ?? null,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      restaurantKeys.length === 0
        ? 'Everything switched on'
        : `${restaurantKeys.length} features on — nothing was deleted`,
    )
    setEditingRestaurant(null)
    router.refresh()
  }

  const Grid = ({
    selected,
    onToggle,
  }: {
    selected: string[]
    onToggle: (key: string) => void
  }) => (
    <div className="space-y-4">
      {groups.map((group) => {
        const inGroup = features.filter((feature) => feature.group === group)
        if (inGroup.length === 0) return null
        return (
          <div key={group}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group}
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {inGroup.map((feature) => (
                <label
                  key={feature.key}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-2.5 text-sm"
                  title={feature.description}
                >
                  <Checkbox
                    checked={selected.includes(feature.key)}
                    onCheckedChange={() => onToggle(feature.key)}
                  />
                  <span className="min-w-0">{feature.label}</span>
                </label>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )

  const toggle = (list: string[], key: string) =>
    list.includes(key) ? list.filter((entry) => entry !== key) : [...list, key]

  const allKeys = features.map((feature) => feature.key)

  return (
    <div className="space-y-5">
      <SectionCard
        title="Packages"
        description="Reusable bundles you can apply to a restaurant when you approve it, or later. Editing one does not change any restaurant already on it — the list is copied across when it is applied."
        actions={
          !packageOpen ? (
            <Button size="sm" onClick={() => setPackageOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              New package
            </Button>
          ) : null
        }
      >
        {packages.length === 0 && !packageOpen ? (
          <div className="py-8 text-center">
            <Package className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">No packages yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Every restaurant currently has everything switched on. Build a Basic or Standard
              bundle here, then apply it when approving.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {packages.map((pkg) => (
              <li key={pkg.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <span className="font-medium">{pkg.name}</span>
                <span className="text-sm text-muted-foreground">
                  {pkg.featureKeys.length} of {allKeys.length} features · {pkg.restaurantCount}{' '}
                  restaurant{pkg.restaurantCount === 1 ? '' : 's'}
                </span>
                {pkg.description ? (
                  <span className="w-full text-xs text-muted-foreground">{pkg.description}</span>
                ) : null}
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => loadPackage(pkg)}>
                    <Pencil className="mr-1.5 size-4" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => removePackage(pkg)}
                    aria-label={`Remove ${pkg.name}`}
                  >
                    <Trash2 className="size-4 text-muted-foreground" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {packageOpen ? (
        <SectionCard title={editingPackage ? 'Edit package' : 'New package'}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pkg-name">Name</Label>
              <Input
                id="pkg-name"
                placeholder="e.g. Basic"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pkg-desc">Description</Label>
              <Input
                id="pkg-desc"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setKeys(allKeys)}>
              Select all
            </Button>
            <Button size="sm" variant="outline" onClick={() => setKeys([])}>
              Clear
            </Button>
            <span className="self-center text-sm text-muted-foreground">
              {keys.length} selected
            </span>
          </div>

          <div className="mt-4">
            <Grid selected={keys} onToggle={(key) => setKeys((current) => toggle(current, key))} />
          </div>

          <div className="mt-4 flex gap-2">
            <Button onClick={savePackage} disabled={busy}>
              {editingPackage ? 'Save changes' : 'Create package'}
            </Button>
            <Button variant="ghost" onClick={resetPackage} disabled={busy}>
              <X className="mr-1.5 size-4" />
              Cancel
            </Button>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Restaurants"
        description="What each one can reach. Switching a feature off hides it and refuses it, and deletes nothing — turn it back on and everything is exactly where they left it."
      >
        <ul className="divide-y divide-border">
          {restaurants.map((restaurant) => {
            const unrestricted = restaurant.enabledFeatures.length === 0
            const pkg = packages.find((entry) => entry.id === restaurant.packageId)
            return (
              <li key={restaurant.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <span className="font-medium">{restaurant.name}</span>
                <span className="text-xs text-muted-foreground">/{restaurant.slug}</span>
                {unrestricted ? (
                  <Badge variant="secondary">Everything</Badge>
                ) : (
                  <Badge variant="info">
                    {restaurant.enabledFeatures.length} of {allKeys.length}
                  </Badge>
                )}
                {pkg ? <span className="text-sm text-muted-foreground">{pkg.name}</span> : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => {
                    setEditingRestaurant(restaurant)
                    setRestaurantKeys(restaurant.enabledFeatures)
                  }}
                >
                  <Pencil className="mr-1.5 size-4" />
                  Edit features
                </Button>
              </li>
            )
          })}
        </ul>
      </SectionCard>

      {editingRestaurant ? (
        <SectionCard
          title={`${editingRestaurant.name} — features`}
          description="Leave everything unticked to give them the whole system. Their data is untouched either way."
        >
          {packages.length > 0 ? (
            <div className="mb-4 flex flex-wrap gap-2">
              <span className="self-center text-sm text-muted-foreground">Apply a package:</span>
              {packages.map((pkg) => (
                <Button
                  key={pkg.id}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setRestaurantKeys(pkg.featureKeys)}
                >
                  {pkg.name}
                </Button>
              ))}
            </div>
          ) : null}

          <div className="mb-4 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setRestaurantKeys([])}>
              Everything
            </Button>
            <span className="self-center text-sm text-muted-foreground">
              {restaurantKeys.length === 0
                ? 'Unrestricted — every feature'
                : `${restaurantKeys.length} of ${allKeys.length} features`}
            </span>
          </div>

          <Grid
            selected={restaurantKeys.length === 0 ? allKeys : restaurantKeys}
            onToggle={(key) =>
              setRestaurantKeys((current) =>
                // Ticking anything while "everything" is on starts an explicit
                // list from the full set, so one untick does not silently
                // become "only this one".
                current.length === 0 ? allKeys.filter((entry) => entry !== key) : toggle(current, key),
              )
            }
          />

          <div className="mt-4 flex gap-2">
            <Button
              onClick={() => saveRestaurant(editingRestaurant.packageId)}
              disabled={busy}
            >
              <Check className="mr-1.5 size-4" />
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditingRestaurant(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </SectionCard>
      ) : null}
    </div>
  )
}
