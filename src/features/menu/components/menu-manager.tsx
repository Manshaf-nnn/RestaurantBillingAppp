'use client'

import * as React from 'react'
import Image from 'next/image'
import { Copy, MoreVertical, Pencil, Plus, Search, Trash2, UtensilsCrossed } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SpiceLevelIndicator, VegIndicator } from '@/components/ui/status'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { deleteFood, duplicateFood, toggleFoodAvailability } from '../actions'
import { FoodDialog, type FoodFormData } from './food-dialog'
import { callAction } from '@/lib/use-action'

export interface ManagedFood {
  id: string
  name: string
  imageUrl: string | null
  price: number
  discountPrice: number | null
  isVeg: boolean
  spiceLevel: 'NONE' | 'MILD' | 'MEDIUM' | 'HOT' | 'EXTRA_HOT'
  isAvailable: boolean
  isPopular: boolean
  isRecommended: boolean
  prepTimeMinutes: number
  soldCount: number
  categoryId: string
  categoryName: string
  variantCount: number
  /** How many locations sell it — "1 of 5" tells an owner what is shared. */
  branchCount: number
  /** True when the location being viewed charges its own price. */
  hasPriceOverride: boolean
}

export interface BranchOption {
  id: string
  name: string
  type: string
}

export interface CategoryOption {
  id: string
  name: string
}

export function MenuManager({
  foods: initialFoods,
  categories,
  currency,
  locale,
  canManage,
  branches = [],
  activeBranchId = null,
  activeBranchName = null,
  branchCount = 1,
}: {
  foods: ManagedFood[]
  categories: CategoryOption[]
  currency: string
  locale: string
  canManage: boolean
  /** Locations this person may share a dish with. */
  branches?: BranchOption[]
  /** The location being viewed, from the top-bar switcher. */
  activeBranchId?: string | null
  activeBranchName?: string | null
  /** How many locations the restaurant has, for the "1 of N" label. */
  branchCount?: number
}) {
  const [foods, setFoods] = React.useState(initialFoods)
  const [search, setSearch] = React.useState('')
  const [category, setCategory] = React.useState('ALL')
  const [diet, setDiet] = React.useState('ALL')
  const [dialogFood, setDialogFood] = React.useState<FoodFormData | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  React.useEffect(() => setFoods(initialFoods), [initialFoods])

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    return foods.filter((food) => {
      if (category !== 'ALL' && food.categoryId !== category) return false
      if (diet === 'VEG' && !food.isVeg) return false
      if (diet === 'NON_VEG' && food.isVeg) return false
      return !query || food.name.toLowerCase().includes(query)
    })
  }, [foods, search, category, diet])

  const toggleAvailability = async (food: ManagedFood, next: boolean) => {
    setFoods((current) =>
      current.map((entry) => (entry.id === food.id ? { ...entry, isAvailable: next } : entry)),
    )
    const result = await callAction(() => toggleFoodAvailability({ id: food.id, isAvailable: next }))
    if (!result.ok) {
      setFoods((current) =>
        current.map((entry) => (entry.id === food.id ? { ...entry, isAvailable: !next } : entry)),
      )
      toast.error(result.error)
    }
  }

  const remove = async () => {
    if (!deleteId) return
    const id = deleteId
    setDeleteId(null)
    const result = await callAction(() => deleteFood(id))
    if (result.ok) {
      setFoods((current) => current.filter((food) => food.id !== id))
      toast.success('Menu item removed')
    } else {
      toast.error(result.error)
    }
  }

  const duplicate = async (id: string) => {
    const result = await callAction(() => duplicateFood(id))
    if (result.ok) toast.success('Duplicated — the copy starts unavailable')
    else toast.error(result.error)
  }

  const openCreate = () => {
    setDialogFood(null)
    setDialogOpen(true)
  }

  const openEdit = (food: ManagedFood) => {
    setDialogFood({ id: food.id } as FoodFormData)
    setDialogOpen(true)
  }

  return (
    <>
      <PageHeader
        title="Menu"
        description={
          activeBranchName
            ? `${foods.length} item${foods.length === 1 ? '' : 's'} on ${activeBranchName}'s menu, at ${activeBranchName}'s prices.`
            : branchCount > 1
              ? `${foods.length} items across ${categories.length} categories, every location. Pick one in the top bar to see and price its own menu.`
              : `${foods.length} items across ${categories.length} categories`
        }
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              <Plus /> Add item
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search items…"
          startIcon={<Search />}
          className="max-w-xs"
        />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All categories</SelectItem>
            {categories.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={diet} onValueChange={setDiet}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All diets</SelectItem>
            <SelectItem value="VEG">Veg only</SelectItem>
            <SelectItem value="NON_VEG">Non-veg</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<UtensilsCrossed />}
          title={foods.length === 0 ? 'No menu items yet' : 'Nothing matches'}
          description={
            foods.length === 0
              ? 'Add your first dish to start taking orders.'
              : 'Try a different search or filter.'
          }
          action={
            canManage && foods.length === 0 ? (
              <Button onClick={openCreate}>
                <Plus /> Add your first item
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((food) => (
            <article
              key={food.id}
              className={cn(
                'flex gap-3 rounded-xl border bg-card p-3 shadow-soft transition-shadow hover:shadow-elevated',
                !food.isAvailable && 'opacity-70',
              )}
            >
              <div className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-muted">
                {food.imageUrl ? (
                  <Image src={food.imageUrl} alt={food.name} fill sizes="80px" className="object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center text-2xl">🍽️</span>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      <VegIndicator isVeg={food.isVeg} />
                      <span className="truncate">{food.name}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{food.categoryName}</p>
                  </div>

                  {canManage ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="Actions">
                          <MoreVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(food)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => duplicate(food.id)}>
                          <Copy /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive onClick={() => setDeleteId(food.id)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>

                <div className="mt-1 flex items-center gap-2">
                  <span className="text-sm font-bold">
                    {formatMoney(food.discountPrice ?? food.price, currency, locale)}
                  </span>
                  {food.discountPrice ? (
                    <span className="text-xs text-muted-foreground line-through">
                      {formatMoney(food.price, currency, locale)}
                    </span>
                  ) : null}
                  {/*
                    Say when this price is not the base one, so nobody raises
                    the base and wonders why this location did not move.
                  */}
                  {food.hasPriceOverride ? (
                    <Badge variant="secondary" size="sm">
                      own price
                    </Badge>
                  ) : null}
                  <SpiceLevelIndicator level={food.spiceLevel} />
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {food.isPopular ? <Badge variant="warning" size="sm">Popular</Badge> : null}
                  {food.isRecommended ? <Badge variant="info" size="sm">Recommended</Badge> : null}
                  {food.variantCount > 0 ? (
                    <Badge variant="secondary" size="sm">
                      {food.variantCount} option{food.variantCount === 1 ? '' : 's'}
                    </Badge>
                  ) : null}
                  {/*
                    How far a dish is shared. Without this, an owner editing at
                    Main has no way to know they are about to change something
                    four other branches also sell.
                  */}
                  {branchCount > 1 ? (
                    <Badge
                      variant={food.branchCount === 0 ? 'destructive' : 'secondary'}
                      size="sm"
                    >
                      {food.branchCount === 0
                        ? 'no location'
                        : food.branchCount === branchCount
                          ? 'all locations'
                          : `${food.branchCount} of ${branchCount}`}
                    </Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">{food.soldCount} sold</span>
                </div>

                {canManage ? (
                  <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={food.isAvailable}
                      onCheckedChange={(next) => toggleAvailability(food, next)}
                    />
                    {food.isAvailable ? 'Available' : 'Unavailable'}
                  </label>
                ) : (
                  <Badge variant={food.isAvailable ? 'success' : 'secondary'} size="sm" className="mt-2">
                    {food.isAvailable ? 'Available' : 'Unavailable'}
                  </Badge>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {canManage ? (
        <FoodDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          foodId={dialogFood?.id}
          categories={categories}
          currency={currency}
          branches={branches}
          activeBranchId={activeBranchId}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete this menu item?"
        description="It will be removed from the menu. Past orders that included it are not affected."
        confirmLabel="Delete"
        destructive
        onConfirm={remove}
      />
    </>
  )
}
