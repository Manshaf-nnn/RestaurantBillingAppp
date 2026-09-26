'use client'

import * as React from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Copy, Eye, Plus, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/primitives'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { regenerateQrCode, saveQrExperience, setQrExperienceActive } from '../actions'
import type { ExperienceStats } from '../queries'
import type { LocationRow } from '../locations'
import { LocationsManager } from './locations-manager'

/**
 * Everything an owner can decide about one QR menu (ar.md §4–§20).
 *
 * ── Why one page and not a wizard ───────────────────────────────────────────
 *
 * §20 sketches a wizard, but the thing it actually asks for is that the owner
 * "should NOT need technical knowledge" and that customisation is OPTIONAL
 * (§21). A wizard makes every step feel required and hides the settings an
 * owner comes back to change. Sections down one page, each with a working
 * default, does what the spec wants: an owner who wants the ordinary QR
 * experience changes nothing and prints the code at the bottom.
 *
 * The one rule with teeth is in `normaliseFields` on the server: identifying
 * customers without asking for a phone number cannot work, because that is how
 * the CRM recognises somebody.
 */

type Rule = 'HIDDEN' | 'OPTIONAL' | 'REQUIRED'
type FieldType = 'TEXT' | 'PHONE' | 'EMAIL' | 'DATE' | 'NUMBER'

export interface EditorField {
  key: string
  label: string
  type: FieldType
  rule: Rule
  categoryId: string | null
  sortOrder: number
}

export interface EditorExperience {
  id: string
  publicId: string
  name: string
  description: string | null
  branchId: string
  type: string
  askTable: boolean
  isActive: boolean
  menuMode: string
  menuCategoryIds: string[]
  menuFoodIds: string[]
  identifyCustomer: boolean
  askCustomerCategory: boolean
  customerCategoryIds: string[]
  showSearch: boolean
  showPrices: boolean
  showOffers: boolean
  askLocation: boolean
  requireLocation: boolean
  offerNote: string | null
  showLoyalty: boolean
  fields: EditorField[]
}

const BUILT_INS: Array<{ key: string; label: string; type: FieldType }> = [
  { key: 'name', label: 'Name', type: 'TEXT' },
  { key: 'phone', label: 'Phone number', type: 'PHONE' },
  { key: 'email', label: 'Email', type: 'EMAIL' },
  { key: 'birthday', label: 'Date of birth', type: 'DATE' },
  { key: 'anniversary', label: 'Anniversary', type: 'DATE' },
]

const SELECT = 'h-9 w-full rounded-lg border border-input bg-background px-2 text-sm'

export function ExperienceEditor({
  experience,
  branches,
  deliveryPlaces,
  customerCategories,
  menuCategories,
  link,
  qrDataUrl,
  previewPath,
  stats,
  currency,
  locale,
}: {
  experience: EditorExperience
  branches: Array<{ id: string; name: string }>
  /** The delivery places at this code's branch, main places and their sub-places. */
  deliveryPlaces: LocationRow[]
  customerCategories: Array<{ id: string; name: string }>
  menuCategories: Array<{ id: string; name: string; items: Array<{ id: string; name: string }> }>
  link: string
  qrDataUrl: string
  previewPath: string
  stats: ExperienceStats
  currency: string
  locale: string
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  const [name, setName] = React.useState(experience.name)
  const [description, setDescription] = React.useState(experience.description ?? '')
  const [branchId, setBranchId] = React.useState(experience.branchId)
  const [type, setType] = React.useState(experience.type as 'ORDERING' | 'MENU_ONLY')
  const [askTable, setAskTable] = React.useState(experience.askTable)
  const [menuMode, setMenuMode] = React.useState(experience.menuMode as 'ALL' | 'CUSTOM')
  const [menuCategoryIds, setMenuCategoryIds] = React.useState(experience.menuCategoryIds)
  const [menuFoodIds, setMenuFoodIds] = React.useState(experience.menuFoodIds)
  const [identify, setIdentify] = React.useState(experience.identifyCustomer)
  const [askCategory, setAskCategory] = React.useState(experience.askCustomerCategory)
  const [categoryIds, setCategoryIds] = React.useState(experience.customerCategoryIds)
  const [showSearch, setShowSearch] = React.useState(experience.showSearch)
  const [showPrices, setShowPrices] = React.useState(experience.showPrices)
  const [showOffers, setShowOffers] = React.useState(experience.showOffers)
  const [offerNote, setOfferNote] = React.useState(experience.offerNote ?? '')
  const [askLocation, setAskLocation] = React.useState(experience.askLocation)
  const [requireLocation, setRequireLocation] = React.useState(experience.requireLocation)
  const [showLoyalty, setShowLoyalty] = React.useState(experience.showLoyalty)
  const [fields, setFields] = React.useState<EditorField[]>(() =>
    experience.fields.length > 0
      ? experience.fields
      : [
          { key: 'name', label: 'Name', type: 'TEXT', rule: 'OPTIONAL', categoryId: null, sortOrder: 0 },
          { key: 'phone', label: 'Phone number', type: 'PHONE', rule: 'REQUIRED', categoryId: null, sortOrder: 1 },
        ],
  )

  const money = (value: number) => formatMoney(value, currency, locale)

  const setField = (index: number, patch: Partial<EditorField>) =>
    setFields((current) => current.map((field, i) => (i === index ? { ...field, ...patch } : field)))

  const addField = (categoryId: string | null) =>
    setFields((current) => [
      ...current,
      {
        key: `field-${current.length + 1}`,
        label: '',
        type: 'TEXT',
        rule: 'OPTIONAL',
        categoryId,
        sortOrder: current.length,
      },
    ])

  const addBuiltIn = (entry: { key: string; label: string; type: FieldType }, categoryId: string | null) =>
    setFields((current) => [
      ...current,
      { key: entry.key, label: entry.label, type: entry.type, rule: 'OPTIONAL', categoryId, sortOrder: current.length },
    ])

  const toggleIn = (list: string[], id: string) =>
    list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]

  const save = async () => {
    setBusy(true)
    const result = await callAction(() =>
      saveQrExperience({
        experienceId: experience.id,
        name,
        description,
        branchId,
        type,
        askTable,
        menuMode,
        menuCategoryIds,
        menuFoodIds,
        identifyCustomer: identify,
        askCustomerCategory: askCategory,
        customerCategoryIds: categoryIds,
        showSearch,
        showPrices,
        showOffers,
        offerNote,
        askLocation,
        requireLocation,
        showLoyalty,
        fields: fields
          .filter((field) => field.label.trim())
          .map((field, index) => ({ ...field, sortOrder: index })),
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Saved')
    router.refresh()
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      toast.success('Link copied')
    } catch {
      toast.error('Could not copy — select the link and copy it by hand')
    }
  }

  const regenerate = async () => {
    setBusy(true)
    const result = await callAction(() => regenerateQrCode({ experienceId: experience.id }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('New code generated — the old printed cards no longer work')
    router.refresh()
  }

  const toggleActive = async () => {
    setBusy(true)
    const result = await callAction(() =>
      setQrExperienceActive({ experienceId: experience.id, isActive: !experience.isActive }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    router.refresh()
  }

  const general = fields.filter((field) => field.categoryId === null)

  return (
    <div className="space-y-5 pb-24">
      {/* ── 1. Basics (§4) ───────────────────────────────────────────── */}
      <SectionCard title="The basics" description="What this code is, and where it belongs.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
            <p className="text-xs text-muted-foreground">Only you see this.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="branch">Location</Label>
            <select id="branch" className={SELECT} value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">Its menu, its prices, its tables.</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="description">Welcome line</Label>
            <Input
              id="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={200}
              placeholder="Shown under your name on the first screen. Optional."
            />
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <Choice
            checked={type === 'ORDERING'}
            onChange={() => setType('ORDERING')}
            title="Takes orders"
            hint="Guests pick a table, browse and order. The normal QR experience."
          />
          <Choice
            checked={type === 'MENU_ONLY'}
            onChange={() => setType('MENU_ONLY')}
            title="Menu only"
            hint="Nothing can be ordered and no table is taken. For a window, a poster or a counter."
          />
        </div>

        {/*
          ar.md §3 — a code with no table behind it. The one switch that turns
          a table card into a delivery or takeaway code.
        */}
        {type === 'ORDERING' ? (
          <div className="mt-3">
            <Toggle
              checked={askTable}
              onChange={setAskTable}
              title="Ask for a table number"
              hint={
                askTable
                  ? 'On for a card on a table. Turn it off for delivery, takeaway or a counter — those guests have no table number to give, and their orders come through as takeaway.'
                  : 'Off — guests go straight to the menu and their orders come through as takeaway, filed against this location.'
              }
            />
          </div>
        ) : null}

        {/*
          Where it goes, for a code with no table.
          
          Only offered once "ask for a table number" is OFF, because the two
          answer the same question: a guest sitting at table 6 does not need to
          tell the kitchen which building to walk to. Offering both would let an
          owner build a code that asks a seated guest for a delivery address.
        */}
        {type === 'ORDERING' && !askTable ? (
          <div className="mt-3 space-y-3">
            <Toggle
              checked={askLocation}
              onChange={setAskLocation}
              title="Ask where to deliver"
              hint="Guests pick from the places you set up below, so the rider reads the same words every time."
            />
            {askLocation ? (
              <Toggle
                checked={requireLocation}
                onChange={setRequireLocation}
                title="A location is required"
                hint={
                  requireLocation
                    ? 'On — the order cannot be placed without one. Right for delivery.'
                    : 'Off — a guest may order without choosing, for a code that also does collection.'
                }
              />
            ) : null}
            {/*
              The places themselves, right here under the switch that asks for
              them. They had a screen of their own, which meant turning the
              question on in one place and answering it in another — and an
              owner who did the first and not the second shipped a code that
              asked guests to choose from nothing.
            */}
            {askLocation ? <LocationsManager rows={deliveryPlaces} branchId={experience.branchId} /> : null}
          </div>
        ) : null}
      </SectionCard>

      {/* ── 2. Who's scanning (§5, §6, §7, §9) ───────────────────────── */}
      <SectionCard
        title="Who is scanning"
        description="Off by default — guests order without being asked anything, exactly as they do today."
      >
        <Toggle
          checked={identify}
          onChange={setIdentify}
          title="Ask who they are"
          hint="Their answers go to your existing customer list. Somebody who has eaten here before is recognised, never duplicated."
        />

        {identify ? (
          <div className="mt-4 space-y-5">
            <div>
              <p className="mb-2 text-sm font-medium">What everyone is asked</p>
              <FieldTable
                fields={fields}
                filter={(field) => field.categoryId === null}
                onChange={setField}
                onRemove={(index) => setFields((current) => current.filter((_, i) => i !== index))}
                onAdd={() => addField(null)}
                onAddBuiltIn={(entry) => addBuiltIn(entry, null)}
                built={general.map((field) => field.key)}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                The phone number is how a guest is recognised, so it cannot be hidden while this is on.
              </p>
            </div>

            <div>
              <Toggle
                checked={askCategory}
                onChange={setAskCategory}
                title="Ask them to choose a category"
                hint="Uses the customer categories you already have. Only the ones you tick appear."
              />
              {askCategory ? (
                customerCategories.length === 0 ? (
                  <p className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                    You have no customer categories yet. Add them under Customers first.
                  </p>
                ) : (
                  <div className="mt-3 space-y-4">
                    <div className="flex flex-wrap gap-2">
                      {customerCategories.map((category) => (
                        <button
                          key={category.id}
                          type="button"
                          onClick={() => setCategoryIds((current) => toggleIn(current, category.id))}
                          aria-pressed={categoryIds.includes(category.id)}
                          className={cn(
                            'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                            categoryIds.includes(category.id)
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'hover:bg-muted',
                          )}
                        >
                          {category.name}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Nothing ticked means every active category is offered.
                    </p>

                    {/* §7 — extra questions, only for one category. */}
                    {customerCategories
                      .filter((category) => categoryIds.length === 0 || categoryIds.includes(category.id))
                      .map((category) => (
                        <div key={category.id} className="rounded-xl border p-3">
                          <p className="mb-2 text-sm font-medium">
                            Extra, only if they choose{' '}
                            <Badge variant="secondary" size="sm">{category.name}</Badge>
                          </p>
                          <FieldTable
                            fields={fields}
                            filter={(field) => field.categoryId === category.id}
                            onChange={setField}
                            onRemove={(index) => setFields((current) => current.filter((_, i) => i !== index))}
                            onAdd={() => addField(category.id)}
                            onAddBuiltIn={(entry) => addBuiltIn(entry, category.id)}
                            built={fields.filter((f) => f.categoryId === category.id).map((f) => f.key)}
                          />
                        </div>
                      ))}
                  </div>
                )
              ) : null}
            </div>
          </div>
        ) : null}
      </SectionCard>

      {/* ── 3. The menu (§10) ────────────────────────────────────────── */}
      <SectionCard title="The menu" description="Everything you sell at this location, or a part of it.">
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice
            checked={menuMode === 'ALL'}
            onChange={() => setMenuMode('ALL')}
            title="Show everything"
            hint="Whatever is on the menu at this location, as it changes."
          />
          <Choice
            checked={menuMode === 'CUSTOM'}
            onChange={() => setMenuMode('CUSTOM')}
            title="Choose what to show"
            hint="Pick sections, or individual dishes."
          />
        </div>

        {menuMode === 'CUSTOM' ? (
          <div className="mt-4 space-y-3">
            {menuCategories.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is on the menu at this location yet.</p>
            ) : (
              menuCategories.map((category) => (
                <div key={category.id} className="rounded-xl border p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox
                      checked={menuCategoryIds.includes(category.id)}
                      onCheckedChange={() => setMenuCategoryIds((current) => toggleIn(current, category.id))}
                    />
                    {category.name}
                    <span className="text-xs font-normal text-muted-foreground">
                      {category.items.length} item{category.items.length === 1 ? '' : 's'}
                    </span>
                  </label>
                  {!menuCategoryIds.includes(category.id) && category.items.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
                      {category.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setMenuFoodIds((current) => toggleIn(current, item.id))}
                          aria-pressed={menuFoodIds.includes(item.id)}
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-xs transition-colors',
                            menuFoodIds.includes(item.id)
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'text-muted-foreground hover:bg-muted',
                          )}
                        >
                          {item.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
            {menuCategoryIds.length === 0 && menuFoodIds.length === 0 ? (
              <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                Nothing is chosen, so this code shows an empty menu. Tick a section, or switch back to “Show everything”.
              </p>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      {/* ── 4. What they can do (§13) ────────────────────────────────── */}
      <SectionCard
        title="What guests can do"
        description="These narrow what you have set for every code. They can hide something, never bring back something you have already hidden."
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard/settings/guest">
              <Smartphone /> How it all looks
            </Link>
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle checked={showSearch} onChange={setShowSearch} title="Search the menu" hint="A search box above the dishes." />
          <Toggle checked={showPrices} onChange={setShowPrices} title="Show prices" hint="Turn off for a menu with no prices on it." />
          <Toggle checked={showOffers} onChange={setShowOffers} title="Show offers" hint="The live discount codes usable on this menu." />
          <Toggle checked={showLoyalty} onChange={setShowLoyalty} title="Show loyalty points" hint="Only if loyalty is switched on for the restaurant." />
        </div>

        {/*
          The live coupons are listed automatically; this is for what the
          discount engine cannot express — "students get 5% on Mondays, show
          your ID". Only offered when the panel is on, because a note nobody
          can see is a setting that lies about having been saved.
        */}
        {showOffers ? (
          <div className="mt-3">
            <Field
              label="Note under the offers"
              hint="Optional. Anything the discount codes above cannot say by themselves."
            >
              <Textarea
                value={offerNote}
                onChange={(event) => setOfferNote(event.target.value.slice(0, 600))}
                rows={3}
                placeholder={'Students get 5% off on Mondays.\nShow your campus ID at pickup.'}
              />
            </Field>
          </div>
        ) : null}
        {type === 'MENU_ONLY' ? (
          <p className="mt-3 text-xs text-muted-foreground">
            This is a menu-only code, so ordering, the basket and order tracking are off whatever is ticked here.
          </p>
        ) : null}
      </SectionCard>

      {/* ── 5. The code itself (§17, §19) ────────────────────────────── */}
      <SectionCard
        title="The code"
        description="Print it, or share the link. Guests never see anything about your system in it."
        actions={
          <Badge variant={experience.isActive ? 'success' : 'secondary'}>
            {experience.isActive ? 'Live' : 'Off'}
          </Badge>
        }
      >
        <div className="flex flex-wrap items-start gap-5">
          <Image
            src={qrDataUrl}
            alt="QR code"
            width={168}
            height={168}
            className="size-42 rounded-xl border bg-white p-2"
            unoptimized
          />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="qr-link">Link</Label>
              <div className="flex gap-2">
                <Input id="qr-link" readOnly value={link} className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={copy} aria-label="Copy link">
                  <Copy />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild>
                <a href={previewPath} target="_blank" rel="noreferrer">
                  <Eye /> Preview
                </a>
              </Button>
              <Button variant="outline" onClick={regenerate} disabled={busy}>
                <RefreshCw /> New code
              </Button>
              <Button variant="ghost" onClick={toggleActive} disabled={busy}>
                {experience.isActive ? 'Switch off' : 'Switch on'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Preview opens exactly what a guest sees — nothing you do in it is saved. A new code stops every
              printed card working, so only do it if a card has gone astray.
            </p>
          </div>
        </div>
      </SectionCard>

      {/* ── 6. What it has done (§22) ────────────────────────────────── */}
      <SectionCard title="How it is doing" description="Opens are counted once per visit; everything else is real orders.">
        <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Opens" value={String(stats.openCount)} />
          <Stat label="Orders" value={String(stats.orders)} />
          <Stat label="Sales" value={money(stats.sales)} />
          <Stat label="Customers" value={String(stats.customers)} />
          <Stat label="New customers" value={String(stats.newCustomers)} />
          <Stat label="Top dish" value={stats.topItems[0]?.name ?? '—'} />
        </dl>
        {stats.byCategory.length > 0 ? (
          <div className="mt-4">
            <p className="mb-2 text-sm font-medium">New customers by category</p>
            <ul className="flex flex-wrap gap-2">
              {stats.byCategory.map((row) => (
                <li key={row.name} className="rounded-full border px-3 py-1 text-xs">
                  {row.name} · <span className="tabular-nums font-medium">{row.customers}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SectionCard>

      {/* The one thing that must always be reachable. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur lg:pl-64">
        <div className="mx-auto flex max-w-5xl items-center justify-end gap-3">
          <p className="mr-auto text-xs text-muted-foreground">Changes apply the moment you save.</p>
          <Button size="lg" onClick={save} loading={busy}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function FieldTable({
  fields,
  filter,
  onChange,
  onRemove,
  onAdd,
  onAddBuiltIn,
  built,
}: {
  fields: EditorField[]
  filter: (field: EditorField) => boolean
  onChange: (index: number, patch: Partial<EditorField>) => void
  onRemove: (index: number) => void
  onAdd: () => void
  onAddBuiltIn: (entry: { key: string; label: string; type: FieldType }) => void
  /** Built-in keys already present, so the quick-add row does not offer them twice. */
  built: string[]
}) {
  const rows = fields.map((field, index) => ({ field, index })).filter(({ field }) => filter(field))
  const missing = BUILT_INS.filter((entry) => !built.includes(entry.key))

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing extra is asked.</p>
      ) : (
        rows.map(({ field, index }) => (
          <div key={`${field.key}-${field.categoryId ?? 'all'}`} className="grid grid-cols-[1fr_7rem_2.5rem] items-center gap-2">
            <Input
              value={field.label}
              onChange={(event) => onChange(index, { label: event.target.value })}
              placeholder="Campus ID, Company name, Room number…"
              maxLength={64}
              className="h-9"
            />
            <select
              className={SELECT}
              value={field.rule}
              onChange={(event) => onChange(index, { rule: event.target.value as Rule })}
              aria-label={`Is ${field.label || 'this'} required?`}
            >
              <option value="OPTIONAL">Optional</option>
              <option value="REQUIRED">Required</option>
              <option value="HIDDEN">Do not ask</option>
            </select>
            <Button variant="ghost" size="icon-sm" onClick={() => onRemove(index)} aria-label={`Remove ${field.label || 'field'}`}>
              <Trash2 />
            </Button>
          </div>
        ))
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus /> Add your own
        </Button>
        {/*
          * The five that write a real customer column. Offered as one-tap
          * chips rather than buried in a type picker, because "also ask for
          * their birthday" is a thing an owner wants, and choosing a field
          * TYPE is not.
          */}
        {missing.map((entry) => (
          <Button
            key={entry.key}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onAddBuiltIn(entry)}
          >
            <Plus /> {entry.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  title: string
  hint: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

function Choice({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean
  onChange: () => void
  title: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      aria-pressed={checked}
      className={cn(
        'rounded-xl border p-3 text-left transition-colors',
        checked ? 'border-primary bg-primary/5' : 'hover:bg-muted',
      )}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
    </button>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
