'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle2, ChefHat, Play, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney, parseMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import {
  completeProductionAction, createProductionOrderAction,
  previewProductionAction, setProductionStatusAction,
} from '../actions'
import type { ProductionPreview } from '../queries'

const REASONS = [
  { value: 'PRODUCTION_LOSS', label: 'Some was lost making it' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'INGREDIENT_SHORTAGE', label: 'Ran short of an ingredient' },
  { value: 'QUALITY_ISSUE', label: 'Not good enough to use' },
  { value: 'OTHER', label: 'Something else' },
] as const

export interface MakeAheadRecipeView {
  id: string
  name: string
  isActive: boolean
  producesItemId: string
  outputName: string
  outputUnit: string
  /** How much one run of the recipe makes. New recipes are created at 1. */
  yieldQty: number
  shelfLifeDays: number | null
  notes: string | null
  items: Array<{ itemId: string; name: string; quantity: number; unit: string }>
}

export interface PendingJob {
  id: string
  number: string
  status: string
  recipeId: string | null
  branchId: string
  startedAt: string | null
  recipeName: string | null
  plannedQty: number
  outputName: string | null
  outputUnit: string | null
}

export interface ProductionConsoleData {
  houses: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string; unit: string; quantity: number }>
  recipes: MakeAheadRecipeView[]
  pending: PendingJob[]
  currency: string
}

/**
 * Kitchen jobs — making something ahead so it is on the shelf when you need it.
 *
 * ── The flow, in the words the spec uses ────────────────────────────────────
 *
 *   New Production → Planned Quantity → what it needs vs what is here
 *     → Create Production Job → the kitchen makes it
 *     → Actual Quantity Produced → Complete Production → stock updates
 *
 * Three buckets, and nothing else: **Ready to Make**, **In Progress**,
 * **Completed**. Approval used to sit between the first two and it has gone —
 * it moved no stock, it was not the maker-checker mechanism, and its permission
 * guarded the one step that changed nothing while completion, which changes
 * everything, needed a weaker one.
 *
 * ── What touches stock ──────────────────────────────────────────────────────
 *
 * Only Complete Production. Creating a job and starting it change no balance,
 * and the screen says so at each step rather than leaving somebody to find out.
 * Recipes live on their own screen now; this one is about today's work.
 */
export function ProductionConsole({ data }: { data: ProductionConsoleData }) {
  const router = useRouter()
  const money = (minor: number) => formatMoney(minor, data.currency)
  const [busy, setBusy] = React.useState(false)

  // ── New Production ────────────────────────────────────────────────────────
  const [houseId, setHouseId] = React.useState(data.houses[0]?.id ?? '')
  const [jobRecipeId, setJobRecipeId] = React.useState('')
  const [plannedQty, setPlannedQty] = React.useState('')
  const [preview, setPreview] = React.useState<ProductionPreview | null>(null)
  const [previewing, setPreviewing] = React.useState(false)

  const chosenRecipe = data.recipes.find((recipe) => recipe.id === jobRecipeId) ?? null
  const plannedNumber = Number(plannedQty)

  /*
   * "Show required ingredients + available stock", live.
   *
   * Debounced because it runs as the quantity is typed and each call resolves
   * the recipe and reads the branch's shelves. 350ms is long enough that typing
   * "100" is one request rather than three, and short enough that the table has
   * caught up by the time somebody reaches for the button.
   */
  React.useEffect(() => {
    if (!houseId || !jobRecipeId || !(plannedNumber > 0)) {
      setPreview(null)
      return
    }
    let cancelled = false
    setPreviewing(true)
    const timer = setTimeout(async () => {
      const result = await callAction(() =>
        previewProductionAction({ branchId: houseId, recipeId: jobRecipeId, plannedQty: plannedNumber }),
      )
      if (cancelled) return
      setPreviewing(false)
      setPreview(result.ok ? result.data : null)
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [houseId, jobRecipeId, plannedNumber])

  const createJob = async () => {
    setBusy(true)
    const result = await callAction(() =>
      createProductionOrderAction({ branchId: houseId, recipeId: jobRecipeId, plannedQty: plannedNumber }),
    )
    setBusy(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(`${result.data.number} created — nothing taken from stock yet`)
    setJobRecipeId(''); setPlannedQty(''); setPreview(null)
    router.refresh()
  }

  const move = async (orderId: string, status: 'IN_PROGRESS' | 'CANCELLED') => {
    setBusy(true)
    const result = await callAction(() => setProductionStatusAction({ orderId, status }))
    setBusy(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(status === 'CANCELLED' ? 'Job cancelled' : 'Started')
    router.refresh()
  }

  // ── Complete Production ───────────────────────────────────────────────────
  /*
   * The job being completed, with the recipe's requirement loaded so each
   * ingredient can be pre-filled. Held as one object rather than a map keyed by
   * job id: only one job is being finished at a time, and a map made it
   * possible to type into one job's boxes while looking at another's.
   */
  const [finishing, setFinishing] = React.useState<{
    job: PendingJob
    lines: ProductionPreview['ingredients']
    used: Record<string, string>
    made: string
    reason: string
    overhead: string
  } | null>(null)

  const openFinish = async (job: PendingJob) => {
    if (!job.recipeId) { toast.error('This job has no recipe'); return }
    setBusy(true)
    const result = await callAction(() =>
      previewProductionAction({
        branchId: job.branchId, recipeId: job.recipeId!, plannedQty: job.plannedQty,
      }),
    )
    setBusy(false)
    if (!result.ok || !result.data) {
      toast.error(result.ok ? 'Could not work out this recipe' : result.error)
      return
    }
    setFinishing({
      job,
      lines: result.data.ingredients,
      // Pre-filled with what the recipe asked for, so a run that went to plan
      // is one tap and a run that did not is one correction.
      used: Object.fromEntries(result.data.ingredients.map((line) => [line.itemId, String(line.required)])),
      made: String(job.plannedQty),
      reason: '',
      overhead: '',
    })
  }

  const finish = async () => {
    if (!finishing) return
    const { job } = finishing
    const actual = Number(finishing.made)
    /*
     * Zero is refused rather than treated as "all of it". A blank box gives
     * `Number('')` === 0, which passes every finite/negative check — and used to
     * consume every ingredient, produce nothing, and record a cost of zero
     * without a word.
     */
    if (!Number.isFinite(actual) || actual <= 0) {
      toast.error('Enter how many came out. If none did, cancel the job instead.')
      return
    }
    if (actual < job.plannedQty && !finishing.reason) {
      toast.error('Fewer came out than planned — say why')
      return
    }

    const consumed = finishing.lines.map((line) => ({
      itemId: line.itemId,
      quantity: Number(finishing.used[line.itemId] ?? line.required),
    }))
    if (consumed.some((line) => !Number.isFinite(line.quantity) || line.quantity < 0)) {
      toast.error('Check the ingredient amounts')
      return
    }

    /*
     * Overheads are typed in whole currency and stored in minor units, through
     * the same helper every other money field uses. This multiplied by 100 by
     * hand, which is 100× too much in yen, won and dong.
     */
    const typed = finishing.overhead
    const overheadMinor =
      typed && Number.isFinite(Number(typed)) && Number(typed) >= 0
        ? parseMoney(typed, data.currency)
        : undefined

    setBusy(true)
    const result = await callAction(() =>
      completeProductionAction({
        orderId: job.id,
        actualQty: actual,
        consumed,
        overheadCost: overheadMinor,
        varianceReason: actual < job.plannedQty ? finishing.reason : undefined,
      }),
    )
    setBusy(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(`${result.data.produced} made, at ${money(result.data.unitCost)} each`)
    setFinishing(null)
    router.refresh()
  }

  if (data.houses.length === 0) {
    return (
      <SectionCard title="No production kitchen yet">
        <p className="py-6 text-center text-sm text-muted-foreground">
          Add a location of type <strong>Production house</strong> first, then kitchen jobs appear here.
        </p>
      </SectionCard>
    )
  }

  const activeRecipes = data.recipes.filter((recipe) => recipe.isActive)
  // DRAFT and the legacy APPROVED both mean "nobody has started it yet".
  const readyToMake = data.pending.filter((job) => job.status !== 'IN_PROGRESS')
  const inProgress = data.pending.filter((job) => job.status === 'IN_PROGRESS')

  const jobRow = (job: PendingJob, started: boolean) => (
    <li key={job.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
      <Link href={`/dashboard/production/${job.id}`} className="font-medium hover:underline">
        {job.number}
      </Link>
      <span className="text-muted-foreground">
        {job.plannedQty} {(job.outputUnit ?? '').toLowerCase()} of {job.outputName ?? job.recipeName}
      </span>
      {started ? <Badge variant="secondary">In progress</Badge> : null}
      <div className="ml-auto flex gap-1">
        {!started ? (
          <Button size="sm" variant="ghost" onClick={() => move(job.id, 'IN_PROGRESS')} disabled={busy}>
            <Play className="mr-1.5 h-4 w-4" />
            Start
          </Button>
        ) : null}
        <Button size="sm" onClick={() => openFinish(job)} disabled={busy}>
          <CheckCircle2 className="mr-1.5 h-4 w-4" />
          Complete Production
        </Button>
        <Button size="sm" variant="ghost" onClick={() => move(job.id, 'CANCELLED')} disabled={busy}>
          <X className="mr-1.5 h-4 w-4" />
          Cancel
        </Button>
      </div>
    </li>
  )

  return (
    <div className="space-y-6">
      {/* ── Complete Production ───────────────────────────────────────────── */}
      {finishing ? (
        <SectionCard
          title={`Complete Production — ${finishing.job.number}`}
          description="Check what actually went in, say how much came out, and the stock moves."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 font-medium">Ingredient</th>
                  <th className="py-2 font-medium">Recipe says</th>
                  <th className="py-2 font-medium">Actually used</th>
                  <th className="py-2 font-medium">In this kitchen</th>
                </tr>
              </thead>
              <tbody>
                {finishing.lines.map((line) => {
                  const typed = Number(finishing.used[line.itemId] ?? line.required)
                  const short = Number.isFinite(typed) && typed > line.available
                  return (
                    <tr key={line.itemId} className="border-b last:border-0">
                      <td className="py-2">{line.name}</td>
                      <td className="py-2 tabular-nums text-muted-foreground">
                        {line.required} {line.unit.toLowerCase()}
                      </td>
                      <td className="py-2">
                        <Input
                          inputMode="decimal"
                          aria-label={`How much ${line.name} was used`}
                          className="h-9 w-28"
                          value={finishing.used[line.itemId] ?? ''}
                          onChange={(e) =>
                            setFinishing((current) =>
                              current
                                ? { ...current, used: { ...current.used, [line.itemId]: e.target.value } }
                                : current,
                            )
                          }
                        />
                      </td>
                      <td className={`py-2 tabular-nums ${short ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
                        {line.available} {line.unit.toLowerCase()}
                        {short ? ' — not enough' : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="cp-made">Actual Quantity Produced</Label>
              <Input
                id="cp-made"
                inputMode="decimal"
                value={finishing.made}
                onChange={(e) => setFinishing((c) => (c ? { ...c, made: e.target.value } : c))}
              />
              <p className="text-xs text-muted-foreground">
                Planned {finishing.job.plannedQty} {(finishing.job.outputUnit ?? '').toLowerCase()}
              </p>
            </div>
            {Number(finishing.made) < finishing.job.plannedQty ? (
              <div className="space-y-1.5">
                <Label htmlFor="cp-reason">Why fewer?</Label>
                <select
                  id="cp-reason"
                  className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={finishing.reason}
                  onChange={(e) => setFinishing((c) => (c ? { ...c, reason: e.target.value } : c))}
                >
                  <option value="">Choose a reason…</option>
                  {REASONS.map((reason) => (
                    <option key={reason.value} value={reason.value}>{reason.label}</option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="cp-overhead">Other costs (optional)</Label>
              <Input
                id="cp-overhead"
                inputMode="decimal"
                placeholder="Labour, power, gas"
                value={finishing.overhead}
                onChange={(e) => setFinishing((c) => (c ? { ...c, overhead: e.target.value } : c))}
              />
            </div>
          </div>

          {/*
            Inventory Impact, spelled out before the button is pressed. This is
            the only action on the screen that moves stock, and saying exactly
            what will move is the difference between a confident tap and a
            hesitant one.
          */}
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <p className="mb-1 font-medium">Inventory Impact</p>
            <p className="text-muted-foreground">
              Takes out{' '}
              {finishing.lines
                .map((line) => `${finishing.used[line.itemId] ?? line.required} ${line.unit.toLowerCase()} ${line.name}`)
                .join(', ') || 'nothing'}
              . Puts in {finishing.made || 0} {(finishing.job.outputUnit ?? '').toLowerCase()} of{' '}
              {finishing.job.outputName ?? finishing.job.recipeName}.
            </p>
            {Number(finishing.made) < finishing.job.plannedQty ? (
              <p className="mt-1 text-muted-foreground">
                Coming up short does not put ingredients back — they were used. The shortfall is
                recorded against the job and raises what each one cost to make.
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex gap-2">
            <Button onClick={finish} disabled={busy}>Complete Production</Button>
            <Button variant="ghost" onClick={() => setFinishing(null)} disabled={busy}>Cancel</Button>
          </div>
        </SectionCard>
      ) : null}

      {/* ── Ready to Make ─────────────────────────────────────────────────── */}
      <SectionCard
        title="Ready to Make"
        description="Created, nothing taken from stock yet."
      >
        {readyToMake.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Nothing waiting. Create one below.</p>
        ) : (
          <ul className="divide-y divide-border">{readyToMake.map((job) => jobRow(job, false))}</ul>
        )}
      </SectionCard>

      {/* ── In Progress ───────────────────────────────────────────────────── */}
      {inProgress.length > 0 ? (
        <SectionCard title="In Progress" description="Being made now.">
          <ul className="divide-y divide-border">{inProgress.map((job) => jobRow(job, true))}</ul>
        </SectionCard>
      ) : null}

      {/* ── New Production ────────────────────────────────────────────────── */}
      <SectionCard
        title="New Production"
        description="Pick what to make and how much. Nothing leaves stock until the job is completed."
      >
        {activeRecipes.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            No make-ahead recipes yet.{' '}
            <Link href="/dashboard/production/recipes" className="underline">Write one first.</Link>
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              {data.houses.length > 1 ? (
                <div className="space-y-1.5">
                  <Label htmlFor="np-house">Kitchen</Label>
                  <select
                    id="np-house"
                    className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                    value={houseId}
                    onChange={(e) => setHouseId(e.target.value)}
                  >
                    {data.houses.map((house) => (
                      <option key={house.id} value={house.id}>{house.name}</option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="np-recipe">What are you making?</Label>
                <select
                  id="np-recipe"
                  className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={jobRecipeId}
                  onChange={(e) => setJobRecipeId(e.target.value)}
                >
                  <option value="">Choose a recipe…</option>
                  {activeRecipes.map((recipe) => (
                    <option key={recipe.id} value={recipe.id}>{recipe.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-qty">Planned Quantity</Label>
                <div className="flex gap-2">
                  <Input
                    id="np-qty"
                    inputMode="decimal"
                    className="flex-1"
                    value={plannedQty}
                    onChange={(e) => setPlannedQty(e.target.value)}
                  />
                  {chosenRecipe ? (
                    <span className="flex h-10 items-center rounded-lg border border-border px-3 text-sm text-muted-foreground">
                      {chosenRecipe.outputUnit.toLowerCase()}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Required ingredients vs what is actually on the shelf. */}
            {preview && preview.ingredients.length > 0 ? (
              <div className="mt-4">
                <p className="mb-2 text-sm font-medium">
                  To make {preview.plannedQty} {preview.producesUnit.toLowerCase()} of {preview.producesName}
                  {previewing ? ' …' : ''}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-2 font-medium">Ingredient</th>
                        <th className="py-2 font-medium">Needs</th>
                        <th className="py-2 font-medium">In this kitchen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.ingredients.map((line) => (
                        <tr key={line.itemId} className="border-b last:border-0">
                          <td className="py-2">{line.name}</td>
                          <td className="py-2 tabular-nums">{line.required} {line.unit.toLowerCase()}</td>
                          <td className={`py-2 tabular-nums ${line.short > 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
                            {line.available} {line.unit.toLowerCase()}
                            {line.short > 0 ? ` — ${line.short} short` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Ingredients cost about {money(preview.totalCost)}.
                  {preview.canMake
                    ? ' Everything is here.'
                    : ' You can still create the job — the shortage is only refused when you complete it.'}
                </p>
                {preview.problems.length > 0 ? (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{preview.problems[0]}</p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4">
              <Button
                onClick={createJob}
                disabled={busy || !jobRecipeId || !(plannedNumber > 0) || !houseId}
              >
                <ChefHat className="mr-1.5 h-4 w-4" />
                Create Production Job
              </Button>
            </div>
          </>
        )}
      </SectionCard>
    </div>
  )
}
